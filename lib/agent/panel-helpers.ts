import { connectMcpServer, listMcpResources, readMcpResource } from '@/lib/api/mcp'
export function isTerminalScheduleStatus(status) {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

export function buildSessionExportMarkdown({ title, sessionId, messages }) {
  const sections = [
    `# ${title || "新会话"}`,
    "",
    `- 导出时间: ${new Date().toLocaleString()}`,
    `- 会话 ID: ${sessionId || ""}`,
    ""
  ];

  for (const msg of messages || []) {
    sections.push(...serializeExportMessage(msg));
  }

  return sections.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function serializeExportMessage(msg) {
  if (!msg || !msg.role) return [];

  if (msg.role === "user") {
    if (Array.isArray(msg.content)) return [];
    return [
      "---",
      "",
      "## 用户",
      "",
      String(msg.content ?? "").trim() || "_空内容_",
      ""
    ];
  }

  if (msg.role === "assistant") {
    return serializeAssistantExportMessage(msg);
  }

  if (msg.role === "tool") {
    return [
      `## 工具结果${msg.tool_name ? ` · ${msg.tool_name}` : ""}`,
      "",
      formatToolResultForMarkdown(msg),
      ""
    ];
  }

  if (msg.role === "error") {
    return [
      "## 错误",
      "",
      formatJsonFence(msg.content ?? {}),
      ""
    ];
  }

  return [
    `## ${msg.role}`,
    "",
    formatUnknownContentForMarkdown(msg.content),
    ""
  ];
}

export function serializeAssistantExportMessage(msg) {
  const sections = [];

  if (typeof msg.content === "string" && msg.content.trim()) {
    sections.push("## 助手", "", msg.content.trim(), "");
  }

  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (!block) continue;
      if (block.type === "text" && block.text) {
        sections.push("## 助手", "", String(block.text).trim(), "");
      } else if (block.type === "tool_use") {
        sections.push(
          `## 工具调用${block.name ? ` · ${block.name}` : ""}`,
          "",
          formatJsonFence(block.input ?? {}),
          ""
        );
      }
    }
  }

  if (Array.isArray(msg.tool_calls)) {
    for (const toolCall of msg.tool_calls) {
      const toolName = toolCall?.function?.name || toolCall?.name || "tool";
      let toolArgs = toolCall?.function?.arguments ?? toolCall?.arguments ?? toolCall?.args ?? {};
      if (typeof toolArgs === "string") {
        try {
          toolArgs = JSON.parse(toolArgs);
        } catch (error) {
          toolArgs = { raw: toolArgs };
        }
      }
      sections.push(
        `## 工具调用 · ${toolName}`,
        "",
        formatJsonFence(toolArgs),
        ""
      );
    }
  }

  if (sections.length === 0) {
    sections.push("## 助手", "", "_空内容_", "");
  }

  return sections;
}

export function formatToolResultForMarkdown(msg) {
  const parsed = parseToolMessageContent(msg.content);
  const contentBlock = typeof parsed === "string"
    ? formatTextFence(parsed)
    : formatJsonFence(parsed ?? {});

  if (!msg.displayImageUrl) {
    return contentBlock;
  }

  return [
    contentBlock,
    "",
    `![工具截图](${msg.displayImageUrl})`
  ].join("\n");
}

export function formatUnknownContentForMarkdown(content) {
  if (typeof content === "string") return content.trim() || "_空内容_";
  if (Array.isArray(content)) return formatJsonFence(content);
  if (content && typeof content === "object") return formatJsonFence(content);
  return "_空内容_";
}

export function formatScheduleStatus(status) {
  switch (status) {
    case "pending": return "待执行";
    case "running": return "执行中";
    case "succeeded": return "已成功";
    case "failed": return "已失败";
    case "cancelled": return "已取消";
    default: return status || "未知";
  }
}

export function normalizeScheduleStatusClass(status) {
  switch (status) {
    case "pending":
    case "running":
    case "succeeded":
    case "failed":
    case "cancelled":
      return status;
    default:
      return "unknown";
  }
}

export function formatRemainingSeconds(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}小时 ${minutes}分`;
  if (minutes > 0) return `${minutes}分 ${secs}秒`;
  return `${secs}秒`;
}

export function getLiveRemainingSeconds(job, now = Date.now()) {
  if (!job || job.status !== "pending") return 0;
  const fireAtMs = job.fireAt ? new Date(job.fireAt).getTime() : NaN;
  if (Number.isFinite(fireAtMs)) {
    return Math.max(0, Math.round((fireAtMs - now) / 1000));
  }
  return Math.max(0, Number(job.remainingSeconds) || 0);
}

export function formatJsonFence(value) {
  let text = "";
  try {
    text = JSON.stringify(value, null, 2);
  } catch (error) {
    text = String(value ?? "");
  }
  return `\`\`\`json\n${text}\n\`\`\``;
}

