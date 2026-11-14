// Turns a command line and cursor position into the rows of the popup.

import { listFiles, quotePath } from "./files.ts";
import { execute, hasTemplate, runGenerator } from "./generators.ts";
import type { GeneratorContext } from "./generators.ts";
import { findOption, resolve } from "./resolve.ts";
import type { Context } from "./resolve.ts";
import { specNames } from "./specs.ts";
import { tokenize } from "./tokenize.ts";
import { absolutePath, pathKey, wordKey } from "./usage.ts";
import type { Usage } from "./usage.ts";
import type { Quote, Token } from "./tokenize.ts";
import type { Arg, ExecuteCommand, FigSuggestion, Generator, Item, Kind, Option, Result, Template } from "./types.ts";
import { toArray } from "./types.ts";

export interface Request {
  line: string;
  /** Cursor position in code points, as zsh reports it. */
  cursor: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
  aliases: Map<string, string>;
  /** What was used before. When given, rows used here before are ranked first. */
  usage?: Usage;
}

/** Called once with everything that is ready quickly, and again when slow generators finish. */
export type Emit = (result: Result, final: boolean) => void;

const MAX_ITEMS = 60;
const MAX_DESCRIPTION = 160;
/** Results that arrive within this window are sent in one reply instead of two. */
const FAST_MS = 25;
const DEADLINE_MS = 6000;

const PRIORITY = { arg: 55, subcommand: 50, option: 45 };

// Words that precede a command without being one, so the next word is looked up instead.
const MODIFIERS = new Set(["noglob", "nocorrect", "command", "builtin", "exec", "time", "if", "then", "else", "elif", "do", "while", "until", "!", "{"]);

interface Candidate {
  names: string[];
  display: string;
  description: string;
  kind: Kind;
  priority: number;
  hidden: boolean;
  insertValue?: string;
  /** Appended instead of a space, e.g. `=` for options written as `--name=value`. */
  suffix?: string;
  /** Insert text that is already complete (file paths, which are quoted and prefixed up front). */
  final?: string;
}

interface Group {
  candidates: Candidate[];
  /** What the candidate names are matched against: usually the whole token. */
  query: string;
  /** Part of the token that stays in front of the inserted value, e.g. `--color=`. */
  prefix: string;
  fuzzy: boolean;
  /** For file listings: the folder part of the token as typed, e.g. `src/`. */
  dir?: string;
}

function describe(text: unknown): string {
  if (typeof text !== "string") return "";
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > MAX_DESCRIPTION ? `${line.slice(0, MAX_DESCRIPTION - 1)}…` : line;
}

const KIND_BY_TYPE: Record<string, Kind> = { folder: "folder", file: "file", option: "option", subcommand: "subcommand" };
// Fig icon types that say more about a value than "argument" does.
const KIND_BY_ICON: Record<string, Kind> = { git: "branch", npm: "package", node: "package", yarn: "package", package: "package", box: "package" };

function kindOf(s: FigSuggestion, fallback: Kind): Kind {
  const byType = s.type ? KIND_BY_TYPE[s.type] : undefined;
  if (byType) return byType;
  const icon = typeof s.icon === "string" ? /^fig:\/\/icon\?type=([a-z]+)/.exec(s.icon)?.[1] : undefined;
  return (fallback === "arg" && icon && KIND_BY_ICON[icon]) || fallback;
}

function toCandidate(raw: string | FigSuggestion, kind: Kind, priority: number): Candidate | null {
  const s: FigSuggestion = typeof raw === "string" ? { name: raw } : raw;
  let names = toArray(s.name)
    .map(String)
    .filter((name) => name.length > 0);
  if (names.length === 0 && s.displayName) names = [s.displayName];
  if (names.length === 0) return null;
  return {
    names,
    display: s.displayName ?? names.join(", "),
    description: describe(s.description),
    kind: kindOf(s, kind),
    priority: typeof s.priority === "number" ? s.priority : priority,
    hidden: s.hidden === true,
    insertValue: typeof s.insertValue === "string" ? s.insertValue : undefined,
  };
}

