// WhatsApp Business Platform (Cloud API) channel, the same model Instinct uses:
// the assistant has its own WhatsApp business number and you chat with it.
// Meta calls our webhook (via the public tunnel URL); every call is verified with
// the app secret (X-Hub-Signature-256) before it is trusted.
import { createHmac, timingSafeEqual } from "node:crypto";
import { audit, digits } from "../config.ts";
import { chunks, type OnMessage } from "./telegram.ts";

export type WhatsAppOpts = {
  accessToken: string;
  appSecret: string;
  verifyToken: string;
  phoneNumberId: string;
  allowedNumbers: string[];
  graphVersion: string;
};

export class WhatsApp {
  o: WhatsAppOpts;
  allowed: Set<string>;
  onMessage: OnMessage;
  status = "waiting for the first webhook call";
  lastFrom = "";
  seen = new Set<string>();
  /** Pairing: a stranger who sends the right code becomes the owner (returns true when paired). */
  onStranger: (from: string, text: string, name: string) => boolean = () => false;

  constructor(o: WhatsAppOpts, onMessage: OnMessage) {
    this.o = o;
    this.allowed = new Set(o.allowedNumbers.map(digits).filter(Boolean));
    this.onMessage = onMessage;
  }

  /** GET verification handshake when you register the webhook in the Meta dashboard. */
  verify(q: URLSearchParams): string | null {
    const ok = q.get("hub.mode") === "subscribe" && !!this.o.verifyToken && q.get("hub.verify_token") === this.o.verifyToken;
    if (ok) this.status = "webhook verified";
    return ok ? q.get("hub.challenge") : null;
  }

  validSignature(raw: Buffer, header: string | undefined): boolean {
    if (!header?.startsWith("sha256=") || !this.o.appSecret) return false;
    const expected = createHmac("sha256", this.o.appSecret).update(raw).digest();
    const got = Buffer.from(header.slice(7), "hex");
    return got.length === expected.length && timingSafeEqual(got, expected);
  }

  /** POST webhook. Returns false when the signature is wrong. */
  handle(raw: Buffer, signature: string | undefined): boolean {
    if (!this.validSignature(raw, signature)) {
      audit("whatsapp_bad_signature");
      return false;
    }
    const body = JSON.parse(raw.toString("utf8"));
    for (const entry of body.entry ?? [])
      for (const ch of entry.changes ?? []) {
        const v = ch.value ?? {};
        if (v.metadata?.phone_number_id && v.metadata.phone_number_id !== this.o.phoneNumberId) continue;
        for (const m of v.messages ?? []) {
          if (this.seen.has(m.id)) continue; // Meta retries deliveries
          this.seen.add(m.id);
          if (this.seen.size > 500) this.seen.clear();
          const from = digits(m.from ?? "");
          if (!this.allowed.has(from)) {
            const name = (v.contacts ?? []).find((c: any) => digits(c.wa_id ?? "") === from)?.profile?.name ?? "";
            if (m.type === "text" && this.onStranger(from, m.text?.body ?? "", name)) {
              this.allowed.add(from);
              this.lastFrom = from;
              this.status = "paired";
              this.send(from, "✅ Paired! I'm your DInstinct assistant. Ask me anything, e.g. \"book a table for two on Friday\".").catch(() => {});
              continue;
            }
            audit("whatsapp_rejected", { from });
            continue;
          }
          const text = m.type === "text" ? m.text?.body : m.type === "button" ? m.button?.text : m.interactive?.button_reply?.title;
          if (!text) {
            this.send(from, "I can only read text messages for now.").catch(() => {});
            continue;
          }
          this.status = "receiving messages";
          this.lastFrom = from;
          this.onMessage(text, (t) => this.send(from, t));
        }
      }
    return true;
  }

  async send(to: string, text: string): Promise<void> {
    for (const part of chunks(text, 4000)) {
      const r = await fetch(`https://graph.facebook.com/${this.o.graphVersion}/${this.o.phoneNumberId}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.o.accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: part, preview_url: false } }),
      });
      if (!r.ok) {
        this.status = `send error ${r.status}`;
        audit("whatsapp_send_error", { status: r.status, body: (await r.text()).slice(0, 300) });
      }
    }
  }
}
