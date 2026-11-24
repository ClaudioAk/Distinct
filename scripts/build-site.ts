// Builds the project website (docs/index.html, served by GitHub Pages) from the app's own
// guard drawing and colours, so the site and the app always look alike.
// Run: node scripts/build-site.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ART_CSS, ART_DARK, ART_LIGHT, GUARD_SVG, MARK_SVG } from "../src/art.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "https://github.com/ClaudioAk/Distinct";
const DOWNLOAD = `${REPO}/releases/latest/download/Distinct.zip`;

const LIGHT = `--bg:#f6f5f2;--card:#fff;--ink:#1d1c1a;--ink2:#5d5a54;--line:#e3e0da;--acc:#2f5bd3;--acc2:#1f3f9e;--ok:#1e7a3c;--bad:#b3261e;--panel:#ecebe6;${ART_LIGHT}`;
const DARK = `--bg:#121214;--card:#1c1c1f;--ink:#eeece8;--ink2:#a8a49c;--line:#323236;--acc:#7d9bff;--acc2:#a9bcff;--ok:#7bd88f;--bad:#ff8a80;--panel:#18181b;${ART_DARK}`;

const features: [string, string, string][] = [
  ["🤖", "An agent with its own browser", "Give it a goal and it plans, opens websites, signs in, fills forms, books and orders, then reports back."],
  ["🔐", "Encrypted vault on your PC", "Passwords, API keys and tokens live in one file encrypted with your master password (scrypt + AES-256-GCM)."],
  ["🙈", "The AI never sees secrets", "The model only sees names and sites. Values are typed straight into the page, only on the sites you allowed."],
  ["🔗", "Secure one-time links", "Missing a login? It sends you a one-time link to add it. It never asks for passwords in chat."],
  ["🚫", "No bank information, ever", "Card numbers, CVC, IBAN, account numbers and PINs are refused in code, with any AI model."],
  ["💬", "Text it anywhere", "Telegram (pair with a 6-digit code), WhatsApp, iMessage, phone calls, or \"Hey Siri\"."],
  ["⏰", "It messages you first", "Reminders, a morning briefing, calendar-clash alerts and emails nobody answered, with quiet hours."],
  ["📧", "Google Workspace", "Gmail, Calendar, Drive, Docs, Sheets, Slides and Tasks. Sending and editing always ask YES first."],
  ["🧠", "Your choice of AI", "Any Claude model (one-click sign-in), free models via FreeLLMAPI, or fully private on your PC."],
  ["💳", "Spending limits", "Per-order and monthly limits, checked before an order is even proposed. Every purchase needs your YES."],
  ["🧾", "Your data, your call", "Activity log, export without secrets, and delete-everything with your master password."],
  ["🌗", "Friendly for everyone", "A step-by-step setup guide in plain words, light and dark mode, and an on-duty guard."],
];