function toCandidates(list: (string | FigSuggestion)[] | undefined, kind: Kind, priority: number): Candidate[] {
  return (list ?? []).map((raw) => toCandidate(raw, kind, priority)).filter((c): c is Candidate => c !== null);
}

function optionCandidates(ctx: Context): Candidate[] {
  const result: Candidate[] = [];
  for (const option of [...(ctx.sub.options ?? []), ...ctx.persistent]) {
    const names = toArray(option.name);
    if (!option.isRepeatable && names.some((name) => ctx.used.has(name))) continue;
    if (option.exclusiveOn?.some((name) => ctx.used.has(name))) continue;
    const candidate = toCandidate(option, "option", PRIORITY.option);
    if (!candidate) continue;
    if (option.requiresSeparator || option.requiresEquals) {
      candidate.suffix = typeof option.requiresSeparator === "string" ? option.requiresSeparator : "=";
    }
    result.push(candidate);
  }
  return result;
}

async function fileGroup(
  token: string,
  prefix: string,
  quote: Quote,
  cwd: string,
  foldersOnly: boolean,
  filter?: Generator["filterTemplateSuggestions"],
): Promise<Group> {
  const listing = await listFiles(token, cwd, foldersOnly);
  let entries = listing.entries;
  if (typeof filter === "function") {
    try {
      const template = foldersOnly ? "folders" : "filepaths";
      const kept = filter(entries.map((e) => ({ name: e.name, type: e.isDir ? "folder" : "file", context: { templateType: template } }) as FigSuggestion));
      const names = new Set(toArray(kept).flatMap((s) => toArray(s?.name)));
      entries = entries.filter((e) => names.has(e.name));
    } catch {
      // Keep the unfiltered listing when the spec's filter throws.
    }
  }
  const candidates = entries.map((entry): Candidate => {
    const quoted = quotePath(listing.dirPart + entry.name, quote, !entry.isDir);
    return {
      names: [entry.name],
      display: entry.name,
      description: "",
      kind: entry.isDir ? "folder" : "file",
      priority: PRIORITY.arg,
      hidden: false,
      // Folders get no trailing space so the user can keep descending into them.
      final: prefix + quoted + (entry.isDir ? "" : " "),
    };
  });
  return { candidates, query: listing.query, prefix: "", fuzzy: false, dir: listing.dirPart };
}

function queryFor(generator: Generator, token: string): { query: string; kept: string } {
  const term = generator.getQueryTerm;
  if (typeof term === "string" && term.length > 0) {
    const at = token.lastIndexOf(term);
    if (at >= 0) return { query: token.slice(at + term.length), kept: token.slice(0, at + term.length) };
  } else if (typeof term === "function") {
    try {
      const query = term(token);
      if (typeof query === "string" && token.endsWith(query)) return { query, kept: token.slice(0, token.length - query.length) };
    } catch {
      // Fall back to matching the whole token.
    }
  }
  return { query: token, kept: "" };
}

interface Sources {
  cwd: string;
  quote: Quote;
  generatorContext: GeneratorContext;
}

/** Everything one argument can offer: fixed suggestions, file templates and generators. */
function argGroups(arg: Arg, prefix: string, query: string, sources: Sources): Promise<Group>[] {
  const groups: Promise<Group>[] = [];
  const fuzzy = arg.filterStrategy === "fuzzy";
  const files = (templates: Template[], filter?: Generator["filterTemplateSuggestions"]) => {
    if (templates.includes("filepaths")) groups.push(fileGroup(query, prefix, sources.quote, sources.cwd, false, filter));
    else if (templates.includes("folders")) groups.push(fileGroup(query, prefix, sources.quote, sources.cwd, true, filter));
  };

  const fixed = toCandidates(arg.suggestions, "arg", PRIORITY.arg);
  if (fixed.length > 0) groups.push(Promise.resolve({ candidates: fixed, query, prefix, fuzzy }));
  files(toArray(arg.template));

  for (const generator of toArray(arg.generators)) {
    if (hasTemplate(generator)) {
      files(toArray(generator.template), generator.filterTemplateSuggestions);
      continue;
    }
    const term = queryFor(generator, query);
    groups.push(
      runGenerator(generator, sources.generatorContext).then((found) => ({
        candidates: toCandidates(found, "arg", PRIORITY.arg),
        query: term.query,
        prefix: prefix + term.kept,
        fuzzy,
      })),
    );
  }
  return groups;
}

