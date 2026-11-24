// Free models through FreeLLMAPI (https://freellmapi.co): an open-source router you run on this PC.
// You add free-tier keys (Gemini, Groq, OpenRouter, NVIDIA…) in its dashboard; it exposes one
// OpenAI-compatible address and routes each request to a free model ("auto:smart", "auto:fast"…).
// DInstinct talks to it like any OpenAI-style server, with tool calling.
import { randomUUID } from "node:crypto";
import type { Config } from "../config.ts";
import type { Block, ChatRequest, ChatResult, Message, Provider } from "./types.ts";

/** Where FreeLLMAPI usually listens: desktop app, then the Docker / npm server. */
export const CANDIDATES = ["http://127.0.0.1:31415/v1", "http://127.0.0.1:3001/v1"];

const text = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((b: any) => (b.type === "text" ? b.text : b.type === "image" ? "[screenshot omitted: this model can't see images]" : "")).join("\n")
      : "";

/** Anthropic-shaped history → OpenAI chat messages (tool calls and tool results keep their ids). */
export function toOpenAI(system: string, messages: Message[]): any[] {
  const out: any[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      const calls = m.content.filter((b) => b.type === "tool_use");
      out.push({
        role: "assistant",
        content: m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n") || null,
        ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })) } : {}),
      });
    } else {
      const texts: string[] = [];
      for (const b of m.content) {
        if (b.type === "tool_result") out.push({ role: "tool", tool_call_id: b.tool_use_id, content: text(b.content) || "(empty)" });
        else if (b.type === "text") texts.push(b.text);
      }
      if (texts.length) out.push({ role: "user", content: texts.join("\n") });
    }
  }
  return out;
}

export function fromOpenAI(choice: any): ChatResult {
  const msg = choice?.message ?? {};
  const content: Block[] = [];
  if (typeof msg.content === "string" && msg.content.trim()) content.push({ type: "text", text: msg.content.trim() });
  for (const tc of msg.tool_calls ?? []) {
    let input: any = {};
    try {
      input = typeof tc.function?.arguments === "string" ? JSON.parse(tc.function.arguments || "{}") : (tc.function?.arguments ?? {});
    } catch {
      input = {};
    }
    content.push({ type: "tool_use", id: tc.id || "fl_" + randomUUID(), name: tc.function?.name ?? "", input });
  }
  const calls = content.some((b) => b.type === "tool_use");
  const stop = choice?.finish_reason === "length" ? "max_tokens" : calls ? "tool_use" : "end_turn";
  return { content, stop_reason: stop };
}

async function call(base: string, key: string, path: string, init: RequestInit = {}, timeoutMs = 120_000): Promise<Response> {
  return fetch(base.replace(/\/$/, "") + path, {
    ...init,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** Finds a running FreeLLMAPI on this PC and checks the key. */
export async function detect(key: string, preferred = ""): Promise<{ base: string; ok: boolean; message: string }> {
  for (const base of [preferred, ...CANDIDATES].filter(Boolean)) {
    try {
      const r = await call(base, key, "/models?available=true", {}, 4000);
      if (r.status === 401 || r.status === 403) return { base, ok: false, message: "FreeLLMAPI is running, but it didn't accept that key. Copy it again (tray icon → Copy Key)." };
      if (r.ok) return { base, ok: true, message: "" };
    } catch {}
  }
  return { base: preferred || CANDIDATES[0], ok: false, message: "FreeLLMAPI isn't running on this PC. Start the FreeLLMAPI app (check the tray icon) and try again." };
}

export type FreeModel = { id: string; label: string };

/** "auto" choices first, then every model that is ready to use with your provider keys. */
export async function listFreeModels(base: string, key: string): Promise<FreeModel[]> {
  const autos: FreeModel[] = [
    { id: "auto:smart", label: "Automatic, smartest free model (recommended)" },
    { id: "auto:fast", label: "Automatic, fastest free model" },
    { id: "auto:reliable", label: "Automatic, most reliable" },
    { id: "auto", label: "Automatic, your fallback chain" },
  ];
  try {
    const r = await call(base, key, "/models?available=true", {}, 6000);
    if (!r.ok) return autos;
    const j = await r.json();
    const ids: FreeModel[] = (j.data ?? [])
      .filter((m: any) => !m.execution_status || m.execution_status === "ready")
      .map((m: any) => ({ id: String(m.id), label: String(m.name ?? m.id) }));
    return [...autos, ...ids.sort((a, b) => a.id.localeCompare(b.id))];
  } catch {
    return autos;
  }
}

export function freeProvider(cfg: Config["llm"], key: string): Provider {
  return {
    name: `Free models via FreeLLMAPI (${cfg.freeModel})`,
    supportsImages: false,
    async chat(req: ChatRequest): Promise<ChatResult> {
      if (!key) throw new Error("FREELLM_NO_KEY");
      const r = await call(cfg.freeUrl || CANDIDATES[0], key, "/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: cfg.freeModel || "auto:smart",
          messages: toOpenAI(req.system, req.messages),
          tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })),
          tool_choice: "auto",
          max_tokens: 8000,
        }),
      });
      const body = await r.text();
      if (!r.ok) throw new Error(`FREELLM_${r.status}: ${body.slice(0, 300)}`);
      const j = JSON.parse(body);
      return fromOpenAI(j.choices?.[0]);
    },
    describeError(err: unknown): string | null {
      const m = String((err as any)?.message ?? err);
      if (m === "FREELLM_NO_KEY") return "The free models aren't set up yet. On your PC open DInstinct → Settings → Free models and paste your FreeLLMAPI key.";
      if (/FREELLM_40[13]/.test(m)) return "FreeLLMAPI didn't accept the key. On your PC, copy it again from the FreeLLMAPI tray icon (Copy Key) into DInstinct → Settings.";
      if (/FREELLM_429/.test(m)) return "The free models are out of quota for now. Add more free provider keys in FreeLLMAPI, wait a bit, or switch to Claude.";
      if (/FREELLM_\d+/.test(m)) return `The free model router had a problem: ${m.replace(/^FREELLM_/, "").slice(0, 200)}`;
      if (err instanceof TypeError || /fetch failed|ECONNREFUSED|timeout/i.test(m)) return "FreeLLMAPI isn't running on your PC. Start the FreeLLMAPI app (tray icon) and ask me again.";
      return null;
    },
  };
}
