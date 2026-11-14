// Remembers what was used and when, so that it can be offered first next time.
//
// Nothing readable is kept. A command line can hold anything, secrets included, so every entry
// is stored as a hash with a count and a time. A hash is enough to answer the only question
// ranking asks: "was this row used here before?"

import fs from "node:fs";
import path from "node:path";
import { expandHome } from "./files.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_ENTRIES = 20_000;
const SAVE_DELAY_MS = 2000;

function fnv1a(text: string, seed: number): number {
  let h = seed;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A 64-bit fingerprint of the parts, as 16 hex digits. */
function fingerprint(...parts: string[]): string {
  const text = parts.join("\x00");
  return fnv1a(text, 0x811c9dc5).toString(16).padStart(8, "0") + fnv1a(`${text}\x01`, 0x9747b28c).toString(16).padStart(8, "0");
}

/** Key for a word used in a context, e.g. `checkout` after `git`. */
export function wordKey(context: string, word: string): string {
  return fingerprint("w", context, word);
}

/** Key for a file or folder, by its absolute path. */
export function pathKey(absolute: string): string {
  return fingerprint("p", absolute);
}

/** The absolute path a typed word refers to, without a trailing slash. */
export function absolutePath(cwd: string, word: string): string {
  return path.resolve(cwd, expandHome(word));
}

export class Usage {
  private entries = new Map<string, [count: number, last: number]>();
  private timer: NodeJS.Timeout | undefined;
  private readonly file: string | null;
  /** Whether the shell's history file has already been read into this store. */
  seeded = false;

  /** Pass null for a store that lives in memory only. */
  constructor(file: string | null) {
    this.file = file;
    if (!file) return;
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8")) as { seeded?: boolean; entries?: Record<string, [number, number]> };
      this.seeded = saved.seeded === true;
      for (const [key, value] of Object.entries(saved.entries ?? {})) {
        if (Array.isArray(value) && typeof value[0] === "number" && typeof value[1] === "number") this.entries.set(key, [value[0], value[1]]);
      }
    } catch {
      // No file yet, or one that cannot be read: start empty.
    }
  }

  record(key: string, at = Date.now()): void {
    const entry = this.entries.get(key);
    if (entry) {
      entry[0]++;
      if (at > entry[1]) entry[1] = at;
    } else this.entries.set(key, [1, at]);
    this.scheduleSave();
  }

  /**
   * Records a file or folder, and every folder on the way to it. Going to
   * `Desktop/work/api` is also a visit to `Desktop` and to `Desktop/work`, which is what puts
   * each of them first while the path is typed one piece at a time.
   */
  recordPath(absolute: string, at = Date.now()): void {
    let current = path.resolve(absolute);
    while (current !== path.dirname(current)) {
      this.record(pathKey(current), at);
      current = path.dirname(current);
    }
  }

  /** Zero for something never used; higher for used more often and more recently. */
  score(key: string, now = Date.now()): number {
    const entry = this.entries.get(key);
    if (!entry) return 0;
    const age = now - entry[1];
    const recency = age < HOUR ? 8 : age < DAY ? 4 : age < 7 * DAY ? 2 : age < 30 * DAY ? 1 : 0.5;
    return (1 + Math.log(entry[0])) * recency;
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
    this.seeded = false;
    clearTimeout(this.timer);
    if (this.file) fs.rmSync(this.file, { force: true });
  }

  private scheduleSave(): void {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.save();
    }, SAVE_DELAY_MS);
    this.timer.unref();
  }

  save(): void {
    if (!this.file) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.entries.size > MAX_ENTRIES) {
      // Keep the most recently used entries.
      const kept = [...this.entries].sort((a, b) => b[1][1] - a[1][1]).slice(0, Math.floor(MAX_ENTRIES * 0.8));
      this.entries = new Map(kept);
    }
    try {
      const temporary = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, seeded: this.seeded, entries: Object.fromEntries(this.entries) }), { mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } catch {
      // History is a convenience; failing to save it must not disturb anything else.
    }
  }
}
