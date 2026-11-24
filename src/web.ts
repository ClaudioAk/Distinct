// Local web server.
//  - Admin pages (dashboard, vault, settings) answer ONLY on this PC (127.0.0.1, no tunnel headers).
//  - Through the public tunnel only these are reachable: /fill/<one-time token>,
//    /wa/webhook (signed by Meta) and /iphone (bearer token).
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA, DEFAULTS, ROOT, audit, digits, saveConfig } from "./config.ts";
import { cachedModels, listModels } from "./llm/claude.ts";
import { detect, listFreeModels } from "./llm/freellm.ts";
import { applyCompanyCA, validateCompanyCA } from "./netcheck.ts";
import { checkApp, inspectToken, listNumbers } from "./channels/whatsapp-setup.ts";

const companyCAName = () => {
  try {
    return validateCompanyCA(fs.readFileSync(path.join(DATA, "company-ca.pem"), "utf8"));
  } catch {
    return "(unreadable)";
  }
};
import { ENTRY_KINDS, MIN_PASSWORD, Vault, normalizeSite, type EntryKind } from "./vault.ts";
import { callerAllowed, speakable, twilioSignatureValid, twiml } from "./channels/phone.ts";
import { BANK_RULE } from "./policy.ts";
import { ART_CSS, ART_DARK, ART_LIGHT, GUARD_SVG, MARK_SVG } from "./art.ts";
import type { App } from "./app.ts";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// Theme: "auto" follows the system, "light"/"dark" are forced (Settings or the header switch).
const LIGHT = `--bg:#f6f5f2;--card:#fff;--ink:#1d1c1a;--ink2:#5d5a54;--line:#e3e0da;--acc:#2f5bd3;--bad:#b3261e;--ok:#1e7a3c;--panel:#ecebe6;${ART_LIGHT}`;
const DARK = `--bg:#121214;--card:#1c1c1f;--ink:#eeece8;--ink2:#a8a49c;--line:#323236;--acc:#7d9bff;--bad:#ff8a80;--ok:#7bd88f;--panel:#18181b;${ART_DARK}`;

const CSS = `
:root{${LIGHT};color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${DARK};color-scheme:dark}}
:root[data-theme=dark]{${DARK};color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.shell{display:flex;min-height:100vh}
aside.side{flex:0 0 300px;background:var(--panel);border-right:1px solid var(--line);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:28px 20px;position:sticky;top:0;height:100vh}
aside.side .guard-art{width:100%;max-width:250px;height:auto}
aside.side p{margin:14px 0 0;text-align:center;color:var(--ink2);font-size:13px;max-width:230px}
aside.side b{color:var(--ink)}
main{flex:1;max-width:760px;margin:0 auto;padding:24px 16px 64px;min-width:0}h1{font-size:24px;margin:8px 0 4px}h2{font-size:17px;margin:0 0 12px}
.mobile-only{display:none}
@media (max-width:900px){aside.side{display:none}.mobile-only{display:block}}
.theme{display:inline-flex;border:1px solid var(--line);border-radius:99px;overflow:hidden}
.theme button{margin:0;padding:4px 11px;background:transparent;color:var(--ink2);border:0;border-radius:0;font-size:12px;font-weight:600}
.theme button.on{background:var(--acc);color:#fff}
.hdr-right{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.rule{border-left:3px solid var(--bad);padding:8px 12px;background:var(--card);border-radius:6px;font-size:13px;color:var(--ink2)}
${ART_CSS}
.sub{color:var(--ink2);margin:0 0 20px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;margin:14px 0}
label{display:block;font-size:13px;color:var(--ink2);margin:10px 0 4px}input,select,textarea{width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);font:inherit}
input[type=checkbox],input[type=radio]{width:auto;margin:0 6px 0 0;vertical-align:middle}button{margin-top:14px;padding:9px 16px;border:0;border-radius:8px;background:var(--acc);color:#fff;font:inherit;font-weight:600;cursor:pointer}
button.ghost{background:transparent;color:var(--ink2);border:1px solid var(--line)}.row{display:flex;gap:10px;flex-wrap:wrap}.row>*{flex:1;min-width:200px}
nav a{margin-right:14px;color:var(--acc);text-decoration:none}.pill{display:inline-block;padding:2px 9px;border-radius:99px;font-size:12px;border:1px solid var(--line);color:var(--ink2)}
.ok{color:var(--ok)}.bad{color:var(--bad)}code{font:13px ui-monospace,Consolas,monospace;background:var(--bg);padding:2px 5px;border-radius:5px;word-break:break-all}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}
.brand{display:flex;align-items:center;gap:9px;color:var(--ink);text-decoration:none;font-weight:700;font-size:18px}
.hero{display:block;width:130px;height:auto;margin:8px auto 0}
details.adv>summary{cursor:pointer;list-style:none;padding:2px 0}details.adv>summary::-webkit-details-marker{display:none}
details.adv>summary::before{content:"▸ ";color:var(--ink2)}details.adv[open]>summary::before{content:"▾ "}
details.adv .card{background:var(--bg)}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}.hint{font-size:13px;color:var(--ink2)}`;

// Tab icon (fixed colors).
const MARK_URI = "data:image/svg+xml;base64," + Buffer.from(fs.readFileSync(path.join(ROOT, "assets", "logo-mark.svg"), "utf8")).toString("base64");

/** Set by startWeb: current theme and the form token for the header switch. */
const ui = { theme: "auto" as "auto" | "light" | "dark", csrf: "" };

type PageOpts = { nav?: boolean; local?: boolean };

function page(title: string, body: string, opts: PageOpts | boolean = {}): string {
  const o: PageOpts = typeof opts === "boolean" ? { nav: opts, local: opts } : opts;
  const nav = o.nav ?? true;
  const local = o.local ?? nav;
  const themeSwitch = local
    ? `<form class="theme" method="post" action="/theme"><input type="hidden" name="csrf" value="${ui.csrf}">${(["auto", "light", "dark"] as const)
        .map((t) => `<button name="theme" value="${t}" class="${ui.theme === t ? "on" : ""}" title="${t === "auto" ? "Follow the system" : t + " mode"}">${t === "auto" ? "Auto" : t === "light" ? "Light" : "Dark"}</button>`)
        .join("")}</form>`
    : "";
  const brand = `<a class="brand" href="/">${MARK_SVG(34)}<span>DInstinct</span></a>`;
  return `<!doctype html><html data-theme="${ui.theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="${MARK_URI}"><title>${esc(title)}</title><style>${CSS}</style></head><body><div class="shell">
<aside class="side">${GUARD_SVG}<p><b>On duty.</b> Your secrets stay encrypted on this PC. No bank information, ever.</p></aside>
<main><header>${brand}<div class="hdr-right">${nav ? `<nav><a href="/vault">Vault</a><a href="/data">Data &amp; connections</a><a href="/settings">Settings</a></nav>` : ""}${themeSwitch}</div></header>${body}</main></div></body></html>`;
}

/** Small guard for narrow screens, where the side panel is hidden. */
const hero = () => `<div class="mobile-only">${MARK_SVG(130).replace('class="mark-art"', 'class="mark-art hero"')}</div>`;

function send(res: http.ServerResponse, status: number, body: string, type = "text/html; charset=utf-8"): void {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin", // "no-referrer" would make browsers send Origin: null on our own forms
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'",
  });
  res.end(body);
}

const redirect = (res: http.ServerResponse, to: string) => {
  res.writeHead(303, { location: to, "cache-control": "no-store" });
  res.end();
};

