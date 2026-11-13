// Loads completion specs from the @withfig/autocomplete package, one file per command, on demand.

import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Subcommand } from "./types.ts";

const require = createRequire(import.meta.url);

let buildDir: string | undefined;
function specDir(): string {
  // The package only exports its index, so resolve that and take its directory.
  buildDir ??= path.dirname(require.resolve("@withfig/autocomplete"));
  return buildDir;
}

async function importFile(relative: string): Promise<Record<string, unknown> | null> {
  try {
    return (await import(pathToFileURL(path.join(specDir(), relative)).href)) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") return null;
    throw error;
  }
}

let index: Promise<Set<string>> | undefined;

/** Names of every spec in the package, e.g. `git` or `aws/s3`. */
export function specNames(): Promise<Set<string>> {
  index ??= importFile("index.js").then((mod) => new Set((mod?.default as string[] | undefined) ?? []));
  return index;
}

const cache = new Map<string, Promise<Subcommand | null>>();

async function load(name: string): Promise<Subcommand | null> {
  // Only names from the index are loaded, so a typed word can never become an arbitrary path.
  if (!(await specNames()).has(name)) return null;
  const mod = (await importFile(`${name}.js`)) ?? (await importFile(`${name}/index.js`));
  let spec: unknown = mod?.default;
  if (typeof spec === "function") spec = await (spec as () => unknown)();
  if (!spec || typeof spec !== "object") return null;
  return spec as Subcommand;
}

/** Returns the spec for a command, or null when there is none or it fails to load. */
export function loadSpec(name: string): Promise<Subcommand | null> {
  let entry = cache.get(name);
  if (!entry) {
    entry = load(name).catch(() => null);
    cache.set(name, entry);
  }
  return entry;
}

/** Turns the first word of a command line into a spec name: `/usr/bin/git` and `\git` both mean `git`. */
export function commandName(word: string): string {
  const base = word.startsWith("\\") ? word.slice(1) : word;
  const slash = base.lastIndexOf("/");
  return slash >= 0 ? base.slice(slash + 1) : base;
}
