// Runs the dynamic parts of a spec: generators that shell out (`git branch`, `docker ps`, …)
// and turn the output into suggestions.

import { spawn } from "node:child_process";
import type { ExecInput, ExecOutput, FigSuggestion, Generator } from "./types.ts";
import { toArray } from "./types.ts";

export interface GeneratorContext {
  /** Words of the command, command name first, with the token under the cursor last. */
  tokens: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_TTL_MS = 5000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 256;

/** Runs one command without a shell and resolves with its output; it never rejects. */
export function execute(input: ExecInput, ctx: { cwd: string; env: NodeJS.ProcessEnv }): Promise<ExecOutput> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let size = 0;
    const child = spawn(input.command, input.args ?? [], {
      cwd: input.cwd ?? ctx.cwd,
      // Completion must never take git's index lock away from the command the user is about to run.
      env: { ...ctx.env, GIT_OPTIONAL_LOCKS: "0", ...input.env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: input.timeout ?? DEFAULT_TIMEOUT_MS,
    });
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) child.kill();
      else stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < 65536) stderr += chunk;
    });
    child.on("error", (error) => resolve({ stdout: "", stderr: String(error), status: 127 }));
    child.on("close", (code) => resolve({ stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), status: code ?? 1 }));
  });
}

interface CacheEntry<T> {
  at: number;
  ttl: number;
  value: Promise<T>;
}

function cached<T>(cache: Map<string, CacheEntry<T>>, key: string, ttl: number, compute: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < hit.ttl) return hit.value;
  if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
  const entry = { at: now, ttl, value: compute() };
  cache.set(key, entry);
  return entry.value;
}

const scriptCache = new Map<string, CacheEntry<ExecOutput>>();
let customCache = new WeakMap<Generator, Map<string, CacheEntry<FigSuggestion[]>>>();

/** Forgets cached generator output. Called for every new prompt, since any command may have changed the answers. */
export function clearGeneratorCache(): void {
  scriptCache.clear();
  customCache = new WeakMap();
}

function toExecInput(script: string | string[] | ExecInput | undefined): ExecInput | null {
  if (!script) return null;
  if (typeof script === "string") return { command: "/bin/sh", args: ["-c", script] };
  if (Array.isArray(script)) {
    const [command, ...args] = script;
    return command ? { command, args } : null;
  }
  return typeof script.command === "string" ? script : null;
}

function clean(list: (FigSuggestion | null | undefined)[] | undefined): FigSuggestion[] {
  if (!Array.isArray(list)) return [];
  return list.filter((s): s is FigSuggestion => !!s && typeof s === "object");
}

/**
 * The part of the current token that decides whether a custom generator must run again.
 * Without a trigger a generator runs once per argument and the results are filtered as the user types.
 */
function triggerKey(generator: Generator, token: string): string {
  const trigger = generator.trigger;
  if (trigger === undefined) return "";
  if (typeof trigger === "string") return token.slice(0, token.lastIndexOf(trigger) + trigger.length);
  return token;
}

async function runScript(generator: Generator, ctx: GeneratorContext): Promise<FigSuggestion[]> {
  const script = typeof generator.script === "function" ? generator.script(ctx.tokens) : generator.script;
  const input = toExecInput(script);
  if (!input) return [];
  if (generator.scriptTimeout !== undefined) input.timeout ??= generator.scriptTimeout;
  const key = JSON.stringify([input.command, input.args, input.cwd ?? ctx.cwd]);
  const ttl = generator.cache?.ttl ?? DEFAULT_TTL_MS;
  const { stdout } = await cached(scriptCache, key, ttl, () => execute(input, ctx));
  if (typeof generator.postProcess === "function") return clean(generator.postProcess(stdout, ctx.tokens));
  return stdout
    .split(generator.splitOn ?? "\n")
    .filter((name) => name.trim().length > 0)
    .map((name) => ({ name }));
}

function runCustom(generator: Generator, ctx: GeneratorContext): Promise<FigSuggestion[]> {
  let cache = customCache.get(generator);
  if (!cache) customCache.set(generator, (cache = new Map()));
  const token = ctx.tokens[ctx.tokens.length - 1] ?? "";
  const key = JSON.stringify([ctx.tokens.slice(0, -1), triggerKey(generator, token), ctx.cwd]);
  return cached(cache, key, generator.cache?.ttl ?? DEFAULT_TTL_MS, async () => {
    const result = await generator.custom!(ctx.tokens, (input) => execute(input, ctx), {
      currentWorkingDirectory: ctx.cwd,
      environmentVariables: ctx.env,
      currentProcess: "zsh",
      sshPrefix: "",
      searchTerm: token,
    });
    return clean(result);
  });
}

/** Runs a script or custom generator. A failing spec yields no suggestions rather than an error. */
export async function runGenerator(generator: Generator, ctx: GeneratorContext): Promise<FigSuggestion[]> {
  try {
    if (typeof generator.custom === "function") return await runCustom(generator, ctx);
    if (generator.script !== undefined) return await runScript(generator, ctx);
  } catch {
    // Specs are third-party code; one that throws must not take the popup down.
  }
  return [];
}

export function hasTemplate(generator: Generator): boolean {
  return toArray(generator.template).length > 0;
}
