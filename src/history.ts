// Feeds the usage store: from commands as they are run, and once from the shell's history file.

import { readFile, stat } from "node:fs/promises";
import { resolve } from "./resolve.ts";
import { commandWordsOf, usageContext } from "./suggest.ts";
import { splitCommands } from "./tokenize.ts";
import { absolutePath, wordKey } from "./usage.ts";
import type { Usage } from "./usage.ts";

const SEED_LINES = 1500;

// Recording only looks things up in the specs. It never runs a command of its own.
const noExec = async () => ({ stdout: "", stderr: "", status: 1 });

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

/**
 * Records every word of a finished command line under the place it was used in, e.g. `checkout`
 * after `git`, and `main` after `git checkout`. With a working directory, words that name an
 * existing file or folder are also recorded by path, which is what ranks `cd` targets.
 */
export async function recordLine(line: string, cwd: string | null, aliases: Map<string, string>, usage: Usage, at = Date.now()): Promise<void> {
  for (const raw of splitCommands(line)) {
    const words = commandWordsOf(raw, aliases);
    for (let i = 1; i < words.length; i++) {
      const word = words[i]!;
      if (word.length === 0) continue;
      const ctx = await resolve(words.slice(0, i), { exec: noExec, cwd: cwd ?? "/", offline: true });
      const isOption = word.startsWith("-");
      const eq = isOption ? word.indexOf("=") : -1;
      usage.record(wordKey(usageContext(ctx), eq > 0 ? word.slice(0, eq) : word), at);
      // Without a working directory (old history lines) only paths that say where they start can be placed.
      const anchored = word.startsWith("/") || word === "~" || word.startsWith("~/");
      if (!isOption && (cwd || anchored)) {
        const absolute = absolutePath(cwd ?? "/", word);
        if (await exists(absolute)) usage.recordPath(absolute, at);
      }
    }
  }
}

export interface HistoryEntry {
  line: string;
  /** Milliseconds since the epoch, or 0 when the file does not say. */
  at: number;
}

/** Reads a zsh history file: plain lines, or the extended `: <time>:<duration>;<command>` form. */
export function parseHistory(raw: Buffer): HistoryEntry[] {
  // zsh stores bytes above 0x82 as a marker byte followed by the byte xor 32.
  const bytes: number[] = [];
  for (let i = 0; i < raw.length; i++) bytes.push(raw[i] === 0x83 && i + 1 < raw.length ? raw[++i]! ^ 0x20 : raw[i]!);
  const text = Buffer.from(bytes).toString("utf8");

  const entries: HistoryEntry[] = [];
  let pending = "";
  for (const physical of text.split("\n")) {
    // A command that spans lines is stored with a backslash before each newline.
    if (physical.endsWith("\\")) {
      pending += `${physical.slice(0, -1)}\n`;
      continue;
    }
    const full = pending + physical;
    pending = "";
    if (full.length === 0) continue;
    const extended = /^: (\d+):\d+;([\s\S]*)$/.exec(full);
    entries.push(extended ? { line: extended[2]!, at: Number(extended[1]) * 1000 } : { line: full, at: 0 });
  }
  return entries;
}

/** Reads the most recent part of the shell's history into the store, once. */
export async function seedFromHistory(file: string, aliases: Map<string, string>, usage: Usage): Promise<number> {
  const raw = await readFile(file).catch(() => null);
  usage.seeded = true;
  if (!raw) return 0;
  const entries = parseHistory(raw).slice(-SEED_LINES);
  // Entries without a time are treated as a month old, so anything used since outranks them.
  const fallback = Date.now() - 30 * 24 * 3_600_000;
  for (const entry of entries) {
    await recordLine(entry.line, null, aliases, usage, entry.at || fallback).catch(() => {});
  }
  usage.save();
  return entries.length;
}
