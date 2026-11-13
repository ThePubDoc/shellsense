// `shellsense setup` and `shellsense uninstall`: add or remove the line in ~/.zshrc that loads the popup.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BEGIN = "# >>> shellsense >>>";
const END = "# <<< shellsense <<<";

function zshrcPath(): string {
  return path.join(process.env.ZDOTDIR || os.homedir(), ".zshrc");
}

/** The managed block. The guard keeps a shell from printing an error if shellsense is later removed or moved. */
function block(script: string): string {
  const quoted = JSON.stringify(script);
  return `${BEGIN}\n[[ -f ${quoted} ]] && source ${quoted}\n${END}\n`;
}

/** Returns the file without the managed block, and whether there was one. */
function strip(content: string): { rest: string; found: boolean } {
  const begin = content.indexOf(BEGIN);
  const end = content.indexOf(END);
  if (begin < 0 || end < begin) return { rest: content, found: false };
  const after = content.slice(end + END.length).replace(/^\n/, "");
  return { rest: content.slice(0, begin).replace(/\n+$/, "\n") + after, found: true };
}

function zshVersion(): string | null {
  try {
    return execFileSync("zsh", ["-c", "print -r -- $ZSH_VERSION"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function olderThan(version: string, major: number, minor: number): boolean {
  const [a = 0, b = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
  return a < major || (a === major && b < minor);
}

export function setup(root: string): number {
  const script = path.join(root, "shell", "shellsense.zsh");
  const file = zshrcPath();
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const { rest, found } = strip(existing);
  const separator = rest.length === 0 || rest.endsWith("\n\n") ? "" : rest.endsWith("\n") ? "\n" : "\n\n";
  fs.writeFileSync(file, rest + separator + block(script));

  console.log(`${found ? "Updated" : "Added"} the shellsense block in ${file}`);
  const zsh = zshVersion();
  if (zsh === null) console.log("Warning: zsh was not found. shellsense only works in zsh for now.");
  else if (olderThan(zsh, 5, 9)) console.log(`Warning: zsh ${zsh} is too old. shellsense needs zsh 5.9 or later.`);
  console.log("Open a new terminal, type `git ` and a letter, and the popup appears.");
  console.log("To remove it again: shellsense uninstall");
  return 0;
}

export function uninstall(): number {
  const file = zshrcPath();
  if (!fs.existsSync(file)) {
    console.log(`Nothing to remove: ${file} does not exist.`);
    return 0;
  }
  const { rest, found } = strip(fs.readFileSync(file, "utf8"));
  if (found) fs.writeFileSync(file, rest);
  console.log(found ? `Removed the shellsense block from ${file}` : `No shellsense block in ${file}`);
  console.log("Shells that are already open keep the popup until they are closed.");
  return 0;
}
