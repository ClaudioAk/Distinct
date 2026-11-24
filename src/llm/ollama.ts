// Local model provider (Ollama /api/chat with tool calling). Fully private, no cloud.
import { randomUUID } from "node:crypto";
import type { Config } from "../config.ts";
import type { Block, ChatRequest, ChatResult, Message, Provider } from "./types.ts";

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((b: any) => (b.type === "text" ? b.text : b.type === "image" ? "[screenshot omitted: local model]" : "")).join("\n");
  return "";
}

export function toOllama(system: string, messages: Message[]): any[] {
  const out: any[] = [{ role: "system", content: system }];
  const toolNames = new Map<string, string>();
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const calls = m.content.filter((b) => b.type === "tool_use");
      for (const c of calls) toolNames.set(c.id, c.name);
      out.push({ role: "assistant", content: text, ...(calls.length ? { tool_calls: calls.map((c) => ({ function: { name: c.name, arguments: c.input } })) } : {}) });
    } else {
      const texts: string[] = [];
      for (const b of m.content) {
        if (b.type === "tool_result") out.push({ role: "tool", tool_name: toolNames.get(b.tool_use_id) ?? "", content: resultText(b.content) });
        else if (b.type === "text") texts.push(b.text);
      }
      if (texts.length) out.push({ role: "user", content: texts.join("\n") });
    }
  }
  return out;
}

export function ollamaProvider(cfg: Config["llm"]): Provider {
  return {
    name: `Ollama (${cfg.ollamaModel}, local)`,
    supportsImages: false,
    async chat(req: ChatRequest): Promise<ChatResult> {
      const res = await fetch(cfg.ollamaUrl.replace(/\/$/, "") + "/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: cfg.ollamaModel,
          stream: false,
          messages: toOllama(req.system, req.messages),
          tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })),
        }),
      });
      if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const msg = (await res.json()).message ?? {};
      const content: Block[] = [];
      if (msg.content?.trim()) content.push({ type: "text", text: msg.content.trim() });
      for (const tc of msg.tool_calls ?? []) {
        let input = tc.function?.arguments ?? {};
        if (typeof input === "string") {
          try {
            input = JSON.parse(input);
          } catch {
            input = {};
          }
        }
        content.push({ type: "tool_use", id: "ol_" + randomUUID(), name: tc.function?.name ?? "", input });
      }
      return { content, stop_reason: msg.tool_calls?.length ? "tool_use" : "end_turn" };
    },
    describeError(err: unknown): string | null {
      if (err instanceof TypeError) return `Couldn't reach Ollama at ${cfg.ollamaUrl}. Is it running?`;
      return null;
    },
  };
}
