/**
 * A relay and a paired computer inside the page, for app.html?fake=<scenario>:
 * the app's own relay.ts seals each request as it would for the live relay, and
 * this computer opens it, answers from the web visual-qa scenario's fixture
 * daemon (./harness scenarioTransport) and seals the response frame by frame.
 * The phone is stored as already paired with this computer and the project
 * selected, so the real App entry opens straight into it.
 */
import { exportPublic, generateKeyPair, openRequest, ResponseSealer, sharedSecret, unb64u } from "@ue-mcp-studio/remote";
import { store } from "../ui-test/mocks/secure-store";
import { scenarioTransport, SCENARIOS } from "./harness";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function installFakeRelay(name: string): Promise<void> {
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`no visual-qa scenario ${name}`);
  const computer = await generateKeyPair();
  const computerKey = await exportPublic(computer.publicKey);
  const device = { id: "e2e-fake", name: "StudioE2E", online: true, computerKey, lastSeen: new Date().toISOString() };
  store.set("trusted", JSON.stringify({ [computerKey]: { pairedAt: new Date().toISOString() } }));
  store.set("selected", JSON.stringify(device));
  const transport = scenarioTransport(scenario, "ue-mcp");
  const base = `${location.origin}/fake-relay`;
  const real = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(base)) return real(input, init);
    const path = url.slice(base.length);
    if (path === "/api/devices") return json(200, { devices: [device], viewers: [] });
    if (path !== `/e2e/${device.id}`) return json(404, { error: `fake relay: ${path} is not answered` });
    const phone = JSON.parse(store.get("phone") ?? "null") as { publicKey: string } | null;
    if (!phone) return json(401, { error: "Not paired." });
    const opened = await openRequest(await sharedSecret(computer.privateKey, phone.publicKey), JSON.parse(String(init.body)));
    if (!opened) return json(403, { error: "fake relay: the request did not open" });
    const { req, responseKey } = opened;
    const sent = req.body !== undefined ? JSON.parse(new TextDecoder().decode(unb64u(req.body))) : undefined;
    const reply = await transport(req.method, req.path, { json: sent, headers: req.headers, signal: init.signal ?? undefined });
    const sealer = new ResponseSealer(responseKey);
    const body = reply.body?.[Symbol.asyncIterator]();
    let headSent = false;
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(c) {
          if (!headSent) {
            headSent = true;
            return c.enqueue(await sealer.head({ status: reply.status, headers: reply.headers }));
          }
          const next = body ? await body.next() : { done: true as const, value: undefined };
          if (next.done) {
            c.enqueue(await sealer.final());
            return c.close();
          }
          c.enqueue(await sealer.data(next.value));
        },
        cancel() {
          void body?.return?.(undefined);
        },
      }),
      { status: 200 },
    );
  };
}
