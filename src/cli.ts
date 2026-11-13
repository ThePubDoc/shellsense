#!/usr/bin/env node
// shellsense command line: start and stop the engine, print shell setup, and query the engine by hand.

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { US, runDaemon, socketPath } from "./daemon.ts";
import { setup, uninstall } from "./setup.ts";
import { suggestOnce } from "./suggest.ts";

const self = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(self), "..");

const USAGE = `shellsense — autocomplete popup for the terminal

  shellsense setup             turn the popup on: adds one line to ~/.zshrc
  shellsense uninstall         turn it off again: removes that line and stops the engine
  shellsense status            show whether the engine is running
  shellsense stop              stop the engine (the next prompt starts a fresh one)
  shellsense suggest <line>    print what would be suggested at the end of <line>
  shellsense init zsh          print the line that loads the popup, to place it yourself
  shellsense daemon [--foreground]   start the engine (shells do this themselves)
`;

/** Sends one message to the engine and resolves with its one-line reply, or null if nothing is listening. */
function ask(message: string, expectReply: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath());
    let reply = "";
    socket.setEncoding("utf8");
    socket.once("error", () => resolve(null));
    socket.once("connect", () => {
      socket.write(`${message}\n`);
      if (!expectReply) socket.end(() => resolve(""));
    });
    socket.on("data", (chunk: string) => {
      reply += chunk;
      if (reply.includes("\n")) {
        socket.destroy();
        resolve(reply.slice(0, reply.indexOf("\n")));
      }
    });
    socket.once("close", () => resolve(reply || null));
  });
}

function startDetached(): void {
  const dir = path.dirname(socketPath());
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const log = fs.openSync(path.join(dir, "daemon.log"), "a");
  // A new session keeps the engine alive when the shell that started it exits, and out of reach of its Ctrl-C.
  const child = spawn(process.execPath, [...process.execArgv, self, "daemon", "--foreground"], {
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "daemon":
      if (args.includes("--foreground")) await runDaemon();
      else startDetached();
      return 0;

    case "setup":
      return setup(root);

    case "uninstall": {
      const code = uninstall();
      await ask("S", false);
      return code;
    }

    case "init":
      if (args[0] !== "zsh") {
        console.error("shellsense: only zsh is supported so far");
        return 1;
      }
      console.log(`source ${JSON.stringify(path.join(root, "shell", "shellsense.zsh"))}`);
      return 0;

    case "status": {
      const reply = await ask("P", true);
      if (reply === null) {
        console.log(`engine: not running (socket ${socketPath()})`);
        return 1;
      }
      const [, pid, clients] = reply.split(US);
      console.log(`engine: running, pid ${pid}, ${clients} connection(s) including this one (socket ${socketPath()})`);
      return 0;
    }

    case "stop": {
      const reply = await ask("S", false);
      console.log(reply === null ? "engine: not running" : "engine: stopped");
      return 0;
    }

    case "suggest": {
      const line = args[0];
      if (line === undefined) {
        console.error("usage: shellsense suggest <line>");
        return 1;
      }
      const result = await suggestOnce({ line, cursor: Array.from(line).length, cwd: process.cwd(), env: process.env, aliases: new Map() });
      for (const item of result.items) {
        console.log([item.kind.padEnd(10), item.display.padEnd(28), JSON.stringify(item.insert).padEnd(30), item.description].join(" "));
      }
      console.error(`${result.items.length} suggestion(s), replacing from column ${result.replaceStart}; Enter would ${result.complete ? "run the line" : "insert the first row"}`);
      return 0;
    }

    default:
      process.stdout.write(USAGE);
      return command === undefined || command === "help" || command === "--help" ? 0 : 1;
  }
}

process.exitCode = await main();
// Generators may leave timers or child processes behind; a one-shot command should not wait for them.
if (process.argv[2] !== "daemon" || !process.argv.includes("--foreground")) process.exit();
