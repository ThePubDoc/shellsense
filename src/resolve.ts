// Walks the words typed so far through a spec to find out what the word under the cursor can be:
// a subcommand, an option, the value of an option, or a positional argument.

import { commandName, loadSpec } from "./specs.ts";
import type { Arg, ExecuteCommand, Option, Subcommand } from "./types.ts";
import { toArray } from "./types.ts";

export interface Context {
  /** False when no spec exists for the command. */
  known: boolean;
  /** The innermost subcommand the typed words lead to. */
  sub: Subcommand;
  /** Options inherited from parent subcommands. */
  persistent: Option[];
  /** Option names already present on the line. */
  used: Set<string>;
  /** Set when the word under the cursor is the value of an option. */
  optionArg: { option: Option; arg: Arg; optional: boolean } | null;
  /** The positional argument the word under the cursor would fill, if any. */
  positional: Arg | null;
  canSubcommand: boolean;
  afterDashDash: boolean;
  /** Words of the innermost command (after `sudo` and friends), command name first. */
  words: string[];
  /** The command and the subcommands the words lead through, e.g. `["git", "checkout"]`. */
  path: string[];
}

export interface ResolveDeps {
  exec: ExecuteCommand;
  cwd: string;
  /** Only look at what the spec files say; skip the parts of a spec that run commands. */
  offline?: boolean;
}

const GENERATE_SPEC_TTL_MS = 30_000;
const GENERATE_SPEC_TIMEOUT_MS = 3000;
const MAX_NESTING = 4;

const subcommandIndex = new WeakMap<Subcommand, Map<string, Subcommand>>();
const loadedSpecs = new WeakMap<Subcommand, Promise<Subcommand>>();
const generatedSpecs = new WeakMap<Subcommand, Map<string, { at: number; value: Promise<Subcommand> }>>();

function findSubcommand(sub: Subcommand, word: string): Subcommand | undefined {
  let index = subcommandIndex.get(sub);
  if (!index) {
    index = new Map();
    for (const child of sub.subcommands ?? []) {
      for (const name of toArray(child.name)) if (!index.has(name)) index.set(name, child);
    }
    subcommandIndex.set(sub, index);
  }
  return index.get(word);
}

export function findOption(sub: Subcommand, persistent: Option[], name: string): Option | undefined {
  const has = (option: Option) => toArray(option.name).includes(name);
  return (sub.options ?? []).find(has) ?? persistent.find(has);
}

async function resolveLoadSpec(sub: Subcommand, token: string, deps: ResolveDeps): Promise<Subcommand> {
  let target: unknown = sub.loadSpec;
  if (typeof target === "function") {
    if (deps.offline) return sub;
    target = await target(token, deps.exec);
  }
  if (Array.isArray(target)) target = target[0];
  // A loader may return a location (`{ name: "aws/s3" }`) instead of the spec itself.
  if (target && typeof target === "object" && !("subcommands" in target) && !("options" in target) && !("args" in target)) {
    target = (target as { name?: unknown }).name;
  }
  if (typeof target === "string") target = await loadSpec(target);
  if (!target || typeof target !== "object") return sub;
  const loaded = target as Subcommand;
  return { ...loaded, name: sub.name, description: sub.description ?? loaded.description };
}

async function withGeneratedSpec(sub: Subcommand, tokens: string[], deps: ResolveDeps): Promise<Subcommand> {
  let cache = generatedSpecs.get(sub);
  if (!cache) generatedSpecs.set(sub, (cache = new Map()));
  const now = Date.now();
  const hit = cache.get(deps.cwd);
  if (hit && now - hit.at < GENERATE_SPEC_TTL_MS) return hit.value;

  const value = (async () => {
    const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), GENERATE_SPEC_TIMEOUT_MS).unref());
    const generated = await Promise.race([sub.generateSpec!(tokens, deps.exec), timeout]).catch(() => undefined);
    if (!generated || typeof generated !== "object") return sub;
    return {
      ...sub,
      subcommands: [...(sub.subcommands ?? []), ...(generated.subcommands ?? [])],
      options: [...(sub.options ?? []), ...(generated.options ?? [])],
      args: generated.args ?? sub.args,
    };
  })();
  if (cache.size > 32) cache.clear();
  cache.set(deps.cwd, { at: now, value });
  return value;
}

/** Applies `loadSpec` and `generateSpec`, the two ways a subcommand defers its definition. */
async function enter(sub: Subcommand, tokens: string[], deps: ResolveDeps): Promise<Subcommand> {
  let resolved = sub;
  if (typeof sub.loadSpec === "function" && deps.offline) return sub;
  if (sub.loadSpec !== undefined) {
    let pending = loadedSpecs.get(sub);
    if (!pending) {
      pending = resolveLoadSpec(sub, tokens[tokens.length - 1] ?? "", deps).catch(() => sub);
      loadedSpecs.set(sub, pending);
    }
    resolved = await pending;
  }
  if (typeof resolved.generateSpec === "function" && !deps.offline) resolved = await withGeneratedSpec(resolved, tokens, deps);
  return resolved;
}

