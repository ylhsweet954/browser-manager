let _rpcId = 0;
const DEFAULT_MCP_TOOL_TIMEOUT_MS = 60000;

type McpHeaders = Record<string, string>;

interface JsonRpcRequestBody {
  jsonrpc: "2.0";
  method: string;
  id: number;
  params?: unknown;
}

async function rpcCall(
  url: string,
  headers: McpHeaders,
  method: string,
  params?: unknown,
  timeoutMs?: number
): Promise<unknown> {
  const id = ++_rpcId;
  const body: JsonRpcRequestBody = {
    jsonrpc: "2.0",
    method,
    id,
    ...(params !== undefined ? { params } : {}),
  };

  const controller = new AbortController();
  const effectiveTimeoutMs = Number.isFinite(timeoutMs) && (timeoutMs as number) > 0 ? (timeoutMs as number) : 0;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  if (effectiveTimeoutMs > 0) {
    timerId = setTimeout(() => controller.abort(), effectiveTimeoutMs);
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    if (timerId) clearTimeout(timerId);
    const err = e as { name?: string };
    if (err.name === "AbortError") {
      throw new Error(`MCP request timed out after ${effectiveTimeoutMs}ms`);
    }
    throw e;
  }

  if (timerId) clearTimeout(timerId);

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`MCP error ${res.status}: ${errText}`);
  }

  const contentType = res.headers.get("content-type") || "";

  if (contentType.includes("text/event-stream")) {
    return _parseSSEResponse(res);
  }

  const json = (await res.json()) as { error?: { message?: string }; result?: unknown };
  if (json.error) {
    throw new Error(`MCP RPC error: ${json.error.message || JSON.stringify(json.error)}`);
  }
  return json.result;
}

async function _parseSSEResponse(res: Response): Promise<unknown> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("MCP SSE: no body");

  const decoder = new TextDecoder();
  let buffer = "";
  let lastResult: unknown = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data: ")) {
        try {
          const json = JSON.parse(trimmed.slice(6)) as { result?: unknown; error?: { message?: string } };
          if (json.result !== undefined) lastResult = json.result;
          if (json.error) throw new Error(`MCP RPC error: ${json.error.message || JSON.stringify(json.error)}`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.startsWith("MCP RPC error")) throw e;
        }
      }
    }
  }

  if (lastResult === null) throw new Error("MCP SSE response contained no result");
  return lastResult;
}

export async function initializeMcp(
  url: string,
  headers: McpHeaders = {}
): Promise<{ serverInfo?: { name?: string }; capabilities?: unknown }> {
  const result = (await rpcCall(url, headers, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: {
      name: "TabManager",
      version: "1.0",
    },
  })) as { serverInfo?: { name?: string }; capabilities?: unknown };
  return result;
}

export async function listMcpTools(
  url: string,
  headers: McpHeaders = {}
): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
  const result = (await rpcCall(url, headers, "tools/list")) as { tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> };
  return result.tools || [];
}

export async function listMcpResources(
  url: string,
  headers: McpHeaders = {}
): Promise<Array<{ name?: string; uri: string; description?: string; mimeType?: string }>> {
  const result = (await rpcCall(url, headers, "resources/list")) as {
    resources?: Array<{ name?: string; uri: string; description?: string; mimeType?: string }>;
  };
  return result.resources || [];
}

export async function readMcpResource(url: string, headers: McpHeaders = {}, uri: string): Promise<unknown> {
  return await rpcCall(url, headers, "resources/read", { uri });
}

export async function callMcpTool(
  url: string,
  headers: McpHeaders,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number = DEFAULT_MCP_TOOL_TIMEOUT_MS
): Promise<unknown> {
  const result = (await rpcCall(
    url,
    headers,
    "tools/call",
    {
      name: toolName,
      arguments: args,
    },
    timeoutMs
  )) as {
    content?: Array<{ type?: string; text?: string }>;
    [key: string]: unknown;
  };

  if (result.content && Array.isArray(result.content)) {
    const texts = result.content.filter((c) => c.type === "text").map((c) => c.text);
    if (texts.length === 1) return { result: texts[0] };
    if (texts.length > 1) return { result: texts.join("\n") };
  }
  return result;
}

export async function connectMcpServer(
  url: string,
  headers: McpHeaders = {}
): Promise<{ name: string; tools: Array<{ name: string; description?: string; inputSchema?: unknown }>; error: string | null }> {
  try {
    const info = await initializeMcp(url, headers);
    const tools = await listMcpTools(url, headers);
    return {
      name: info.serverInfo?.name || "MCP Server",
      tools,
      error: null,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      name: "MCP Server",
      tools: [],
      error: msg,
    };
  }
}
