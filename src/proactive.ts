// Proactive engine: Distinct starts the conversation.
//  - Reminders you (or the agent) set
//  - A morning briefing: today's agenda, calendar clashes, bookings coming up,
//    important unread mail, and emails you sent that nobody answered
//  - Calendar-clash alerts during the day
// Respects quiet hours, never repeats the same alert, and everything it remembers
// (reminders, what it already told you) lives in the encrypted vault.
import { randomUUID } from "node:crypto";
import { audit } from "./config.ts";
import { header } from "./google.ts";
import type { ToolDef } from "./llm/types.ts";
import type { App } from "./app.ts";
import type { Core } from "./core.ts";

export type Reminder = { id: string; text: string; due: string };

const hm = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};
const fmtTime = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const day = (d: Date) => d.toLocaleDateString("en-CA"); // YYYY-MM-DD in local time

export function inQuietHours(now: Date, start: string, end: string): boolean {
  if (!start || !end || start === end) return false;
  const t = now.getHours() * 60 + now.getMinutes();
  const a = hm(start);
  const b = hm(end);
  return a < b ? t >= a && t < b : t >= a || t < b;
}

/** Pairs of overlapping, timed events the owner hasn't declined. */
export function findConflicts(events: any[]): [any, any][] {
  const timed = events
    .filter((e) => e.start?.dateTime && e.status !== "cancelled" && e.transparency !== "transparent")
    .filter((e) => !(e.attendees ?? []).some((a: any) => a.self && a.responseStatus === "declined"))
    .map((e) => ({ e, s: Date.parse(e.start.dateTime), t: Date.parse(e.end?.dateTime ?? e.start.dateTime) }))
    .sort((x, y) => x.s - y.s);
  const out: [any, any][] = [];
  for (let i = 0; i < timed.length; i++)
    for (let j = i + 1; j < timed.length && timed[j].s < timed[i].t; j++) out.push([timed[i].e, timed[j].e]);
  return out;
}

export class Proactive {
  app: App;
  timer: NodeJS.Timeout | null = null;
  lastCalendarCheck = 0;
  running = false;

