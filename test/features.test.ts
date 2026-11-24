// Proactive engine, Google tools, phone calls, spending limits, private mode, data controls.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dinstinct-feat-"));
fs.writeFileSync(
  path.join(dir, "config.json"),
  JSON.stringify({ port: 7796, publicUrl: "https://example.test", ownerName: "Alex", phone: { enabled: true, allowedNumbers: ["+201000000000"], language: "en-US" }, notifyChannel: "none" }),
);
process.env.DINSTINCT_DATA = dir;
const { loadConfig } = await import("../src/config.ts");
const { App } = await import("../src/app.ts");
const { startWeb } = await import("../src/web.ts");
const { findConflicts, inQuietHours } = await import("../src/proactive.ts");
const { buildEmail } = await import("../src/google.ts");
const { parseAmount } = await import("../src/tools.ts");

const app = new App(loadConfig());
await app.create("correct horse battery");
const server = startWeb(app);
await new Promise((r) => server.once("listening", r));
const outbox: string[] = [];
app.notifyLate = async (t: string) => void outbox.push(t);

const toolUse = (name: string, input: any) => ({ content: [{ type: "tool_use", id: "t" + Math.random(), name, input }], stop_reason: "tool_use" });
const say = (text: string) => ({ content: [{ type: "text", text }], stop_reason: "end_turn" });
function script(steps: any[]) {
  let i = 0;
  const seen: any[] = [];
  (app.core as any).llm = () => ({ name: "fake", supportsImages: false, describeError: () => null, chat: async (req: any) => (seen.push(req), steps[i++] ?? say("done")) });
  return seen;
}

// Fake Google: calendar, gmail, sending.
const sentMail: any[] = [];
const ev = (id: string, title: string, s: string, e: string) => ({ id, summary: title, start: { dateTime: s }, end: { dateTime: e } });
app.vault.setSystem("google_refresh_token", "rt");
app.vault.setSystem("google_email", "me@example.com");
const g = app.core.google as any;
g.accessToken = async () => "at";
g.events = async () => [
  ev("a", "Standup", "2026-11-25T09:00:00+02:00", "2026-11-25T10:00:00+02:00"),
  ev("b", "Dentist appointment", "2026-11-25T09:30:00+02:00", "2026-11-25T10:30:00+02:00"),
  ev("c", "Lunch", "2026-11-25T13:00:00+02:00", "2026-11-25T14:00:00+02:00"),
];
g.searchMail = async (q: string) =>
  q.startsWith("in:sent") ? [{ id: "m1", threadId: "t1" }, { id: "m2", threadId: "t2" }] : [{ subject: "Contract", from: "Boss <boss@x.com>" }];
g.thread = async (id: string) => ({
  messages: [{ internalDate: String(Date.now() - 5 * 86400_000), payload: { headers: [{ name: "From", value: id === "t1" ? "Me <me@example.com>" : "Them <them@x.com>" }, { name: "To", value: "Landlord <l@x.com>" }, { name: "Subject", value: "Deposit" }] } }],
});
g.api = async (method: string, url: string, body: any) => {
  if (url.includes("/messages/send")) sentMail.push(body);
  return {};
};

test("quiet hours and calendar clash detection", () => {
  const at = (h: number) => new Date(2026, 10, 25, h, 0);
  assert.ok(inQuietHours(at(23), "22:00", "08:00"));
  assert.ok(inQuietHours(at(3), "22:00", "08:00"));
  assert.ok(!inQuietHours(at(12), "22:00", "08:00"));
  const clashes = findConflicts([
    ev("a", "A", "2026-11-25T09:00:00Z", "2026-11-25T10:00:00Z"),
    ev("b", "B", "2026-11-25T09:30:00Z", "2026-11-25T10:30:00Z"),
    { ...ev("c", "C", "2026-11-25T09:15:00Z", "2026-11-25T09:45:00Z"), attendees: [{ self: true, responseStatus: "declined" }] },
    ev("d", "D", "2026-11-25T10:30:00Z", "2026-11-25T11:00:00Z"),
  ]);
  assert.deepEqual(clashes.map(([x, y]) => x.id + y.id), ["ab"]);
});

