import assert from "node:assert/strict";
import { test } from "node:test";
import { RS, US, encodeResult } from "../src/daemon.ts";

test("a reply is one line of separated fields", () => {
  const line = encodeResult(7, { replaceStart: 4, complete: false, items: [{ display: "checkout", description: "Switch branches", kind: "subcommand", insert: "checkout ", cursorBack: 0, matchStart: 0, matchLength: 2, recent: true }] }, true);
  assert.equal(line, ["R", "7", "1", "4", "0"].join(US) + RS + ["checkout", "Switch branches", "s", "checkout ", "0", "0", "2", "1"].join(US));
});

test("control characters cannot break the framing", () => {
  const line = encodeResult(1, { replaceStart: 0, complete: false, items: [{ display: "a\nb", description: `x${US}y${RS}z`, kind: "arg", insert: "a\tb", cursorBack: 2, matchStart: 0, matchLength: 0, recent: false }] }, false);
  assert.equal(line.includes("\n"), false);
  assert.equal(line.split(RS).length, 2);
  assert.equal(line.split(RS)[1]!.split(US).length, 8);
});

test("an empty result still carries its header", () => {
  assert.equal(encodeResult(3, { replaceStart: 9, items: [], complete: true }, true), ["R", "3", "1", "9", "1"].join(US));
});
