// Wires the vault, the agent core and the chat channels together.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Proactive } from "./proactive.ts";
import { Tunnel } from "./tunnel.ts";
import { ClaudeLogin, findAnt } from "./claude-login.ts";
import { connectWebhook } from "./channels/whatsapp-setup.ts";
import { detect, listFreeModels, type FreeModel } from "./llm/freellm.ts";
import { DATA, DEFAULTS, audit, saveConfig, type Config } from "./config.ts";
import { Vault } from "./vault.ts";
import { Core } from "./core.ts";
import { Telegram } from "./channels/telegram.ts";
import { WhatsApp } from "./channels/whatsapp.ts";
import { IMessage } from "./channels/imessage.ts";

export class App {
  cfg: Config;
  vault: Vault;
  core: Core;
  telegram: Telegram | null = null;
  whatsapp: WhatsApp | null = null;
  imessage: IMessage | null = null;
  outbox: string[] = []; // late iPhone replies when no notify channel is set
  csrf = randomBytes(24).toString("base64url");
  proactive: Proactive;
  tunnel: Tunnel;
  claudeLogin = new ClaudeLogin();
  freeStatus: { ok: boolean; message: string } = { ok: false, message: "" };
  freeModels: FreeModel[] = [];
  pairing: { code: string; expires: number; wrong: number; paired: string } | null = null;

  constructor(cfg: Config) {
    this.cfg = cfg;
    this.vault = new Vault(path.join(DATA, "vault.dat"));
    this.core = new Core(cfg, this.vault);
    this.proactive = new Proactive(this);
    this.tunnel = new Tunnel(cfg.port, (url) => {
      this.cfg.publicUrl = url; // links and webhooks now use the new secure address
      saveConfig(this.cfg);
      // The free secure address changes on each start: tell Meta the new one.
      if (this.cfg.whatsapp.enabled && this.cfg.whatsapp.appId && this.vault.isUnlocked())
        setTimeout(() => this.connectWhatsAppWebhook().catch((e) => audit("whatsapp_webhook_error", { message: String(e?.message ?? e).slice(0, 200) })), 3000);
    });
  }

  /** Shows a 6-digit code; the first Telegram user to send it within 15 minutes becomes the owner. */
  startPairing(): string {
    const code = String(100000 + (randomBytes(4).readUInt32BE() % 900000));
    this.pairing = { code, expires: Date.now() + 15 * 60_000, wrong: 0, paired: "" };
    return code;
  }

  tryPair(from: string, text: string, name: string, channel: "telegram" | "whatsapp" = "telegram"): boolean {
    const p = this.pairing;
    if (!p || p.paired || Date.now() > p.expires) return false;
    if (!text.includes(p.code)) {
      if (++p.wrong >= 10) this.pairing = null; // stop guessing
      return false;
    }
    p.paired = name || "you";
    const list = channel === "whatsapp" ? this.cfg.whatsapp.allowedNumbers : this.cfg.telegram.allowedUserIds;
    if (!list.includes(from)) list.push(from);
    if (channel === "whatsapp" && (this.cfg.notifyChannel === "none" || !this.telegram)) this.cfg.notifyChannel = "whatsapp";
    saveConfig(this.cfg);
    audit(`${channel}_paired`);
    return true;
  }

  /** Points Meta's webhook at our current public address (called after setup and whenever the address changes). */
  async connectWhatsAppWebhook(): Promise<void> {
    const w = this.cfg.whatsapp;
    const v = this.vault;
    if (!this.cfg.publicUrl) throw new Error("Turn on 'Reach me on my phone' first; WhatsApp needs it to reach this PC.");
    const result = await connectWebhook(w.graphVersion, {
      appId: w.appId,
      secret: v.getSystem("whatsapp_app_secret"),
      token: v.getSystem("whatsapp_access_token"),
      wabaId: w.wabaId,
      callbackUrl: `${this.cfg.publicUrl.replace(/\/$/, "")}/wa/webhook`,
      verifyToken: v.getSystem("whatsapp_verify_token"),
    });
    v.setState("whatsapp_webhook_url", this.cfg.publicUrl);
    v.setState("whatsapp_webhook_mode", result);
    audit("whatsapp_webhook_connected", result);
  }

  async unlock(password: string): Promise<void> {
    await this.vault.unlock(password);
    this.ensureGeneratedSecrets();
    audit("unlock");
    this.startChannels();
    if (!process.env.NODE_TEST_CONTEXT) {
      this.proactive.start();
      if (this.cfg.remoteAccess) this.tunnel.start().catch(() => {});
      // Free models: find the router again and refresh the model list (quiet, local).
      const fk = this.vault.getSystem("freellm_api_key");
      if (fk)
        detect(fk, this.cfg.llm.freeUrl)
          .then(async (d) => {
            this.freeStatus = { ok: d.ok, message: d.ok ? "" : d.message };
            if (d.ok) this.freeModels = await listFreeModels(d.base, fk);
          })
          .catch(() => {});
      // Show whether the Claude sign-in still works (quiet check, no charge).
      if (this.cfg.llm.provider === "claude" && this.cfg.llm.claudeAuth === "signin" && !this.vault.getSystem("anthropic_api_key") && findAnt())
        this.claudeLogin.check().catch(() => {});
    }
  }

  async create(password: string): Promise<void> {
    await this.vault.create(password);
    this.ensureGeneratedSecrets();
    audit("vault_created");
  }