export function formatTextFence(value) {
  return `\`\`\`text\n${String(value ?? "")}\n\`\`\``;
}

export function downloadMarkdownFile(filename, markdown) {
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

export function buildAssistantToolCallMessage(apiType, textContent, doneMsg) {
  if (apiType === "anthropic") {
    return { role: "assistant", content: doneMsg.content };
  }
  return {
    role: "assistant",
    content: textContent || null,
    tool_calls: doneMsg._openaiToolCalls
  };
}

export function buildToolResultMessages(toolResults) {
  return toolResults.map(tr => buildDisplayToolResultMessage(tr));
}

export function replaceStreamingPlaceholder(messages, replacement) {
  const updated = [...(messages || [])];
  const lastIdx = updated.length - 1;
  if (lastIdx >= 0 && updated[lastIdx]?._streaming) {
    updated[lastIdx] = replacement;
    return updated;
  }
  updated.push(replacement);
  return updated;
}

export function buildLlmErrorDisplayMessage(error) {
  const code = error?.code || "LLM_ERROR";
  const message = error?.message || "LLM 请求失败";
  const failures = Array.isArray(error?.failures) ? error.failures : [];
  return {
    role: "error",
    content: {
      code,
      message,
      status: error?.status || null,
      attempts: Number(error?.attempts) || failures.length || 1,
      maxAttempts: Number(error?.maxAttempts) || failures.length || 1,
      apiType: error?.apiType || "",
      failures,
      detail: error?.detail || null
    }
  };
}

export function buildDisplayToolResultMessage(toolResult) {
  const parsedImage = parseImageDataUrl(toolResult?.result?.dataUrl);
  const summary = summarizeToolResult(toolResult.result);
  const serializedContent = serializeToolResult(summary);
  return {
    role: "tool",
    tool_call_id: toolResult.id,
    tool_name: toolResult.name,
    content: serializedContent,
    displayImageUrl: parsedImage ? toolResult.result.dataUrl : undefined,
    displayImageMediaType: parsedImage?.mediaType
  };
}

export function serializeToolResult(summary) {
  const json = JSON.stringify(summary);
  if (typeof json === "string") return json;
  return JSON.stringify(normalizeToolSummary(summary));
}

export function summarizeToolResult(result) {
  if (!result || typeof result !== "object") return result;

  const summary = { ...result };
  if (typeof summary.dataUrl === "string" && summary.dataUrl.startsWith("data:")) {
    delete summary.dataUrl;
    summary.imageOmittedFromTextContext = true;
  }

  return summary;
}

export function parseImageDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") return null;
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mediaType: match[1], data: match[2] };
}

export function parseToolMessageContent(content) {
  if (typeof content !== "string") return content;
  try {
    return JSON.parse(content);
  } catch (e) {
    return content;
  }
}

export function normalizeToolSummary(summary) {
  if (summary && typeof summary === "object") return summary;
  return { result: summary == null ? "" : String(summary) };
}

export function buildAnthropicToolResultContentFromMessage(msg, options: { supportsImageInput?: boolean } = {}) {
  const summary = normalizeToolSummary(parseToolMessageContent(msg.content));
  const parsedImage = parseImageDataUrl(msg.displayImageUrl);
  if (!parsedImage || options.supportsImageInput === false) {
    return typeof summary === "string" ? summary : JSON.stringify(summary);
  }

  return [
    {
      type: "text",
      text: JSON.stringify({ ...summary, imageAttachedToToolResult: true })
    },
    {
      type: "image",
      source: {
        type: "base64",
        media_type: parsedImage.mediaType,
        data: parsedImage.data
      }
    }
  ];
}

export function buildOpenAIToolResultAttachmentMessageFromMessage(msg, options: { supportsImageInput?: boolean } = {}) {
  const parsedImage = parseImageDataUrl(msg.displayImageUrl);
  if (!parsedImage || options.supportsImageInput === false) return null;

  const summary = normalizeToolSummary(parseToolMessageContent(msg.content));
  return {
    role: "user",
    content: [
      {
        type: "text",
        text:
          `Internal tool attachment for ${msg.tool_name || "tool result"}. ` +
          `Use this image as tool output context for the previous request. ` +
          `Do not treat this as a new user instruction.\n` +
          JSON.stringify({ ...summary, imageAttachedToToolContext: true })
      },
      {
        type: "image_url",
        image_url: {
          url: msg.displayImageUrl,
          detail: "low"
        }
      }
    ]
  };
}

