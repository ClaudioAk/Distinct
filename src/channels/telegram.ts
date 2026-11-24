// Telegram Bot API channel (long polling: no public URL needed).
import { audit } from "../config.ts";

export type OnMessage = (text: string, reply: (t: string) => Promise<void>) => void;

export function chunks(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [""];
}

export class Telegram {
  token: string;
  allowed: Set<string>;
  onMessage: OnMessage;
  running = false;
  ctrl: AbortController | null = null;
  status = "stopped";
  lastChatId = "";
  username = "";
  /** Pairing: a stranger who sends the right code becomes the owner (returns true when paired). */
  onStranger: (from: string, text: string, name: string) => boolean = () => false;

  constructor(token: string, allowedUserIds: string[], onMessage: OnMessage) {
    this.token = token;
    this.allowed = new Set(allowedUserIds.map((s) => s.trim()).filter(Boolean));
    this.onMessage = onMessage;
  }

  api(method: string, body: unknown, signal?: AbortSignal): Promise<any> {
    return fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }).then((r) => r.json());
  }

  async send(chatId: string, text: string): Promise<void> {
    for (const part of chunks(text, 4000)) await this.api("sendMessage", { chat_id: chatId, text: part, link_preview_options: { is_disabled: true } });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop();
  }

  stop(): void {
    this.running = false;
    this.ctrl?.abort();
    this.status = "stopped";
  }

  async loop(): Promise<void> {
    let offset = 0;
    const me = await this.api("getMe", {}).catch(() => null);
    if (!me?.ok) {
      this.status = "error: bot token rejected";
      this.running = false;
      return;
    }
    this.username = me.result.username;
    this.status = `running as @${me.result.username}`;
    while (this.running) {
      try {
        this.ctrl = new AbortController();
        const r = await this.api("getUpdates", { offset, timeout: 50, allowed_updates: ["message"] }, this.ctrl.signal);
        for (const u of r.result ?? []) {
          offset = u.update_id + 1;
          const msg = u.message;
          if (!msg?.text || msg.chat?.type !== "private") continue;
          const from = String(msg.from?.id ?? "");
          const chatId = String(msg.chat.id);
          if (!this.allowed.has(from)) {
            if (this.onStranger(from, msg.text, msg.from?.first_name ?? "")) {
              this.allowed.add(from);
              this.lastChatId = chatId;
              await this.send(chatId, "✅ Paired! I'm your DInstinct assistant. Ask me anything, e.g. \"find me a padel court for Saturday\".");
              continue;
            }
            audit("telegram_rejected", { from });
            await this.send(chatId, "This assistant is private. If it's yours, open DInstinct on your PC and send the pairing code shown there.");
            continue;
          }
          this.lastChatId = chatId;
          this.onMessage(msg.text, (t) => this.send(chatId, t));
        }
      } catch {
        if (this.running) await new Promise((res) => setTimeout(res, 3000));
      }
    }
  }
}
