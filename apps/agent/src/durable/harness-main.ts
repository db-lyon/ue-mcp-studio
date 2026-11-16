/**
 * The durable harness: one long-lived process per project that owns the
 * project's Pi Durable storage and runs every durable conversation. Started
 * detached by a daemon, it outlives every daemon: clients connect to it (the
 * daemon serves its tool calls and credentials), and what waits for a daemon
 * waits until the next one connects.
 *
 * It runs the Studio version it was started with. A newer Studio's daemon
 * hands it that Studio's extension, which is installed over the running one,
 * so calls from then on run the new code; once idle it exits, and the next
 * daemon starts the newer harness.
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { DurableEngine, type ExtensionFactory } from "./pi.js";
import { createStudioExtension } from "./extension.js";
import {
  DURABLE_PROTOCOL,
  logFile,
  recordFile,
  storageFile,
  telemetryFile,
  type ClientMessage,
  type HarnessLaunch,
  type HarnessMessage,
  type HarnessRecord,
  type HarnessRequest,
} from "./protocol.js";
import { onLines, sendLine, writeJsonAtomic } from "../turn-host-protocol.js";

/** How long the harness stays with no daemon connected and nothing to run. */
const IDLE_EXIT_MS = 10 * 60_000;

interface Pending {
  req: HarnessRequest;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  onStarted?: () => Promise<void>;
  /** The daemon was told to go: whatever it ran, a later daemon cannot know the outcome. */
  went: boolean;
}

