// File and folder suggestions for the `filepaths` and `folders` templates.

import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Quote } from "./tokenize.ts";

export interface FileEntry {
  /** Entry name, with a trailing slash for folders. */
  name: string;
  isDir: boolean;
}

export interface FileListing {
  /** The part of the token up to and including the last slash, exactly as typed. */
  dirPart: string;
  /** The part after the last slash: what the entry names are matched against. */
  query: string;
  entries: FileEntry[];
}

const MAX_ENTRIES = 2000;
const CACHE_MS = 1000;
const cache = new Map<string, { at: number; entries: Promise<FileEntry[]> }>();

export function expandHome(dir: string): string {
  if (dir === "~" || dir.startsWith("~/")) return path.join(os.homedir(), dir.slice(1));
  return dir;
}

async function readEntries(dir: string): Promise<FileEntry[]> {
  const dirents = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const entries = await Promise.all(
    dirents.slice(0, MAX_ENTRIES).map(async (entry) => {
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        isDir = await stat(path.join(dir, entry.name)).then(
          (info) => info.isDirectory(),
          () => false,
        );
      }
      return { name: isDir ? `${entry.name}/` : entry.name, isDir };
    }),
  );
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/** Lists the directory that the typed token points into. */
export async function listFiles(token: string, cwd: string, foldersOnly: boolean): Promise<FileListing> {
  const slash = token.lastIndexOf("/");
  const dirPart = slash >= 0 ? token.slice(0, slash + 1) : "";
  const query = token.slice(slash + 1);
  const dir = path.resolve(cwd, expandHome(dirPart) || ".");

  const now = Date.now();
  let cached = cache.get(dir);
  if (!cached || now - cached.at > CACHE_MS) {
    if (cache.size > 64) cache.clear();
    cached = { at: now, entries: readEntries(dir) };
    cache.set(dir, cached);
  }
  let entries = await cached.entries;
  // Dotfiles stay hidden until the user types the dot, as in `ls`.
  if (!query.startsWith(".")) entries = entries.filter((entry) => !entry.name.startsWith("."));
  if (foldersOnly) entries = entries.filter((entry) => entry.isDir);
  return { dirPart, query, entries };
}

const SHELL_SPECIAL = /[\s'"\\$`!&|;<>()*?[\]#{}~^=]/g;

/** Quotes a path for insertion, keeping the quote style the user already opened. */
export function quotePath(value: string, quote: Quote, closeQuote: boolean): string {
  if (quote === "'") return `'${value.replaceAll("'", "'\\''")}${closeQuote ? "'" : ""}`;
  if (quote === '"') return `"${value.replace(/["\\$`]/g, "\\$&")}${closeQuote ? '"' : ""}`;
  // A leading tilde must stay unescaped so the shell still expands it.
  const home = value === "~" || value.startsWith("~/") ? "~" : "";
  return home + value.slice(home.length).replace(SHELL_SPECIAL, "\\$&");
}
