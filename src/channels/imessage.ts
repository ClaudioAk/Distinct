// iMessage channel through Sendblue (an iMessage API provider; no Mac needed).
// The assistant gets its own blue-bubble number, and you text it from your iPhone like Instinct.
//
// Sendblue does not document a signature for incoming webhooks, so the webhook URL carries a
// long random secret (/imessage/webhook/<secret>), and only the owner's handles are answered.
import { audit, digits } from "../config.ts";
import { chunks, type OnMessage } from "./telegram.ts";

const API = "https://api.sendblue.co/api";

export type IMessageOpts = {
  keyId: string;
  secretKey: string;
  fromNumber: string; // the assistant's Sendblue number, E.164
  allowedHandles: string[]; // owner's phone numbers and/or Apple ID emails
};

export const normalizeHandle = (h: string) => (h.includes("@") ? h.trim().toLowerCase() : digits(h));

export class IMessage {
  o: IMessageOpts;
  allowed: Set<string>;
  onMessage: OnMessage;
  status = "waiting for the first message";
  lastTo = "";
  seen = new Set<string>();

  constructor(o: IMessageOpts, onMessage: OnMessage) {
    this.o = o;
    this.allowed = new Set(o.allowedHandles.map(normalizeHandle).filter(Boolean));
    this.onMessage = onMessage;
  }

  headers() {
    return { "sb-api-key-id": this.o.keyId, "sb-api-secret-key": this.o.secretKey, "content-type": "application/json" };
  }

  /** Inbound "receive" webhook payload (already authenticated by the URL secret). */
  handle(body: any): void {
    if (!body || body.is_outbound) return;
    const id = String(body.message_handle ?? "");
    if (id) {
      if (this.seen.has(id)) return; // Sendblue retries deliveries
      this.seen.add(id);
      if (this.seen.size > 500) this.seen.clear();
    }
    if (body.group_id) return; // group chats are not supported
    const from = String(body.from_number ?? "");
    const replyTo = String(body.number || from);
    if (![from, replyTo].some((h) => this.allowed.has(normalizeHandle(h)))) {
      audit("imessage_rejected", { from });
      return;
    }
    const text = String(body.content ?? "").trim();
    if (!text) {
      this.send(replyTo, "I can only read text messages for now.").catch(() => {});
      return;
    }
    this.status = `receiving messages (${body.service ?? "iMessage"})`;
    this.lastTo = replyTo;
    this.typing(replyTo).catch(() => {});
    this.onMessage(text, (t) => this.send(replyTo, t));
  }

  async typing(to: string): Promise<void> {
    if (to.includes("@")) return;
    await fetch(`${API}/send-typing-indicator`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ from_number: this.o.fromNumber, number: to }),
    });
  }

  async send(to: string, text: string): Promise<void> {
    for (const part of chunks(text, 4000)) {
      const r = await fetch(`${API}/send-message`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ number: to, from_number: this.o.fromNumber, content: part }),
      });
      if (!r.ok) {
        this.status = `send error ${r.status}`;
        audit("imessage_send_error", { status: r.status, body: (await r.text()).slice(0, 300) });
      }
    }
  }
}
