// Guided WhatsApp setup against a simulated Meta Graph API: paste App ID/secret, token,
// connect (webhook registered automatically), pair by code through a signed webhook.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dinstinct-wa-"));
fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ port: 7795, publicUrl: "https://abc.trycloudflare.com" }));
process.env.DINSTINCT_DATA = dir;
const { loadConfig } = await import("../src/config.ts");
const { App } = await import("../src/app.ts");
const { startWeb } = await import("../src/web.ts");

const APP_ID = "1234567890";
const SECRET = "0123456789abcdef0123456789abcdef";
const TOKEN = "EAAGtesttoken";
const calls: { method: string; url: string; body: string; auth: string }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init: any = {}) => {
  const u = String(url);
  if (!u.startsWith("https://graph.facebook.com")) return realFetch(url, init);
  calls.push({ method: init.method ?? "GET", url: u, body: String(init.body ?? ""), auth: init.headers?.authorization ?? "" });
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
  if (u.includes(`/${APP_ID}?fields=id,name`)) return u.includes(encodeURIComponent(`${APP_ID}|${SECRET}`)) ? json({ id: APP_ID, name: "My DInstinct" }) : json({ error: { message: "Error validating client secret" } }, 400);
  if (u.includes("/debug_token"))
    return json({ data: { is_valid: true, app_id: APP_ID, expires_at: Math.floor(Date.now() / 1000) + 86400, scopes: ["whatsapp_business_messaging", "whatsapp_business_management"], granular_scopes: [{ scope: "whatsapp_business_messaging", target_ids: ["777"] }] } });
  if (u.includes("/777/phone_numbers")) return json({ data: [{ id: "555000", display_phone_number: "+1 555-010-9999", verified_name: "Test Number" }] });
  if (u.includes(`/${APP_ID}/subscriptions`) || u.includes("/777/subscribed_apps")) return json({ success: true });
  if (u.includes("/555000/messages")) return json({ messages: [{ id: "wamid.1" }] });
  return json({ error: { message: "unexpected " + u } }, 400);
}) as any;

test("guided WhatsApp setup: three pastes, automatic number + webhook, pairing by code", async () => {
  const app = new App(loadConfig());
  await app.create("correct horse battery");
  await app.unlock("correct horse battery");
  app.tunnel.state = "on"; // pretend the secure connection is on
  const server = startWeb(app);
  await new Promise((r) => server.once("listening", r));
  try {
    await flow(app);
  } finally {
    server.close();
    server.closeAllConnections?.();
    await app.lock();
  }
});

async function flow(app: any) {
  const base = "http://127.0.0.1:7795";
  const html = await (await realFetch(`${base}/whatsapp`)).text();
  assert.match(html, /1\. Create your WhatsApp app at Meta/);
  const csrf = html.match(/name="csrf" value="([^"]+)"/)![1];
  const post = async (p: string, body: Record<string, string>) => {
    const r = await realFetch(base + p, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, ...body }), redirect: "manual" });
    return decodeURIComponent((r.headers.get("location") ?? "").replace(/\+/g, " "));
  };

  assert.match(await post("/whatsapp/app", { appId: APP_ID, secret: "f".repeat(32) }), /doesn't match/);
  assert.match(await post("/whatsapp/app", { appId: APP_ID, secret: SECRET }), /Found your app "My DInstinct"/);
  assert.match(await post("/whatsapp/token", { token: TOKEN }), /Found your WhatsApp number \+1 555-010-9999/);
  assert.equal(app.cfg.whatsapp.phoneNumberId, "555000");
  assert.equal(app.cfg.whatsapp.wabaId, "777");
  assert.ok(app.cfg.whatsapp.tokenExpires > Date.now(), "temporary token expiry recorded");

  assert.match(await post("/whatsapp/connect", {}), /Connected/);
  const sub = calls.find((c) => c.url.includes(`/${APP_ID}/subscriptions`))!;
  const params = new URLSearchParams(sub.body);
  assert.equal(params.get("callback_url"), "https://abc.trycloudflare.com/wa/webhook");
  assert.equal(params.get("fields"), "messages");
  assert.equal(params.get("verify_token"), app.vault.getSystem("whatsapp_verify_token"));
  const wabaCalls = calls.filter((c) => c.url.includes("/777/subscribed_apps") && c.auth === `Bearer ${TOKEN}`);
  assert.equal(wabaCalls.length, 2, "subscribe, then override the webhook address");
  assert.equal(wabaCalls[0].body, "");
  assert.deepEqual(JSON.parse(wabaCalls[1].body), { override_callback_uri: "https://abc.trycloudflare.com/wa/webhook", verify_token: app.vault.getSystem("whatsapp_verify_token") });
  assert.ok(calls.every((c) => c.url.startsWith("https://graph.facebook.com/v27.0/")), "current Graph API version");
  // Meta's verification call reaches the running channel
  const vt = app.vault.getSystem("whatsapp_verify_token");
  assert.equal(await (await realFetch(`${base}/wa/webhook?hub.mode=subscribe&hub.verify_token=${vt}&hub.challenge=42`)).text(), "42");

  await post("/whatsapp/pair", {});
  const code = app.pairing!.code;
  const page4 = await (await realFetch(`${base}/whatsapp`)).text();
  assert.match(page4, new RegExp(`wa.me/15550109999\\?text=${code}`));
  const body = Buffer.from(JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: "555000" }, contacts: [{ wa_id: "201000000000", profile: { name: "Alex" } }], messages: [{ id: "m1", from: "201000000000", type: "text", text: { body: code } }] } }] }] }));
  const sig = "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
  assert.equal((await realFetch(`${base}/wa/webhook`, { method: "POST", headers: { "x-hub-signature-256": sig, "content-type": "application/json" }, body })).status, 200);
  assert.deepEqual(app.cfg.whatsapp.allowedNumbers, ["201000000000"]);
  assert.match(await (await realFetch(`${base}/whatsapp`)).text(), /WhatsApp is ready/);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(calls.some((c) => c.url.includes("/555000/messages") && /Paired/.test(c.body)), "paired confirmation sent");
}