function readBody(req: http.IncomingMessage, limit = 1_000_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("too large"));
        req.destroy();
      } else parts.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function startWeb(app: App): http.Server {
  const port = app.cfg.port;
  ui.csrf = app.csrf;
  ui.theme = app.cfg.ui.theme;

  const isLocal = (req: http.IncomingMessage) => {
    const ip = req.socket.remoteAddress ?? "";
    const host = (req.headers.host ?? "").toLowerCase();
    return (
      ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip) &&
      !req.headers["cf-connecting-ip"] &&
      !req.headers["x-forwarded-for"] &&
      !req.headers["x-forwarded-host"] &&
      (host === `127.0.0.1:${port}` || host === `localhost:${port}`) // blocks DNS-rebinding tricks
    );
  };

  const formOk = (req: http.IncomingMessage, f: URLSearchParams) => {
    const origin = req.headers.origin;
    const originOk = !origin || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
    return originOk && safeEqual(f.get("csrf") ?? "", app.csrf);
  };
  const csrf = () => `<input type="hidden" name="csrf" value="${app.csrf}">`;

  // ---------- pages ----------

  const dashboard = (msg = "") => {
    const v = app.vault;
    const note = msg ? `<p class="bad">${esc(msg)}</p>` : "";
    if (!v.exists())
      return page(
        "DInstinct setup",
        `${hero()}<h1>Welcome to DInstinct</h1><p class="sub">Create the master password for your vault. It encrypts every password, login and API key on this PC. There is no way to recover it, so store it somewhere safe.</p>${note}
<form class="card" method="post" action="/setup">${csrf()}<label>Master password (at least ${MIN_PASSWORD} characters)</label><input type="password" name="password" autocomplete="new-password" required minlength="${MIN_PASSWORD}">
<label>Repeat it</label><input type="password" name="password2" autocomplete="new-password" required><button>Create encrypted vault</button></form>`,
        { nav: false, local: true },
      );
    if (!v.isUnlocked())
      return page(
        "DInstinct locked",
        `${hero()}<h1>DInstinct is locked</h1><p class="sub">Enter your master password. Chats and the browser only run while the vault is unlocked.</p>${note}
<form class="card" method="post" action="/unlock">${csrf()}<label>Master password</label><input type="password" name="password" autocomplete="current-password" autofocus required><button>Unlock</button></form>`,
        { nav: false, local: true },
      );
    const c = app.cfg;
    const pub = c.publicUrl.replace(/\/$/, "");
    const st = (on: boolean, s: string) => `<span class="${on ? "ok" : "hint"}">${esc(s)}</span>`;
    return page(
      "DInstinct",
      `<h1>${c.ownerName ? `Hi ${esc(c.ownerName)}` : "DInstinct"}</h1><p class="sub">Your assistant is <b class="ok">on duty</b> · ${app.core.session.busy ? "working on a task" : "ready"} · ${esc(app.core.llm().name)}</p>${note}
${!c.setupDone ? `<div class="card" style="border-color:var(--acc)"><h2>Finish setting up</h2><p>A few quick steps and you can text your assistant from your phone.</p><a href="/welcome?step=1"><button type="button">Continue setup</button></a></div>` : ""}
<div class="card"><h2>Reach me on my phone</h2>${
        app.tunnel.state === "on"
          ? `<p class="ok">✓ On. Secure links open on your phone.</p><form method="post" action="/remote">${csrf()}<input type="hidden" name="on" value="0"><button class="ghost">Turn off</button></form>`
          : app.tunnel.state === "installing" || app.tunnel.state === "starting"
            ? `<p>${esc(app.tunnel.message)}</p><a href="/"><button type="button" class="ghost">Refresh</button></a>`
            : `${app.tunnel.state === "error" ? `<p class="bad">${esc(app.tunnel.message)}</p>` : `<p class="hint">Off. Secure links only open on this PC.</p>`}<form method="post" action="/remote">${csrf()}<input type="hidden" name="on" value="1"><button>Turn on</button></form>`
      }</div>
<div class="card"><h2>Sign in to your accounts</h2><p class="hint">Sign in once in the assistant's browser (Gmail, shops, bookings) and it stays signed in.</p><a href="/welcome?step=4"><button type="button" class="ghost">Open sign-in</button></a></div>
<div class="card"><h2>Channels</h2><table>
<tr><td>Telegram</td><td>${app.telegram ? st(app.telegram.status.startsWith("running"), app.telegram.status) : st(false, c.telegram.enabled ? "needs bot token" : "off")}</td></tr>
<tr><td>WhatsApp</td><td>${app.whatsapp ? st(true, app.whatsapp.status) : st(false, c.whatsapp.enabled ? "needs access token" : "off")} · <a href="/whatsapp">${c.whatsapp.allowedNumbers.length ? "manage" : "set up"}</a>${c.whatsapp.enabled ? `<div class="hint">Webhook URL: <code>${esc(pub || "(set a public URL)")}/wa/webhook</code><br>Verify token: <code>${esc(app.vault.getSystem("whatsapp_verify_token"))}</code></div>` : ""}</td></tr>
<tr><td>iMessage</td><td>${app.imessage ? st(true, app.imessage.status) : st(false, c.imessage.enabled ? "needs Sendblue keys" : "off")}${c.imessage.enabled ? `<div class="hint">Sendblue receive webhook: <code>${esc(pub || "(set a public URL)")}/imessage/webhook/${esc(app.vault.getSystem("imessage_webhook_secret"))}</code><br>Text <b>${esc(c.imessage.fromNumber || "(your Sendblue number)")}</b> from your iPhone.</div>` : ""}</td></tr>
<tr><td>Phone calls</td><td>${st(c.phone.enabled, c.phone.enabled ? (app.vault.getSystem("twilio_auth_token") ? "on" : "needs Twilio auth token") : "off")}${c.phone.enabled ? `<div class="hint">Twilio voice webhook: <code>${esc(pub || "(set a public URL)")}/voice/incoming</code></div>` : ""}</td></tr>
<tr><td>Google</td><td>${app.core.google.connected() ? st(true, app.vault.getSystem("google_email") || "connected") : `<a href="/data">connect</a>`}</td></tr>
<tr><td>Proactive</td><td>${st(c.proactive.enabled, c.proactive.enabled ? `on · briefing ${c.proactive.briefing ? c.proactive.briefingTime : "off"} · quiet ${c.proactive.quietStart}–${c.proactive.quietEnd} · via ${c.notifyChannel}` : "off")}</td></tr>
<tr><td>Siri Shortcut</td><td>${st(c.iphone.enabled, c.iphone.enabled ? "on" : "off")}${c.iphone.enabled ? `<div class="hint">Shortcut URL: <code>${esc(pub || "(set a public URL)")}/iphone</code><br>Header <code>Authorization: Bearer ${esc(app.vault.getSystem("iphone_token"))}</code></div>` : ""}</td></tr>
</table></div>
<form class="card" method="post" action="/lock">${csrf()}<h2>Lock</h2><p class="hint">Stops the channels and the browser and wipes the key from memory.</p><button class="ghost">Lock now</button></form>
<form class="card" method="post" action="/password">${csrf()}<h2>Change master password</h2><div class="row"><div><label>Current</label><input type="password" name="old" required></div><div><label>New (${MIN_PASSWORD}+ characters)</label><input type="password" name="new" required minlength="${MIN_PASSWORD}"></div></div><button class="ghost">Change</button></form>`,
    );
  };

  const vaultPage = (msg = "") => {
    const rows = app.vault
      .entries()
      .map(
        (e) => `<tr><td><b>${esc(e.name)}</b><br><span class="pill">${e.kind}</span></td><td>${e.sites.map(esc).join("<br>") || '<span class="hint">no sites</span>'}</td>
<td>${Object.keys(e.fields).map(esc).join(", ")}</td><td><form method="post" action="/vault/delete">${csrf()}<input type="hidden" name="id" value="${esc(e.id)}"><button class="ghost" style="margin:0">Delete</button></form></td></tr>`,
      )
      .join("");
    const mems = app.vault
      .memories()
      .map((m) => `<tr><td>${esc(m.text)}</td><td><form method="post" action="/memory/delete">${csrf()}<input type="hidden" name="id" value="${esc(m.id)}"><button class="ghost" style="margin:0">Forget</button></form></td></tr>`)
      .join("");
    return page(
      "Vault",
      `<h1>Vault</h1><p class="sub">Encrypted on this PC. The assistant can see names, sites and field names, never values, and can only type a value into the sites listed.</p>${msg ? `<p class="bad">${esc(msg)}</p>` : ""}
<div class="card"><table><tr><th>Name</th><th>Allowed sites</th><th>Fields</th><th></th></tr>${rows || '<tr><td colspan="4" class="hint">Empty</td></tr>'}</table></div>
<form class="card" method="post" action="/vault/add">${csrf()}<h2>Add or update an entry</h2>
<p class="rule">${esc(BANK_RULE)} Saving one is refused. For shopping, keep a payment method saved on the store's own site; DInstinct asks you before every order.</p>
<div class="row"><div><label>Name</label><input name="name" required placeholder="Anghami"></div><div><label>Kind</label><select name="kind">${ENTRY_KINDS.map((k) => `<option>${k}</option>`).join("")}</select></div></div>
<label>Allowed sites (comma separated)</label><input name="sites" placeholder="anghami.com">
<div class="row"><div><label>Username / email</label><input name="username" autocomplete="off"></div><div><label>Password</label><input type="password" name="password" autocomplete="new-password"></div></div>
<label>Other fields, one per line as key=value (e.g. phone=…, address=…, membership=…)</label><textarea name="extra" rows="3" autocomplete="off"></textarea>
<button>Save encrypted</button></form>
<div class="card"><h2>Memories</h2><table>${mems || '<tr><td class="hint">Nothing remembered yet</td></tr>'}</table></div>`,
    );
  };

  const secretInput = (name: string, label: string) =>
    `<label>${label} ${app.vault.getSystem(name) ? '<span class="pill">saved</span>' : ""}</label><input type="password" name="${name}" autocomplete="off" placeholder="${app.vault.getSystem(name) ? "leave blank to keep · type clear to remove" : ""}">`;

  const settingsPage = () => {
    const c = app.cfg;
    const sel = (v: string, cur: string) => `<option${v === cur ? " selected" : ""}>${v}</option>`;
    const chk = (name: string, on: boolean) => `<input type="checkbox" name="${name}"${on ? " checked" : ""}>`;
    return page(
      "Settings",
      `<h1>Settings</h1><p class="sub">Everything here is saved encrypted on this PC. Not sure? Use the <a href="/welcome?step=1">setup guide</a> instead.</p>
${c.llm.provider === "claude" ? claudeCard(false) : c.llm.provider === "free" ? freeCard(false) : ""}
<form method="post" action="/settings">${csrf()}
<div class="card"><h2>You</h2><label>What should it call you?</label><input name="ownerName" value="${esc(c.ownerName)}"></div>
<div class="card"><h2>Assistant's brain</h2><label>Which AI</label><select name="provider"><option value="claude"${c.llm.provider === "claude" ? " selected" : ""}>Smart: Claude (paid, best results)</option><option value="free"${c.llm.provider === "free" ? " selected" : ""}>Free: free models via FreeLLMAPI</option><option value="ollama"${c.llm.provider === "ollama" ? " selected" : ""}>Private: only on this PC (Ollama)</option></select>
${c.llm.provider === "free" ? freeModelPicker() : modelPicker()}
<details><summary class="hint" style="cursor:pointer">I have a Claude key instead</summary>${secretInput("anthropic_api_key", "Claude key (from console.anthropic.com)")}</details>
<p class="hint">Tip: start any message with <b>private:</b> to keep just that task on this PC.</p></div>
<div class="card"><h2>When it messages you first</h2>
<label>Send reminders and updates on</label><select name="notifyChannel">${(["telegram", "imessage", "whatsapp", "none"] as const).map((x) => `<option value="${x}"${x === c.notifyChannel ? " selected" : ""}>${{ telegram: "Telegram", imessage: "iMessage", whatsapp: "WhatsApp", none: "Nowhere (off)" }[x]}</option>`).join("")}</select>
<label>${chk("proEnabled", c.proactive.enabled)}Let it start conversations (reminders, heads-ups)</label>
<label>${chk("proBriefing", c.proactive.briefing)}Morning summary of my day</label>
<label>${chk("proCalendar", c.proactive.calendarAlerts)}Warn me about calendar clashes</label>
<div class="row"><div><label>Morning summary at</label><input type="time" name="briefingTime" value="${esc(c.proactive.briefingTime)}"></div><div><label>Don't disturb from</label><input type="time" name="quietStart" value="${esc(c.proactive.quietStart)}"></div><div><label>until</label><input type="time" name="quietEnd" value="${esc(c.proactive.quietEnd)}"></div></div></div>
<div class="card"><h2>Spending limits</h2><p class="hint">It always asks you before buying anything, and refuses anything over these limits. 0 = no limit.</p>
<div class="row"><div><label>Max per order</label><input type="number" min="0" step="1" name="perOrder" value="${c.spending.perOrder}"></div><div><label>Max per month</label><input type="number" min="0" step="1" name="perMonth" value="${c.spending.perMonth}"></div><div><label>Currency</label><input name="currency" value="${esc(c.spending.currency)}" maxlength="5"></div></div></div>
<button>Save</button>
<details class="card adv"><summary><b>Advanced</b> <span class="hint">(other chat apps, phone calls, Google, cloud browser, technical options)</span></summary>
<div class="card"><h2>AI fine-tuning</h2><div class="row">
<div><label>Other Claude model ID (overrides the list; e.g. a new or older model)</label><input name="claudeModelCustom" placeholder="claude-…" autocomplete="off"></div><div><label>Thinking effort (lower = faster and cheaper)</label><select name="claudeEffort">${["low", "medium", "high", "xhigh", "max"].map((e) => sel(e, c.llm.claudeEffort)).join("")}</select></div></div>
<div class="row"><div><label>Ollama URL</label><input name="ollamaUrl" value="${esc(c.llm.ollamaUrl)}"></div><div><label>Ollama model</label><input name="ollamaModel" value="${esc(c.llm.ollamaModel)}"></div></div>
<label>Public URL (filled in automatically by "Reach me on my phone"; set your own fixed address here)</label><input name="publicUrl" value="${esc(c.publicUrl)}" placeholder="https://dinstinct.example.com"></div>
<div class="card"><h2>Browser</h2><label>Where the assistant browses</label><select name="browserMode">
<option value="auto"${c.browser.mode === "auto" ? " selected" : ""}>Automatic (cloud if a Browserbase key is saved, otherwise this PC)</option>
<option value="browserbase"${c.browser.mode === "browserbase" ? " selected" : ""}>Cloud: Browserbase (keeps logins between tasks)</option>
<option value="cdp"${c.browser.mode === "cdp" ? " selected" : ""}>Cloud: other provider (CDP WebSocket URL)</option>
<option value="local"${c.browser.mode === "local" ? " selected" : ""}>This PC (Edge)</option></select>
${secretInput("browserbase_api_key", "Browserbase API key")}
<label>Browserbase region</label><select name="bbRegion">${["us-west-2", "us-east-1", "eu-central-1", "ap-southeast-1"].map((r) => sel(r, c.browser.browserbaseRegion)).join("")}</select>
${secretInput("cloud_browser_cdp_url", "Other provider CDP URL (wss://…, includes its token)")}
<label>${chk("headless", c.browser.headless)}This PC mode: hide the browser window</label>
<p class="hint">With a cloud browser, the vault file stays on this PC, but a saved value is sent to the cloud browser at the moment the assistant types it into a site.</p></div>
<div class="card"><h2>Telegram</h2><label>${chk("tgEnabled", c.telegram.enabled)}Enabled</label>${secretInput("telegram_bot_token", "Bot token (from @BotFather)")}
<label>Allowed Telegram user ids (comma separated)</label><input name="tgAllowed" value="${esc(c.telegram.allowedUserIds.join(", "))}"></div>
<div class="card"><h2>WhatsApp (Cloud API)</h2><p><a href="/whatsapp">Use the guided WhatsApp setup →</a></p><label>${chk("waEnabled", c.whatsapp.enabled)}Enabled</label>
<div class="row"><div><label>Phone number ID</label><input name="waPhoneId" value="${esc(c.whatsapp.phoneNumberId)}"></div><div><label>Your WhatsApp number(s), with country code</label><input name="waAllowed" value="${esc(c.whatsapp.allowedNumbers.join(", "))}"></div></div>
${secretInput("whatsapp_access_token", "Access token")}${secretInput("whatsapp_app_secret", "App secret (verifies webhooks)")}</div>
<div class="card"><h2>iMessage (Sendblue)</h2><label>${chk("imEnabled", c.imessage.enabled)}Enabled</label>
<div class="row"><div><label>Assistant's Sendblue number (+1…)</label><input name="imFrom" value="${esc(c.imessage.fromNumber)}"></div><div><label>Your iPhone number(s) / Apple ID email(s)</label><input name="imAllowed" value="${esc(c.imessage.allowedHandles.join(", "))}"></div></div>
${secretInput("sendblue_api_key_id", "Sendblue API key ID")}${secretInput("sendblue_api_secret", "Sendblue API secret key")}</div>
<div class="card"><h2>Phone calls (Twilio)</h2><label>${chk("phoneEnabled", c.phone.enabled)}Enabled</label>
<div class="row"><div><label>Your phone number(s) allowed to call</label><input name="phoneAllowed" value="${esc(c.phone.allowedNumbers.join(", "))}"></div>
<div><label>Speech language</label><select name="phoneLang">${["en-US", "en-GB", "ar-EG", "ar-SA", "fr-FR", "de-DE", "es-ES"].map((l) => sel(l, c.phone.language)).join("")}</select></div></div>
${secretInput("twilio_auth_token", "Twilio auth token (verifies calls)")}
<p class="hint">In Twilio, set your number's "A call comes in" webhook to <code>${esc(c.publicUrl || "(public URL)")}/voice/incoming</code> (HTTP POST).</p></div>
<div class="card"><h2>Siri Shortcut</h2><label>${chk("iphoneEnabled", c.iphone.enabled)}Enabled</label></div>
<div class="card"><h2>Company network certificate</h2>
<p class="hint">Only if your workplace firewall (Fortinet, Zscaler, Sophos…) inspects secure connections and DInstinct says it can't reach Claude. Ask IT for the firewall's <i>SSL inspection CA certificate</i> and paste it here. ${fs.existsSync(path.join(DATA, "company-ca.pem")) ? `<b>Currently trusted:</b> ${esc(companyCAName())}. Type <b>clear</b> to remove.` : ""}</p>
<textarea name="company_ca" rows="4" placeholder="-----BEGIN CERTIFICATE-----" spellcheck="false"></textarea></div>
<div class="card"><h2>Google Workspace OAuth client</h2><p class="hint">Google Cloud console → APIs &amp; Services → Credentials → OAuth client ID → <b>Web application</b>, redirect URI <code>http://127.0.0.1:${c.port}/google/callback</code>. Then connect on the Data &amp; connections page.</p>
<label>Client ID</label><input name="google_client_id" value="${esc(app.vault.getSystem("google_client_id"))}" autocomplete="off">${secretInput("google_client_secret", "Client secret")}</div>
<button>Save</button></details></form>`,
    );
  };

  // ---------- welcome guide (plain language, one thing per step) ----------

  const steps = ["Brain", "Chat", "Phone access", "Your accounts"];
  const welcome = (step: number, msg = "") => {
    const c = app.cfg;
    const dots = `<p class="hint">Step ${step} of ${steps.length} · ${steps.map((s, i) => (i + 1 === step ? `<b>${s}</b>` : s)).join(" → ")}</p>`;
    const err = msg ? `<p class="bad">${esc(msg)}</p>` : "";
    const skip = (to: number, label = "Skip for now") => `<a class="hint" href="/welcome?step=${to}">${label}</a>`;
    let body = "";
    let refresh = false;
    if (step === 1) {
      const hasKey = !!app.vault.getSystem("anthropic_api_key");
      const L = app.claudeLogin;
      refresh = L.state === "installing" || L.state === "waiting" || L.state === "checking";
      body = `<h1>Let's set up your assistant</h1><p class="sub">Four quick steps. You can change everything later.</p>${dots}${err}
${c.llm.provider === "free" ? freeCard(true) : claudeCard(true)}
<form class="card" method="post" action="/welcome/brain">${csrf()}
<label>What should it call you?</label><input name="ownerName" value="${esc(c.ownerName)}" placeholder="Your first name">
<label style="margin-top:14px"><input type="radio" name="brain" value="claude"${c.llm.provider === "claude" ? " checked" : ""}> Use <b>Claude</b> (smart, recommended)</label>
<label><input type="radio" name="brain" value="free"${c.llm.provider === "free" ? " checked" : ""}> Use <b>free models</b> (Gemini, Groq, Qwen…) through the free FreeLLMAPI app. No cost; less capable than Claude.</label>
<label><input type="radio" name="brain" value="ollama"${c.llm.provider === "ollama" ? " checked" : ""}> Use <b>Private</b> mode: runs only on this PC with Ollama. Free, but needs a powerful computer and is slower.</label>
<details style="margin-top:10px"><summary class="hint" style="cursor:pointer">I have a Claude key instead</summary>
<input name="key" type="password" autocomplete="off" placeholder="${hasKey ? "Key saved ✓ (paste a new one to replace it)" : "sk-ant-…"}" style="margin-top:8px"></details>
<button>Continue</button></form>`;
    } else if (step === 2) {
      const tg = app.telegram;
      const p = app.pairing;
      if (p?.paired) {
        body = `<h1>You're connected 🎉</h1>${dots}<div class="card"><p>Paired with <b>${esc(p.paired)}</b> on Telegram. Send your assistant a message any time, like you'd text a friend.</p>
<p class="hint">Try: "What's the weather tomorrow?" or "Find me a table for two on Friday."</p><a href="/welcome?step=3"><button type="button">Continue</button></a></div>`;
      } else if (tg && p && tg.username) {
        refresh = true;
        body = `<h1>Say hello to your assistant</h1>${dots}<div class="card">
<p>1. Open your bot on your phone: <a href="https://t.me/${esc(tg.username)}?start=${p.code}" target="_blank" rel="noopener"><b>t.me/${esc(tg.username)}</b></a></p>
<p>2. Tap <b>Start</b> (or send this code):</p><p style="font-size:36px;font-weight:700;letter-spacing:6px;margin:6px 0">${p.code}</p>
<p class="hint">This page updates by itself once you're paired. The code works for 15 minutes.</p></div>`;
      } else if (tg && !tg.username && tg.status.startsWith("error")) {
        body = `<h1>Chat with it on Telegram</h1>${dots}<p class="bad">That bot token didn't work. Copy it again from BotFather.</p>${telegramForm()}`;
      } else if (tg && !tg.username) {
        refresh = true;
        body = `<h1>Connecting to Telegram…</h1>${dots}<p class="sub">One moment.</p>`;
      } else {
        body = `<h1>Where do you want to chat?</h1><p class="sub">The easiest is <b>Telegram</b>: free, works on any phone, and needs no extra setup.</p>${dots}${err}${telegramForm()}
<div class="card"><h2>WhatsApp</h2><p class="hint">Your assistant gets its own WhatsApp number (free test number from Meta). Takes about 10 minutes with a guided page.</p><a href="/whatsapp"><button type="button" class="ghost">Set up WhatsApp</button></a></div>
<p class="hint">iMessage and phone calls need paid accounts; you can add them later in Settings → Advanced.</p>${skip(3)}`;
      }
    } else if (step === 3) {
      const t = app.tunnel;
      refresh = t.state === "installing" || t.state === "starting";
      const status =
        t.state === "on" ? `<p class="ok">✓ On. Your phone can now open the secure links DInstinct sends you.</p><a href="/welcome?step=4"><button type="button">Continue</button></a>`
        : refresh ? `<p>${esc(t.message || "Working…")}</p><p class="hint">This page updates by itself.</p>`
        : `${t.state === "error" ? `<p class="bad">${esc(t.message)}</p>` : ""}<form method="post" action="/welcome/remote">${csrf()}<button>Turn on</button></form>`;
      body = `<h1>Let it reach your phone</h1><p class="sub">When your assistant needs a password, it sends you a secure link instead of asking in the chat. Turn this on so those links open on your phone, not only on this PC.</p>${dots}
<div class="card">${status}<p class="hint">Uses a free, encrypted Cloudflare connection. Only the secure links go through it; your settings and vault stay reachable from this PC only.</p></div>${skip(4)}`;
    } else {
      const local = !app.core.browser.isCloud();
      body = `<h1>Sign in to your accounts</h1><p class="sub">Your assistant uses its own browser. Sign in there once (Gmail, Amazon, your favourite shops…) and it stays signed in.</p>${dots}${msg ? `<p class="ok">${esc(msg)}</p>` : ""}
<div class="card">${local ? `<form method="post" action="/welcome/signin">${csrf()}<button>Open the assistant's browser</button></form><p class="hint">A browser window opens on this PC. Sign in to the sites you use, then just leave it. Don't save bank cards there; DInstinct never handles bank details.</p>` : `<p>Your assistant uses a cloud browser. When it needs to sign in somewhere, it will send you a secure link.</p>`}</div>
<form method="post" action="/welcome/finish">${csrf()}<button>Finish</button></form>`;
    }
    const html = page("Welcome", body, { nav: false, local: true });
    return refresh ? html.replace("<head>", '<head><meta http-equiv="refresh" content="3">') : html;
  };

  /** "Free models" card: install FreeLLMAPI, add free keys there, paste one key here. */
  const freeCard = (inGuide: boolean) => {
    const connected = !!app.vault.getSystem("freellm_api_key") && app.freeStatus.ok;
    const back = inGuide ? '<input type="hidden" name="back" value="guide">' : "";
    return `<div class="card"><h2>Free models (FreeLLMAPI)</h2>
${connected ? `<p class="ok">✓ Connected to FreeLLMAPI on this PC (${app.freeModels.length ? `${app.freeModels.length - 4} free models ready` : "ready"}).</p>` : ""}
${app.freeStatus.message ? `<p class="bad">${esc(app.freeStatus.message)}</p>` : ""}
<p>Use free AI models (Gemini, Groq, Qwen, DeepSeek, GLM…) at no cost, through the free open-source <b>FreeLLMAPI</b> app:</p>
<p>1. Install <a href="https://apps.microsoft.com/detail/9PBN6G8K2B7F" target="_blank" rel="noopener"><b>FreeLLMAPI from the Microsoft Store</b></a> and open it (it sits in the tray, by the clock).</p>
<p>2. In its dashboard (tray icon → <i>Open Dashboard</i>) go to <b>Keys</b> and add free keys. Easiest: a <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google Gemini key</a> and a <a href="https://console.groq.com/keys" target="_blank" rel="noopener">Groq key</a>; both are free with just an account.</p>
<p>3. Tray icon → <b>Copy Key</b>, and paste it here:</p>
<form method="post" action="/free/connect">${csrf()}${back}<input name="key" type="password" autocomplete="off" required placeholder="${app.vault.getSystem("freellm_api_key") ? "Key saved ✓ (paste again to reconnect)" : "freellmapi-…"}"><button>Connect free models</button></form>
<p class="hint">Good to know: free models are less capable than Claude at long website tasks, and some free providers may use what you send to improve their models (check each provider's terms). Your vault passwords and bank details are never sent to any model. For sensitive tasks, start your message with <b>private:</b>.</p></div>`;
  };

  /** Claude model menu, filled from the live list of models this account can use. */
  const modelPicker = () => {
    const cur = app.cfg.llm.claudeModel;
    const models = cachedModels();
    const tip = (id: string) =>
      /fable|mythos/.test(id) ? "most capable" : /opus/.test(id) ? "very smart" : /sonnet/.test(id) ? "fast and smart" : /haiku/.test(id) ? "fastest, cheapest" : "";
    const opts = models.map((m) => `<option value="${esc(m.id)}"${m.id === cur ? " selected" : ""}>${esc(m.name)}${tip(m.id) ? ` (${tip(m.id)})` : ""}${m.id === DEFAULTS.llm.claudeModel ? " · recommended" : ""}</option>`);
    if (!models.some((m) => m.id === cur)) opts.unshift(`<option value="${esc(cur)}" selected>${esc(cur)}</option>`);
    return `<label>Claude model</label><select name="claudeModel">${opts.join("")}</select>
<p class="hint">${models.length ? `${models.length} models available on your account.` : "Sign in to Claude to see every model on your account."} Bigger models think better; smaller ones answer faster and cost less. <a href="/settings?refreshModels=1">Refresh list</a></p>`;
  };

  const freeModelPicker = () => {
    const cur = app.cfg.llm.freeModel;
    const list = app.freeModels.length ? app.freeModels : [{ id: "auto:smart", label: "Automatic, smartest free model (recommended)" }];
    const opts = list.map((m) => `<option value="${esc(m.id)}"${m.id === cur ? " selected" : ""}>${esc(m.id.startsWith("auto") ? m.label : m.id)}</option>`);
    if (!list.some((m) => m.id === cur)) opts.unshift(`<option value="${esc(cur)}" selected>${esc(cur)}</option>`);
    return `<label>Free model</label><select name="freeModel">${opts.join("")}</select><p class="hint">"Automatic" lets FreeLLMAPI pick a free model that's available right now and switch if one runs out.</p>`;
  };

  // ---------- guided WhatsApp setup ----------

  const whatsappPage = (msg = "", ok = "") => {
    const w = app.cfg.whatsapp;
    const v = app.vault;
    const hasApp = !!(w.appId && v.getSystem("whatsapp_app_secret"));
    const hasToken = !!(v.getSystem("whatsapp_access_token") && w.phoneNumberId);
    const connected = !!app.cfg.publicUrl && v.getState("whatsapp_webhook_url", "") === app.cfg.publicUrl && w.enabled;
    const paired = w.allowedNumbers.length > 0;
    const current = !hasApp ? 1 : !hasToken ? 2 : !connected ? 3 : !paired ? 4 : 5;
    const done = (n: number, title: string, summary: string) => `<div class="card"><h2>✓ ${n}. ${title}</h2><p class="hint">${summary}</p></div>`;
    const todo = (n: number, title: string) => `<div class="card" style="opacity:.6"><h2>${n}. ${title}</h2></div>`;
    const msgs = `${msg ? `<p class="bad">${esc(msg)}</p>` : ""}${ok ? `<p class="ok">${esc(ok)}</p>` : ""}`;
    let refresh = false;
    const cards: string[] = [];

    // 1. Meta app
    if (current > 1) cards.push(done(1, "Your WhatsApp app at Meta", `App ID ${esc(w.appId)}`));
    else
      cards.push(`<div class="card" style="border-color:var(--acc)"><h2>1. Create your WhatsApp app at Meta</h2>${msgs}
<p>WhatsApp needs a free "app" at Meta (Facebook's company). It takes about 5 minutes:</p>
<p>1. Click <a href="https://business.facebook.com/business/loginpage/?next=https%3A%2F%2Fdevelopers.facebook.com%2Fapps%2F" target="_blank" rel="noopener"><b>Open Meta for Developers</b></a> and click <b>Continue with Facebook</b> (or <i>Create new account</i>). You land on <b>My Apps</b>.
<br><span class="hint">First time? Meta first asks you to register as a developer (confirm your phone/email, accept the terms). Then click <b>My Apps</b> at the top right.</span></p>
<p>&nbsp;&nbsp;&nbsp;Click <b>Create App</b>. Type a name (e.g. "My DInstinct") and your email.</p>
<p>2. Choose the use case <b>Connect with customers through WhatsApp</b> → <b>Next</b>.</p>
<p>3. Pick your business portfolio, or create one (any name is fine) → <b>Next</b> → <b>Create app</b>.</p>
<p>4. On the <b>Quickstart</b> page click <b>Start using the API</b>. If asked, choose or create a WhatsApp Business account; Meta gives you a free test number.</p>
<p>5. In the left menu open <b>App settings → Basic</b>. Copy the <b>App ID</b> and the <b>App secret</b> (click <i>Show</i>) into here:</p>
<form method="post" action="/whatsapp/app">${csrf()}<div class="row"><div><label>App ID</label><input name="appId" inputmode="numeric" autocomplete="off" required value="${esc(w.appId)}"></div>
<div><label>App secret</label><input name="secret" type="password" autocomplete="off" required></div></div><button>Check and save</button></form></div>`);

    // 2. Access token → number found automatically
    if (current > 2) {
      const exp = w.tokenExpires ? ` · token expires ${new Date(w.tokenExpires).toLocaleString()}` : " · permanent token";
      cards.push(done(2, "WhatsApp number", `${esc(w.displayNumber)}${exp}`));
    } else if (current === 2)
      cards.push(`<div class="card" style="border-color:var(--acc)"><h2>2. Give DInstinct access to the number</h2>${msgs}
<p>1. In your Meta app, open <b>API Setup</b> (from Quickstart: <i>Start using the API</i>).</p>
<p>2. Click <b>Generate access token</b> (allow the permissions it asks for), then copy the long code.</p>
<p>3. Paste it here. DInstinct finds your WhatsApp number by itself.</p>
<form method="post" action="/whatsapp/token">${csrf()}<label>Access token</label><input name="token" type="password" autocomplete="off" required placeholder="EAAG…"><button>Check and save</button></form>
<p class="hint">While you're on API Setup: with Meta's free <b>test number</b>, put your own WhatsApp number in the <b>To</b> field and confirm the code WhatsApp sends you. The test number can only reply to numbers added there.</p></div>`);
    else cards.push(todo(2, "Give DInstinct access to the number"));

    // 3. Webhook
    const manual = `<details style="margin-top:10px"><summary class="hint" style="cursor:pointer">Messages not arriving? Set it in Meta by hand</summary>
<p class="hint">In your Meta app open <b>Use cases → Customize → Configuration</b> (older apps: <b>WhatsApp → Configuration</b>). Under Webhook click <b>Edit</b>:</p>
<p class="hint">Callback URL: <code>${esc((app.cfg.publicUrl || "(turn on phone access first)").replace(/\/$/, ""))}/wa/webhook</code><br>Verify token: <code>${esc(v.getSystem("whatsapp_verify_token"))}</code></p>
<p class="hint">Click <b>Verify and save</b>, then under Webhook fields turn on <b>messages</b> (Subscribe). Note: the free secure address changes when DInstinct restarts; DInstinct updates Meta automatically, but a hand-entered address must be updated by hand.</p></details>`;
    if (current > 3) cards.push(done(3, "Connected to Meta", "Messages to the number now reach DInstinct. If the secure address changes, DInstinct tells Meta by itself.") .replace("</p></div>", `</p>${manual}</div>`));
    else if (current === 3) {
      const t = app.tunnel;
      refresh = t.state === "installing" || t.state === "starting";
      cards.push(`<div class="card" style="border-color:var(--acc)"><h2>3. Connect it</h2>${msgs}
${
  !app.cfg.publicUrl || t.state !== "on"
    ? refresh
      ? `<p>${esc(t.message || "Connecting…")}</p><p class="hint">This page updates by itself.</p>`
      : `<p>WhatsApp has to reach this PC over the internet. Turn on the secure connection first:</p><form method="post" action="/whatsapp/remote">${csrf()}<button>Turn on</button></form>${t.state === "error" ? `<p class="bad">${esc(t.message)}</p>` : ""}`
    : `<p>One click and DInstinct tells Meta where to deliver your messages.</p><form method="post" action="/whatsapp/connect">${csrf()}<button>Connect WhatsApp</button></form>${manual}`
}</div>`);
    } else cards.push(todo(3, "Connect it"));

    // 4. Pair
    if (current > 4) cards.push(done(4, "Paired", `Your number: +${esc(w.allowedNumbers.join(", +"))}`));
    else if (current === 4) {
      const p = app.pairing;
      const digitsOnly = w.displayNumber.replace(/\D/g, "");
      if (p && !p.paired && Date.now() < p.expires) {
        refresh = true;
        cards.push(`<div class="card" style="border-color:var(--acc)"><h2>4. Say hello</h2>
<p>On your phone, send this code to <b>${esc(w.displayNumber)}</b> on WhatsApp:</p>
<p style="font-size:36px;font-weight:700;letter-spacing:6px;margin:6px 0">${p.code}</p>
<p><a href="https://wa.me/${digitsOnly}?text=${p.code}" target="_blank" rel="noopener"><button type="button">Open WhatsApp with the code</button></a></p>
<p class="hint">This page updates by itself once you're paired. Nothing arriving? Check the "To" list from step 2.</p></div>`);
      } else
        cards.push(`<div class="card" style="border-color:var(--acc)"><h2>4. Say hello</h2><p>Get a code and send it from your phone, and DInstinct will know it's you.</p>
<form method="post" action="/whatsapp/pair">${csrf()}<button>Get my code</button></form></div>`);
    } else cards.push(todo(4, "Say hello"));

    if (current === 5)
      cards.unshift(`<div class="card" style="border-color:var(--ok)"><h2>🎉 WhatsApp is ready</h2><p>Message <b>${esc(w.displayNumber)}</b> any time. Reminders and updates can come here too (Settings → "Send reminders and updates on").</p>
${w.tokenExpires ? `<p class="bad">Your access token is temporary and stops working ${new Date(w.tokenExpires).toLocaleString()}.</p>` : ""}</div>`);

    const permanent = `<details class="card"><summary><b>Make the access token permanent</b> <span class="hint">(the one from step 2 expires quickly)</span></summary>
<p>1. Open <a href="https://business.facebook.com/latest/settings/system_users" target="_blank" rel="noopener">Meta Business settings → System Users</a> → <b>+ Add</b> → name it "DInstinct", role <b>Admin</b>.</p>
<p>2. Open it and click <b>Assign assets</b>: choose your <b>app</b> and turn on <i>Manage app</i> (Full control); then your <b>WhatsApp account</b> and turn on <i>Manage WhatsApp Business accounts</i> (Full control) → <b>Assign assets</b>.</p>
<p>3. Click <b>Generate token</b> → pick your app → choose the longest expiry offered (<b>Never</b> if shown) → tick <i>business_management</i>, <i>whatsapp_business_management</i> and <i>whatsapp_business_messaging</i> → <b>Generate token</b>.</p>
<p>4. Paste it here (DInstinct checks it and shows if it ever expires):</p><form method="post" action="/whatsapp/token">${csrf()}<input name="token" type="password" autocomplete="off" required><button>Save permanent token</button></form></details>`;

    const html = page(
      "WhatsApp setup",
      `<h1>Set up WhatsApp</h1><p class="sub">Like Instinct: your assistant gets its own WhatsApp number and you chat with it. Four steps; DInstinct checks each one for you.</p>
${cards.join("")}${current >= 3 ? permanent : ""}`,
    );
    return refresh ? html.replace("<head>", '<head><meta http-equiv="refresh" content="3">') : html;
  };

  /** The "Sign in with Claude" card, used in the setup guide and in Settings. */
  const claudeCard = (inGuide: boolean) => {
    const L = app.claudeLogin;
    const hasKey = !!app.vault.getSystem("anthropic_api_key");
    let inner: string;
    if (L.state === "ok")
      inner = `<p class="ok">✓ Claude is connected${L.account ? ` (${esc(L.account)})` : ""}.</p><p class="hint">Make sure your account has credit: <a href="https://console.anthropic.com/settings/billing" target="_blank" rel="noopener">add credit</a> (a few dollars lasts a long time).</p>
<form method="post" action="/claude/signout">${csrf()}<button class="ghost">Sign out</button></form>`;
    else if (L.state === "installing" || L.state === "waiting" || L.state === "checking")
      inner = `<p><b>${esc(L.message)}</b></p><p class="hint">This page updates by itself.</p>${inGuide ? "" : `<a href="/settings"><button type="button" class="ghost">Refresh</button></a>`}`;
    else if (hasKey && !inGuide) inner = `<p class="ok">✓ Using your saved Claude key.</p>`;
    else
      inner = `${L.state === "error" ? `<p class="bad">${esc(L.message)}</p><form method="post" action="/claude/check">${csrf()}${inGuide ? '<input type="hidden" name="back" value="guide">' : ""}<button class="ghost">Check again</button></form>` : ""}<p>Click the button, sign in to Anthropic in the browser window that opens (or create a free account), and you're done. No codes to copy.</p>
<form method="post" action="/claude/signin">${csrf()}${inGuide ? '<input type="hidden" name="back" value="guide">' : ""}<button>Sign in with Claude</button></form>
<p class="hint">New accounts need a little credit to work: Anthropic shows you how after you sign in.</p>`;
    return `<div class="card"><h2>Connect Claude</h2>${inner}</div>`;
  };

  const telegramForm = () => `<form class="card" method="post" action="/welcome/telegram">${csrf()}
<h2>Telegram (recommended)</h2>
<p>1. On your phone, open <a href="https://t.me/BotFather" target="_blank" rel="noopener"><b>@BotFather</b></a> in Telegram.</p>
<p>2. Send <b>/newbot</b>, then pick any name, e.g. "My DInstinct".</p>
<p>3. BotFather replies with a long code (the <i>token</i>). Copy it and paste it here:</p>
<input name="token" autocomplete="off" placeholder="123456789:AA…" required><button>Connect</button></form>`;

  const dataPage = (msg = "") => {
    const g = app.core.google;
    const email = app.vault.getSystem("google_email");
    const reminders = app.vault.getState<any[]>("reminders", []);
    const spend = app.vault.getState<{ month: string; total: number }>("spend", { month: "", total: 0 });
    const month = new Date().toISOString().slice(0, 7);
    const s = app.cfg.spending;
    const llm = app.cfg.llm.provider === "ollama" ? "your local model (nothing leaves this PC)" : `Claude via the Anthropic API (not used for model training by default)`;
    return page(
      "Data & connections",
      `<h1>Data &amp; connections</h1><p class="sub">What DInstinct can reach, what it keeps, and how to take it all back.</p>${msg ? `<p class="${/connected|revoked/i.test(msg) ? "ok" : "bad"}">${esc(msg)}</p>` : ""}
<div class="card"><h2>Google Workspace</h2>
${g.connected() ? `<p>Connected as <b>${esc(email)}</b>: Gmail, Calendar, Drive, Docs, Sheets, Slides, Tasks.</p><p class="hint">Read on demand only; nothing is copied or indexed. Sending email, calendar changes and edits always ask you YES first.</p><form method="post" action="/google/disconnect">${csrf()}<button class="ghost">Disconnect and revoke access</button></form>` : `<p class="hint">Lets DInstinct read and act in Gmail, Calendar, Drive, Docs, Sheets, Slides and Tasks, and power the morning briefing. Uses your own Google OAuth client (Settings), so no middleman.</p><p><a href="/google/connect"><button type="button">Connect Google</button></a></p>`}</div>
<div class="card"><h2>Where your data lives</h2><table>
<tr><td>Vault, tokens, memories, reminders</td><td>Encrypted in <code>data/vault.dat</code> on this PC</td></tr>
<tr><td>AI model</td><td>${esc(llm)}. Start a message with <b>private:</b> to keep that task on the local model.</td></tr>
<tr><td>Browser</td><td>${app.cfg.browser.mode === "local" ? "Edge on this PC" : app.cfg.browser.mode === "browserbase" ? "Browserbase cloud browser (sessions released after each task)" : "Your cloud browser provider"}</td></tr>
<tr><td>Bank information</td><td>Never stored, requested or typed</td></tr>
<tr><td>Reminders waiting</td><td>${reminders.length}</td></tr>
<tr><td>Spent this month</td><td>${spend.month === month ? spend.total : 0} of ${s.perMonth || "∞"} ${esc(s.currency)} (per order max ${s.perOrder || "∞"})</td></tr>
</table></div>
<div class="card"><h2>Export</h2><p class="hint">Settings, vault entry names and sites, memories, reminders and the full activity log. No passwords or tokens.</p><a href="/data/export"><button type="button" class="ghost">Download my data (JSON)</button></a></div>
<form class="card" method="post" action="/data/delete">${csrf()}<h2>Delete everything</h2><p class="hint">Revokes Google access, then erases the vault, settings, log and browser profile from this PC. This can't be undone.</p>
<div class="row"><div><label>Master password</label><input type="password" name="password" required></div><div><label>Type DELETE</label><input name="confirm" required autocomplete="off"></div></div><button style="background:var(--bad)">Delete everything</button></form>`,
    );
  };

  const fillPage = (token: string, msg = "") => {
    const f = app.core.fills.get(token);
    if (!f || Date.now() > f.expires) return page("Link expired", `<h1>This link no longer works</h1><p class="sub">It was already used or expired. Ask your assistant for a new one.</p>`, false);
    if (!app.vault.isUnlocked()) return page("Locked", `<h1>DInstinct is locked</h1><p class="sub">Unlock it on your PC, then open this link again.</p>`, false);
    const inputs = f.fields
      .map((x) => `<label>${esc(x.label)}</label><input name="f_${esc(x.key)}" type="${x.secret ? "password" : "text"}" autocomplete="off" autocapitalize="off" spellcheck="false">`)
      .join("");
    return page(
      "Save to vault",
      `<h1>Save to your vault</h1><p class="sub">${esc(f.reason)}</p>${msg ? `<p class="bad">${esc(msg)}</p>` : ""}
<form class="card" method="post"><h2>${esc(f.name)} <span class="pill">${esc(f.kind)}</span></h2>${inputs}
<label>Can be used on these sites only</label><input name="sites" value="${esc(f.sites.join(", "))}">
<p class="hint">Encrypted with your master password on your PC. Your assistant can type it into these sites but can never read it.</p>
<p class="rule">Never enter card numbers, bank accounts or PINs here. DInstinct refuses them.</p>
<button name="action" value="save">Save encrypted</button> <button class="ghost" name="action" value="cancel">Cancel</button></form>`,
      false,
    );
  };

  // ---------- router ----------

  return http
    .createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://x");
        const p = url.pathname;
        const m = req.method ?? "GET";

        // Public: one-time vault links
        const fm = p.match(/^\/fill\/([A-Za-z0-9_-]{43})$/);
        if (fm) {
          const token = fm[1];
          if (m === "GET") return send(res, 200, fillPage(token));
          const form = new URLSearchParams((await readBody(req)).toString("utf8"));
          const f = app.core.fills.get(token);
          if (!f || Date.now() > f.expires || !app.vault.isUnlocked()) return send(res, 410, fillPage(token));
          if (form.get("action") === "cancel") {
            f.done(false);
            return send(res, 200, page("Cancelled", `<h1>Cancelled</h1><p class="sub">Nothing was saved.</p>`, false));
          }
          const fields: Record<string, string> = {};
          for (const x of f.fields) fields[x.key] = (form.get("f_" + x.key) ?? "").slice(0, 2000);
          if (Object.values(fields).every((v) => !v)) return send(res, 400, fillPage(token, "Fill in at least one field."));
          const sites = (form.get("sites") ?? "").split(",").map(normalizeSite).filter(Boolean);
          try {
            app.vault.upsert({ kind: f.kind, name: f.name, sites, fields });
          } catch (e: any) {
            audit("bank_rule_blocked", { where: "fill_link", name: f.name });
            return send(res, 400, fillPage(token, e.message));
          }
          audit("vault_filled_via_link", { name: f.name, sites });
          f.done(true);
          return send(res, 200, page("Saved", `<h1>Saved to your vault</h1><p class="sub">Your assistant will pick up where it left off. You can close this page.</p>`, false));
        }

        // Public: WhatsApp webhook
        if (p === "/wa/webhook") {
          if (!app.whatsapp) return send(res, 503, "whatsapp off", "text/plain");
          if (m === "GET") {
            const ch = app.whatsapp.verify(url.searchParams);
            return ch ? send(res, 200, ch, "text/plain") : send(res, 403, "forbidden", "text/plain");
          }
          const raw = await readBody(req);
          const ok = app.whatsapp.handle(raw, req.headers["x-hub-signature-256"] as string | undefined);
          return send(res, ok ? 200 : 401, ok ? "ok" : "bad signature", "text/plain");
        }

        // Public: iMessage (Sendblue) webhook, authenticated by the secret in the URL
        const im = p.match(/^\/imessage\/webhook\/([A-Za-z0-9_-]{20,})$/);
        if (im && m === "POST") {
          if (!app.imessage || !app.vault.isUnlocked() || !safeEqual(im[1], app.vault.getSystem("imessage_webhook_secret"))) {
            audit("imessage_webhook_rejected");
            return send(res, 404, "not found", "text/plain");
          }
          let body: any = null;
          try {
            body = JSON.parse((await readBody(req, 200_000)).toString("utf8"));
          } catch {
            return send(res, 400, "bad json", "text/plain");
          }
          app.imessage.handle(body); // returns at once; Sendblue only waits 45 s
          return send(res, 200, "ok", "text/plain");
        }

        // Public: phone calls (Twilio Voice), verified with Twilio's signature
        if ((p === "/voice/incoming" || p === "/voice/speech") && m === "POST") {
          const form = new URLSearchParams((await readBody(req, 50_000)).toString("utf8"));
          const lang = app.cfg.phone.language || "en-US";
          const xmlRes = (s: string) => send(res, 200, s, "text/xml; charset=utf-8");
          const fullUrl = app.cfg.publicUrl.replace(/\/$/, "") + (req.url ?? p);
          if (!app.cfg.phone.enabled || !app.vault.isUnlocked()) return xmlRes(twiml({ say: ["DInstinct is not available right now."], hangup: true, language: lang }));
          if (!twilioSignatureValid(app.vault.getSystem("twilio_auth_token"), fullUrl, form, req.headers["x-twilio-signature"] as string | undefined)) {
            audit("phone_bad_signature");
            return send(res, 403, "forbidden", "text/plain");
          }
          if (!callerAllowed(form.get("From") ?? "", app.cfg.phone.allowedNumbers)) {
            audit("phone_rejected");
            return xmlRes(twiml({ say: ["Sorry, this assistant is private."], hangup: true, language: lang }));
          }
          const gather = { action: "/voice/speech", prompt: "" };
          if (p === "/voice/incoming") {
            const name = app.cfg.ownerName ? `, ${app.cfg.ownerName}` : "";
            return xmlRes(twiml({ gather: { ...gather, prompt: `Hi${name}, it's DInstinct. What can I do for you?` }, language: lang }));
          }
          const said = (form.get("SpeechResult") ?? "").trim();
          if (!said) return xmlRes(twiml({ gather: { ...gather, prompt: "Sorry, I didn't catch that. Could you say it again?" }, language: lang }));
          const collected: string[] = [];
          let open = true;
          const reply = async (t: string) => {
            if (open) collected.push(t);
            else await app.notifyLate(t);
          };
          const task = app.core.inbound("phone", said, reply);
          await Promise.race([task, new Promise((r) => setTimeout(r, 11_000))]); // Twilio waits ~15 s
          open = false;
          const full = collected.join(" ");
          if (full.length > 700) app.notifyLate(full).catch(() => {});
          const where = app.cfg.notifyChannel === "none" ? "" : ` on ${app.cfg.notifyChannel}`;
          const speech = full ? speakable(full) : `I'm on it. I'll message you${where} when it's done.`;
          return xmlRes(twiml({ say: [speech], gather: { ...gather, prompt: "Anything else?" }, language: lang }));
        }

        // Public: iPhone Shortcut
        if (p === "/iphone" && m === "POST") {
          if (!app.cfg.iphone.enabled) return send(res, 404, "off", "text/plain");
          if (!app.vault.isUnlocked()) return send(res, 503, "DInstinct is locked. Unlock it on your PC.", "text/plain");
          const auth = String(req.headers.authorization ?? "");
          if (!safeEqual(auth, `Bearer ${app.vault.getSystem("iphone_token")}`)) {
            audit("iphone_rejected");
            return send(res, 401, "unauthorized", "text/plain");
          }
          const raw = (await readBody(req, 20_000)).toString("utf8").trim();
          let text = raw;
          try {
            const j = JSON.parse(raw);
            text = String(j.text ?? j.message ?? "");
          } catch {}
          const waiting = app.outbox.splice(0);
          if (!text.trim()) return send(res, 200, waiting.join("\n\n") || "No new messages.", "text/plain; charset=utf-8");
          const collected: string[] = [];
          let open = true;
          const reply = async (t: string) => {
            if (open) collected.push(t);
            else await app.notifyLate(t);
          };
          const task = app.core.inbound("iphone", text, reply);
          await Promise.race([task, new Promise((r) => setTimeout(r, 25_000))]);
          open = false;
          const where = app.cfg.notifyChannel === "none" ? "next time you ask" : `on ${app.cfg.notifyChannel}`;
          const out = [...waiting, ...collected].join("\n\n") || `Working on it. I'll send the result ${where}.`;
          return send(res, 200, out, "text/plain; charset=utf-8");
        }

        // Everything below is the admin UI: this PC only.
        if (!isLocal(req)) return send(res, 404, "not found", "text/plain");

        if (m === "GET") {
          if (p === "/") return send(res, 200, dashboard());
          if (!app.vault.isUnlocked()) return redirect(res, "/");
          if (p === "/vault") return send(res, 200, vaultPage());
          if (p === "/settings") {
            if (app.cfg.llm.provider === "claude")
              await Promise.race([
                listModels(app.cfg.llm, app.vault.getSystem("anthropic_api_key"), url.searchParams.has("refreshModels")).catch(() => {}),
                new Promise((r) => setTimeout(r, 5000)),
              ]);
            const busy = ["installing", "waiting", "checking"].includes(app.claudeLogin.state);
            const html = settingsPage();
            return send(res, 200, busy ? html.replace("<head>", '<head><meta http-equiv="refresh" content="3">') : html);
          }
          if (p === "/whatsapp") return send(res, 200, whatsappPage(url.searchParams.get("msg") ?? "", url.searchParams.get("ok") ?? ""));
          if (p === "/welcome") return send(res, 200, welcome(Math.min(4, Math.max(1, Number(url.searchParams.get("step")) || 1)), url.searchParams.get("msg") ?? ""));
          if (p === "/data") return send(res, 200, dataPage(url.searchParams.get("msg") ?? ""));
          if (p === "/data/export") {
            res.writeHead(200, {
              "content-type": "application/json; charset=utf-8",
              "content-disposition": `attachment; filename="dinstinct-export-${new Date().toISOString().slice(0, 10)}.json"`,
              "cache-control": "no-store",
            });
            return res.end(JSON.stringify(app.exportData(), null, 2));
          }
          if (p === "/google/connect") {
            if (!app.core.google.configured()) return redirect(res, "/data?msg=" + encodeURIComponent("Add your Google OAuth client ID and secret in Settings first."));
            return redirect(res, app.core.google.authUrl());
          }
          if (p === "/google/callback") {
            const err = url.searchParams.get("error");
            try {
              if (err) throw new Error(`Google said: ${err}`);
              const email = await app.core.google.finish(url.searchParams.get("state") ?? "", url.searchParams.get("code") ?? "");
              return redirect(res, "/data?msg=" + encodeURIComponent(`Connected ${email}.`));
            } catch (e: any) {
              return redirect(res, "/data?msg=" + encodeURIComponent(e.message));
            }
          }
          return send(res, 404, page("Not found", "<h1>Not found</h1>"));
        }

        const form = new URLSearchParams((await readBody(req)).toString("utf8"));
        if (!formOk(req, form)) return send(res, 403, "bad form token", "text/plain");

        if (p === "/theme") {
          const t = form.get("theme");
          if (t === "auto" || t === "light" || t === "dark") {
            app.cfg.ui.theme = ui.theme = t;
            saveConfig(app.cfg);
          }
          const back = String(req.headers.referer ?? "/").replace(/^https?:\/\/[^/]+/, "");
          return redirect(res, back.startsWith("/") && !back.startsWith("//") ? back : "/");
        }
        if (p === "/setup") {
          if (form.get("password") !== form.get("password2")) return send(res, 400, dashboard("The passwords don't match."));
          try {
            await app.create(form.get("password") ?? "");
            await app.unlock(form.get("password") ?? "");
          } catch (e: any) {
            return send(res, 400, dashboard(e.message));
          }
          return redirect(res, "/welcome?step=1");
        }
        if (p === "/unlock") {
          try {
            await app.unlock(form.get("password") ?? "");
          } catch (e: any) {
            audit("unlock_failed");
            return send(res, 401, dashboard(e.message));
          }
          return redirect(res, "/");
        }
        if (!app.vault.isUnlocked()) return redirect(res, "/");

        if (p === "/lock") {
          await app.lock();
          return redirect(res, "/");
        }
        if (p === "/password") {
          try {
            await app.vault.changePassword(form.get("old") ?? "", form.get("new") ?? "");
            audit("password_changed");
          } catch (e: any) {
            return send(res, 400, dashboard(e.message));
          }
          return send(res, 200, dashboard("Master password changed."));
        }
        if (p === "/vault/add") {
          const fields: Record<string, string> = {};
          if (form.get("username")) fields.username = form.get("username")!;
          if (form.get("password")) fields.password = form.get("password")!;
          for (const line of (form.get("extra") ?? "").split(/\r?\n/)) {
            const i = line.indexOf("=");
            if (i > 0) {
              const k = line.slice(0, i).trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
              if (k) fields[k] = line.slice(i + 1).trim();
            }
          }
          const kind = ((ENTRY_KINDS as string[]).includes(form.get("kind") ?? "") ? form.get("kind") : "login") as EntryKind;
          const name = (form.get("name") ?? "").trim();
          try {
            if (name) app.vault.upsert({ kind, name, sites: (form.get("sites") ?? "").split(","), fields });
          } catch (e: any) {
            audit("bank_rule_blocked", { where: "vault_ui" });
            return send(res, 400, vaultPage(e.message));
          }
          return redirect(res, "/vault");
        }
        if (p === "/welcome/brain") {
          app.cfg.ownerName = (form.get("ownerName") ?? "").trim().slice(0, 60);
          const brain = form.get("brain");
          app.cfg.llm.provider = brain === "ollama" ? "ollama" : brain === "free" ? "free" : "claude";
          if (brain === "free" && !(app.vault.getSystem("freellm_api_key") && app.freeStatus.ok)) {
            app.saveConfig();
            return send(res, 400, welcome(1, "Connect FreeLLMAPI first: follow the 3 steps in the Free models box above."));
          }
          const key = (form.get("key") ?? "").trim();
          if (key) {
            if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) return send(res, 400, welcome(1, "That doesn't look like an Anthropic key. It starts with sk-ant-."));
            app.vault.setSystem("anthropic_api_key", key);
          }
          if (key) app.cfg.llm.claudeAuth = "key";
          if (app.cfg.llm.provider === "claude" && !app.vault.getSystem("anthropic_api_key")) {
            if (app.claudeLogin.state !== "ok") return send(res, 400, welcome(1, "Click 'Sign in with Claude' first (or choose Private)."));
            app.cfg.llm.claudeAuth = "signin";
          }
          app.saveConfig();
          return redirect(res, "/welcome?step=2");
        }
        if (p === "/claude/signin") {
          app.cfg.llm.provider = "claude";
          app.cfg.llm.claudeAuth = "signin";
          app.saveConfig();
          app.claudeLogin.signIn().then((ok) => ok && app.core.resetLlm()).catch(() => {});
          await new Promise((r) => setTimeout(r, 400));
          return redirect(res, form.get("back") === "guide" ? "/welcome?step=1" : "/settings");
        }
        if (p.startsWith("/whatsapp/")) {
          const w = app.cfg.whatsapp;
          const back = (msg = "", ok = "") => redirect(res, `/whatsapp?${new URLSearchParams(msg ? { msg } : ok ? { ok } : {})}`);
          try {
            if (p === "/whatsapp/app") {
              const appId = (form.get("appId") ?? "").trim();
              const secret = (form.get("secret") ?? "").trim();
              const name = await checkApp(w.graphVersion, appId, secret);
              w.appId = appId;
              app.vault.setSystem("whatsapp_app_secret", secret);
              saveConfig(app.cfg);
              return back("", `Found your app "${name}".`);
            }
            if (p === "/whatsapp/token") {
              const token = (form.get("token") ?? "").trim();
              const info = await inspectToken(w.graphVersion, w.appId, app.vault.getSystem("whatsapp_app_secret"), token);
              const numbers = await listNumbers(w.graphVersion, token, info.wabaIds);
              if (!numbers.length) throw new Error("This token can't see any WhatsApp number yet. In Meta, finish WhatsApp → API Setup, then generate the token again.");
              const n = numbers.find((x) => x.id === w.phoneNumberId) ?? numbers[0];
              app.vault.setSystem("whatsapp_access_token", token);
              Object.assign(w, { phoneNumberId: n.id, wabaId: n.wabaId, displayNumber: n.display, tokenExpires: info.expiresAt });
              app.saveConfig();
              return back("", `Found your WhatsApp number ${n.display}${n.name ? ` (${n.name})` : ""}.`);
            }
            if (p === "/whatsapp/remote") {
              app.cfg.remoteAccess = true;
              saveConfig(app.cfg);
              app.tunnel.start().catch(() => {});
              await new Promise((r) => setTimeout(r, 300));
              return back();
            }
            if (p === "/whatsapp/connect") {
              w.enabled = true;
              app.saveConfig(); // starts the WhatsApp channel so Meta's check gets an answer
              await app.connectWhatsAppWebhook();
              app.vault.setState("whatsapp_webhook_url", app.cfg.publicUrl);
              return back("", "Connected. Meta will now deliver your messages to DInstinct.");
            }
            if (p === "/whatsapp/pair") {
              app.startPairing();
              return back();
            }
          } catch (e: any) {
            audit("whatsapp_setup_error", { step: p, message: String(e?.message ?? e).slice(0, 200) });
            return back(String(e?.message ?? e));
          }
        }
        if (p === "/free/connect") {
          const key = (form.get("key") ?? "").trim() || app.vault.getSystem("freellm_api_key");
          const backTo = form.get("back") === "guide" ? "/welcome?step=1" : "/settings";
          if (!key) {
            app.freeStatus = { ok: false, message: "Paste the key from the FreeLLMAPI tray icon (Copy Key)." };
            return redirect(res, backTo);
          }
          const d = await detect(key, app.cfg.llm.freeUrl);
          app.freeStatus = { ok: d.ok, message: d.message };
          if (d.ok) {
            app.vault.setSystem("freellm_api_key", key);
            app.cfg.llm.freeUrl = d.base;
            app.cfg.llm.provider = "free";
            app.freeModels = await listFreeModels(d.base, key);
            app.saveConfig();
            audit("free_models_connected", { base: d.base, models: app.freeModels.length });
          }
          return redirect(res, backTo);
        }
        if (p === "/claude/check") {
          if (await app.claudeLogin.check()) app.core.resetLlm();
          return redirect(res, form.get("back") === "guide" ? "/welcome?step=1" : "/settings");
        }
        if (p === "/claude/signout") {
          await app.claudeLogin.signOut();
          app.core.resetLlm();
          return redirect(res, "/settings");
        }
        if (p === "/welcome/telegram") {
          const token = (form.get("token") ?? "").trim();
          if (!/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token)) return send(res, 400, welcome(2, "That isn't a bot token. It looks like 123456789:AA… (copy the whole line from BotFather)."));
          app.vault.setSystem("telegram_bot_token", token);
          app.cfg.telegram.enabled = true;
          if (app.cfg.notifyChannel === "none" || !app.imessage) app.cfg.notifyChannel = "telegram";
          app.saveConfig(); // restarts channels
          app.startPairing();
          return redirect(res, "/welcome?step=2");
        }
        if (p === "/welcome/remote") {
          app.cfg.remoteAccess = true;
          saveConfig(app.cfg);
          app.tunnel.start().catch(() => {});
          await new Promise((r) => setTimeout(r, 300));
          return redirect(res, "/welcome?step=3");
        }
        if (p === "/welcome/signin") {
          try {
            await app.core.browser.openForSignIn();
          } catch (e: any) {
            return send(res, 500, welcome(4, ""));
          }
          return redirect(res, "/welcome?step=4&msg=" + encodeURIComponent("The browser is open on this PC. Sign in to your sites there, then come back and click Finish."));
        }
        if (p === "/welcome/finish") {
          app.cfg.setupDone = true;
          saveConfig(app.cfg);
          return redirect(res, "/");
        }
        if (p === "/remote") {
          if (form.get("on") === "1") {
            app.cfg.remoteAccess = true;
            app.tunnel.start().catch(() => {});
          } else {
            app.cfg.remoteAccess = false;
            app.tunnel.stop();
          }
          saveConfig(app.cfg);
          await new Promise((r) => setTimeout(r, 300));
          return redirect(res, "/");
        }
        if (p === "/telegram/pair") {
          app.startPairing();
          return redirect(res, "/welcome?step=2");
        }
        if (p === "/google/disconnect") {
          await app.core.google.disconnect();
          return redirect(res, "/data?msg=" + encodeURIComponent("Google disconnected and access revoked."));
        }
        if (p === "/data/delete") {
          if (form.get("confirm") !== "DELETE") return send(res, 400, dataPage("Type DELETE to confirm."));
          try {
            const probe = new Vault(app.vault.file);
            await probe.unlock(form.get("password") ?? "");
            probe.lock();
          } catch {
            return send(res, 401, dataPage("Wrong master password. Nothing was deleted."));
          }
          await app.deleteEverything();
          return redirect(res, "/");
        }
        if (p === "/vault/delete") {
          app.vault.remove(form.get("id") ?? "");
          return redirect(res, "/vault");
        }
        if (p === "/memory/delete") {
          app.vault.removeMemory(form.get("id") ?? "");
          return redirect(res, "/vault");
        }
        if (p === "/settings") {
          const c = app.cfg;
          const list = (s: string | null) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
          c.ownerName = (form.get("ownerName") ?? "").slice(0, 60);
          c.publicUrl = /^https:\/\/[^\s/]+/.test(form.get("publicUrl") ?? "") ? form.get("publicUrl")!.trim().replace(/\/$/, "") : "";
          c.llm.provider = (["claude", "ollama", "free"].includes(form.get("provider") ?? "") ? form.get("provider") : "claude") as any;
          const fm = (form.get("freeModel") ?? "").trim();
          if (fm && /^[\w.:@\/-]{1,120}$/.test(fm)) c.llm.freeModel = fm;
          const custom = (form.get("claudeModelCustom") ?? "").trim();
          const picked = custom || (form.get("claudeModel") ?? "").trim();
          if (picked) {
            if (!/^claude-[a-z0-9][a-z0-9.\-@]{1,80}$/.test(picked))
              return send(res, 400, page("Settings", `<h1>Settings not saved</h1><p class="bad">"${esc(picked)}" isn't a Claude model ID (they look like claude-opus-5-5).</p><p><a href="/settings">Back to Settings</a></p>`));
            c.llm.claudeModel = picked;
          }
          c.llm.claudeEffort = (["low", "medium", "high", "xhigh", "max"].includes(form.get("claudeEffort") ?? "") ? form.get("claudeEffort") : "medium") as any;
          c.llm.ollamaUrl = (form.get("ollamaUrl") || c.llm.ollamaUrl).trim();
          c.llm.ollamaModel = (form.get("ollamaModel") || c.llm.ollamaModel).trim();
          c.browser.headless = form.has("headless");
          c.browser.mode = (["auto", "browserbase", "cdp", "local"].includes(form.get("browserMode") ?? "") ? form.get("browserMode") : "auto") as any;
          c.browser.browserbaseRegion = ["us-west-2", "us-east-1", "eu-central-1", "ap-southeast-1"].includes(form.get("bbRegion") ?? "") ? form.get("bbRegion")! : "us-west-2";
          c.telegram.enabled = form.has("tgEnabled");
          c.telegram.allowedUserIds = list(form.get("tgAllowed")).filter((x) => /^\d+$/.test(x));
          c.whatsapp.enabled = form.has("waEnabled");
          c.whatsapp.phoneNumberId = digits(form.get("waPhoneId") ?? "");
          c.whatsapp.allowedNumbers = list(form.get("waAllowed")).map(digits).filter(Boolean);
          c.imessage.enabled = form.has("imEnabled");
          c.imessage.fromNumber = digits(form.get("imFrom") ?? "") ? "+" + digits(form.get("imFrom") ?? "") : "";
          c.imessage.allowedHandles = list(form.get("imAllowed")).filter((h) => h.includes("@") || digits(h).length >= 7);
          c.iphone.enabled = form.has("iphoneEnabled");
          c.phone.enabled = form.has("phoneEnabled");
          c.phone.allowedNumbers = list(form.get("phoneAllowed")).map(digits).filter((x) => x.length >= 7);
          c.phone.language = /^[a-z]{2}-[A-Z]{2}$/.test(form.get("phoneLang") ?? "") ? form.get("phoneLang")! : "en-US";
          const time = (k: string, d: string) => (/^\d{2}:\d{2}$/.test(form.get(k) ?? "") ? form.get(k)! : d);
          c.proactive.enabled = form.has("proEnabled");
          c.proactive.briefing = form.has("proBriefing");
          c.proactive.calendarAlerts = form.has("proCalendar");
          c.proactive.briefingTime = time("briefingTime", "08:00");
          c.proactive.quietStart = time("quietStart", "22:00");
          c.proactive.quietEnd = time("quietEnd", "08:00");
          const num = (k: string) => Math.max(0, Math.floor(Number(form.get(k)) || 0));
          c.spending.perOrder = num("perOrder");
          c.spending.perMonth = num("perMonth");
          c.spending.currency = (form.get("currency") ?? "USD").trim().toUpperCase().replace(/[^A-Z]/g, "").slice(0, 5) || "USD";
          const gid = (form.get("google_client_id") ?? "").trim();
          if (gid !== app.vault.getSystem("google_client_id")) app.vault.setSystem("google_client_id", gid);
          c.notifyChannel = (["imessage", "telegram", "whatsapp", "none"].includes(form.get("notifyChannel") ?? "") ? form.get("notifyChannel") : "none") as any;
          for (const k of ["anthropic_api_key", "telegram_bot_token", "whatsapp_access_token", "whatsapp_app_secret", "browserbase_api_key", "cloud_browser_cdp_url", "sendblue_api_key_id", "sendblue_api_secret", "twilio_auth_token", "google_client_secret"]) {
            const v = (form.get(k) ?? "").trim();
            if (v === "clear") app.vault.setSystem(k, "");
            else if (v) app.vault.setSystem(k, v);
          }
          const ca = (form.get("company_ca") ?? "").trim();
          const caFile = path.join(DATA, "company-ca.pem");
          if (ca === "clear") {
            fs.rmSync(caFile, { force: true });
            audit("company_ca_removed");
          } else if (ca) {
            try {
              const name = validateCompanyCA(ca);
              fs.writeFileSync(caFile, ca + "\n");
              applyCompanyCA(caFile);
              audit("company_ca_added", { name });
              app.claudeLogin.state = "idle"; // let the owner retry the Claude check
            } catch (e: any) {
              return send(res, 400, page("Settings", `<h1>Settings not saved</h1><p class="bad">${esc(e.message)}</p><p><a href="/settings">Back to Settings</a></p>`));
            }
          }
          const keyField = (form.get("anthropic_api_key") ?? "").trim();
          if (keyField === "clear") c.llm.claudeAuth = "signin";
          else if (keyField) c.llm.claudeAuth = "key";
          await app.core.browser.close(); // reconnect with the new browser settings on the next task
          app.core.browser.cfg = c.browser;
          app.saveConfig();
          audit("settings_saved");
          return redirect(res, "/");
        }
        return send(res, 404, "not found", "text/plain");
      } catch (e: any) {
        audit("http_error", { message: String(e?.message ?? e).slice(0, 200) });
        if (!res.headersSent) send(res, 500, "error", "text/plain");
      }
    })
    .listen(port, "127.0.0.1");
}
