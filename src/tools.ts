// Tools the AI can call. None of them returns a vault secret to the model.
import { audit } from "./config.ts";
import { ENTRY_KINDS, hostMatches, normalizeSite, type EntryKind } from "./vault.ts";
import { BANK_RULE, isBankField, looksLikeBankValue } from "./policy.ts";
import { runGoogleTool } from "./google.ts";
import { runReminderTool } from "./proactive.ts";

/** Parses "$42.50", "1,299 EGP", "€30" → 42.5 / 1299 / 30. NaN when no number. */
export function parseAmount(s: string): number {
  const m = String(s).replace(/,(?=\d{3}\b)/g, "").match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : NaN;
}
import type { Block, ToolDef } from "./llm/types.ts";
import type { Core } from "./core.ts";

const str = { type: "string" };
const obj = (properties: Record<string, any>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });

export const TOOLS: ToolDef[] = [
  {
    name: "browser_open",
    description: "Open a URL in the assistant's browser and return a snapshot of the page (text + numbered interactive elements).",
    input_schema: obj({ url: str }, ["url"]),
  },
  { name: "browser_snapshot", description: "Re-read the current page. Element [ref] numbers change after every snapshot.", input_schema: obj({}, []) },
  { name: "browser_click", description: "Click the element with this [ref] from the latest snapshot.", input_schema: obj({ ref: str }, ["ref"]) },
  {
    name: "browser_type",
    description: "Type ordinary (non-secret) text into an input, or choose an option in a <select>. Set submit=true to press Enter afterwards.",
    input_schema: obj({ ref: str, text: str, submit: { type: "boolean" } }, ["ref", "text"]),
  },
  { name: "browser_key", description: "Press a keyboard key on the page, e.g. Enter, Tab, Escape, PageDown, ArrowDown.", input_schema: obj({ key: str }, ["key"]) },
  { name: "browser_back", description: "Go back one page.", input_schema: obj({}, []) },
  { name: "browser_screenshot", description: "Take a screenshot of the page (secret fields are blacked out). Use when the text snapshot is not enough.", input_schema: obj({}, []) },
  {
    name: "vault_list",
    description: "List the owner's saved vault entries: name, kind, allowed sites and which fields exist. Values are never shown.",
    input_schema: obj({}, []),
  },
  {
    name: "vault_fill",
    description:
      "Type one vault field (e.g. username, email, password, address) into a page input. Only works on the entry's allowed sites, and never into payment or bank fields.",
    input_schema: obj({ ref: str, entry: str, field: str }, ["ref", "entry", "field"]),
  },
  {
    name: "vault_request_fill",
    description:
      "Send the owner a secure, encrypted one-time link to save a login or personal details (never bank or card details) into their vault. Waits until they submit it (up to 15 minutes). Use when vault_list has no suitable entry.",
    input_schema: obj(
      {
        kind: { type: "string", enum: ["login", "identity", "note"] },
        name: { type: "string", description: "Entry name, e.g. 'Anghami'" },
        sites: { type: "array", items: str, description: "Hostnames it may be used on, e.g. ['anghami.com']" },
        fields: {
          type: "array",
          description: "Fields to ask for",
          items: obj({ key: { type: "string", description: "lowercase id, e.g. email, password" }, label: str, secret: { type: "boolean" } }, ["key", "label", "secret"]),
        },
        reason: { type: "string", description: "One short sentence telling the owner why it's needed" },
      },
      ["kind", "name", "sites", "fields", "reason"],
    ),
  },
  {
    name: "ask_user",
    description: "Ask the owner a question in the chat and wait for their reply (up to 30 minutes). Also use it for one-time sign-in codes.",
    input_schema: obj({ question: str }, ["question"]),
  },
  {
    name: "confirm_purchase",
    description:
      "Required before placing any order or paying. Only a payment method the owner already saved on the merchant's site may be used. Shows the item, seller and total and waits for YES. Approval lasts 10 minutes.",
    input_schema: obj({ item: str, seller: str, total: str }, ["item", "seller", "total"]),
  },
  { name: "remember", description: "Save a lasting fact about the owner (preferences, addresses they mention, people). No secrets.", input_schema: obj({ fact: str }, ["fact"]) },
  { name: "forget", description: "Delete a remembered fact by its id.", input_schema: obj({ id: str }, ["id"]) },
];