async function commandGroup(query: string): Promise<Group> {
  // Offered where a command name is expected mid-line, as in `sudo gi`.
  if (query.length === 0) return { candidates: [], query, prefix: "", fuzzy: false };
  const names = [...(await specNames())].filter((name) => !name.includes("/") && name.startsWith(query));
  return { candidates: toCandidates(names, "subcommand", PRIORITY.subcommand), query, prefix: "", fuzzy: false };
}

function collect(ctx: Context, current: Token, req: Request): Promise<Group>[] {
  const token = current.text;
  const sources: Sources = {
    cwd: req.cwd,
    quote: current.quote,
    generatorContext: { tokens: [...ctx.words, token], cwd: req.cwd, env: req.env },
  };
  if (!ctx.known) return [fileGroup(token, "", current.quote, req.cwd, false)];

  const groups: Promise<Group>[] = [];
  let optionArg = ctx.optionArg;
  let prefix = "";
  let query = token;

  // `--name=val`: the value is completed in place and the option name stays in front.
  if (!optionArg && !ctx.afterDashDash && token.startsWith("-")) {
    const eq = token.indexOf("=");
    const option: Option | undefined = eq > 0 ? findOption(ctx.sub, ctx.persistent, token.slice(0, eq)) : undefined;
    const arg = option ? toArray(option.args)[0] : undefined;
    if (option && arg) {
      optionArg = { option, arg, optional: false };
      prefix = token.slice(0, eq + 1);
      query = token.slice(eq + 1);
    }
  }
  if (optionArg) {
    groups.push(...argGroups(optionArg.arg, prefix, query, sources));
    if (!optionArg.optional) return groups;
  }

  const fuzzy = ctx.sub.filterStrategy === "fuzzy";
  if (ctx.positional) {
    if (ctx.positional.isCommand) groups.push(commandGroup(token));
    groups.push(...argGroups(ctx.positional, "", token, sources));
  }
  if (ctx.canSubcommand) {
    const subcommands = toCandidates(ctx.sub.subcommands, "subcommand", PRIORITY.subcommand);
    if (subcommands.length > 0) groups.push(Promise.resolve({ candidates: subcommands, query: token, prefix: "", fuzzy }));
  }
  const extra = toCandidates(ctx.sub.additionalSuggestions, "arg", PRIORITY.subcommand);
  if (extra.length > 0) groups.push(Promise.resolve({ candidates: extra, query: token, prefix: "", fuzzy }));
  if (!ctx.afterDashDash) {
    groups.push(Promise.resolve({ candidates: optionCandidates(ctx), query: token, prefix: "", fuzzy }));
  }
  return groups;
}

/** Lower is better; null means the candidate does not match what was typed. */
function match(names: string[], query: string, fuzzy: boolean): { name: string; rank: number } | null {
  if (query.length === 0) return { name: names[0]!, rank: 1 };
  const lowerQuery = query.toLowerCase();
  let best: { name: string; rank: number } | null = null;
  for (const name of names) {
    const lower = name.toLowerCase();
    let rank = -1;
    if (name === query) rank = 0;
    else if (name.startsWith(query)) rank = 1;
    else if (lower.startsWith(lowerQuery)) rank = 2;
    else if (fuzzy && lower.includes(lowerQuery)) rank = 3;
    if (rank >= 0 && (!best || rank < best.rank)) best = { name, rank };
  }
  return best;
}

const CURSOR_MARK = "{cursor}";

/** Where in the displayed text the typed characters sit, so the shell can highlight them. */
function matchSpan(display: string, name: string, query: string): { matchStart: number; matchLength: number } {
  const none = { matchStart: 0, matchLength: 0 };
  if (query.length === 0) return none;
  const nameAt = display.indexOf(name);
  const queryAt = name.toLowerCase().indexOf(query.toLowerCase());
  if (nameAt < 0 || queryAt < 0) return none;
  return { matchStart: Array.from(display.slice(0, nameAt + queryAt)).length, matchLength: Array.from(query).length };
}