  async lock(): Promise<void> {
    this.proactive.stop();
    this.tunnel.stop();
    this.stopChannels();
    await this.core.browser.close();
    this.core.session.abort = true;
    this.core.session.pending?.(null);
    for (const f of this.core.fills.values()) f.done(false);
    this.vault.lock();
    this.core.resetLlm();
    audit("lock");
  }

  ensureGeneratedSecrets(): void {
    if (!this.vault.getSystem("iphone_token")) this.vault.setSystem("iphone_token", randomBytes(24).toString("base64url"));
    if (!this.vault.getSystem("whatsapp_verify_token")) this.vault.setSystem("whatsapp_verify_token", randomBytes(16).toString("hex"));
    if (!this.vault.getSystem("imessage_webhook_secret")) this.vault.setSystem("imessage_webhook_secret", randomBytes(32).toString("base64url"));
  }

  startChannels(): void {
    this.stopChannels();
    const v = this.vault;
    const onMessage = (channel: string) => (text: string, reply: (t: string) => Promise<void>) => {
      this.core.inbound(channel, text, reply).catch((e) => audit("inbound_error", { message: String(e?.message ?? e) }));
    };
    if (this.cfg.telegram.enabled && v.getSystem("telegram_bot_token")) {
      this.telegram = new Telegram(v.getSystem("telegram_bot_token"), this.cfg.telegram.allowedUserIds, onMessage("telegram"));
      this.telegram.onStranger = (from, text, name) => this.tryPair(from, text, name);
      this.telegram.start();
    }
    if (this.cfg.whatsapp.enabled && v.getSystem("whatsapp_access_token")) {
      this.whatsapp = new WhatsApp(
        {
          accessToken: v.getSystem("whatsapp_access_token"),
          appSecret: v.getSystem("whatsapp_app_secret"),
          verifyToken: v.getSystem("whatsapp_verify_token"),
          phoneNumberId: this.cfg.whatsapp.phoneNumberId,
          allowedNumbers: this.cfg.whatsapp.allowedNumbers,
          graphVersion: this.cfg.whatsapp.graphVersion,
        },
        onMessage("whatsapp"),
      );
      this.whatsapp.onStranger = (from, text, name) => this.tryPair(from, text, name, "whatsapp");
    }

    if (this.cfg.imessage.enabled && v.getSystem("sendblue_api_key_id") && v.getSystem("sendblue_api_secret")) {
      this.imessage = new IMessage(
        {
          keyId: v.getSystem("sendblue_api_key_id"),
          secretKey: v.getSystem("sendblue_api_secret"),
          fromNumber: this.cfg.imessage.fromNumber,
          allowedHandles: this.cfg.imessage.allowedHandles,
        },
        onMessage("imessage"),
      );
    }
  }

  stopChannels(): void {
    this.telegram?.stop();
    this.telegram = null;
    this.whatsapp = null;
    this.imessage = null;
  }

  saveConfig(): void {
    saveConfig(this.cfg);
    this.core.cfg = this.cfg;
    this.core.resetLlm();
    if (this.vault.isUnlocked()) this.startChannels();
  }

  /** Wipes everything Distinct stored on this PC, after revoking Google access. */
  async deleteEverything(): Promise<void> {
    await this.core.google.disconnect().catch(() => {});
    await this.lock();
    for (const f of ["vault.dat", "vault.dat.tmp", "audit.log", "config.json"]) fs.rmSync(path.join(DATA, f), { force: true });
    fs.rmSync(path.join(DATA, "browser-profile"), { recursive: true, force: true });
    Object.assign(this.cfg, structuredClone(DEFAULTS));
    audit("everything_deleted");
  }

  /** Export of what Distinct knows, without any secret values. */
  exportData(): unknown {
    const v = this.vault;
    let auditLog = "";
    try {
      auditLog = fs.readFileSync(path.join(DATA, "audit.log"), "utf8");
    } catch {}
    return {
      exported: new Date().toISOString(),
      note: "Secret values (passwords, tokens) are not included.",
      settings: this.cfg,
      vaultEntries: v.entries().map((e) => ({ name: e.name, kind: e.kind, sites: e.sites, fields: Object.keys(e.fields), created: e.created, updated: e.updated })),
      memories: v.memories(),
      reminders: v.getState("reminders", []),
      connected: { google: v.getSystem("google_email") || null },
      auditLog: auditLog.split("\n").filter(Boolean).map((l) => JSON.parse(l)),
    };
  }

  /** Message the owner first (reminders, briefings, late replies) on the primary channel. */
  async notifyOwner(text: string): Promise<void> {
    this.core.session.transcript.push({ who: "assistant", text });
    return this.notifyLate(text);
  }

  /** Deliver a message that arrived after a call or Siri Shortcut stopped waiting. */
  async notifyLate(text: string): Promise<void> {
    const n = this.cfg.notifyChannel;
    if (n === "imessage" && this.imessage) {
      const to = this.imessage.lastTo || this.cfg.imessage.allowedHandles[0];
      if (to) return this.imessage.send(to, text);
    }
    if (n === "telegram" && this.telegram) {
      const chat = this.telegram.lastChatId || this.cfg.telegram.allowedUserIds[0];
      if (chat) return this.telegram.send(chat, text);
    }
    if (n === "whatsapp" && this.whatsapp) {
      const to = this.whatsapp.lastFrom || this.whatsapp.allowed.values().next().value;
      if (to) return this.whatsapp.send(to, text);
    }
    this.outbox.push(text);
  }
}