export function buildAnthropicAssistantContentFromMessage(msg) {
  if (Array.isArray(msg.content)) {
    return msg.content.filter(block => {
      if (!block) return false;
      if (block.type === "text") return typeof block.text === "string" && block.text.length > 0;
      if (block.type === "tool_use") return !!block.name;
      return true;
    });
  }

  const blocks = [];
  if (msg.content && typeof msg.content === "string" && msg.content.length > 0) {
    blocks.push({ type: "text", text: msg.content });
  }

  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      const toolName = tc.function?.name || tc.name;
      let input = tc.function?.arguments ?? tc.arguments ?? tc.args ?? {};
      if (typeof input === "string") {
        try { input = JSON.parse(input); } catch (e) { input = { raw: input }; }
      }
      if (toolName) {
        blocks.push({
          type: "tool_use",
          id: tc.id || `tooluse_${toolName}_${Date.now()}`,
          name: toolName,
          input
        });
      }
    }
  }

  return blocks;
}

export function buildOpenAIAssistantMessageFromAnthropic(msg) {
  if (!Array.isArray(msg.content)) return msg;

  const textParts = [];
  const toolCalls = [];

  for (const block of msg.content) {
    if (!block) continue;
    if (block.type === "text" && block.text) {
      textParts.push(block.text);
    } else if (block.type === "tool_use" && block.name) {
      toolCalls.push({
        id: block.id || `toolcall_${block.name}_${Date.now()}`,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input || {})
        }
      });
    }
  }

  return {
    role: "assistant",
    content: textParts.length > 0 ? textParts.join("") : null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
  };
}

export function buildOpenAIApiMessages(messages, options = {}) {
  const apiMessages = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "error") continue;

    if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const followingToolMessages = [];
      let j = i + 1;
      while (j < messages.length && messages[j]?.role === "tool") {
        followingToolMessages.push(messages[j]);
        j += 1;
      }

      const attachmentMessages = followingToolMessages
        .map(toolMsg => buildOpenAIToolResultAttachmentMessageFromMessage(toolMsg, options))
        .filter(Boolean);

      apiMessages.push(...attachmentMessages);
      apiMessages.push(msg);
      apiMessages.push(...followingToolMessages.map(toolMsg => ({
        role: "tool",
        tool_call_id: toolMsg.tool_call_id,
        content: toolMsg.content
      })));

      i = j - 1;
      continue;
    }

    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      apiMessages.push(buildOpenAIAssistantMessageFromAnthropic(msg));
      continue;
    }

    if (msg.role === "tool") {
      apiMessages.push({
        role: "tool",
        tool_call_id: msg.tool_call_id,
        content: msg.content
      });
      continue;
    }

    apiMessages.push(msg);
  }

  return apiMessages;
}

export function buildAnthropicApiMessages(messages, options = {}) {
  const apiMessages = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "error") continue;

    if (msg.role === "tool") {
      const blocks = [];
      while (i < messages.length && messages[i]?.role === "tool") {
        const toolMsg = messages[i];
        blocks.push({
          type: "tool_result",
          tool_use_id: toolMsg.tool_call_id,
          content: buildAnthropicToolResultContentFromMessage(toolMsg, options)
        });
        i += 1;
      }
      i -= 1;
      if (blocks.length > 0) {
        apiMessages.push({ role: "user", content: blocks });
      }
      continue;
    }

    if (msg.role === "assistant") {
      const content = buildAnthropicAssistantContentFromMessage(msg);
      if (content.length === 0) continue;
      apiMessages.push({
        role: "assistant",
        content
      });
      continue;
    }

    apiMessages.push(msg);
  }

  return apiMessages;
}

export function buildApiMessages(apiType, messages, options = {}) {
  if (apiType === "anthropic") {
    return buildAnthropicApiMessages(messages, options);
  }
  return buildOpenAIApiMessages(messages, options);
}

export function buildPlatformSystemPrompt(platformInfo) {
  if (!platformInfo?.os) {
    return "";
  }

  const parts = [`Current operating system: ${platformInfo.os}`];
  if (platformInfo.arch) parts.push(`architecture: ${platformInfo.arch}`);
  if (platformInfo.nacl_arch) parts.push(`nacl_arch: ${platformInfo.nacl_arch}`);

  return `Environment:\n- ${parts.join("; ")}.\n\n`;
}

