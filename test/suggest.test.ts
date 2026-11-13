import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { suggestOnce } from "../src/suggest.ts";

let dir: string;

before(() => {
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "shellsense-test-")));
  mkdirSync(path.join(dir, "src"));
  mkdirSync(path.join(dir, "docs"));
  mkdirSync(path.join(dir, ".hidden"));
  mkdirSync(path.join(dir, "my folder"));
  writeFileSync(path.join(dir, "README.md"), "");
  writeFileSync(path.join(dir, "my file.txt"), "");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init");
  git("branch", "feature/login");
});

after(() => rmSync(dir, { recursive: true, force: true }));

async function run(line: string, aliases: Record<string, string> = {}) {
  const result = await suggestOnce({
    line,
    cursor: Array.from(line).length,
    cwd: dir,
    env: process.env,
    aliases: new Map(Object.entries(aliases)),
  });
  return { ...result, names: result.items.map((item) => item.display), find: (name: string) => result.items.find((item) => item.display === name) };
}

test("subcommands are matched by prefix and replace the typed word", async () => {
  const r = await run("git ch");
  assert.deepEqual(r.names, ["checkout", "cherry-pick"]);
  assert.equal(r.replaceStart, 4);
  assert.equal(r.find("checkout")?.insert, "checkout ");
  assert.equal(r.find("checkout")?.kind, "subcommand");
});

test("nothing is offered while the command name is being typed", async () => {
  assert.deepEqual((await run("gi")).names, []);
  assert.deepEqual((await run("")).names, []);
});

test("options insert the form that matches what was typed", async () => {
  assert.equal((await run("git commit -")).find("-m, --message")?.insert, "-m ");
  assert.equal((await run("git commit --me")).find("-m, --message")?.insert, "--message ");
});

test("an option already on the line is not offered again", async () => {
  assert.ok((await run("git commit -")).find("-a, --all"));
  assert.equal((await run("git commit -a -")).find("-a, --all"), undefined);
  assert.equal((await run("git commit --all -")).find("-a, --all"), undefined);
});

test("generators run in the working directory", async () => {
  const r = await run("git checkout fea");
  assert.equal(r.find("feature/login")?.insert, "feature/login ");
});

test("folders stay open for further typing and dotfiles need a dot", async () => {
  const r = await run("cd ");
  assert.equal(r.find("src/")?.insert, "src/");
  assert.equal(r.find("src/")?.kind, "folder");
  assert.equal(r.find("README.md"), undefined);
  assert.equal(r.find(".hidden/"), undefined);
  assert.ok((await run("cd .")).find(".hidden/"));
  assert.equal(r.find("my folder/")?.insert, "my\\ folder/");
  assert.equal((await run("cd src/../do")).find("docs/")?.insert, "src/../docs/");
});

test("file names are escaped, or quoted the way the user started", async () => {
  assert.equal((await run("cat my")).find("my file.txt")?.insert, "my\\ file.txt ");
  assert.equal((await run('cat "my')).find("my file.txt")?.insert, '"my file.txt" ');
  assert.equal((await run("cat docs/")).replaceStart, 4);
});

test("an unknown command falls back to files, as does a redirect", async () => {
  assert.ok((await run("some-unknown-tool RE")).find("README.md"));
  assert.ok((await run("git log > RE")).find("README.md"));
});

test("aliases are expanded before the spec is looked up", async () => {
  const r = await run("gco -", { gco: "git checkout" });
  assert.ok(r.find("-b"));
  assert.equal(r.replaceStart, 4);
});

test("a command after sudo is completed with its own spec", async () => {
  assert.deepEqual((await run("sudo git ch")).names, ["checkout", "cherry-pick"]);
});

test("only the command after a separator is completed", async () => {
  const r = await run("cd src && git ch");
  assert.deepEqual(r.names, ["checkout", "cherry-pick"]);
  assert.equal(r.replaceStart, 14);
});

test("positions are counted in characters, not UTF-16 units", async () => {
  const r = await run("echo 😀 && git ch");
  assert.equal(r.replaceStart, 14);
});

test("inside a typed folder the first row stands for that folder", async () => {
  mkdirSync(path.join(dir, "src", "lib"), { recursive: true });
  const r = await run("cd src/");
  assert.deepEqual(r.names, [".", "lib/"]);
  assert.equal(r.items[0]?.insert, "src/");
  assert.equal(r.find("lib/")?.insert, "src/lib/");
  // Files can follow too, so there is no "stay here" row there.
  assert.equal((await run("ls docs/../")).find("."), undefined);
});

test("complete is true only when the typed word already is one of the rows", async () => {
  assert.equal((await run("git ch")).complete, false);
  assert.equal((await run("cd sr")).complete, false);
  assert.equal((await run("cd ")).complete, false);
  assert.equal((await run("git status ")).complete, false);
  assert.equal((await run("git checkout feature/")).complete, false);
  assert.equal((await run("cd src")).complete, true);
  assert.equal((await run("git commit -a")).complete, true);
});

test("rows say what kind of thing they are and which part was typed", async () => {
  const branch = (await run("git checkout fea")).find("feature/login");
  assert.equal(branch?.kind, "branch");
  assert.deepEqual([branch?.matchStart, branch?.matchLength], [0, 3]);
  const option = (await run("git commit --me")).find("-m, --message");
  assert.deepEqual([option?.matchStart, option?.matchLength], [4, 4]);
  assert.equal((await run("git commit -")).find("-m, --message")?.kind, "option");
  assert.equal((await run("cat ")).find("README.md")?.matchLength, 0);
});

test("a row that only repeats the finished word is dropped", async () => {
  assert.deepEqual((await run("git cherry-pick")).names, []);
});