export async function runHarness(launch: HarnessLaunch): Promise<{ close(): Promise<void> }> {
  const log = (text: string): void => {
    try {
      fs.appendFileSync(logFile(launch.dataDir), `${new Date().toISOString()} ${text}\n`);
    } catch {
      // Nowhere to write it.
    }
  };
  if (launch.claudeCommand) process.env.PI_CLAUDE_CODE_COMMAND = launch.claudeCommand;
  const clients = new Set<net.Socket>();
  let daemon: net.Socket | null = null;
  const pending = new Map<string, Pending>();
  let seq = 0;
  let extensionVersion = launch.version;
  let lastDaemonAt = Date.now();

  const emit = (msg: HarnessMessage): void => {
    for (const c of clients) sendLine(c, msg);
  };
  const send = (p: { reqId: string } & Pending): void => {
    const req = p.req.kind === "tool" ? { ...p.req, started: p.req.started || p.went } : p.req;
    sendLine(daemon, { t: "req", reqId: p.reqId, req } satisfies HarnessMessage);
  };

  const engine = await DurableEngine.open(storageFile(launch.dataDir), {
    log,
    emit,
    request: (req, onStarted, signal) => new Promise((resolve, reject) => {
      const reqId = `r${Date.now().toString(36)}-${++seq}`;
      const p: Pending = { req, resolve, reject, onStarted, went: false };
      pending.set(reqId, p);
      signal?.addEventListener("abort", () => {
        if (!pending.delete(reqId)) return;
        emit({ t: "cancel", reqId });
        reject(new Error("aborted"));
      }, { once: true });
      if (daemon) send({ reqId, ...p });
    }),
  }, telemetryFile(launch.dataDir));
  engine.install(createStudioExtension as unknown as ExtensionFactory);

  const ret = (sock: net.Socket, id: string, work: () => Promise<unknown>): void => {
    void work().then(
      (value) => sendLine(sock, { t: "ret", id, ok: true, value: value ?? null } satisfies HarnessMessage),
      (e: unknown) => {
        log(`request ${id} failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
        sendLine(sock, { t: "ret", id, ok: false, error: e instanceof Error ? e.message : String(e) } satisfies HarnessMessage);
      },
    );
  };

  /** A newer Studio's extension, installed over the running one. */
  const installFrom = async (ext: { version: string; file: string }): Promise<void> => {
    if (ext.version === extensionVersion) return;
    try {
      const mod = (await import(pathToFileURL(ext.file).href)) as { createStudioExtension?: ExtensionFactory };
      if (typeof mod.createStudioExtension !== "function") throw new Error("it has no createStudioExtension");
      engine.install(mod.createStudioExtension);
      extensionVersion = ext.version;
      log(`installed Studio ${ext.version}'s extension over ${launch.version}'s`);
    } catch (e) {
      log(`could not install Studio ${ext.version}'s extension: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handle = (sock: net.Socket, msg: ClientMessage): void => {
    switch (msg.t) {
      case "submit":
        return ret(sock, msg.id, () => engine.submit(msg.sessionId, msg.requestId, msg.content, msg.agent, msg.whenBusy));
      case "seed":
        return ret(sock, msg.id, () => engine.seed(msg.sessionId, msg.messages));
      case "abort":
        return ret(sock, msg.id, () => engine.abort(msg.sessionId, msg.children));
      case "stopChild":
        return ret(sock, msg.id, () => engine.stopChild(msg.sessionId, msg.callId));
      case "background":
        return ret(sock, msg.id, () => engine.background(msg.sessionId));
      case "tell":
        return ret(sock, msg.id, () => engine.tell(msg.sessionId, msg.callId, msg.text, msg.requestId));
      case "sync":
        return ret(sock, msg.id, () => engine.sync(msg.sessionId, msg.after));
      case "compact":
        return ret(sock, msg.id, () => engine.compact(msg.sessionId, msg.instructions));
      case "assign":
        return ret(sock, msg.id, () => engine.assign(msg.sessionId, msg.callId, msg.start));
      case "fork":
        return ret(sock, msg.id, () => engine.fork(msg.from, msg.to, msg.text, msg.fromEnd));
      case "inspect":
        return ret(sock, msg.id, async () => ({ version: launch.version, pid: process.pid, extension: extensionVersion, ...(await engine.inspect()) }));
      case "traces":
        return ret(sock, msg.id, () => (msg.traceId ? engine.trace(msg.traceId) : engine.traces(msg.filter)));
      case "res": {
        const p = pending.get(msg.reqId);
        if (!p) return;
        pending.delete(msg.reqId);
        p.resolve(msg.value);
        return;
      }
      case "started": {
        // Recorded before the daemon may run it, so a harness restart never runs it again.
        const p = pending.get(msg.reqId);
        if (!p) return;
        void (p.onStarted?.() ?? Promise.resolve()).then(() => {
          p.went = true;
          sendLine(sock, { t: "go", reqId: msg.reqId });
        }, (e: unknown) => log(`could not record that ${msg.reqId} started: ${e instanceof Error ? e.message : String(e)}`));
        return;
      }
      default:
        return;
    }
  };

  const server = net.createServer((sock) => {
    let authed = false;
    onLines(sock, (raw) => {
      const msg = raw as unknown as ClientMessage;
      if (!authed) {
        if (msg.t !== "hello" || msg.token !== launch.token) {
          sendLine(sock, { t: "refused", why: "bad token" } satisfies HarnessMessage);
          sock.end();
          return;
        }
        authed = true;
        clients.add(sock);
        sendLine(sock, { t: "hello", protocol: DURABLE_PROTOCOL, version: launch.version, pid: process.pid, extension: extensionVersion, features: ["usage", "abortSettles", "traces"] } satisfies HarnessMessage);
        if (msg.role === "daemon") {
          daemon = sock;
          lastDaemonAt = Date.now();
          log(`daemon connected (Studio ${msg.version})`);
          if (msg.extension) void installFrom(msg.extension);
          // What waited for a daemon goes to this one.
          for (const [reqId, p] of pending) send({ reqId, ...p });
        }
        return;
      }
      handle(sock, msg);
    }, (e) => log(`a client message failed: ${e instanceof Error ? e.message : String(e)}`));
    const gone = () => {
      clients.delete(sock);
      if (daemon === sock) {
        daemon = null;
        lastDaemonAt = Date.now();
        log("daemon disconnected");
      }
    };
    sock.on("close", gone);
    sock.on("error", gone);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(launch.socket, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const record: HarnessRecord = { protocol: DURABLE_PROTOCOL, version: launch.version, pid: process.pid, socket: launch.socket, token: launch.token, startedAt: new Date().toISOString() };
  writeJsonAtomic(recordFile(launch.dataDir), record);
  log(`harness ${process.pid} listening (Studio ${launch.version})`);
  await engine.resume();

  // Exit when nothing is left to do: no daemon for a while and nothing running, or a newer Studio waits to start its own.
  const timer = setInterval(() => {
    const idle = !engine.active() && pending.size === 0;
    const newer = extensionVersion !== launch.version;
    if (idle && ((!daemon && Date.now() - lastDaemonAt > IDLE_EXIT_MS) || newer)) {
      clearInterval(timer);
      log(newer ? `idle with Studio ${extensionVersion} connected: exiting so it starts its own harness` : "idle with no daemon: exiting");
      void (async () => {
        server.close();
        for (const c of clients) c.destroy();
        await engine.close().catch(() => undefined);
        try {
          const now = JSON.parse(fs.readFileSync(recordFile(launch.dataDir), "utf-8")) as HarnessRecord;
          if (now.pid === process.pid) fs.rmSync(recordFile(launch.dataDir), { force: true });
        } catch {
          // Gone already.
        }
        process.exit(0);
      })();
    }
  }, 5000);
  timer.unref();
  return {
    // For tests that run a harness in their own process.
    close: async () => {
      clearInterval(timer);
      server.close();
      for (const c of clients) c.destroy();
      await engine.close().catch(() => undefined);
    },
  };
}

/** Entry: node durable-harness.js <launch file>. */
const file = process.argv[2];
if (file && path.basename(file) === "harness.launch.json") {
  let launch: HarnessLaunch;
  try {
    launch = JSON.parse(fs.readFileSync(file, "utf-8")) as HarnessLaunch;
    fs.rmSync(file, { force: true });
  } catch (e) {
    process.stderr.write(`no launch file: ${String(e)}\n`);
    process.exit(2);
  }
  process.on("uncaughtException", (e) => {
    try {
      fs.appendFileSync(logFile(launch.dataDir), `${new Date().toISOString()} uncaught: ${e instanceof Error ? e.stack : String(e)}\n`);
    } catch {
      // Nowhere to write it.
    }
  });
  process.on("unhandledRejection", (e) => {
    try {
      fs.appendFileSync(logFile(launch.dataDir), `${new Date().toISOString()} unhandled: ${e instanceof Error ? e.stack : String(e)}\n`);
    } catch {
      // Nowhere to write it.
    }
  });
  runHarness(launch).catch((e: unknown) => {
    try {
      fs.appendFileSync(logFile(launch.dataDir), `${new Date().toISOString()} failed to start: ${e instanceof Error ? e.stack : String(e)}\n`);
    } catch {
      // Nowhere to write it.
    }
    process.exit(1);
  });
}
