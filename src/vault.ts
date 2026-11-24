// Encrypted local vault.
//
// File format (data/vault.dat, JSON):
//   { v, kdf: { name: "scrypt", N, r, p, salt }, iv, tag, ct }
// The master password goes through scrypt to a 256-bit key; the whole payload
// (entries, API tokens, memories) is encrypted with AES-256-GCM. The header is
// bound to the ciphertext as AAD, so tampering with KDF settings is detected.
// Nothing secret is ever written to disk in plain text, and the key only lives
// in memory while the vault is unlocked.

import { randomBytes, scrypt as scryptCb, createCipheriv, createDecipheriv, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { assertNoBankInfo, isBankField, looksLikeBankValue } from "./policy.ts";

// No "card" kind: bank and card details are never stored (see policy.ts).
export type EntryKind = "login" | "identity" | "note";
export const ENTRY_KINDS: EntryKind[] = ["login", "identity", "note"];

/** Entries the agent may use: allowed kind and no bank-looking data (older vault files may hold some). */
export function usable(e: { kind: string; fields: Record<string, string> }): boolean {
  return (ENTRY_KINDS as string[]).includes(e.kind) && !Object.entries(e.fields).some(([k, v]) => isBankField(k) || looksLikeBankValue(v));
}

export type Entry = {
  id: string;
  kind: EntryKind;
  name: string;
  sites: string[]; // hostnames the agent may type these values into, e.g. "anghami.com"
  fields: Record<string, string>;
  created: string;
  updated: string;
};

export type Memory = { id: string; text: string; created: string };

type Payload = {
  entries: Entry[];
  system: Record<string, string>; // API keys and channel tokens, never shown to the AI
  memories: Memory[];
  state?: Record<string, unknown>; // reminders, briefing/notification history, spending totals
};

type Header = { v: 1; kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string } };

const KDF_DEFAULT = { N: 2 ** 17, r: 8, p: 1 };
export const MIN_PASSWORD = 12;

