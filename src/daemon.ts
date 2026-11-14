// The long-lived engine process. Shells connect over a Unix socket and exchange one line per message.
//
// Fields are separated by US (\x1f) and records by RS (\x1e). Newlines inside the command line travel as GS (\x1d).
//
//   shell → engine   H <pid> <PATH> <alias=value RS alias=value …>     hello, once per connection
//                    Q <seq> <cursor> <cwd> <line>                     what would complete here?
//                    I <history file> <history 0|1>                    once per connection, after H
//                    X <cwd> <line>                                    this command line is about to run
//                    D <cwd>                                           the shell changed into this folder
//                    F                                                  forget all recorded history
//                    L                                                  a new prompt started: drop cached generator output
//                    P                                                  ping
//                    S                                                  shut down
//   engine → shell   R <seq> <final 0|1> <replaceStart> <complete 0|1> [RS <display> <description> <kind> <insert> <cursorBack> <matchStart> <matchLength> <recent 0|1>]…
//                    P <pid> <clients>

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { clearGeneratorCache } from "./generators.ts";
import { recordLine, seedFromHistory } from "./history.ts";
import { suggest } from "./suggest.ts";
import { Usage } from "./usage.ts";
import type { Kind, Result } from "./types.ts";

export const US = "\x1f";
export const RS = "\x1e";
export const GS = "\x1d";

const IDLE_EXIT_MS = 30 * 60 * 1000;
const MAX_LINE_BYTES = 1024 * 1024;

const KIND_CODE: Record<Kind, string> = { subcommand: "s", option: "o", arg: "a", file: "f", folder: "d", branch: "b", package: "p" };

export function socketPath(): string {
  if (process.env.SHELLSENSE_SOCK) return process.env.SHELLSENSE_SOCK;
  const state = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(state, "shellsense", "sock");
}

// Control characters would break the framing, and the shell could not display them anyway.
const field = (value: string) => value.replace(/[\x00-\x1f\x7f]/g, " ");

export function encodeResult(seq: number, result: Result, final: boolean): string {
  const head = ["R", seq, final ? 1 : 0, result.replaceStart, result.complete ? 1 : 0].join(US);
  const rows = result.items.map((item) =>
    [field(item.display), field(item.description), KIND_CODE[item.kind], field(item.insert), item.cursorBack, item.matchStart, item.matchLength, item.recent ? 1 : 0].join(US),
  );
  return [head, ...rows].join(RS);
}

interface Client {
  seq: number;
  env: NodeJS.ProcessEnv;
  aliases: Map<string, string>;
  /** False when this shell has turned history off. */
  history: boolean;
}

function isAlive(file: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(file);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

function listen(server: net.Server, file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(file, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

/** Runs the engine until it is told to stop. Resolves immediately if another engine already owns the socket. */
export async function runDaemon(): Promise<void> {
  const file = socketPath();
  // The kernel limit for a Unix socket path is 104 bytes on macOS and 108 on Linux.
  if (Buffer.byteLength(file) > 103) throw new Error(`socket path is too long (${Buffer.byteLength(file)} bytes, limit 103): ${file}`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });

  const server = net.createServer();
  try {
    await listen(server, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    if (await isAlive(file)) return;
    // A previous engine died without cleaning up; take over its socket.
    fs.unlinkSync(file);
    await listen(server, file);
  }
  fs.chmodSync(file, 0o600);

  // What was used before, kept next to the socket. One store for all shells.
  const usage = new Usage(path.join(path.dirname(file), "usage.json"));
  let seeding = false;

  let clients = 0;
  let idle: NodeJS.Timeout | undefined;
  const shutdown = () => {
    usage.save();
    try {
      fs.unlinkSync(file);
    } catch {
      // Already gone.
    }
    process.exit(0);
  };
  const armIdle = () => {
    clearTimeout(idle);
    if (clients === 0) idle = setTimeout(shutdown, IDLE_EXIT_MS);
  };
  armIdle();

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGHUP", () => {});
  // Specs are third-party code. Whatever they throw is logged; the engine keeps serving.
  process.on("uncaughtException", (error) => console.error(new Date().toISOString(), "uncaught", error));
  process.on("unhandledRejection", (error) => console.error(new Date().toISOString(), "unhandled", error));

  server.on("connection", (socket) => {
    clients++;
    armIdle();
    const client: Client = { seq: 0, env: { ...process.env }, aliases: new Map(), history: true };
    const write = (line: string) => {
      if (!socket.destroyed) socket.write(`${line}\n`);
    };

    const handle = (line: string) => {
      const parts = line.split(US);
      switch (parts[0]) {
        case "H": {
          if (parts[2]) client.env = { ...process.env, PATH: parts[2] };
          client.aliases = new Map();
          for (const pair of parts.slice(3).join(US).split(RS)) {
            const eq = pair.indexOf("=");
            if (eq > 0) client.aliases.set(pair.slice(0, eq), pair.slice(eq + 1));
          }
          break;
        }
        case "Q": {
          const seq = Number(parts[1]);
          const cursor = Number(parts[2]);
          const cwd = parts[3] ?? "";
          if (!Number.isInteger(seq) || !Number.isInteger(cursor) || !path.isAbsolute(cwd)) return;
          client.seq = seq;
          const request = {
            line: parts.slice(4).join(US).replaceAll(GS, "\n"),
            cursor,
            cwd,
            env: client.env,
            aliases: client.aliases,
            usage: client.history ? usage : undefined,
          };
          const reply = (result: Result, final: boolean) => {
            // The shell has moved on when a newer query arrived; an old answer would only flicker.
            if (client.seq === seq) write(encodeResult(seq, result, final));
          };
          suggest(request, reply).catch((error) => {
            console.error(new Date().toISOString(), "suggest failed", error);
            reply({ replaceStart: cursor, items: [], complete: true }, true);
          });
          break;
        }
        case "I": {
          client.history = parts[2] !== "0";
          const historyFile = parts[1] ?? "";
          // The first shell to connect brings its history file, so ranking is useful from the start.
          if (client.history && !usage.seeded && !seeding && path.isAbsolute(historyFile)) {
            seeding = true;
            seedFromHistory(historyFile, client.aliases, usage)
              .catch((error) => console.error(new Date().toISOString(), "reading history failed", error))
              .finally(() => (seeding = false));
          }
          break;
        }
        case "X": {
          const cwd = parts[1] ?? "";
          if (!client.history || !path.isAbsolute(cwd)) return;
          recordLine(parts.slice(2).join(US).replaceAll(GS, "\n"), cwd, client.aliases, usage).catch(() => {});
          break;
        }
        case "D":
          if (client.history && parts[1] && path.isAbsolute(parts[1])) usage.recordPath(parts[1]);
          break;
        case "F":
          usage.clear();
          break;
        case "L":
          clearGeneratorCache();
          break;
        case "P":
          write(["P", process.pid, clients].join(US));
          break;
        case "S":
          shutdown();
          break;
      }
    };

    let buffered = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        handle(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
      }
      if (buffered.length > MAX_LINE_BYTES) socket.destroy();
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      client.seq = -1;
      clients--;
      armIdle();
    });
  });

  await new Promise<void>(() => {});
}
