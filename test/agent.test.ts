// Agent loop + channel tests with a scripted fake model (no network, no API cost).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import { Vault } from "../src/vault.ts";
import { Core } from "../src/core.ts";
import { DEFAULTS } from "../src/config.ts";
import { toOllama } from "../src/llm/ollama.ts";
import { WhatsApp } from "../src/channels/whatsapp.ts";

async function setup(script: (msgs: any[]) => any) {
  const v = new Vault(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dinstinct-")), "vault.dat"));
  await v.create("correct horse battery");
  const core = new Core(structuredClone(DEFAULTS), v);
  const seen: any[] = [];
  (core as any).llm = () => ({
    name: "fake",
    supportsImages: false,
    describeError: () => null,
    chat: async (req: any) => {
      seen.push(JSON.parse(JSON.stringify(req.messages)));
      return script(req.messages);
    },
  });
  const out: string[] = [];
  return { v, core, seen, out, send: async (t: string) => void out.push(t) };
}

const toolUse = (name: string, input: any) => ({ content: [{ type: "tool_use", id: "t" + Math.random(), name, input }], stop_reason: "tool_use" });
const say = (text: string) => ({ content: [{ type: "text", text }], stop_reason: "end_turn" });

test("vault secrets never reach the model, and fills are site-locked", async () => {
  let step = 0;
  const { v, core, seen, out, send } = await setup(() => [toolUse("vault_list", {}), toolUse("vault_fill", { ref: "1", entry: "Anghami", field: "password" }), say("done")][step++]);
  v.upsert({ kind: "login", name: "Anghami", sites: ["anghami.com"], fields: { email: "me@x.com", password: "TopSecret#1" } });
  // Fake browser on the wrong site
  let filled = "";
  core.browser = { ensure: async () => {}, fieldInfo: async () => "password", host: () => "evil.example.com", fillSecret: async (_r: string, val: string) => void (filled = val) } as any;
  await core.inbound("telegram", "log in to anghami", send);
  assert.equal(filled, "", "must not fill on another site");
  const transcript = JSON.stringify(seen);
  assert.ok(!transcript.includes("TopSecret#1"), "secret leaked to the model");
  assert.match(transcript, /Blocked: \\"Anghami\\" may only be used on anghami.com/);
  assert.deepEqual(out, ["done"]);

  // Right site: value goes to the page, not the model
  step = 0;
  seen.length = 0;
  core.browser = { ensure: async () => {}, fieldInfo: async () => "password", host: () => "www.anghami.com", fillSecret: async (_r: string, val: string) => void (filled = val) } as any;
  await core.inbound("telegram", "again", send);
  assert.equal(filled, "TopSecret#1");
  assert.ok(!JSON.stringify(seen).includes("TopSecret#1"));
});

test("bank rule: no card requests, no card typing, chat card numbers redacted", async () => {
  let step = 0;
  const { v, core, seen, out, send } = await setup(() =>
    [
      toolUse("vault_request_fill", { kind: "card", name: "Visa", sites: ["shop.example.com"], fields: [{ key: "number", label: "Card number", secret: true }], reason: "to pay" }),
      toolUse("vault_request_fill", { kind: "note", name: "Bank", sites: ["bank.example"], fields: [{ key: "acct", label: "IBAN", secret: true }], reason: "x" }),
      toolUse("browser_type", { ref: "3", text: "4111 1111 1111 1111" }),
      toolUse("browser_type", { ref: "4", text: "123" }),
      toolUse("vault_fill", { ref: "4", entry: "Shop", field: "password" }),
      toolUse("browser_type", { ref: "5", text: "Cairo 11511" }),
      say("done"),
    ][step++],
  );
  v.upsert({ kind: "login", name: "Shop", sites: ["shop.example.com"], fields: { password: "pw-long-1" } });
  const typed: string[] = [];
  let filled = "";
  core.browser = {
    ensure: async () => {},
    host: () => "shop.example.com",
    fieldInfo: async (ref: string) => (ref === "4" ? "cc-csc cvc" : "address"),
    type: async (_r: string, t: string) => (typed.push(t), "ok"),
    fillSecret: async (_r: string, val: string) => void (filled = val),
  } as any;
  await core.inbound("imessage", "buy flowers, my card is 4242 4242 4242 4242", send);
  const t = JSON.stringify(seen);
  assert.ok(!t.includes("4242 4242"), "card number reached the model");
  assert.match(out[0], /removed what looked like a card/);
  assert.equal((JSON.stringify(seen.at(-1)).match(/Refused: DInstinct never handles bank information/g) ?? []).length, 2);
  assert.deepEqual(typed, ["Cairo 11511"], "only the address may be typed");
  assert.equal(filled, "", "nothing typed into the CVC field");
  assert.equal(core.fills.size, 0, "no fill link created");
});

test("confirm_purchase waits for the owner's yes", async () => {
  let step = 0;
  const { core, out, send } = await setup(() => [toolUse("confirm_purchase", { item: "Flowers", seller: "Shop", total: "$40" }), say("ordered")][step++]);
  const run = core.inbound("whatsapp", "send flowers", send);
  await new Promise((r) => setTimeout(r, 50));
  assert.match(out.at(-1)!, /Confirm purchase\?/);
  await core.inbound("whatsapp", "نعم", send); // owner approves (Arabic yes)
  await run;
  assert.equal(out.at(-1), "ordered");
});

test("STOP cancels a waiting task", async () => {
  const { core, out, send } = await setup(() => toolUse("ask_user", { question: "Which day?" }));
  const run = core.inbound("telegram", "book a court", send);
  await new Promise((r) => setTimeout(r, 30));
  await core.inbound("telegram", "stop", send);
  await run;
  assert.ok(out.includes("Stopping…"));
  assert.equal(core.session.busy, false);
});

test("ollama conversion keeps tool calls and results paired", () => {
  const msgs = toOllama("sys", [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: "checking" }, { type: "tool_use", id: "a", name: "browser_open", input: { url: "x.com" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: [{ type: "image" }] }] },
  ]);
  assert.equal(msgs[2].tool_calls[0].function.name, "browser_open");
  assert.deepEqual(msgs[3], { role: "tool", tool_name: "browser_open", content: "[screenshot omitted: local model]" });
});

test("whatsapp webhook: signature checked, strangers ignored", () => {
  const got: string[] = [];
  const wa = new WhatsApp(
    { accessToken: "t", appSecret: "app-secret", verifyToken: "vt", phoneNumberId: "111", allowedNumbers: ["+20 100 000 0000"], graphVersion: "v21.0" },
    (text) => got.push(text),
  );
  const body = (from: string, id: string) =>
    Buffer.from(JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: "111" }, messages: [{ id, from, type: "text", text: { body: "hello " + from } }] } }] }] }));
  const sign = (b: Buffer) => "sha256=" + createHmac("sha256", "app-secret").update(b).digest("hex");

  const ok = body("201000000000", "m1");
  assert.equal(wa.handle(ok, "sha256=" + "0".repeat(64)), false);
  assert.equal(wa.handle(ok, sign(ok)), true);
  assert.equal(wa.handle(ok, sign(ok)), true); // retry: not delivered twice
  const stranger = body("15550001111", "m2");
  wa.handle(stranger, sign(stranger));
  assert.deepEqual(got, ["hello 201000000000"]);
  assert.equal(wa.verify(new URLSearchParams("hub.mode=subscribe&hub.verify_token=vt&hub.challenge=42")), "42");
  assert.equal(wa.verify(new URLSearchParams("hub.mode=subscribe&hub.verify_token=no&hub.challenge=42")), null);
});
