/* global chrome */
import { resolveLlmRequestUrl } from "./llmEndpoint";

/**
 * Lightweight non-streaming, no-tools LLM text completion.
 * Shared between the side panel and the service worker.
 *
 * @param {Object} config - { apiType, baseUrl, apiKey, model }
 * @param {Array}  messages - [{ role, content }] — plain text only, no tool messages
 * @returns {Promise<string>} the assistant text response
 */
export async function textComplete(config, messages) {
  if (!config?.apiKey || !config?.baseUrl || !config?.model) {
    throw new Error("LLM config incomplete (apiKey / baseUrl / model required)");
  }

  if (config.apiType === "anthropic") {
    return _anthropicComplete(config, messages);
  }
  return _openaiComplete(config, messages);
}

const DEFAULT_ANTHROPIC_CACHE_CONTROL = { type: "ephemeral" };

function buildOpenAICacheFields(options = {}) {
  const cacheKey = String(options?.sessionId || "").trim();
  return cacheKey ? { prompt_cache_key: cacheKey } : {};
}

async function _openaiComplete(config, messages, options = {}) {
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
      ...buildOpenAICacheFields(options)
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.status);
    throw new Error(`OpenAI API error ${res.status}: ${text}`);
  }

  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  const text = extractOpenAITextContent(content);
  if (!text) {
    throw new Error("Unexpected OpenAI response shape");
  }
  return text;
}

function extractOpenAITextContent(content) {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const text = content
      .filter((block) => block?.type === "text" && typeof block?.text === "string")
      .map((block) => block.text)
      .join("")
      .trim();
    return text;
  }

  return "";
}

async function _anthropicComplete(config, messages) {
  let systemPrompt = "";
  const apiMessages = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      systemPrompt = msg.content;
    } else {
      apiMessages.push(msg);
    }
  }

  const url = resolveLlmRequestUrl("anthropic", config.baseUrl);
  const body = {
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
    const text = await res.text().catch(() => res.status);
    throw new Error(`Anthropic API error ${res.status}: ${text}`);
  }

  const json = await res.json();
  const block = json?.content?.find((b) => b.type === "text");
  if (!block?.text) {
    throw new Error("Unexpected Anthropic response shape");
  }
  return block.text.trim();
}

/**
 * Read LLM config from chrome.storage.local.
 * Returns null if not configured.
 */
export async function getLLMConfigForMemory() {
  const { llmConfig } = await chrome.storage.local.get({
    llmConfig: { apiType: "openai", baseUrl: "", apiKey: "", model: "" },
  });
  if (!llmConfig?.apiKey || !llmConfig?.baseUrl || !llmConfig?.model) {
    return null;
  }
  return llmConfig;
}