test("proactive: reminders fire once, briefing covers agenda/clashes/bookings/mail/unanswered, clashes not repeated", async () => {
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  app.vault.setState("reminders", [{ id: "r1", text: "Cancel the gym trial", due: new Date(noon.getTime() - 60_000).toISOString() }]);
  await app.proactive.tick(noon);
  const text = outbox.join("\n---\n");
  assert.match(text, /⏰ Reminder: Cancel the gym trial/);
  assert.match(text, /Good morning Alex/);
  assert.match(text, /Standup/);
  assert.match(text, /clash/i);
  assert.match(text, /Dentist appointment/); // booking heads-up
  assert.match(text, /Important unread \(1\)/);
  assert.match(text, /No reply yet:\n• "Deposit"/); // t1: owner sent last; t2: they replied
  assert.equal((text.match(/Deposit/g) ?? []).length, 1);
  const n = outbox.length;
  (app.proactive as any).lastCalendarCheck = 0;
  await app.proactive.tick(noon);
  assert.equal(outbox.length, n, "nothing repeated on the next tick");
  assert.deepEqual(app.vault.getState("reminders", []), []);
  // quiet hours: a new reminder waits
  const night = new Date();
  night.setHours(23, 30, 0, 0);
  app.vault.setState("reminders", [{ id: "r2", text: "Late one", due: new Date(night.getTime() - 60_000).toISOString() }]);
  await app.proactive.tick(night);
  assert.equal(outbox.length, n);
});

test("gmail_send needs the owner's YES; header injection is refused", async () => {
  script([toolUse("gmail_send", { to: "l@x.com", subject: "Deposit?", body: "Hi, any news on the deposit?" }), say("sent it")]);
  const msgs: string[] = [];
  const run = app.core.inbound("telegram", "chase the landlord", async (t) => void msgs.push(t));
  await new Promise((r) => setTimeout(r, 50));
  assert.match(msgs.at(-1)!, /Send this email\?/);
  assert.equal(sentMail.length, 0, "sent before approval");
  await app.core.inbound("telegram", "yes", async (t) => void msgs.push(t));
  await run;
  assert.equal(sentMail.length, 1);
  assert.throws(() => buildEmail({ to: "a@x.com\r\nBcc: evil@x.com", subject: "s", body: "b" }), /Line breaks/);
  const raw = Buffer.from(buildEmail({ to: "a@x.com", subject: "مرحبا", body: "hi" }), "base64url").toString();
  assert.match(raw, /Subject: =\?UTF-8\?B\?/);
});

test("spending limits are enforced before asking", async () => {
  assert.equal(parseAmount("$1,299.50"), 1299.5);
  assert.equal(parseAmount("42 EGP"), 42);
  const seen = script([toolUse("confirm_purchase", { item: "TV", seller: "Shop", total: "$450" }), say("ok")]);
  const msgs: string[] = [];
  await app.core.inbound("telegram", "buy a tv", async (t) => void msgs.push(t));
  assert.match(JSON.stringify(seen.at(-1).messages), /spending limit/);
  assert.ok(!msgs.some((m) => /Confirm purchase/.test(m)), "should not even ask");
});

test("private: tasks use the local model only", async () => {
  delete (app.core as any).llm; // use the real provider selection
  let called = "";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    called = String(url);
    if (called.includes("11434")) return new Response(JSON.stringify({ message: { content: "local answer" } }));
    return realFetch(url, init);
  }) as any;
  const msgs: string[] = [];
  await app.core.inbound("telegram", "private: summarise my health notes", async (t) => void msgs.push(t));
  globalThis.fetch = realFetch;
  assert.match(called, /127\.0\.0\.1:11434\/api\/chat/);
  assert.equal(msgs.at(-1), "local answer");
  assert.equal(app.core.privateTask, false);
});