const shots: [string, string][] = [
  ["02-setup-guide-brain.png", "Step-by-step setup guide"],
  ["03-setup-guide-chat.png", "Pair Telegram with a code"],
  ["05-vault.png", "The encrypted vault"],
  ["07-settings.png", "Simple settings"],
  ["08-whatsapp-setup.png", "Guided WhatsApp setup"],
  ["09-data-and-privacy.png", "Your data and connections"],
];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const html = `<!doctype html>
<html lang="en" data-theme="auto">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Distinct · your private AI assistant</title>
<meta name="description" content="A private personal AI assistant you text on Telegram, WhatsApp, iMessage, by phone or Siri. It acts on websites for you and keeps every password encrypted on your own PC.">
<meta property="og:title" content="Distinct · your private AI assistant">
<meta property="og:description" content="Text it like a friend. It does things on websites for you, and every password stays encrypted on your own PC.">
<meta property="og:image" content="https://claudioak.github.io/Distinct/images/10-home-dark.png">
<link rel="icon" href="data:image/svg+xml;base64,${Buffer.from(fs.readFileSync(path.join(ROOT, "assets", "logo-mark.svg"), "utf8")).toString("base64")}">
<style>
:root{${LIGHT};color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${DARK};color-scheme:dark}}
:root[data-theme=dark]{${DARK};color-scheme:dark}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--acc)}
.wrap{max-width:1080px;margin:0 auto;padding:0 20px}
nav{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 0}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:19px;color:var(--ink);text-decoration:none}
.navr{display:flex;align-items:center;gap:18px;flex-wrap:wrap}.navr a{text-decoration:none;font-weight:600;font-size:15px}
.theme{display:inline-flex;border:1px solid var(--line);border-radius:99px;overflow:hidden}
.theme button{border:0;background:transparent;color:var(--ink2);padding:5px 11px;font:600 12px system-ui;cursor:pointer}
.theme button.on{background:var(--acc);color:#fff}
.hero{display:grid;grid-template-columns:1.25fr .75fr;gap:30px;align-items:center;padding:40px 0 30px}
h1{font-size:clamp(34px,5vw,56px);line-height:1.05;margin:0 0 16px;letter-spacing:-.02em}
.lead{font-size:19px;color:var(--ink2);margin:0 0 26px;max-width:560px}
.cta{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.btn{display:inline-block;padding:13px 22px;border-radius:10px;font-weight:700;text-decoration:none;font-size:16px}
.btn.primary{background:var(--acc);color:#fff}.btn.primary:hover{background:var(--acc2)}
.btn.ghost{border:1px solid var(--line);color:var(--ink);background:var(--card)}
.small{font-size:13px;color:var(--ink2);margin-top:10px}
.guard{background:var(--panel);border:1px solid var(--line);border-radius:22px;padding:26px 18px 10px;text-align:center}
.guard .guard-art{width:100%;max-width:240px;height:auto;margin:0 auto}
.guard p{margin:6px 0 0;font-size:13px;color:var(--ink2)}
section{padding:34px 0}
h2{font-size:30px;margin:0 0 8px;letter-spacing:-.01em}.sub{color:var(--ink2);margin:0 0 24px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px}
.card h3{margin:6px 0 4px;font-size:17px}.card p{margin:0;color:var(--ink2);font-size:15px}.ico{font-size:24px}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:16px}
.shots figure{margin:0;background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden}
.shots img{display:block;width:100%;height:220px;object-fit:cover;object-position:top}
.shots figcaption{padding:10px 14px;font-size:14px;color:var(--ink2)}
.steps{counter-reset:s;list-style:none;padding:0;margin:0;display:grid;gap:12px}
.steps li{counter-increment:s;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px 16px 62px;position:relative}
.steps li::before{content:counter(s);position:absolute;left:18px;top:15px;width:30px;height:30px;border-radius:50%;background:var(--acc);color:#fff;font-weight:800;display:grid;place-items:center}
.cmp{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden;font-size:15px}
.cmp th,.cmp td{padding:11px 14px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
.cmp th{background:var(--panel)}.cmp td:last-child{color:var(--ok);font-weight:600}
.note{border-left:4px solid var(--acc);background:var(--card);padding:12px 16px;border-radius:8px;color:var(--ink2);font-size:14px}
footer{padding:30px 0 50px;color:var(--ink2);font-size:14px;border-top:1px solid var(--line);margin-top:30px}
code{font:14px ui-monospace,Consolas,monospace;background:var(--panel);padding:2px 6px;border-radius:5px}
@media (max-width:820px){.hero{grid-template-columns:1fr}.guard{max-width:300px;margin:0 auto}.navr .hide-sm{display:none}}
${ART_CSS}
</style>
</head>
<body>
<div class="wrap">
<nav>
  <a class="brand" href="#">${MARK_SVG(34)}<span>Distinct</span></a>
  <div class="navr">
    <a class="hide-sm" href="#features">Features</a><a class="hide-sm" href="#privacy">Privacy</a><a class="hide-sm" href="#install">Install</a>
    <a href="${REPO}">GitHub</a>
    <div class="theme" role="group" aria-label="Theme"><button data-t="auto">Auto</button><button data-t="light">Light</button><button data-t="dark">Dark</button></div>
  </div>
</nav>

<header class="hero">
  <div>
    <h1>Your private AI assistant.<br>Just text it.</h1>
    <p class="lead">Distinct does real things on websites for you (bookings, orders, forms, your accounts) while every password stays <b>encrypted on your own PC</b>. Chat with it on Telegram, WhatsApp, iMessage, by phone or with Siri.</p>
    <div class="cta">
      <a class="btn primary" href="${DOWNLOAD}">⬇ Download for Windows</a>
      <a class="btn ghost" href="${REPO}">View on GitHub</a>
    </div>
    <p class="small">Free and open source (MIT). Windows 10/11. Works with Claude, free models, or fully offline.</p>
  </div>
  <div class="guard">${GUARD_SVG}<p><b>On duty.</b> No bank information, ever.</p></div>
</header>

<section id="features">
  <h2>What it does</h2><p class="sub">An agent that acts for you, with guard rails built into the code.</p>
  <div class="grid">${features.map(([i, t, d]) => `<div class="card"><div class="ico">${i}</div><h3>${esc(t)}</h3><p>${esc(d)}</p></div>`).join("")}</div>
</section>

<section id="screens">
  <h2>See it</h2><p class="sub">Plain words, one thing per step, light or dark.</p>
  <div class="shots">${shots.map(([f, c]) => `<figure><a href="images/${f}"><img src="images/${f}" alt="${esc(c)}" loading="lazy"></a><figcaption>${esc(c)}</figcaption></figure>`).join("")}</div>
</section>

<section id="privacy">
  <h2>Private by design</h2><p class="sub">Hosted assistants keep your logins on their servers. Distinct keeps them with you.</p>
  <table class="cmp">
    <tr><th></th><th>Typical hosted assistant</th><th>Distinct</th></tr>
    <tr><td>Where passwords live</td><td>The provider's servers</td><td>An encrypted file on your PC</td></tr>
    <tr><td>Can the AI read them?</td><td>Often optional</td><td>Never</td></tr>
    <tr><td>Bank and card details</td><td>Stored for purchases</td><td>Refused in code</td></tr>
    <tr><td>Which AI model</td><td>Theirs</td><td>Your choice, even offline</td></tr>
    <tr><td>Sending, buying, deleting</td><td>Settings-dependent</td><td>Always asks you YES first</td></tr>
    <tr><td>Your data</td><td>Licence to their service</td><td>Export or delete it any time</td></tr>
  </table>
  <p class="note" style="margin-top:16px">Website and email content is treated as untrusted data, never as instructions. Only you are answered on every channel, and the settings pages only open on your own PC.</p>
</section>

<section id="install">
  <h2>Install in 5 minutes</h2><p class="sub">No technical knowledge needed.</p>
  <ol class="steps">
    <li><b><a href="${DOWNLOAD}">Download Distinct.zip</a></b>, right-click it → <i>Extract All</i>.</li>
    <li>Open the folder and double-click <b>Install Distinct.cmd</b>. If Windows shows "Windows protected your PC", click <i>More info → Run anyway</i>. It installs what's needed and adds a desktop icon.</li>
    <li>A page opens. Choose a <b>master password</b>. It protects everything and can't be recovered, so keep it safe.</li>
    <li>Follow the <b>setup guide</b>: click <i>Sign in with Claude</i> (or pick free models), pair Telegram with a 6-digit code, and turn on phone access.</li>
    <li>Text your assistant: <i>"Find me a padel court for Saturday morning."</i></li>
  </ol>
  <p class="small">Developers: <code>git clone ${REPO}.git</code> → <code>npm install</code> → <code>npm start</code>. Node 24+.</p>
</section>

<footer>
  Distinct is an independent open-source project (MIT licence). It is not affiliated with Instinct, Anthropic, Meta, Apple, Google, Telegram, Sendblue, Twilio, Cloudflare or FreeLLMAPI.
  · <a href="${REPO}">Source code</a> · <a href="${REPO}/blob/main/SECURITY.md">Security</a> · <a href="${REPO}/releases">Releases</a>
</footer>
</div>
<script>
(function(){
  var root=document.documentElement, btns=document.querySelectorAll('.theme button');
  function set(t){ root.setAttribute('data-theme',t); btns.forEach(function(b){b.classList.toggle('on',b.dataset.t===t)}); try{localStorage.setItem('distinct-theme',t)}catch(e){} }
  var saved='auto'; try{saved=localStorage.getItem('distinct-theme')||'auto'}catch(e){}
  set(saved); btns.forEach(function(b){b.addEventListener('click',function(){set(b.dataset.t)})});
})();
</script>
</body>
</html>
`;

fs.writeFileSync(path.join(ROOT, "docs", "index.html"), html);
fs.writeFileSync(path.join(ROOT, "docs", ".nojekyll"), "");
console.log("Wrote docs/index.html");
