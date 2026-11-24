// End to end: the agent asks for a login, the owner fills the one-time link
// (arriving through the tunnel), the entry is stored encrypted and the agent continues.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "distinct-web-"));
fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ port: 7798, publicUrl: "https://example.test" }));
process.env.DISTINCT_DATA = dir;
const { loadConfig } = await import("../src/config.ts");
const { App } = await import("../src/app.ts");
const { startWeb } = await import("../src/web.ts");

test("fill link saves an encrypted entry and the agent never sees it", async () => {
  const app = new App(loadConfig());
  await app.create("correct horse battery");
  const server = startWeb(app);
  await new Promise((r) => server.once("listening", r));

  let step = 0;
  const seen: string[] = [];
  (app.core as any).llm = () => ({
    name: "fake",
    supportsImages: false,
    describeError: () => null,
    chat: async (req: any) => {
      seen.push(JSON.stringify(req.messages));
      return [
        {
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "a",
              name: "vault_request_fill",
              input: { kind: "login", name: "Anghami", sites: ["anghami.com"], reason: "I need your Anghami login to make the playlist.", fields: [{ key: "email", label: "Email", secret: false }, { key: "password", label: "Password", secret: true }] },
            },
          ],
        },
        { stop_reason: "end_turn", content: [{ type: "text", text: "Playlist made." }] },
      ][step++];
    },
  });

  const out: string[] = [];
  const run = app.core.inbound("whatsapp", "make me a playlist on anghami", async (t) => void out.push(t));
  await new Promise((r) => setTimeout(r, 100));
  const link = out[0].match(/https:\/\/example\.test(\/fill\/[A-Za-z0-9_-]{43})/)!;
  assert.ok(link, "no fill link sent");
  const url = `http://127.0.0.1:7798${link[1]}`;

  const tunnel = { "cf-connecting-ip": "203.0.113.9" };
  assert.equal((await fetch("http://127.0.0.1:7798/vault", { headers: tunnel })).status, 404, "admin must be hidden from the tunnel");
  const form = await fetch(url, { headers: tunnel });
  assert.match(await form.text(), /type="password"/);

  const body = new URLSearchParams({ f_email: "me@example.com", f_password: "TopSecret#1", sites: "anghami.com", action: "save" });
  const saved = await fetch(url, { method: "POST", headers: { ...tunnel, "content-type": "application/x-www-form-urlencoded" }, body });
  assert.match(await saved.text(), /Saved to your vault/);
  await run;

  assert.equal(out.at(-1), "Playlist made.");
  assert.equal(app.vault.find("Anghami")?.fields.password, "TopSecret#1");
  assert.ok(!seen.join().includes("TopSecret#1"), "secret reached the model");
  assert.ok(!fs.readFileSync(path.join(dir, "vault.dat"), "utf8").includes("TopSecret#1"), "plain text on disk");
  assert.equal((await fetch(url, { headers: tunnel })).status, 200);
  assert.match(await (await fetch(url)).text(), /no longer works/, "link must be single use");

  server.close();
});