function toItem(candidate: Candidate, name: string, prefix: string, quote: Quote, query: string, recent: boolean): Item {
  const base = { display: candidate.display, description: candidate.description, kind: candidate.kind, recent, ...matchSpan(candidate.display, name, query) };
  if (candidate.final !== undefined) return { ...base, insert: candidate.final, cursorBack: 0 };

  // Paths that come from a spec's own generator (as `cd` does) are plain names and still need quoting.
  if (candidate.kind === "file" || candidate.kind === "folder") {
    const isFolder = candidate.kind === "folder";
    const value = prefix + (candidate.insertValue ?? name);
    return { ...base, insert: quotePath(value, quote, !isFolder) + (isFolder ? "" : " "), cursorBack: 0 };
  }

  // Specs use \b and \n in insertValue as editing hints for Fig's own UI; they mean nothing here.
  let value = (candidate.insertValue ?? name).replace(/[\b\n\r]/g, "");
  let cursorBack = 0;
  const mark = value.indexOf(CURSOR_MARK);
  if (mark >= 0) {
    const after = value.slice(mark + CURSOR_MARK.length);
    value = prefix + value.slice(0, mark) + after;
    cursorBack = Array.from(after).length;
  } else if (candidate.suffix !== undefined) {
    value = prefix + value + candidate.suffix;
  } else if (quote) {
    value = `${quote}${prefix}${value}${quote} `;
  } else {
    value = prefix + value;
    if (!/[\s=/]$/.test(value)) value += " ";
  }
  return { ...base, insert: value, cursorBack };
}

/**
 * Ranks and trims the candidates. `complete` reports whether the word under the cursor is already
 * one of the rows in full, which is what tells the shell that Enter should run the line rather
 * than insert the highlighted row. In every other case Enter takes the highlighted row.
 */
/** Where to look up what was used before: the store, the place in the command, and the folder. */
interface Boost {
  usage: Usage;
  context: string;
  cwd: string;
}

/** The place a word is used in, e.g. `git checkout`, or `git checkout -b` for the value of an option. */
export function usageContext(ctx: Context): string {
  return (ctx.optionArg ? [...ctx.path, toArray(ctx.optionArg.option.name)[0] ?? ""] : ctx.path).join(" ");
}

function build(groups: Group[], current: Token, boost: Boost | null): { items: Item[]; complete: boolean } {
  const token = current.text;
  const now = Date.now();
  const scored: { item: Item; rank: number; used: number; priority: number; order: number }[] = [];
  let order = 0;
  let complete = false;
  let insideFolder = false;
  for (const group of groups) {
    const isPathList = group.candidates.some((c) => c.kind === "file" || c.kind === "folder");
    // `cd src/`: the folder is named in full and the rows are what lies inside it.
    if (isPathList && group.query.length === 0 && token.endsWith("/")) {
      insideFolder ||= group.candidates.every((c) => c.kind === "folder");
    }
    for (const candidate of group.candidates) {
      const found = match(candidate.names, group.query, group.fuzzy);
      if (!found) continue;
      if (candidate.hidden && found.rank !== 0) continue;
      // Dotfiles stay out of the way until the user types the dot, whichever source listed them.
      const isPath = candidate.kind === "file" || candidate.kind === "folder";
      if (isPath && candidate.names[0]!.startsWith(".") && !group.query.startsWith(".")) continue;
      // `cd src` next to a `src/` row is as complete as an exact match.
      if (found.rank === 0 || (candidate.kind === "folder" && candidate.names.includes(`${group.query}/`))) complete = true;
      // Files and folders are remembered by where they are, everything else by the word and its place.
      let used = 0;
      if (boost && isPath) {
        used = boost.usage.score(pathKey(absolutePath(boost.cwd, (group.dir ?? group.prefix) + (candidate.insertValue ?? found.name))), now);
      } else if (boost) {
        for (const name of candidate.names) used = Math.max(used, boost.usage.score(wordKey(boost.context, name), now));
      }
      scored.push({
        item: toItem(candidate, found.name, group.prefix, current.quote, group.query, used > 0),
        rank: found.rank,
        used,
        priority: candidate.priority,
        order: order++,
      });
    }
  }
  // How well the row matches what was typed comes first; among equals, what was used before.
  scored.sort((a, b) => a.rank - b.rank || b.used - a.used || b.priority - a.priority || a.order - b.order);

  const items: Item[] = [];
  const seen = new Set<string>();
  for (const { item } of scored) {
    if (seen.has(item.insert)) continue;
    seen.add(item.insert);
    items.push(item);
    if (items.length >= MAX_ITEMS) break;
  }
  // A lone row that repeats exactly what is already typed has nothing to offer.
  if (items.length === 1 && scored[0]!.rank === 0 && items[0]!.kind !== "folder") return { items: [], complete };
  // Where only folders can follow, the first row stands for the folder already typed, so the
  // highlighted choice is "stay here" and the folders inside it are one arrow key away. Enter on
  // it changes nothing on the line, which the shell takes as "run".
  if (insideFolder && items.length > 0) {
    items.unshift({ display: ".", description: describe(token), kind: "folder", insert: quotePath(token, current.quote, false), cursorBack: 0, matchStart: 0, matchLength: 0, recent: false });
  }
  return { items, complete };
}

