// Claude provider (Anthropic TypeScript SDK). Works with any Claude model: the request is
// shaped from each model's live capabilities (Models API), so older or newer models don't break.
import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "../config.ts";
import type { ChatRequest, ChatResult, Provider } from "./types.ts";
import { PROFILE } from "../claude-login.ts";
import { isCertError } from "../netcheck.ts";

/** A pasted key wins; otherwise the "Sign in with Claude" profile; otherwise the SDK's own lookup. */
export function makeClient(cfg: Config["llm"], apiKey: string): Anthropic {
  return apiKey ? new Anthropic({ apiKey }) : cfg.claudeAuth === "signin" ? new Anthropic({ profile: PROFILE }) : new Anthropic();
}

export type ModelInfo = {
  id: string;
  name: string;
  adaptive: boolean; // adaptive thinking supported
  efforts: string[]; // supported effort levels (empty = no effort setting)
  maxOutput: number;
  created: string;
};

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export function toModelInfo(m: any): ModelInfo {
  const caps = m.capabilities ?? {};
  const effort = caps.effort ?? {};
  return {
    id: m.id,
    name: m.display_name ?? m.id,
    adaptive: !!caps.thinking?.types?.adaptive?.supported,
    efforts: effort.supported ? EFFORTS.filter((e) => effort[e]?.supported) : [],
    maxOutput: m.max_tokens ?? 16000,
    created: m.created_at ?? "",
  };
}

let cache: { at: number; models: ModelInfo[] } | null = null;

/** Every Claude model this account can use, newest first (cached for 10 minutes). */
export async function listModels(cfg: Config["llm"], apiKey: string, force = false): Promise<ModelInfo[]> {
  if (cache && !force && Date.now() - cache.at < 10 * 60_000) return cache.models;
  const client = makeClient(cfg, apiKey);
  const models: ModelInfo[] = [];
  for await (const m of client.models.list({ limit: 100 })) models.push(toModelInfo(m));
  models.sort((a, b) => b.created.localeCompare(a.created));
  cache = { at: Date.now(), models };
  return models;
}

export const cachedModels = () => cache?.models ?? [];

/** Server-side refusal fallback ("default" routing) exists on these models only. */
const FALLBACK_MODELS = /^claude-(fable-5-[12]|mythos-5-[12]|opus-5(-5)?|sonnet-5-5)$/;

/** Builds the request so it fits the chosen model. */
export function buildParams(model: string, info: ModelInfo | undefined, effort: string, req: ChatRequest, useFallbacks: boolean) {
  const params: any = {
    model,
    max_tokens: Math.min(16000, info?.maxOutput ?? 16000),
    system: req.system,
    tools: req.tools,
    messages: req.messages,
  };
  // Unknown model (not in the list yet): send the plain request, which every model accepts.
  if (info?.adaptive) params.thinking = { type: "adaptive" };
  if (info && info.efforts.length) {
    // Use the chosen effort if the model has it, else the nearest lower level it does have.
    const want = EFFORTS.indexOf(effort);
    const ok = info.efforts.filter((e) => EFFORTS.indexOf(e) <= want);
    params.output_config = { effort: ok.length ? ok[ok.length - 1] : info.efforts[0] };
  }
  const fallbacks = useFallbacks && FALLBACK_MODELS.test(model);
  return { params, fallbacks };
}

export function claudeProvider(cfg: Config["llm"], apiKey: string): Provider {
  // Created on first use: a missing sign-in profile must not break pages that only show the name.
  let made: Anthropic | null = null;
  const clientFor = () => (made ??= makeClient(cfg, apiKey));

  return {
    name: `Claude (${cachedModels().find((m) => m.id === cfg.claudeModel)?.name ?? cfg.claudeModel})`,
    supportsImages: true,
    async chat(req: ChatRequest): Promise<ChatResult> {
      let info = cachedModels().find((m) => m.id === cfg.claudeModel);
      if (!info) info = (await listModels(cfg, apiKey).catch(() => [] as ModelInfo[])).find((m) => m.id === cfg.claudeModel);
      const { params, fallbacks } = buildParams(cfg.claudeModel, info, cfg.claudeEffort, req, cfg.claudeFallbacks);
      const client = clientFor();
      // Server-side fallback: if the model declines a request, the API retries it on a fallback model.
      const res: any = fallbacks
        ? await client.beta.messages.create({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
        : await client.messages.create(params);
      return { content: res.content, stop_reason: res.stop_reason };
    },
    describeError(err: unknown): string | null {
      if (err instanceof Anthropic.AuthenticationError)
        return "I'm not signed in to Claude any more. On your PC, open Distinct → Settings → Sign in with Claude.";
      if (err instanceof Anthropic.NotFoundError)
        return `The model "${cfg.claudeModel}" isn't available on your account. Pick another one in Distinct → Settings.`;
      if (err instanceof Anthropic.APIError && /credit balance|billing|purchase credits/i.test(err.message))
        return "Your Claude account is out of credit. Add some at console.anthropic.com/settings/billing, then ask me again.";
      if (err instanceof Anthropic.RateLimitError) return "Claude is rate-limited right now. Try again in a minute.";
      if (err instanceof Anthropic.APIConnectionError)
        return isCertError(err)
          ? "Your network's firewall is blocking my secure connection to Claude. Ask IT to allow api.anthropic.com (details on your PC in Distinct → Settings)."
          : "Couldn't reach Claude. Check the internet connection.";
      if (err instanceof Anthropic.APIError) return `Claude API error ${err.status ?? ""}: ${err.message}`;
      if (err instanceof Error && /resolve authentication|profile/i.test(err.message))
        return "Claude isn't connected yet. On your PC, open Distinct and click 'Sign in with Claude'.";
      return null;
    },
  };
}
