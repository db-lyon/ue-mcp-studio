/**
 * #463 L6: the Windows transport and peer authentication built for pi-server
 * and pi-client: ordered bytes both ways after a token preamble, and nothing
 * reaches the server from a peer without the token.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import * as net from "node:net";
import { createPipeListener, createPipeTransport, pipePath, preamble, type PipeConnection, type PipeListener } from "../../src/durable/pi-pipe.js";

let listener: PipeListener | null = null;
afterEach(async () => {
  await listener?.close();
  listener = null;
});

const until = async (cond: () => boolean, what: string) => {
  for (const end = Date.now() + 5000; !cond(); await new Promise((r) => setTimeout(r, 10))) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
};

function serve(token: string, handshakeMs?: number) {
  const path = pipePath(`studio-pipe-test-${crypto.randomUUID()}`);
  const got: Buffer[] = [];
  const conns: PipeConnection[] = [];
  const refused: string[] = [];
  let closed = 0;
  listener = createPipeListener({ path, token, ...(handshakeMs ? { handshakeMs } : {}), onRefused: (why) => refused.push(why) });
  const started = listener.start((c) => {
    conns.push(c);
    return { onData: (d) => got.push(Buffer.from(d)), onClose: () => closed++, onError: () => undefined };
  });
  return { path, got, conns, refused, closed: () => closed, started };
}

describe("the authenticated pipe for pi-server and pi-client", () => {
  it("carries ordered bytes both ways once the token checks out", async () => {
    const s = serve("secret-token");
    await s.started;
    const back: Buffer[] = [];
    let ended = 0;
    const t = await createPipeTransport({ path: s.path, token: "secret-token" })({ onData: (d) => back.push(Buffer.from(d)), onClose: () => ended++, onError: () => undefined });
    await t.send(new TextEncoder().encode("hello "));
    await t.send(new TextEncoder().encode("server"));
    await until(() => Buffer.concat(s.got).toString() === "hello server", "the client's bytes");
    expect(s.conns).toHaveLength(1);
    await s.conns[0].send(new TextEncoder().encode("hello client"));
    await until(() => Buffer.concat(back).toString() === "hello client", "the server's bytes");
    t.close();
    await until(() => s.closed() === 1, "the close");
    expect(s.refused).toEqual([]);
  });

  it("hands on bytes sent with the preamble, and reads a preamble split across writes", async () => {
    const s = serve("t0k");
    await s.started;
    const sock = net.connect(s.path);
    await new Promise((r) => sock.once("connect", r));
    const p = preamble("t0k");
    sock.write(p.subarray(0, 3));
    await new Promise((r) => setTimeout(r, 30));
    sock.write(Buffer.concat([p.subarray(3), Buffer.from("first")]));
    await until(() => Buffer.concat(s.got).toString() === "first", "the bytes after the preamble");
    sock.destroy();
  });

  it("refuses a wrong token, a stranger and silence, before the server sees a byte", async () => {
    const s = serve("right", 200);
    await s.started;
    await expect((async () => {
      const t = await createPipeTransport({ path: s.path, token: "wrong" })({ onData: () => undefined, onClose: () => undefined, onError: () => undefined });
      await t.send(new TextEncoder().encode("let me in"));
    })()).resolves.toBeUndefined();
    const stranger = net.connect(s.path);
    await new Promise((r) => stranger.once("connect", r));
    stranger.write("GET / HTTP/1.1\r\n\r\n");
    const silent = net.connect(s.path);
    await new Promise((r) => silent.once("connect", r));
    await until(() => s.refused.length === 3, "three refusals");
    expect(s.refused.sort()).toEqual(["no token in time", "not a Studio pipe client", "wrong token"]);
    expect(s.conns).toHaveLength(0);
    expect(s.got).toHaveLength(0);
    stranger.destroy();
    silent.destroy();
  });
});