const YES = new Set(["yes", "y", "ok", "confirm", "نعم", "ايوه", "أيوه", "ايوة", "اه", "آه", "تمام", "موافق"]);
export const isYes = (s: string) => YES.has(s.trim().toLowerCase().replace(/[.!؟?]+$/, ""));

function need(input: any, ...keys: string[]): void {
  for (const k of keys) if (typeof input?.[k] !== "string" || !input[k].trim()) throw new Error(`missing "${k}"`);
}

export async function runTool(core: Core, name: string, input: any): Promise<string | Block[]> {
  const b = core.browser;
  const vault = core.vault;
  switch (name) {
    case "browser_open":
      need(input, "url");
      audit("browser_open", { url: input.url });
      return b.open(input.url);
    case "browser_snapshot":
      return b.snapshot();
    case "browser_click":
      need(input, "ref");
      return b.click(input.ref);
    case "browser_type": {
      need(input, "ref");
      const text = String(input.text ?? "");
      if (looksLikeBankValue(text) || (/\d{3,}/.test(text) && isBankField(await b.fieldInfo(input.ref)))) {
        audit("bank_rule_blocked", { tool: "browser_type", host: b.host() });
        return `Blocked: ${BANK_RULE} Use a payment method already saved on the site, or tell the owner to finish payment themselves.`;
      }
      return b.type(input.ref, text, !!input.submit);
    }
    case "browser_key":
      need(input, "key");
      return b.key(input.key);
    case "browser_back":
      return b.back();
    case "browser_screenshot": {
      if (!core.llm().supportsImages) return "Screenshots are not available with the local model; use browser_snapshot.";
      const data = await b.screenshot();
      return [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data } }];
    }
    case "vault_list":
      return JSON.stringify(vault.listForAgent());
    case "vault_fill": {
      need(input, "ref", "entry", "field");
      const e = vault.findUsable(input.entry);
      if (!e) return `No usable vault entry named "${input.entry}". Use vault_list, or vault_request_fill to ask the owner.`;
      if (isBankField(input.field)) return `Blocked: ${BANK_RULE}`;
      const value = e.fields[input.field];
      if (!value) return `Entry "${e.name}" has no "${input.field}" field. Fields: ${Object.keys(e.fields).join(", ")}`;
      await b.ensure();
      const host = b.host();
      if (!e.sites.some((s) => hostMatches(host, s))) {
        audit("vault_fill_blocked", { entry: e.name, field: input.field, host });
        return `Blocked: "${e.name}" may only be used on ${e.sites.join(", ") || "(no sites)"}, but this page is ${host || "unknown"}. If this is a legitimate site for it, ask the owner (ask_user) to add it in the vault.`;
      }
      if (isBankField(await b.fieldInfo(input.ref))) {
        audit("bank_rule_blocked", { tool: "vault_fill", entry: e.name, host });
        return `Blocked: that looks like a payment or bank field. ${BANK_RULE}`;
      }
      await b.fillSecret(input.ref, value);
      audit("vault_fill", { entry: e.name, field: input.field, host });
      return `Typed ${e.name}.${input.field} into [${input.ref}] (value hidden from you). Take a snapshot to continue.`;
    }
    case "vault_request_fill": {
      need(input, "name", "reason");
      if (input.kind === "card" || isBankField(String(input.name)) || (Array.isArray(input.fields) && input.fields.some((f: any) => isBankField(`${f?.key ?? ""} ${f?.label ?? ""}`)))) {
        audit("bank_rule_blocked", { tool: "vault_request_fill", name: input.name });
        return `Refused: ${BANK_RULE} Don't ask the owner for them. For purchases use a payment method already saved on the merchant's site (with confirm_purchase), or let the owner pay themselves.`;
      }
      const kind = ((ENTRY_KINDS as string[]).includes(input.kind) ? input.kind : "login") as EntryKind;
      const sites = (Array.isArray(input.sites) ? input.sites : []).map((s: string) => normalizeSite(String(s))).filter(Boolean);
      const fields = (Array.isArray(input.fields) ? input.fields : [])
        .map((f: any) => ({ key: String(f.key ?? "").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 32), label: String(f.label ?? f.key ?? "").slice(0, 60), secret: f.secret !== false }))
        .filter((f: any) => f.key)
        .slice(0, 12);
      if (!fields.length) return "Give at least one field.";
      const ok = await core.requestFill(kind, input.name, sites, fields, input.reason);
      return ok ? `The owner saved "${input.name}" to the vault. Use vault_fill with entry "${input.name}".` : "The owner didn't fill the link in time (or the vault is locked). Tell them, then stop.";
    }
    case "ask_user": {
      need(input, "question");
      const reply = await core.ask(input.question);
      return reply === null ? "No reply within 30 minutes." : `Owner replied: ${reply}`;
    }
    case "confirm_purchase": {
      need(input, "item", "seller", "total");
      // Spending limits (set by the owner in Settings), enforced before even asking.
      const lim = core.cfg.spending;
      const amount = parseAmount(input.total);
      const month = new Date().toISOString().slice(0, 7);
      const spent = core.vault.getState<{ month: string; total: number }>("spend", { month, total: 0 });
      const spentThisMonth = spent.month === month ? spent.total : 0;
      if ((lim.perOrder > 0 || lim.perMonth > 0) && Number.isNaN(amount))
        return "Blocked: couldn't read the total as a number. Give the exact total, e.g. '42.50 USD'.";
      if (lim.perOrder > 0 && amount > lim.perOrder) {
        audit("spending_limit_blocked", { amount, limit: lim.perOrder });
        return `Blocked by the owner's spending limit: ${amount} is over the ${lim.perOrder} ${lim.currency} per-order limit. Tell the owner; they can raise it in Settings or order themselves.`;
      }
      if (lim.perMonth > 0 && spentThisMonth + amount > lim.perMonth) {
        audit("spending_limit_blocked", { amount, spentThisMonth, limit: lim.perMonth });
        return `Blocked by the owner's monthly spending limit (${spentThisMonth} of ${lim.perMonth} ${lim.currency} used). Tell the owner.`;
      }
      const reply = await core.ask(`Confirm purchase?\n• ${input.item}\n• Seller: ${input.seller}\n• Total: ${input.total}\nReply YES to approve, anything else to cancel.`);
      audit("confirm_purchase", { item: input.item, seller: input.seller, total: input.total, approved: !!reply && isYes(reply) });
      if (reply && isYes(reply)) {
        core.session.purchaseApprovedUntil = Date.now() + 10 * 60_000;
        if (!Number.isNaN(amount)) core.vault.setState("spend", { month, total: spentThisMonth + amount });
        return "Approved. You may enter card details and place this exact order within 10 minutes.";
      }
      core.session.purchaseApprovedUntil = 0;
      return `Not approved (owner said: ${reply ?? "nothing"}). Do not buy.`;
    }
    case "remember":
      need(input, "fact");
      return `Saved as memory ${vault.addMemory(input.fact).id}.`;
    case "forget":
      need(input, "id");
      return vault.removeMemory(input.id) ? "Forgotten." : "No memory with that id.";
    default:
      return runReminderTool(core, name, input) ?? (await runGoogleTool(core, name, input)) ?? `Unknown tool ${name}`;
  }
}
