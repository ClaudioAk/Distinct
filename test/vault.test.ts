import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Vault, hostMatches, normalizeSite } from "../src/vault.ts";

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dinstinct-")), "vault.dat");

test("vault encrypts at rest and round-trips", async () => {
  const file = tmp();
  const v = new Vault(file);
  await v.create("correct horse battery");
  v.upsert({ kind: "login", name: "Anghami", sites: ["https://www.anghami.com/login"], fields: { email: "me@example.com", password: "S3cret-Pa55!" } });
  v.setSystem("telegram_bot_token", "123:ABC-token");
  v.lock();

  const raw = fs.readFileSync(file, "utf8");
  for (const s of ["S3cret-Pa55!", "me@example.com", "Anghami", "123:ABC-token", "anghami.com"]) assert.ok(!raw.includes(s), `plain text leaked: ${s}`);

  const v2 = new Vault(file);
  await v2.unlock("correct horse battery");
  const e = v2.find("anghami")!;
  assert.equal(e.fields.password, "S3cret-Pa55!");
  assert.deepEqual(e.sites, ["anghami.com"]);
  assert.equal(v2.getSystem("telegram_bot_token"), "123:ABC-token");
});

test("wrong password and tampering are rejected", async () => {
  const file = tmp();
  const v = new Vault(file);
  await v.create("correct horse battery");
  v.lock();
  await assert.rejects(new Vault(file).unlock("wrong password!!"), /Wrong password/);

  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.kdf.N = 2 ** 14; // try to weaken the KDF
  fs.writeFileSync(file, JSON.stringify(raw));
  await assert.rejects(new Vault(file).unlock("correct horse battery"), /Wrong password/);
});

test("short master passwords are refused", async () => {
  await assert.rejects(new Vault(tmp()).create("short"), /at least/);
});

test("agent view never contains values", async () => {
  const v = new Vault(tmp());
  await v.create("correct horse battery");
  v.upsert({ kind: "login", name: "Gym", sites: ["gym.example.com"], fields: { email: "me@x.com", password: "Hunter2-long" } });
  const view = JSON.stringify(v.listForAgent());
  assert.ok(!view.includes("Hunter2-long") && !view.includes("me@x.com"));
  assert.match(view, /"fields":\["email","password"\]/);
});

test("bank information is never stored", async () => {
  const v = new Vault(tmp());
  await v.create("correct horse battery");
  const bad: Record<string, string>[] = [
    { number: "4111 1111 1111 1111" },
    { cvc: "123" },
    { iban: "x" },
    { note: "my card 4242-4242-4242-4242" },
    { info: "DE89 3704 0044 0532 0130 00" },
    { routing_number: "021000021" },
    { pin: "1234" },
  ];
  for (const fields of bad) assert.throws(() => v.upsert({ kind: "note", name: "x", sites: [], fields }), /never handles bank information/);
  assert.throws(() => v.upsert({ kind: "card" as any, name: "Visa", sites: [], fields: { holder: "me" } }), /Unknown entry kind/);
  assert.equal(v.entries().length, 0);
  // ordinary numbers are fine
  v.upsert({ kind: "identity", name: "Me", sites: ["a.com"], fields: { phone: "+20 100 123 4567", postcode: "11511" } });
});

test("change password keeps data", async () => {
  const file = tmp();
  const v = new Vault(file);
  await v.create("correct horse battery");
  v.addMemory("Prefers window seats");
  await v.changePassword("correct horse battery", "another long passphrase");
  v.lock();
  const v2 = new Vault(file);
  await v2.unlock("another long passphrase");
  assert.equal(v2.memories()[0].text, "Prefers window seats");
});

test("site matching", () => {
  assert.equal(normalizeSite("https://www.Anghami.com/login"), "anghami.com");
  assert.equal(normalizeSite("javascript:alert(1)"), "");
  assert.ok(hostMatches("play.anghami.com", "anghami.com"));
  assert.ok(hostMatches("www.anghami.com", "anghami.com"));
  assert.ok(!hostMatches("anghami.com.evil.io", "anghami.com"));
  assert.ok(!hostMatches("notanghami.com", "anghami.com"));
});