interface PendingOption {
  option: Option;
  args: Arg[];
  index: number;
  count: number;
}

type Outcome = { context: Context } | { nested: string[] };

async function walk(root: Subcommand, words: string[], deps: ResolveDeps): Promise<Outcome> {
  let sub = await enter(root, words.slice(0, 1), deps);
  const path = [commandName(words[0] ?? "")];
  let persistent: Option[] = [];
  let used = new Set<string>();
  let argIndex = 0;
  let argsStarted = false;
  let afterDashDash = false;
  let pending: PendingOption | null = null;

  const expectValue = (option: Option): PendingOption | null => {
    const args = toArray(option.args);
    // An option written as `--name=value` never takes the next word as its value.
    if (args.length === 0 || option.requiresSeparator || option.requiresEquals) return null;
    return { option, args, index: 0, count: 0 };
  };
  const consumeOption = (word: string): PendingOption | null => {
    const mark = (option: Option) => toArray(option.name).forEach((name) => used.add(name));
    const exact = findOption(sub, persistent, word);
    if (exact) {
      mark(exact);
      return expectValue(exact);
    }
    const eq = word.indexOf("=");
    if (eq > 0) {
      const option = findOption(sub, persistent, word.slice(0, eq));
      if (option) mark(option);
      return null;
    }
    // `-abc` is `-a -b -c`; the last flag may take the next word as its value.
    if (!word.startsWith("--") && word.length > 2 && !sub.parserDirectives?.flagsArePosixNoncompliant) {
      for (let k = 1; k < word.length; k++) {
        const option = findOption(sub, persistent, `-${word[k]}`);
        if (!option) break;
        mark(option);
        if (toArray(option.args).length > 0) return k === word.length - 1 ? expectValue(option) : null;
      }
    }
    return null;
  };

  for (let i = 1; i < words.length; i++) {
    const word = words[i]!;
    const looksLikeOption = !afterDashDash && word.startsWith("-") && word.length > 1;

    if (pending) {
      const arg = pending.args[pending.index]!;
      const skippable = arg.isOptional || (arg.isVariadic && pending.count > 0);
      if (!(skippable && looksLikeOption)) {
        pending.count++;
        if (!arg.isVariadic) pending.index++;
        if (pending.index >= pending.args.length) pending = null;
        continue;
      }
      pending = null;
    }

    if (looksLikeOption) {
      if (word === "--" && !findOption(sub, persistent, "--")) afterDashDash = true;
      else pending = consumeOption(word);
      continue;
    }

    if (!argsStarted) {
      const child = findSubcommand(sub, word);
      if (child) {
        persistent = [...persistent, ...(sub.options ?? []).filter((option) => option.isPersistent)];
        sub = await enter(child, words.slice(0, i + 1), deps);
        path.push(toArray(child.name)[0] ?? word);
        used = new Set();
        argIndex = 0;
        continue;
      }
    }
    argsStarted = true;
    const arg = toArray(sub.args)[argIndex];
    if (arg) {
      // `sudo git …`: the rest of the line is another command with its own spec.
      if (arg.isCommand) return { nested: words.slice(i) };
      if (!arg.isVariadic) argIndex++;
    }
  }

  let optionArg: Context["optionArg"] = null;
  if (pending) {
    const arg = pending.args[pending.index]!;
    optionArg = { option: pending.option, arg, optional: !!arg.isOptional || (!!arg.isVariadic && pending.count > 0) };
  }
  return {
    context: {
      known: true,
      sub,
      persistent,
      used,
      optionArg,
      positional: toArray(sub.args)[argIndex] ?? null,
      canSubcommand: !argsStarted,
      afterDashDash,
      words,
      path,
    },
  };
}

function unknownCommand(words: string[]): Context {
  return {
    known: false,
    sub: { name: words[0] ?? "" },
    persistent: [],
    used: new Set(),
    optionArg: null,
    positional: null,
    canSubcommand: false,
    afterDashDash: false,
    words,
    path: [commandName(words[0] ?? "")],
  };
}

/** `words` are the completed words of the command, command name first; the word under the cursor is not included. */
export async function resolve(words: string[], deps: ResolveDeps): Promise<Context> {
  let current = words;
  for (let depth = 0; depth < MAX_NESTING; depth++) {
    const root = await loadSpec(commandName(current[0] ?? ""));
    if (!root) break;
    const outcome = await walk(root, current, deps);
    if ("context" in outcome) return outcome.context;
    current = outcome.nested;
  }
  return unknownCommand(current);
}
