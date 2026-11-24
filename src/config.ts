// Non-secret settings, stored in data/config.json.
// Secrets (API keys, bot tokens, app secrets) live in the encrypted vault instead.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA = process.env.DINSTINCT_DATA ? path.resolve(process.env.DINSTINCT_DATA) : path.join(ROOT, "data");

export type Config = {
  ownerName: string;
  port: number;
  publicUrl: string; // https tunnel URL (e.g. Cloudflare Tunnel) for WhatsApp, iPhone and fill links
  llm: {
    provider: "claude" | "ollama" | "free";
    freeUrl: string; // FreeLLMAPI's OpenAI-compatible address (found automatically)
    freeModel: string;
    claudeAuth: "signin" | "key"; // signin = "Sign in with Claude" (no key to copy)
    claudeModel: string;
    claudeEffort: "low" | "medium" | "high" | "xhigh" | "max";
    claudeFallbacks: boolean;
    ollamaUrl: string;
    ollamaModel: string;
  };
  browser: {
    mode: "auto" | "browserbase" | "cdp" | "local"; // auto = cloud when a Browserbase key is saved, else Edge on this PC
    channel: string;
    headless: boolean;
    browserbaseRegion: string;
    browserbaseContextId: string; // created automatically; keeps the assistant's logins between tasks
  };
  telegram: { enabled: boolean; allowedUserIds: string[] };
  whatsapp: { enabled: boolean; phoneNumberId: string; allowedNumbers: string[]; graphVersion: string; appId: string; wabaId: string; displayNumber: string; tokenExpires: number };
  imessage: { enabled: boolean; fromNumber: string; allowedHandles: string[] };
  iphone: { enabled: boolean };
  notifyChannel: "imessage" | "telegram" | "whatsapp" | "none"; // primary channel for messages DInstinct starts
  ui: { theme: "auto" | "light" | "dark" };
  remoteAccess: boolean; // run the secure tunnel automatically when unlocked
  setupDone: boolean;
  phone: { enabled: boolean; allowedNumbers: string[]; language: string };
  proactive: { enabled: boolean; briefing: boolean; briefingTime: string; calendarAlerts: boolean; quietStart: string; quietEnd: string };
  spending: { perOrder: number; perMonth: number; currency: string }; // 0 = no limit
};

export const DEFAULTS: Config = {
  ownerName: "",
  port: 7777,
  publicUrl: "",
  llm: {
    provider: "claude",
    claudeAuth: "signin",
    freeUrl: "",
    freeModel: "auto:smart",
    claudeModel: "claude-opus-5-5",
    claudeEffort: "medium",
    claudeFallbacks: true,
    ollamaUrl: "http://127.0.0.1:11434",
    ollamaModel: "qwen3:8b",
  },
  browser: { mode: "auto", channel: "msedge", headless: false, browserbaseRegion: "us-west-2", browserbaseContextId: "" },
  telegram: { enabled: false, allowedUserIds: [] },
  whatsapp: { enabled: false, phoneNumberId: "", allowedNumbers: [], graphVersion: "v27.0", appId: "", wabaId: "", displayNumber: "", tokenExpires: 0 },
  imessage: { enabled: false, fromNumber: "", allowedHandles: [] },
  iphone: { enabled: false },
  notifyChannel: "telegram",
  ui: { theme: "auto" },
  remoteAccess: false,
  setupDone: false,
  phone: { enabled: false, allowedNumbers: [], language: "en-US" },
  proactive: { enabled: true, briefing: true, briefingTime: "08:00", calendarAlerts: true, quietStart: "22:00", quietEnd: "08:00" },
  spending: { perOrder: 100, perMonth: 300, currency: "USD" },
};

const FILE = path.join(DATA, "config.json");

function merge(base: any, over: any): any {
  if (typeof base !== "object" || base === null || Array.isArray(base)) return over ?? base;
  const out: any = { ...base };
  for (const k of Object.keys(base)) if (over && k in over) out[k] = merge(base[k], over[k]);
  return out;
}

export function loadConfig(): Config {
  fs.mkdirSync(DATA, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, JSON.stringify(DEFAULTS, null, 2));
  const cfg: Config = merge(DEFAULTS, JSON.parse(fs.readFileSync(FILE, "utf8")));
  // Older files saved Graph API v21.0; Meta's current version is v27.0.
  if (Number(cfg.whatsapp.graphVersion.replace(/\D/g, "")) < 270) cfg.whatsapp.graphVersion = DEFAULTS.whatsapp.graphVersion;
  return cfg;
}

export function saveConfig(c: Config): void {
  fs.writeFileSync(FILE, JSON.stringify(c, null, 2));
}

export function audit(event: string, detail: Record<string, unknown> = {}): void {
  // Audit trail of what the agent did. Never contains secret values.
  if (process.env.NODE_TEST_CONTEXT) return; // keep test runs out of the real log
  const line = JSON.stringify({ t: new Date().toISOString(), event, ...detail });
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.appendFileSync(path.join(DATA, "audit.log"), line + "\n");
  } catch {}
}

export const digits = (s: string) => s.replace(/\D/g, "");
