const OPENAI_COMPLETIONS_PATH = "/v1/chat/completions";
const ANTHROPIC_MESSAGES_PATH = "/v1/messages";

export type LlmApiType = "openai" | "anthropic";

export function getDefaultLlmEndpointPath(apiType: LlmApiType): string {
  return apiType === "anthropic" ? ANTHROPIC_MESSAGES_PATH : OPENAI_COMPLETIONS_PATH;
}

export function resolveLlmRequestUrl(apiType: LlmApiType, baseUrl: string): string {
  const raw = String(baseUrl || "").trim();
  if (!raw) return "";

  const defaultPath = getDefaultLlmEndpointPath(apiType);
  const explicitPath = detectExplicitPath(raw);
  if (explicitPath) {
    return raw;
  }

  return `${raw.replace(/\/+$/, "")}${defaultPath}`;
}

function detectExplicitPath(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return !!(parsed.pathname && parsed.pathname !== "/" && !parsed.pathname.endsWith("/"));
  } catch {
    const withoutQuery = rawUrl.split(/[?#]/, 1)[0];
    const normalized = withoutQuery.replace(/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\/[^/]+/, "");
    if (!normalized) return false;
    return normalized !== "/" && !normalized.endsWith("/");
  }
}