function deriveKey(password: string, salt: Buffer, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password.normalize("NFKC"), salt, 32, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export function normalizeSite(s: string): string {
  let v = s.trim().toLowerCase();
  if (!v) return "";
  try {
    if (v.includes("://")) v = new URL(v).hostname;
  } catch {
    return "";
  }
  v = v.replace(/^\*\./, "").replace(/^www\./, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(v) ? v : "";
}

/** True when `host` is `site` or one of its subdomains. */
export function hostMatches(host: string, site: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  return h === site || h.endsWith("." + site);
}

export class Vault {
  file: string;
  key: Buffer | null = null;
  header: Header | null = null;
  data: Payload | null = null;

  constructor(file: string) {
    this.file = file;
  }

  exists(): boolean {
    return fs.existsSync(this.file);
  }

  isUnlocked(): boolean {
    return this.key !== null && this.data !== null;
  }

  async create(password: string): Promise<void> {
    if (this.exists()) throw new Error("A vault already exists.");
    if (password.length < MIN_PASSWORD) throw new Error(`Use at least ${MIN_PASSWORD} characters.`);
    const salt = randomBytes(16);
    this.header = { v: 1, kdf: { name: "scrypt", ...KDF_DEFAULT, salt: salt.toString("base64") } };
    this.key = await deriveKey(password, salt, KDF_DEFAULT.N, KDF_DEFAULT.r, KDF_DEFAULT.p);
    this.data = { entries: [], system: {}, memories: [] };
    this.save();
  }

  async unlock(password: string): Promise<void> {
    const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
    const header: Header = { v: raw.v, kdf: raw.kdf };
    const { N, r, p, salt } = header.kdf;
    const key = await deriveKey(password, Buffer.from(salt, "base64"), N, r, p);
    try {
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(raw.iv, "base64"));
      d.setAAD(Buffer.from(JSON.stringify(header)));
      d.setAuthTag(Buffer.from(raw.tag, "base64"));
      const plain = Buffer.concat([d.update(Buffer.from(raw.ct, "base64")), d.final()]);
      this.data = JSON.parse(plain.toString("utf8"));
      plain.fill(0);
    } catch {
      key.fill(0);
      await new Promise((r) => setTimeout(r, 1000)); // slow down guessing
      throw new Error("Wrong password.");
    }
    this.key = key;
    this.header = header;
  }

  lock(): void {
    this.key?.fill(0);
    this.key = null;
    this.data = null;
  }

  async changePassword(oldPw: string, newPw: string): Promise<void> {
    if (newPw.length < MIN_PASSWORD) throw new Error(`Use at least ${MIN_PASSWORD} characters.`);
    const probe = new Vault(this.file);
    await probe.unlock(oldPw); // throws on a wrong password
    probe.lock();
    const salt = randomBytes(16);
    this.key?.fill(0);
    this.header = { v: 1, kdf: { name: "scrypt", ...KDF_DEFAULT, salt: salt.toString("base64") } };
    this.key = await deriveKey(newPw, salt, KDF_DEFAULT.N, KDF_DEFAULT.r, KDF_DEFAULT.p);
    this.save();
  }

  save(): void {
    if (!this.key || !this.data || !this.header) throw new Error("Vault is locked.");
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(Buffer.from(JSON.stringify(this.header)));
    const ct = Buffer.concat([c.update(JSON.stringify(this.data), "utf8"), c.final()]);
    const out = { ...this.header, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  #d(): Payload {
    if (!this.data) throw new Error("Vault is locked.");
    return this.data;
  }

  // ---- entries --------------------------------------------------------

  entries(): Entry[] {
    return this.#d().entries;
  }

  find(name: string): Entry | undefined {
    const n = name.trim().toLowerCase();
    return this.#d().entries.find((e) => e.name.toLowerCase() === n);
  }

  /** Lookup for the agent: never returns an entry that breaks the bank rule. */
  findUsable(name: string): Entry | undefined {
    const e = this.find(name);
    return e && usable(e) ? e : undefined;
  }

  /** What the AI is allowed to know: names, kinds, sites and which fields exist. Never values. */
  listForAgent(): { name: string; kind: EntryKind; sites: string[]; fields: string[] }[] {
    return this.#d().entries.filter(usable).map((e) => ({
      name: e.name,
      kind: e.kind,
      sites: e.sites,
      fields: Object.keys(e.fields).filter((k) => e.fields[k] !== ""),
    }));
  }

  upsert(input: { kind: EntryKind; name: string; sites: string[]; fields: Record<string, string> }): Entry {
    if (!ENTRY_KINDS.includes(input.kind)) throw new Error(`Unknown entry kind "${input.kind}".`);
    assertNoBankInfo(input.fields); // throws: bank and card details are never stored
    const now = new Date().toISOString();
    const sites = [...new Set(input.sites.map(normalizeSite).filter(Boolean))];
    const existing = this.find(input.name);
    if (existing) {
      existing.kind = input.kind;
      existing.sites = sites;
      for (const [k, v] of Object.entries(input.fields)) if (v !== "") existing.fields[k] = v;
      existing.updated = now;
      this.save();
      return existing;
    }
    const e: Entry = { id: randomUUID(), kind: input.kind, name: input.name.trim(), sites, fields: { ...input.fields }, created: now, updated: now };
    this.#d().entries.push(e);
    this.save();
    return e;
  }

  remove(id: string): void {
    const d = this.#d();
    d.entries = d.entries.filter((e) => e.id !== id);
    this.save();
  }

  // ---- system secrets (API keys, bot tokens) -------------------------

  getSystem(k: string): string {
    return this.#d().system[k] ?? "";
  }

  setSystem(k: string, v: string): void {
    if (v === "") delete this.#d().system[k];
    else this.#d().system[k] = v;
    this.save();
  }

  // ---- encrypted app state ----------------------------------------------

  getState<T>(k: string, fallback: T): T {
    const s = this.#d().state ?? {};
    return k in s ? (s[k] as T) : fallback;
  }

  setState(k: string, v: unknown): void {
    const d = this.#d();
    d.state = { ...(d.state ?? {}), [k]: v };
    this.save();
  }

  // ---- memories -------------------------------------------------------

  memories(): Memory[] {
    return this.#d().memories;
  }

  addMemory(text: string): Memory {
    const m = { id: randomUUID().slice(0, 8), text: text.slice(0, 500), created: new Date().toISOString() };
    this.#d().memories.push(m);
    this.save();
    return m;
  }

  removeMemory(id: string): boolean {
    const d = this.#d();
    const before = d.memories.length;
    d.memories = d.memories.filter((m) => m.id !== id);
    this.save();
    return d.memories.length < before;
  }
}