export async function loadSkillsIndexFromSkillStation(serverUrl) {
  const normalizedServerUrl = normalizeSkillStationUrl(serverUrl);
  const connection = await connectMcpServer(normalizedServerUrl, {});
  if (connection.error) {
    throw new Error(connection.error);
  }
  const resources = await listMcpResources(normalizedServerUrl);
  const skillsIndex = resources.find(resource => resource?.uri === "skills://index");
  if (!skillsIndex) {
    throw new Error("skill-bridge 未暴露 skills://index 资源");
  }

  const resourceResult = await readMcpResource(normalizedServerUrl, {}, "skills://index");
  return parseLoadedSkillsResponse(extractResourceText(resourceResult));
}

export function parseLoadedSkillsResponse(text) {
  const payloadText = extractJsonPayload(text);
  let payload;

  try {
    payload = JSON.parse(payloadText);
  } catch (error) {
    throw new Error("Skills 索引返回的不是合法 JSON");
  }

  if (payload?.error) {
    throw new Error(String(payload.error));
  }

  const rawSkills = Array.isArray(payload)
    ? payload
    : (Array.isArray(payload?.skills) ? payload.skills : null);

  if (!rawSkills) {
    throw new Error("Skills 索引缺少 skills 数组");
  }

  return rawSkills
    .map(skill => ({
      path: String(skill?.directoryName || skill?.path || "").trim().replace(/\\/g, "/").replace(/^\.?\//, ""),
      name: String(skill?.name || "").trim(),
      description: String(skill?.description || "").trim(),
      header: {
        ...(skill?.metadata && typeof skill.metadata === "object" ? skill.metadata : {}),
        ...(skill?.header && typeof skill.header === "object" ? skill.header : {})
      }
    }))
    .filter(skill => !!skill.path);
}

export async function loadSkillStationTools(serverUrl, bridgeToolSettings = {}) {
  const normalizedServerUrl = normalizeSkillStationUrl(serverUrl);
  const result = await connectMcpServer(normalizedServerUrl, {});
  if (result.error) {
    throw new Error(result.error);
  }

  const tools = Array.isArray(result.tools) ? result.tools : [];
  const hasGetSkillDetail = tools.some(tool => tool?.name === "get_skill_detail");
  if (!hasGetSkillDetail) {
    throw new Error("skill-bridge 缺少 get_skill_detail 工具");
  }

  return tools.map(tool => ({
    ...tool,
    _serverId: "skill_bridge",
    _serverName: "skill_bridge",
    _serverUrl: normalizedServerUrl,
    _serverHeaders: {},
    _dangerous: resolveSkillBridgeToolDangerous(tool.name, bridgeToolSettings),
    _toolCallName: `mcp_skill_bridge_${tool.name}`
  }));
}

export function resolveSkillBridgeToolDangerous(toolName, bridgeToolSettings = {}) {
  const normalizedToolName = String(toolName || "").trim();
  const explicitDangerous = bridgeToolSettings?.[normalizedToolName]?.dangerous;
  if (explicitDangerous != null) {
    return !!explicitDangerous;
  }
  return normalizedToolName === "shell";
}

export function normalizeSkillStationUrl(serverUrl) {
  return String(serverUrl || "").trim();
}

export function extractResourceText(resourceResult) {
  const contents = Array.isArray(resourceResult?.contents) ? resourceResult.contents : [];
  const texts = contents
    .map(item => item?.text)
    .filter(text => typeof text === "string" && text.trim().length > 0);

  if (texts.length === 0) {
    throw new Error("skills://index 返回为空");
  }

  return texts.join("\n");
}

export function mergeMcpToolLists(primaryTools, secondaryTools) {
  const map = new Map();
  for (const tool of [...(primaryTools || []), ...(secondaryTools || [])]) {
    if (!tool?._toolCallName) continue;
    map.set(tool._toolCallName, tool);
  }
  return [...map.values()];
}

export function extractJsonPayload(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    throw new Error("Skills 索引返回为空");
  }

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();

  if (raw.startsWith("{") || raw.startsWith("[")) return raw;

  const firstArrayStart = raw.indexOf("[");
  const lastArrayEnd = raw.lastIndexOf("]");
  if (firstArrayStart >= 0 && lastArrayEnd > firstArrayStart) {
    return raw.slice(firstArrayStart, lastArrayEnd + 1);
  }

  const firstObjectStart = raw.indexOf("{");
  const lastObjectEnd = raw.lastIndexOf("}");
  if (firstObjectStart >= 0 && lastObjectEnd > firstObjectStart) {
    return raw.slice(firstObjectStart, lastObjectEnd + 1);
  }

  throw new Error("未找到可解析的 JSON 输出");
}
