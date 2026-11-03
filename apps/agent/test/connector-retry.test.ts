/**
 * How the connector retries: a passing relay error is retried on the normal
 * backoff, a takeover by another process waits long enough that two cannot
 * trade the project's socket every second, and a process that no longer runs
 * the project does not connect at all.
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { Connector, TAKEN_OVER_CLOSE, refusal, type ConnectorState } from "../src/remote/connector.js";

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
});

/** A relay that answers each upgrade with `respond`, counting them. */
async function relay(respond: (n: number, req: http.IncomingMessage, socket: import("node:stream").Duplex, head: Buffer, wss: WebSocketServer) => void) {
  const server = http.createServer((_q, r) => r.writeHead(404).end());
  const wss = new WebSocketServer({ noServer: true });
  const seen = { upgrades: 0 };
  server.on("upgrade", (req, socket, head) => respond(++seen.upgrades, req, socket, head, wss));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

function connector(url: string, owns?: () => boolean) {
  const states: ConnectorState[] = [];
  const c = new Connector({
    relayUrl: url,
    deviceId: "7a2d3b63-1f54-4a8f-8b62-9e2f3a4b5c6d",
    deviceName: "Game",
    computerPublic: "k",
    token: async () => "uemcp_dev",
    handle: async () => {},
    onState: (s) => states.push(s),
    log: () => {},
    ...(owns ? { owns } : {}),
  });
  return { c, states };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await wait(20);
  }
}

describe("the connector's retries", () => {
  it("only 401, 403 and 409 are refusals; a 5xx is passing", () => {
    expect(refusal(401)?.code).toBe("signed-out");
    expect(refusal(403)?.code).toBe("no-plan");
    expect(refusal(409)?.code).toBe("other-account");
    expect(refusal(500)).toBeNull();
    expect(refusal(502)).toBeNull();
    expect(refusal(503)).toBeNull();
  });

  it("a 500 while the relay redeploys keeps trying on the normal backoff and comes online, never an error", async () => {
    const r = await relay((n, req, socket, head, wss) => {
      if (n === 1) return void socket.end("HTTP/1.1 500 Internal Server Error\r\ncontent-length: 0\r\n\r\n");
      wss.handleUpgrade(req, socket, head, (ws) => ws.send(JSON.stringify({ t: "hello", deviceId: "x", login: "dev" })));
    });
    const { c, states } = connector(r.url);
    c.start();
    await until(() => states.some((s) => s.state === "online"), 4000);
    c.stop();
    expect(states.some((s) => s.state === "error")).toBe(false);
    expect(states.find((s) => s.state === "connecting" && "reason" in s && s.reason)).toMatchObject({ reason: "The relay answered HTTP 500; trying again." });
    expect(r.seen.upgrades).toBe(2);
  });

  it("after another connection takes the project over, waits a minute instead of taking it straight back", async () => {
    const r = await relay((_n, req, socket, head, wss) =>
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.send(JSON.stringify({ t: "hello", deviceId: "x", login: "dev" }));
        setTimeout(() => ws.close(TAKEN_OVER_CLOSE, "replaced"), 50);
      }),
    );
    const { c, states } = connector(r.url);
    c.start();
    await until(() => states.some((s) => s.state === "connecting" && "reason" in s && s.reason === "Another connection for this project took over."));
    await wait(2000);
    c.stop();
    expect(r.seen.upgrades).toBe(1);
  });

  it("a process that no longer runs the project stays off and opens no socket", async () => {
    const r = await relay((_n, _req, socket) => void socket.end("HTTP/1.1 500 x\r\n\r\n"));
    const { c, states } = connector(r.url, () => false);
    c.start();
    await wait(300);
    expect(r.seen.upgrades).toBe(0);
    expect(states.at(-1)).toEqual({ state: "off" });
    expect(c.status).toEqual({ state: "off" });
  });
});