/** The words of a command once aliases are expanded and leading modifiers such as `noglob` are dropped. */
export function commandWordsOf(words: string[], aliases: Map<string, string>): string[] {
  let result = expandAliases(words, aliases);
  while (result.length > 0 && MODIFIERS.has(result[0]!)) result = result.slice(1);
  return result;
}

function expandAliases(words: string[], aliases: Map<string, string>): string[] {
  const seen = new Set<string>();
  let result = words;
  while (result.length > 0) {
    const first = result[0]!;
    const value = aliases.get(first);
    if (value === undefined || seen.has(first)) break;
    seen.add(first);
    const parsed = tokenize(value);
    const expansion = parsed.tokens.map((t) => t.text);
    if (parsed.current.text.length > 0) expansion.push(parsed.current.text);
    result = [...expansion, ...result.slice(1)];
  }
  return result;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

export async function suggest(req: Request, emit: Emit): Promise<void> {
  const text = Array.from(req.line).slice(0, req.cursor).join("");
  const parsed = tokenize(text);
  const current = parsed.current;
  const replaceStart = Array.from(text.slice(0, current.start)).length;
  let boost: Boost | null = req.usage ? { usage: req.usage, context: "", cwd: req.cwd } : null;
  const send = (groups: Group[], final: boolean) => emit({ replaceStart, ...build(groups, current, boost) }, final);

  let pending: Promise<Group>[];
  if (current.redirect) {
    pending = [fileGroup(current.text, "", current.quote, req.cwd, false)];
  } else {
    const words = commandWordsOf(
      parsed.tokens.map((t) => t.text),
      req.aliases,
    );
    // Nothing is offered while the command name itself is being typed.
    if (words.length === 0) return send([], true);
    const exec: ExecuteCommand = (input) => execute(input, { cwd: req.cwd, env: req.env });
    const ctx = await resolve(words, { exec, cwd: req.cwd });
    if (boost) boost = { ...boost, context: usageContext(ctx) };
    pending = collect(ctx, current, req);
  }

  // Groups keep their source order however late they resolve, so ranking does not depend on timing.
  const slots: (Group | undefined)[] = new Array(pending.length);
  const ready = () => slots.filter((group): group is Group => group !== undefined);
  const all = Promise.all(pending.map((group, i) => group.then((g) => void (slots[i] = g), () => undefined)));
  const quick = await Promise.race([all.then(() => true), delay(FAST_MS).then(() => false)]);
  if (quick) return send(ready(), true);
  if (ready().length > 0) send(ready(), false);
  await Promise.race([all, delay(DEADLINE_MS)]);
  send(ready(), true);
}

/** Convenience wrapper that waits for the final result. */
export function suggestOnce(req: Request): Promise<Result> {
  return new Promise((resolve, reject) => {
    suggest(req, (result, final) => {
      if (final) resolve(result);
    }).catch(reject);
  });
}
