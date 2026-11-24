// Messages use the Anthropic Messages API shape everywhere; the Ollama adapter converts.

export type Block = { type: string; [k: string]: any };
export type Message = { role: "user" | "assistant"; content: string | Block[] };
export type ToolDef = { name: string; description: string; input_schema: Record<string, any> };

export type ChatRequest = { system: string; messages: Message[]; tools: ToolDef[] };
export type ChatResult = { content: Block[]; stop_reason: string | null };

export type Provider = {
  name: string;
  supportsImages: boolean;
  chat(req: ChatRequest): Promise<ChatResult>;
  describeError(err: unknown): string | null;
};
