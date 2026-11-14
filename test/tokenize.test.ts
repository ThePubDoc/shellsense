import assert from "node:assert/strict";
import { test } from "node:test";
import { splitCommands, tokenize } from "../src/tokenize.ts";

const words = (input: string) => tokenize(input).tokens.map((t) => t.text);
const current = (input: string) => tokenize(input).current;

test("splits completed words from the word under the cursor", () => {
  assert.deepEqual(words("git commit -m"), ["git", "commit"]);
  assert.equal(current("git commit -m").text, "-m");
  assert.equal(current("git commit -m").start, 11);
});

test("a trailing space starts a new, empty word at the cursor", () => {
  assert.deepEqual(words("git commit "), ["git", "commit"]);
  assert.deepEqual(current("git commit "), { text: "", start: 11, quote: "", redirect: false });
});

test("quotes and escapes are removed from the text but the word starts at its quote", () => {
  assert.deepEqual(words(`cat "my file" 'a b' c\\ d `), ["cat", "my file", "a b", "c d"]);
  const open = current('cat "my fi');
  assert.equal(open.text, "my fi");
  assert.equal(open.start, 4);
  assert.equal(open.quote, '"');
});

test("only the command after the last separator counts", () => {
  assert.deepEqual(words("cd src && git "), ["git"]);
  assert.deepEqual(words("ls | grep foo; docker ps "), ["docker", "ps"]);
  assert.deepEqual(words('echo "$(git '), ["git"]);
  assert.deepEqual(words("echo `git log "), ["git", "log"]);
});

test("redirect targets are marked and left out of the command", () => {
  assert.deepEqual(words("ls -l > out.txt 2>&1 "), ["ls", "-l"]);
  assert.equal(current("sort < inp").redirect, true);
  assert.equal(current("sort < inp").text, "inp");
  assert.equal(current("make 2> ").redirect, true);
});

test("leading variable assignments are not the command", () => {
  assert.deepEqual(words("FOO=1 BAR=2 npm run "), ["npm", "run"]);
});

test("a finished line is split into every command on it", () => {
  assert.deepEqual(splitCommands("cd src && git status"), [
    ["cd", "src"],
    ["git", "status"],
  ]);
  assert.deepEqual(splitCommands('FOO=1 npm run "my script" | tee out.log > /dev/null; ls'), [["npm", "run", "my script"], ["tee", "out.log"], ["ls"]]);
  assert.deepEqual(splitCommands(""), []);
});
