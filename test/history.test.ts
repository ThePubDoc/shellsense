import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { parseHistory, recordLine, seedFromHistory } from "../src/history.ts";
import { suggestOnce } from "../src/suggest.ts";
import { Usage, wordKey } from "../src/usage.ts";

let dir: string;
const none = new Map<string, string>();

before(() => {
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "shellsense-history-")));
  for (const name of ["alpha", "beta", "gamma"]) mkdirSync(path.join(dir, name));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init");
  git("branch", "aaa-first");
  git("branch", "zzz-last");
});

after(() => rmSync(dir, { recursive: true, force: true }));

async function rowsFor(line: string, usage?: Usage) {
  const result = await suggestOnce({ line, cursor: Array.from(line).length, cwd: dir, env: process.env, aliases: none, usage });
  return result.items;
}

test("a subcommand that was run is offered first", async () => {
  const usage = new Usage(null);
  assert.notEqual((await rowsFor("git ", usage))[0]?.display, "stash");
  await recordLine("git stash", dir, none, usage);
  const rows = await rowsFor("git ", usage);
  assert.equal(rows[0]?.display, "stash");
  assert.equal(rows[0]?.recent, true);
  assert.equal(rows[1]?.recent, false);
});

test("a value is remembered for the place it was used in", async () => {
  const usage = new Usage(null);
  await recordLine("git checkout zzz-last", dir, none, usage);
  assert.equal((await rowsFor("git checkout ", usage))[0]?.display, "zzz-last");
  // The same word after a different subcommand was never used, so it gets no lift there.
  assert.equal((await rowsFor("git merge ", usage)).find((row) => row.display === "zzz-last")?.recent ?? false, false);
});

test("a folder that was entered ranks above its neighbours", async () => {
  const usage = new Usage(null);
  assert.equal((await rowsFor("cd ", usage))[0]?.display, "alpha/");
  await recordLine("cd gamma", dir, none, usage);
  const rows = await rowsFor("cd ", usage);
  assert.equal(rows[0]?.display, "gamma/");
  assert.equal(rows[0]?.recent, true);
});

test("going deep into a path marks every folder on the way", async () => {
  mkdirSync(path.join(dir, "gamma", "inner", "deep"), { recursive: true });
  mkdirSync(path.join(dir, "gamma", "aside"));
  const usage = new Usage(null);
  await recordLine("cd gamma/inner/deep/", dir, none, usage);
  // Typed one piece at a time, each level leads with the folder that was passed through.
  assert.equal((await rowsFor("cd ", usage))[0]?.display, "gamma/");
  const second = await rowsFor("cd gamma/", usage);
  assert.deepEqual(
    second.map((row) => [row.display, row.recent]),
    [
      [".", false],
      ["inner/", true],
      ["aside/", false],
    ],
  );
  assert.equal((await rowsFor("cd gamma/inner/", usage))[1]?.display, "deep/");
});

test("what was typed still decides first: history only orders equal matches", async () => {
  const usage = new Usage(null);
  await recordLine("git stash", dir, none, usage);
  assert.deepEqual(
    (await rowsFor("git ch", usage)).map((row) => row.display),
    ["checkout", "cherry-pick"],
  );
});

test("every command on a line is recorded, and more recent use wins", async () => {
  const usage = new Usage(null);
  const twoHoursAgo = Date.now() - 2 * 3_600_000;
  await recordLine("cd alpha && git stash", dir, none, usage, twoHoursAgo);
  await recordLine("git tag", dir, none, usage);
  const rows = (await rowsFor("git ", usage)).map((row) => row.display);
  assert.deepEqual(rows.slice(0, 2), ["tag", "stash"]);
  assert.equal((await rowsFor("cd ", usage))[0]?.display, "alpha/");
});

test("the store keeps hashes, never the words themselves", async () => {
  const file = path.join(dir, "usage.json");
  const usage = new Usage(file);
  await recordLine("curl -H secret-token-12345 https://example.invalid/private", dir, none, usage);
  usage.save();
  const saved = readFileSync(file, "utf8");
  assert.equal(saved.includes("secret-token-12345"), false);
  assert.equal(saved.includes("example.invalid"), false);
  // A second store reading the file knows the same things.
  assert.ok(new Usage(file).size > 0);
  usage.clear();
  assert.equal(new Usage(file).size, 0);
});

test("the same word in the same place always gives the same key", () => {
  assert.equal(wordKey("git", "checkout"), wordKey("git", "checkout"));
  assert.notEqual(wordKey("git", "checkout"), wordKey("git checkout", "checkout"));
  assert.match(wordKey("git", "checkout"), /^[0-9a-f]{16}$/);
});

test("zsh history files are read in both formats", () => {
  const plain = parseHistory(Buffer.from("git status\nls -la\n"));
  assert.deepEqual(plain, [
    { line: "git status", at: 0 },
    { line: "ls -la", at: 0 },
  ]);
  const extended = parseHistory(Buffer.from(": 1700000000:0;git commit -m 'one'\n: 1700000100:3;echo a \\\nb\n"));
  assert.deepEqual(extended, [
    { line: "git commit -m 'one'", at: 1700000000000 },
    { line: "echo a \nb", at: 1700000100000 },
  ]);
});

test("the history file seeds the store once", async () => {
  const file = path.join(dir, "zsh_history");
  writeFileSync(file, ": 1700000000:0;git stash\n: 1700000050:0;git stash pop\n");
  const usage = new Usage(null);
  assert.equal(await seedFromHistory(file, none, usage), 2);
  assert.equal(usage.seeded, true);
  assert.equal((await rowsFor("git ", usage))[0]?.display, "stash");
  assert.equal(await seedFromHistory(path.join(dir, "missing"), none, new Usage(null)), 0);
});
