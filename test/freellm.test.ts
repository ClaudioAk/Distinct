// Free models via a fake FreeLLMAPI router (OpenAI-compatible): key check, model list,
// and a full tool-calling round trip through the assistant.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Vault } from "../src/vault.ts";
import { Core } from "../src/core.ts";
import { DEFAULTS } from "../src/config.ts";
import { detect, listFreeModels, toOpenAI } from "../src/llm/freellm.ts";

const KEY = "freellmapi-testkey";
const requests: any[] = [];
const server = http.createServer(async (req, res) => {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${KEY}`) return res.writeHead(401).end("{}");
  if (req.url?.startsWith("/v1/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ data: [{ id: "gemini-3.8-flash", execution_status: "ready" }, { id: "glm-5.3", execution_status: "ready" }, { id: "kimi-k3", execution_status: "needsKey" }] }));
  }
  let body = "";
  for await (const c of req) body += c;
  const j = JSON.parse(body);
  requests.push(j);
  const sawTool = j.messages.some((m: any) => m.role === "tool");
  const reply = sawTool
    ? { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "You have 1 reminder set." } }] }
    : { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "list_reminders", arguments: "{}" } }] } }] };
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(reply));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as any).port}/v1`;

test("FreeLLMAPI: detect, list free models, and a tool-calling task", async () => {
  assert.deepEqual((await detect("wrong", base)).ok, false);
  assert.match((await detect("wrong", base)).message, /didn't accept that key/);
  assert.equal((await detect(KEY, base)).ok, true);

  const models = await listFreeModels(base, KEY);
  assert.equal(models[0].id, "auto:smart");
  assert.ok(models.some((m) => m.id === "glm-5.3"));
  assert.ok(!models.some((m) => m.id === "kimi-k3"), "only models ready to use");

  const v = new Vault(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dinstinct-free-")), "vault.dat"));
  await v.create("correct horse battery");
  v.setSystem("freellm_api_key", KEY);
  const cfg = structuredClone(DEFAULTS);
  cfg.llm.provider = "free";
  cfg.llm.freeUrl = base;
  cfg.llm.freeModel = "auto:smart";
  const core = new Core(cfg, v);
  const out: string[] = [];
  await core.inbound("telegram", "what reminders do I have?", async (t) => void out.push(t));
  assert.equal(out.at(-1), "You have 1 reminder set.");
  assert.equal(requests[0].model, "auto:smart");
  assert.ok(requests[0].tools.some((t: any) => t.type === "function" && t.function.name === "browser_open"));
  const second = requests[1].messages;
  assert.equal(second.at(-2).tool_calls[0].id, "call_1");
  assert.deepEqual(second.at(-1), { role: "tool", tool_call_id: "call_1", content: "[]" });

  // router down → plain-language message
  const cfg2 = structuredClone(cfg);
  cfg2.llm.freeUrl = "http://127.0.0.1:9/v1";
  const core2 = new Core(cfg2, v);
  const out2: string[] = [];
  await core2.inbound("telegram", "hi", async (t) => void out2.push(t));
  assert.match(out2.at(-1)!, /FreeLLMAPI isn't running/);
  server.close();
});

test("OpenAI message conversion keeps ids and drops images", () => {
  const msgs = toOpenAI("sys", [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "tool_use", id: "x1", name: "browser_screenshot", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "x1", content: [{ type: "image" }] }] },
  ]);
  assert.equal(msgs[2].tool_calls[0].function.arguments, "{}");
  assert.match(msgs[3].content, /screenshot omitted/);
});