  constructor(app: App) {
    this.app = app;
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => this.tick().catch((e) => audit("proactive_error", { message: String(e?.message ?? e).slice(0, 200) })), 60_000);
    setTimeout(() => this.tick().catch(() => {}), 5_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get vault() {
    return this.app.vault;
  }

  seen(key: string): boolean {
    return this.vault.getState<string[]>("notified", []).includes(key);
  }

  mark(key: string): void {
    const list = this.vault.getState<string[]>("notified", []);
    list.push(key);
    this.vault.setState("notified", list.slice(-400));
  }

  async say(text: string): Promise<void> {
    await this.app.notifyOwner(text);
    audit("proactive_message", { chars: text.length });
  }

  async tick(now = new Date()): Promise<void> {
    if (this.running || !this.vault.isUnlocked()) return;
    this.running = true;
    try {
      const p = this.app.cfg.proactive;
      const quiet = inQuietHours(now, p.quietStart, p.quietEnd);

      // 1. Reminders (held during quiet hours)
      if (!quiet) {
        const all = this.vault.getState<Reminder[]>("reminders", []);
        const due = all.filter((r) => Date.parse(r.due) <= now.getTime());
        if (due.length) {
          this.vault.setState("reminders", all.filter((r) => !due.includes(r)));
          for (const r of due) await this.say(`⏰ Reminder: ${r.text}`);
        }
      }
      if (!p.enabled || quiet) return;

      // 2. Morning briefing, once a day
      if (p.briefing && now.getHours() * 60 + now.getMinutes() >= hm(p.briefingTime) && this.vault.getState("lastBriefing", "") !== day(now)) {
        this.vault.setState("lastBriefing", day(now));
        const text = await this.briefing(now);
        if (text) await this.say(text);
      }

      // 3. Calendar clashes, every 15 minutes
      const g = this.app.core.google;
      if (p.calendarAlerts && g.connected() && now.getTime() - this.lastCalendarCheck > 15 * 60_000) {
        this.lastCalendarCheck = now.getTime();
        const events = await g.events(now, new Date(now.getTime() + 48 * 3600_000));
        for (const [a, b] of findConflicts(events)) {
          const key = `conflict:${a.id}:${b.id}`;
          if (this.seen(key)) continue;
          this.mark(key);
          await this.say(
            `Heads up: calendar clash.\n• ${a.summary ?? "(no title)"} ${fmtTime(new Date(a.start.dateTime))}–${fmtTime(new Date(a.end.dateTime))}\n• ${b.summary ?? "(no title)"} ${fmtTime(new Date(b.start.dateTime))}–${fmtTime(new Date(b.end.dateTime))}\nWant me to move or decline one?`,
          );
        }
      }
    } finally {
      this.running = false;
    }
  }

  async briefing(now: Date): Promise<string> {
    const name = this.app.cfg.ownerName;
    const parts: string[] = [];
    const todayEnd = new Date(now);
    todayEnd.setHours(23, 59, 59, 999);

    const reminders = this.vault.getState<Reminder[]>("reminders", []).filter((r) => Date.parse(r.due) <= todayEnd.getTime());
    if (reminders.length) parts.push("Reminders today:\n" + reminders.map((r) => `• ${fmtTime(new Date(r.due))} ${r.text}`).join("\n"));

    const g = this.app.core.google;
    if (g.connected()) {
      const events = await g.events(now, new Date(now.getTime() + 36 * 3600_000));
      const today = events.filter((e) => Date.parse(e.start?.dateTime ?? e.start?.date) <= todayEnd.getTime());
      if (today.length)
        parts.push("Today:\n" + today.map((e) => `• ${e.start?.dateTime ? fmtTime(new Date(e.start.dateTime)) : "all day"} ${e.summary ?? "(no title)"}`).join("\n"));
      const clashes = findConflicts(today);
      if (clashes.length) parts.push(`⚠ ${clashes.length} clash${clashes.length > 1 ? "es" : ""}: ${clashes.map(([a, b]) => `${a.summary} / ${b.summary}`).join("; ")}`);
      const bookings = events.filter((e) => /reserv|booking|table for|appointment|check-?in|flight|حجز|موعد/i.test(`${e.summary ?? ""} ${e.description ?? ""}`));
      if (bookings.length)
        parts.push("Coming up (still going? I can cancel or reschedule):\n" + bookings.map((e) => `• ${e.summary} ${e.start?.dateTime ? new Date(e.start.dateTime).toLocaleString() : e.start?.date}`).join("\n"));

      const important = await g.searchMail("is:unread is:important newer_than:1d", 5);
      if (important.length) parts.push(`Important unread (${important.length}):\n` + important.slice(0, 3).map((m) => `• ${m.subject} (from ${m.from.replace(/<.*>/, "").trim()})`).join("\n"));

      const dropped = await this.droppedThreads();
      if (dropped.length) parts.push("No reply yet:\n" + dropped.map((d) => `• "${d.subject}" to ${d.to} (${d.days} days)`).join("\n") + "\nWant me to draft follow-ups?");
    }
    if (!parts.length) return "";
    return `Good morning${name ? " " + name : ""}! ☀️\n\n${parts.join("\n\n")}`;
  }

  /** Emails the owner sent 3–14 days ago where theirs is still the last message. */
  async droppedThreads(): Promise<{ subject: string; to: string; days: number }[]> {
    const g = this.app.core.google;
    const me = (this.vault.getSystem("google_email") || "").toLowerCase();
    if (!me) return [];
    const sent = await g.searchMail("in:sent newer_than:14d older_than:3d -category:promotions", 15);
    const out: { subject: string; to: string; days: number }[] = [];
    for (const threadId of [...new Set(sent.map((m) => m.threadId))]) {
      if (out.length >= 3) break;
      const key = `followup:${threadId}`;
      if (this.seen(key)) continue;
      const t = await g.thread(threadId);
      const last = t.messages?.at(-1);
      const h = header(last?.payload?.headers);
      if (!h("From").toLowerCase().includes(me)) continue; // they replied
      if (/no-?reply|unsubscribe/i.test(h("To"))) continue;
      this.mark(key);
      out.push({ subject: h("Subject") || "(no subject)", to: h("To").replace(/<.*>/, "").trim() || h("To"), days: Math.round((Date.now() - Number(last.internalDate)) / 86400_000) });
    }
    return out;
  }
}

// ---- reminder tools (always available) -----------------------------------

const obj = (properties: Record<string, any>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });

export const REMINDER_TOOLS: ToolDef[] = [
  {
    name: "remind_me",
    description: "Set a reminder: Distinct will message the owner at that time. 'when' is an ISO date-time with timezone offset.",
    input_schema: obj({ text: { type: "string" }, when: { type: "string" } }, ["text", "when"]),
  },
  { name: "list_reminders", description: "List upcoming reminders.", input_schema: obj({}, []) },
  { name: "cancel_reminder", description: "Cancel a reminder by id.", input_schema: obj({ id: { type: "string" } }, ["id"]) },
];

export function runReminderTool(core: Core, name: string, input: any): string | null {
  const v = core.vault;
  const all = () => v.getState<Reminder[]>("reminders", []);
  switch (name) {
    case "remind_me": {
      const t = Date.parse(String(input?.when ?? ""));
      if (!input?.text || Number.isNaN(t)) return "Give text and a valid ISO date-time.";
      if (t < Date.now() - 60_000) return "That time is in the past.";
      const r = { id: randomUUID().slice(0, 8), text: String(input.text).slice(0, 300), due: new Date(t).toISOString() };
      v.setState("reminders", [...all(), r]);
      return `Reminder ${r.id} set for ${new Date(t).toString()}.`;
    }
    case "list_reminders":
      return JSON.stringify(all().sort((a, b) => a.due.localeCompare(b.due)));
    case "cancel_reminder": {
      const before = all();
      const left = before.filter((r) => r.id !== input?.id);
      v.setState("reminders", left);
      return left.length < before.length ? "Cancelled." : "No reminder with that id.";
    }
  }
  return null;
}
