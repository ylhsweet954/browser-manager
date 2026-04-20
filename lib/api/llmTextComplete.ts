import { resolveStoredLlmModel } from "@/lib/config/llmDefaults";
import type { LlmApiType } from "./llmEndpoint";
import { resolveLlmRequestUrl } from "./llmEndpoint";

export interface LlmTextConfig {
  apiType: LlmApiType;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface LlmTextMessage {
  role: string;
  content: string;
}

const DEFAULT_ANTHROPIC_CACHE_CONTROL = { type: "ephemeral" as const };

function buildOpenAICacheFields(options: { sessionId?: string } = {}): { prompt_cache_key?: string } {
  const cacheKey = String(options?.sessionId || "").trim();
  return cacheKey ? { prompt_cache_key: cacheKey } : {};
}

export async function textComplete(config: LlmTextConfig, messages: LlmTextMessage[]): Promise<string> {
  if (!config?.apiKey || !config?.baseUrl || !config?.model) {
    throw new Error("LLM config incomplete (apiKey / baseUrl / model required)");
  }

  if (config.apiType === "anthropic") {
    return _anthropicComplete(config, messages);
  }
  return _openaiComplete(config, messages);
}

async function _openaiComplete(
  config: LlmTextConfig,
  messages: LlmTextMessage[],
  options: { sessionId?: string } = {}
): Promise<string> {
  const url = resolveLlmRequestUrl("openai", config.baseUrl);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      stream: false,
      max_tokens: 600,
      ...buildOpenAICacheFields(options),
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => String(res.status));
    throw new Error(`OpenAI API error ${res.status}: ${text}`);
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
  };
  const content = json?.choices?.[0]?.message?.content;
  const text = extractOpenAITextContent(content);
  if (!text) {
    throw new Error("Unexpected OpenAI response shape");
  }
  return text;
}

function extractOpenAITextContent(
  content: string | Array<{ type?: string; text?: string }> | undefined
): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const text = content
      .filter((block) => block?.type === "text" && typeof block?.text === "string")
      .map((block) => block.text as string)
      .join("")
      .trim();
    return text;
  }

  return "";
}

async function _anthropicComplete(config: LlmTextConfig, messages: LlmTextMessage[]): Promise<string> {
  let systemPrompt = "";
  const apiMessages: LlmTextMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      systemPrompt = msg.content;
    } else {
      apiMessages.push(msg);
    }
  }

  const url = resolveLlmRequestUrl("anthropic", config.baseUrl);
  const body: Record<string, unknown> = {
    model: config.model,
    cache_control: DEFAULT_ANTHROPIC_CACHE_CONTROL,
    messages: apiMessages,
    max_tokens: 600,
  };
  if (systemPrompt) body.system = systemPrompt;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => String(res.status));
    throw new Error(`Anthropic API error ${res.status}: ${text}`);
  }

  const json = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
  const block = json?.content?.find((b) => b.type === "text");
  if (!block?.text) {
    throw new Error("Unexpected Anthropic response shape");
  }
  return block.text.trim();
}

const DEFAULT_LLM_STORAGE: LlmTextConfig = {
  apiType: "openai",
  baseUrl: "",
  apiKey: "",
  model: "",
};

/**
 * Read LLM config from chrome.storage.local.
 * Returns null if not configured.
 */
export async function getLLMConfigForMemory(): Promise<LlmTextConfig | null> {
  const { llmConfig } = await chrome.storage.local.get({
    llmConfig: DEFAULT_LLM_STORAGE,
  });
  const c = llmConfig as LlmTextConfig;
  const model = resolveStoredLlmModel(c?.apiType, c?.model);
  if (!c?.apiKey || !c?.baseUrl) {
    return null;
  }
  return { ...c, model };
}