test("phone call: Twilio signature checked, owner's speech answered aloud", async () => {
  app.vault.setSystem("twilio_auth_token", "twilio-token");
  script([say("You have standup at nine.")]);
  const sign = (url: string, p: URLSearchParams) => {
    let d = url;
    for (const k of [...new Set(p.keys())].sort()) for (const v of p.getAll(k)) d += k + v;
    return createHmac("sha1", "twilio-token").update(d).digest("base64");
  };
  const call = (pathname: string, params: Record<string, string>, good = true) => {
    const p = new URLSearchParams(params);
    return fetch(`http://127.0.0.1:7796${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": good ? sign("https://example.test" + pathname, p) : "bad", "cf-connecting-ip": "1.1.1.1" },
      body: p,
    });
  };
  assert.equal((await call("/voice/incoming", { From: "+201000000000" }, false)).status, 403);
  assert.match(await (await call("/voice/incoming", { From: "+15550000000" })).text(), /private/);
  assert.match(await (await call("/voice/incoming", { From: "+201000000000" })).text(), /<Gather input="speech"[^>]*><Say[^>]*>Hi, Alex/);
  const r = await (await call("/voice/speech", { From: "+201000000000", SpeechResult: "what's on today?" })).text();
  assert.match(r, /You have standup at nine\./);
  assert.match(r, /Anything else\?/);
});

test("Sign in with Claude: not signed in gives a plain-language message, not a crash", async () => {
  const { claudeProvider } = await import("../src/llm/claude.ts");
  const prev = { dir: process.env.ANTHROPIC_CONFIG_DIR, key: process.env.ANTHROPIC_API_KEY };
  process.env.ANTHROPIC_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "no-anthropic-profile-"));
  delete process.env.ANTHROPIC_API_KEY;
  const p = claudeProvider({ ...app.cfg.llm, claudeAuth: "signin" }, "");
  assert.match(p.name, /Claude/); // building the provider never throws
  let msg = "";
  try {
    await p.chat({ system: "x", messages: [{ role: "user", content: "hi" }], tools: [] });
  } catch (e) {
    msg = p.describeError(e) ?? String(e);
  }
  process.env.ANTHROPIC_CONFIG_DIR = prev.dir;
  if (prev.key) process.env.ANTHROPIC_API_KEY = prev.key;
  if (!prev.dir) delete process.env.ANTHROPIC_CONFIG_DIR;
  assert.match(msg, /Sign in with Claude/);
  // The guide shows the button
  const html = await (await fetch("http://127.0.0.1:7796/welcome?step=1")).text();
  assert.match(html, /Sign in with Claude/);
});

test("any Claude model: requests fit each model; 'model sonnet' switches from chat", async () => {
  const { buildParams, toModelInfo, listModels } = await import("../src/llm/claude.ts");
  const req = { system: "s", messages: [], tools: [] };
  const caps = (efforts: string[], adaptive: boolean) => ({
    thinking: { types: { adaptive: { supported: adaptive } } },
    effort: { supported: efforts.length > 0, ...Object.fromEntries(["low", "medium", "high", "xhigh", "max"].map((e) => [e, { supported: efforts.includes(e) }])) },
  });
  const opus46 = toModelInfo({ id: "claude-opus-4-6", display_name: "Claude Opus 4.6", max_tokens: 128000, capabilities: caps(["low", "medium", "high", "max"], true) });
  const haiku45 = toModelInfo({ id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5", max_tokens: 64000, capabilities: caps([], false) });
  const a = buildParams(opus46.id, opus46, "xhigh", req as any, true);
  assert.deepEqual([a.params.thinking, a.params.output_config, a.fallbacks], [{ type: "adaptive" }, { effort: "high" }, false]);
  const b = buildParams(haiku45.id, haiku45, "medium", req as any, true);
  assert.equal(b.params.thinking, undefined);
  assert.equal(b.params.output_config, undefined);
  const c = buildParams("claude-opus-5-5", undefined, "medium", req as any, true);
  assert.equal(c.fallbacks, true);
  assert.equal(c.params.thinking, undefined, "unknown capabilities: plain request");

  // chat command, with a fake model list
  void listModels;
  const fakeModels = [
    toModelInfo({ id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5", created_at: "2026-11-01", capabilities: caps(["low", "medium", "high"], true) }),
    toModelInfo({ id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-10-01", capabilities: caps(["low", "medium", "high"], true) }),
  ];
  app.core.modelLister = async () => fakeModels;
  app.cfg.llm.provider = "claude";
  const msgs: string[] = [];
  const say = async (t: string) => void msgs.push(t);
  await app.core.inbound("telegram", "model", say);
  assert.match(msgs.at(-1)!, /Claude Sonnet 5\.5 \(claude-sonnet-5-5\)/);
  await app.core.inbound("telegram", "model sonnet", say);
  assert.equal(msgs.at(-1), "Switched to Claude Sonnet 5.5.");
  assert.equal(app.cfg.llm.claudeModel, "claude-sonnet-5-5");
  await app.core.inbound("telegram", "model gpt", say);
  assert.match(msgs.at(-1)!, /No Claude model matches/);
  app.cfg.llm.claudeModel = "claude-opus-5-5";
});

test("Telegram pairing by code: right code pairs, guessing is cut off", () => {
  const code = app.startPairing();
  assert.match(code, /^\d{6}$/);
  assert.equal(app.tryPair("111", "/start 000000", "Eve"), false);
  assert.equal(app.tryPair("222", `/start ${code}`, "Alex"), true);
  assert.ok(app.cfg.telegram.allowedUserIds.includes("222"));
  assert.equal(app.tryPair("333", `/start ${code}`, "Late"), false, "code is single use");
  app.startPairing();
  for (let i = 0; i < 10; i++) app.tryPair("444", "/start 123", "x");
  assert.equal(app.pairing, null, "pairing stops after 10 wrong tries");
});

test("welcome guide pages render and validate input", async () => {
  const html = await (await fetch("http://127.0.0.1:7796/welcome?step=1")).text();
  assert.match(html, /Let's set up your assistant/);
  const csrf = html.match(/name="csrf" value="([^"]+)"/)![1];
  const post = (p: string, body: Record<string, string>) =>
    fetch(`http://127.0.0.1:7796${p}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, ...body }), redirect: "manual" });
  assert.match(await (await post("/welcome/brain", { brain: "claude", key: "not-a-key" })).text(), /look like an Anthropic key/);
  assert.match(await (await post("/welcome/telegram", { token: "hello" })).text(), /a bot token/);
  for (const s of [2, 3, 4]) assert.equal((await fetch(`http://127.0.0.1:7796/welcome?step=${s}`)).status, 200);
});

test("data export has no secrets; delete everything needs the password", async () => {
  app.vault.upsert({ kind: "login", name: "Anghami", sites: ["anghami.com"], fields: { password: "TopSecret#1" } });
  const exp = JSON.stringify(app.exportData());
  assert.ok(!exp.includes("TopSecret#1") && !exp.includes("twilio-token") && !exp.includes('"rt"'));
  assert.match(exp, /Anghami/);
  const html = await (await fetch("http://127.0.0.1:7796/data")).text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/)![1];
  const del = (password: string) =>
    fetch("http://127.0.0.1:7796/data/delete", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, password, confirm: "DELETE" }), redirect: "manual" });
  assert.equal((await del("wrong password!!")).status, 401);
  assert.ok(fs.existsSync(path.join(dir, "vault.dat")));
  assert.equal((await del("correct horse battery")).status, 303);
  assert.ok(!fs.existsSync(path.join(dir, "vault.dat")));
  server.close();
});
