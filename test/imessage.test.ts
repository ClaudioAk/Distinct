// iMessage (Sendblue) webhook: URL secret, owner-only, dedupe, replies sent through the Sendblue API.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "distinct-im-"));
fs.writeFileSync(
  path.join(dir, "config.json"),
  JSON.stringify({ port: 7797, imessage: { enabled: true, fromNumber: "+15550009999", allowedHandles: ["+20 100 000 0000", "Me@iCloud.com"] } }),
);
process.env.DISTINCT_DATA = dir;
const { loadConfig } = await import("../src/config.ts");
const { App } = await import("../src/app.ts");
const { startWeb } = await import("../src/web.ts");

test("iMessage webhook answers only the owner, through Sendblue", async () => {
  const app = new App(loadConfig());
  await app.create("correct horse battery");
  app.vault.setSystem("sendblue_api_key_id", "kid");
  app.vault.setSystem("sendblue_api_secret", "ksecret");
  app.startChannels();
  const server = startWeb(app);
  await new Promise((r) => server.once("listening", r));
  (app.core as any).llm = () => ({ name: "fake", supportsImages: false, describeError: () => null, chat: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "Hi! On it." }] }) });

  const sent: any[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    if (String(url).startsWith("https://api.sendblue.co")) {
      sent.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
      return new Response("{}", { status: 200 });
    }
    return realFetch(url, init);
  }) as any;

  const secret = app.vault.getSystem("imessage_webhook_secret");
  const post = (s: string, body: any) =>
    realFetch(`http://127.0.0.1:7797/imessage/webhook/${s}`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "1.2.3.4" }, body: JSON.stringify(body) });
  const msg = (from: string, handle: string, extra = {}) => ({ content: "hello", from_number: from, number: from, is_outbound: false, message_handle: handle, service: "iMessage", ...extra });

  assert.equal((await post("x".repeat(43), msg("+201000000000", "h0"))).status, 404, "wrong secret must be rejected");
  assert.equal((await post(secret, msg("+15551234567", "h1"))).status, 200);
  assert.equal((await post(secret, msg("+201000000000", "h2", { is_outbound: true }))).status, 200);
  assert.equal((await post(secret, msg("+201000000000", "h3"))).status, 200);
  assert.equal((await post(secret, msg("+201000000000", "h3"))).status, 200); // retry, deduped
  await new Promise((r) => setTimeout(r, 200));

  const replies = sent.filter((s) => s.url.endsWith("/send-message"));
  assert.equal(replies.length, 1, "exactly one reply, only to the owner");
  assert.deepEqual(replies[0].body, { number: "+201000000000", from_number: "+15550009999", content: "Hi! On it." });
  assert.equal(replies[0].headers["sb-api-key-id"], "kid");
  assert.ok(sent.some((s) => s.url.endsWith("/send-typing-indicator")), "typing indicator shown");

  // Apple ID email handle is accepted too
  await post(secret, msg("me@icloud.com", "h4"));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(sent.filter((s) => s.url.endsWith("/send-message")).at(-1).body.number, "me@icloud.com");

  globalThis.fetch = realFetch;
  server.close();
});
