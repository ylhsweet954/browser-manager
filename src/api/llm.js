/* global chrome */
import { callMcpTool } from "./mcp";

const DOM_LOCATOR_PROPERTIES = {
  tabId: { type: "number", description: "Optional browser tab ID. Defaults to the current active tab." },
  selector: { type: "string", description: "Optional CSS selector used to find elements." },
  text: { type: "string", description: "Optional text to match against element text or labels." },
  matchExact: { type: "boolean", description: "Whether text matching should be exact. Defaults to false." },
  index: { type: "number", description: "Zero-based index within the matched elements. Defaults to 0." }
};
const DEFAULT_SCHEDULE_TOOL_TIMEOUT_SECONDS = 30;
const DEFAULT_MCP_TOOL_TIMEOUT_SECONDS = 60;

// ==================== Tool Definitions ====================

const TOOLS = [
  {
    name: "tab_list",
    description: "Get a snapshot of all currently open browser tabs. Returns each tab's id, url, title, and lastAccessed, plus capturedAt timing fields so you can judge whether the tab state may be stale and refresh it again if needed. Use when the user asks about open tabs, browser context, or page-related questions and you need to identify the right tab first.",
    schema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "tab_extract",
    description: "Extract the text content of a browser tab. Also returns tab metadata including title, url, and lastAccessed when available. Use when you need to read page content to answer the user's question.",
    schema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "The browser tab ID to extract content from" }
      },
      required: ["tabId"]
    }
  },
  {
    name: "tab_scroll",
    description: "Scroll a browser tab and return the updated scroll position. Use when you need to inspect another part of the currently visible page before taking another screenshot or reading the layout. If tabId is omitted, scrolls the current active tab.",
    schema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Optional browser tab ID. Defaults to the current active tab." },
        deltaY: { type: "number", description: "Optional vertical scroll delta in pixels. Positive scrolls down, negative scrolls up." },
        pageFraction: { type: "number", description: "Optional fraction of one viewport height to scroll, such as 0.8 or -1." },
        position: {
          type: "string",
          enum: ["top", "bottom"],
          description: "Optional absolute scroll target. Use 'top' or 'bottom'."
        },
        behavior: {
          type: "string",
          enum: ["auto", "smooth"],
          description: "Scroll behavior. Defaults to 'auto'."
        }
      },
      required: []
    }
  },
  {
    name: "dom_query",
    description: "Query the current page DOM and return matching elements with text, attributes, positions, and match count. Use this to inspect the page structure before interacting with it.",
    schema: {
      type: "object",
      properties: {
        ...DOM_LOCATOR_PROPERTIES,
        maxResults: { type: "number", description: "Maximum number of matching elements to return (default 5, max 20)." }
      },
      required: []
    }
  },
  {
    name: "dom_click",
    description: "Click a DOM element on the page by selector or text match. Use this for buttons, links, tabs, menus, and other clickable elements.",
    schema: {
      type: "object",
      properties: DOM_LOCATOR_PROPERTIES,
      required: []
    }
  },
  {
    name: "dom_set_value",
    description: "Set the value of an input, textarea, or select element and dispatch input/change events. Use this to fill forms or update controls.",
    schema: {
      type: "object",
      properties: {
        ...DOM_LOCATOR_PROPERTIES,
        value: { type: "string", description: "The value to set on the target form element." }
      },
      required: ["value"]
    }
  },
  {
    name: "dom_style",
    description: "Temporarily apply inline CSS styles to a matched DOM element. Useful for visual debugging or emphasizing an element for the user.",
    schema: {
      type: "object",
      properties: {
        ...DOM_LOCATOR_PROPERTIES,
        styles: {
          type: "object",
          description: "Object mapping CSS property names to values, e.g. {\"outline\":\"3px solid red\"}"
        },
        durationMs: { type: "number", description: "How long to keep the styles before restoring them (default 2000ms)." }
      },
      required: ["styles"]
    }
  },
  {
    name: "dom_get_html",
    description: "Get the inner or outer HTML of a matched DOM element. Use this when you need markup context for a specific part of the page.",
    schema: {
      type: "object",
      properties: {
        ...DOM_LOCATOR_PROPERTIES,
        mode: {
          type: "string",
          enum: ["outer", "inner"],
          description: "Whether to return the element's outerHTML or innerHTML. Defaults to outer."
        },
        maxLength: { type: "number", description: "Maximum HTML length to return (default 4000, max 20000)." }
      },
      required: []
    }
  },
  {
    name: "dom_highlight",
    description: "Scroll the page to a matched DOM element and flash a visible highlight around it for about one second so the user can spot it on the page.",
    schema: {
      type: "object",
      properties: {
        ...DOM_LOCATOR_PROPERTIES,
        durationMs: { type: "number", description: "How long the highlight should remain visible (default 1000ms)." }
      },
      required: []
    }
  },
  {
    name: "eval_js",
    description: "Dangerous tool. Execute arbitrary JavaScript on the current active page in the page's main JavaScript context. Use only when structured DOM tools are insufficient. The application will handle explicit user confirmation before execution, so do not ask the user for confirmation in natural language; call the tool directly when needed.",
    schema: {
      type: "object",
      properties: {
        jsScript: { type: "string", description: "JavaScript source code to execute in the page's main world. Use `return ...` if you want a result value back." }
      },
      required: ["jsScript"]
    }
  },
  {
    name: "tab_open",
    description: "Open a new browser tab with the given URL. By default focuses on the new tab. Returns tab metadata including lastAccessed when available.",
    schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to open" },
        active: { type: "boolean", description: "Whether to focus on the new tab (default true). Set false to open in background." }
      },
      required: ["url"]
    }
  },
  {
    name: "tab_focus",
    description: "Switch focus to an existing browser tab by its ID. If the tab is in a different browser window, move it into the current window first, then focus it. Returns tab metadata including windowId and lastAccessed when available.",
    schema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "The tab ID to focus on" }
      },
      required: ["tabId"]
    }
  },
  {
    name: "tab_close",
    description: "Close one or more browser tabs by their IDs. Returns metadata for each tab before it was closed, including lastAccessed when available.",
    schema: {
      type: "object",
      properties: {
        tabIds: {
          type: "array",
          items: { type: "number" },
          description: "Array of tab IDs to close"
        }
      },
      required: ["tabIds"]
    }
  },
  {
    name: "tab_group",
    description: "Group multiple browser tabs together with a label and color. Use when the user asks to organize tabs.",
    schema: {
      type: "object",
      properties: {
        tabIds: {
          type: "array",
          items: { type: "number" },
          description: "Array of tab IDs to group together"
        },
        name: { type: "string", description: "Display name for the tab group" },
        color: {
          type: "string",
          enum: ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"],
          description: "Color for the tab group"
        }
      },
      required: ["tabIds", "name"]
    }
  },
  {
    name: "group_list",
    description: "Get a snapshot of all tab groups across browser windows. Returns each group's metadata and current tabs, plus capturedAt timing fields. Use when the user asks about groups or tab organization.",
    schema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "group_get",
    description: "Get a snapshot of a specific tab group by its groupId, including current tabs and capturedAt timing fields.",
    schema: {
      type: "object",
      properties: {
        groupId: { type: "number", description: "The browser tab group ID" }
      },
      required: ["groupId"]
    }
  },
  {
    name: "group_update",
    description: "Update a tab group's title, color, and/or collapsed state. Returns the updated group snapshot.",
    schema: {
      type: "object",
      properties: {
        groupId: { type: "number", description: "The browser tab group ID" },
        name: { type: "string", description: "New display title for the group" },
        color: {
          type: "string",
          enum: ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"],
          description: "New color for the tab group"
        },
        collapsed: { type: "boolean", description: "Whether the group should be collapsed" }
      },
      required: ["groupId"]
    }
  },
  {
    name: "group_add_tabs",
    description: "Add one or more tabs to an existing tab group. Returns the updated group snapshot.",
    schema: {
      type: "object",
      properties: {
        groupId: { type: "number", description: "The browser tab group ID" },
        tabIds: {
          type: "array",
          items: { type: "number" },
          description: "Array of tab IDs to add to the group"
        }
      },
      required: ["groupId", "tabIds"]
    }
  },
  {
    name: "group_remove_tabs",
    description: "Remove one or more tabs from their current tab groups. Returns the updated tab metadata after ungrouping.",
    schema: {
      type: "object",
      properties: {
        tabIds: {
          type: "array",
          items: { type: "number" },
          description: "Array of tab IDs to remove from their current groups"
        }
      },
      required: ["tabIds"]
    }
  },
  {
    name: "group_ungroup",
    description: "Dissolve an entire tab group by its groupId. Returns the group snapshot captured before ungrouping and the resulting tabs.",
    schema: {
      type: "object",
      properties: {
        groupId: { type: "number", description: "The browser tab group ID" }
      },
      required: ["groupId"]
    }
  },
  {
    name: "history_search",
    description: "Search browser history by keyword. Returns recent matching URLs with titles and visit times. Use when the user asks about previously visited pages.",
    schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search keyword" },
        maxResults: { type: "number", description: "Maximum number of results to return (default 10)" }
      },
      required: ["query"]
    }
  },
  {
    name: "tab_get_active",
    description: "Get a snapshot of the currently focused/active tab. Use when the user says 'this page', 'current page', 'the page I'm looking at', etc. Returns the tab's ID, URL, title, lastAccessed, and capturedAt timing fields so you can then use tab_extract to read its content and judge whether the snapshot may need refreshing.",
    schema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "tab_screenshot",
    description: "Capture a screenshot of the currently visible tab. Returns a base64-encoded PNG image data URL. Note: can only capture the active tab of a window.",
    schema: {
      type: "object",
      properties: {
        windowId: { type: "number", description: "Window ID to capture (default: current window)" }
      },
      required: []
    }
  },
  {
    name: "window_list",
    description: "Get a snapshot of all browser windows. Returns each window's metadata and its current tabs, plus capturedAt timing fields. Use when the user asks about windows, cross-window tab organization, or which window contains a tab.",
    schema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "window_get_current",
    description: "Get a snapshot of the current browser window, including its tabs and capturedAt timing fields.",
    schema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "window_focus",
    description: "Focus a browser window by its ID. Returns the focused window snapshot.",
    schema: {
      type: "object",
      properties: {
        windowId: { type: "number", description: "The browser window ID to focus" }
      },
      required: ["windowId"]
    }
  },
  {
    name: "window_move_tab",
    description: "Move one or more tabs into a target browser window. Returns metadata for the moved tabs and the target window snapshot.",
    schema: {
      type: "object",
      properties: {
        tabIds: {
          type: "array",
          items: { type: "number" },
          description: "Array of tab IDs to move"
        },
        windowId: { type: "number", description: "The target browser window ID" }
      },
      required: ["tabIds", "windowId"]
    }
  },
  {
    name: "window_create",
    description: "Create a new browser window. You may optionally provide a URL to open and whether the new window should be focused.",
    schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Optional URL to open in the new window" },
        focused: { type: "boolean", description: "Whether the new window should be focused (default true)" }
      },
      required: []
    }
  },
  {
    name: "window_close",
    description: "Close a browser window by its ID. Returns the window snapshot captured before closing.",
    schema: {
      type: "object",
      properties: {
        windowId: { type: "number", description: "The browser window ID to close" }
      },
      required: ["windowId"]
    }
  },
  {
    name: "get_current_time",
    description: "Get the current date, time and timezone. Use when you need to know the current time, or when the user asks about time, or before setting a reminder with an absolute timestamp.",
    schema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "schedule_tool",
    description: "Schedule a tool call to execute at a future time. The toolName must be one of the available built-in tools or connected MCP tools. Provide EITHER delaySeconds (relative, preferred) OR timestamp (absolute). Example: schedule tab_open to open a URL in 5 minutes.",
    schema: {
      type: "object",
      properties: {
        delaySeconds: { type: "number", description: "Seconds from now (e.g. 300 for 5 minutes). Preferred." },
        timestamp: { type: "number", description: "Absolute Unix timestamp in ms. Only if user gives exact datetime." },
        toolName: { type: "string", description: "Name of the tool to call (e.g. tab_open, tab_close, mcp__xxx)" },
        toolArgs: { type: "object", description: "Arguments to pass to the tool" },
        label: { type: "string", description: "Short human-readable description of this scheduled task" },
        timeoutSeconds: { type: "number", description: `Maximum execution time after the schedule fires. Defaults to ${DEFAULT_SCHEDULE_TOOL_TIMEOUT_SECONDS} seconds.` }
      },
      required: ["toolName", "toolArgs"]
    }
  },
  {
    name: "list_scheduled",
    description: "List all pending scheduled tool calls with their IDs, tool names, and fire times.",
    schema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "cancel_scheduled",
    description: "Cancel a pending scheduled tool call by its ID.",
    schema: {
      type: "object",
      properties: {
        scheduleId: { type: "string", description: "The schedule ID to cancel" }
      },
      required: ["scheduleId"]
    }
  }
];

export const BUILTIN_TOOL_COUNT = TOOLS.length;

export function buildMcpToolCallName(serverName, toolName) {
  return `mcp_${serverName}_${toolName}`;
}

/**
 * Get tool definitions formatted for the specified API type.
 * Merges built-in tools with MCP tools.
 * @param {string} apiType - "openai" or "anthropic"
 * @param {Array} [mcpTools] - MCP tools from connected servers [{name, description, inputSchema, _serverUrl, _serverHeaders, _toolCallName}]
 * @param {Object} [options]
 * @param {boolean} [options.includeBuiltins=true] - Whether to include built-in browser tools
 * @returns {Array} formatted tool definitions
 */
export function getTools(apiType, mcpTools = [], { includeBuiltins = true } = {}) {
  // Convert MCP tools to our internal format
  const externalTools = mcpTools.map(t => ({
    name: t._toolCallName || buildMcpToolCallName(t._serverName || "server", t.name),
    description: `[MCP] ${t.description || t.name}`,
    schema: t.inputSchema || { type: "object", properties: {} }
  }));

  const allTools = includeBuiltins ? [...TOOLS, ...externalTools] : externalTools;

  if (apiType === "anthropic") {
    return allTools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.schema
    }));
  }
  return allTools.map(t => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.schema
    }
  }));
}

// ==================== Tool Executors ====================

/**
 * Execute a tool call by name. Routes to the appropriate handler.
 * MCP tool names use the configured server name namespace and are routed
 * to the corresponding MCP server.
 * All executors return a result object (never throw).
 * @param {string} name - tool name
 * @param {Object} args - tool arguments
 * @param {Array} [mcpRegistry] - MCP tool registry [{name, _serverUrl, _serverHeaders, _toolCallName}]
 * @returns {Promise<Object>} result to send back to LLM
 */
export async function executeTool(name, args, mcpRegistry = []) {
  try {
    // Route MCP tools to external server
    if (name.startsWith("mcp_")) {
      const mcpTool = mcpRegistry.find(t =>
        (t._toolCallName || buildMcpToolCallName(t._serverName || "server", t.name)) === name
      );
      if (!mcpTool) return { error: `MCP tool not found: ${name}` };
      const { mcpToolTimeoutSeconds } = await chrome.storage.local.get({
        mcpToolTimeoutSeconds: DEFAULT_MCP_TOOL_TIMEOUT_SECONDS
      });
      const timeoutMs = Math.max(1, Number(mcpToolTimeoutSeconds) || DEFAULT_MCP_TOOL_TIMEOUT_SECONDS) * 1000;

      return await callMcpTool(mcpTool._serverUrl, mcpTool._serverHeaders, mcpTool.name, args, timeoutMs);
    }

    // Built-in tools
    switch (name) {
      case "tab_list":    return await _execTabList(args);
      case "tab_extract": return await _execTabExtract(args);
      case "tab_scroll":  return await _execTabScroll(args);
      case "dom_query":   return await _execDomQuery(args);
      case "dom_click":   return await _execDomClick(args);
      case "dom_set_value": return await _execDomSetValue(args);
      case "dom_style":   return await _execDomStyle(args);
      case "dom_get_html": return await _execDomGetHtml(args);
      case "dom_highlight": return await _execDomHighlight(args);
      case "eval_js":     return await _execEvalJs(args);
      case "tab_open":    return await _execTabOpen(args);
      case "tab_focus":   return await _execTabFocus(args);
      case "tab_close":   return await _execTabClose(args);
      case "tab_group":   return await _execTabGroup(args);
      case "group_list": return await _execGroupList(args);
      case "group_get": return await _execGroupGet(args);
      case "group_update": return await _execGroupUpdate(args);
      case "group_add_tabs": return await _execGroupAddTabs(args);
      case "group_remove_tabs": return await _execGroupRemoveTabs(args);
      case "group_ungroup": return await _execGroupUngroup(args);
      case "history_search": return await _execHistorySearch(args);
      case "tab_get_active": return await _execTabGetActive(args);
      case "tab_screenshot": return await _execTabScreenshot(args);
      case "window_list": return await _execWindowList(args);
      case "window_get_current": return await _execWindowGetCurrent(args);
      case "window_focus": return await _execWindowFocus(args);
      case "window_move_tab": return await _execWindowMoveTab(args);
      case "window_create": return await _execWindowCreate(args);
      case "window_close": return await _execWindowClose(args);
      case "get_current_time": return _execGetCurrentTime();
      case "schedule_tool": return await _execScheduleTool(args, mcpRegistry);
      case "list_scheduled": return _execListScheduled();
      case "cancel_scheduled": return _execCancelScheduled(args);
      default: return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return {
      error: e.message,
      hint: "The operation failed."
    };
  }
}

async function _executeToolWithTimeout(name, args, mcpRegistry, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return await executeTool(name, args, mcpRegistry);
  }

  return await Promise.race([
    executeTool(name, args, mcpRegistry),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Tool execution timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    })
  ]);
}

/**
 * Build consistent timing metadata for browser state snapshots.
 */
function _buildCapturedAt() {
  const now = new Date();
  return {
    timestamp: now.getTime(),
    iso: now.toISOString(),
    local: now.toLocaleString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
  };
}

/**
 * Parse a base64 data URL and estimate its decoded byte size.
 */
function _parseDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") return null;
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  const [, mediaType, base64Data] = match;
  const padding = base64Data.endsWith("==") ? 2 : (base64Data.endsWith("=") ? 1 : 0);
  return {
    mediaType,
    base64Data,
    approxBytes: Math.max(0, Math.floor(base64Data.length * 3 / 4) - padding)
  };
}

/**
 * Resize and recompress screenshots so they are practical for multimodal tool results.
 */
async function _optimizeScreenshotDataUrl(dataUrl) {
  const parsed = _parseDataUrl(dataUrl);
  if (!parsed || typeof document === "undefined") {
    return {
      dataUrl,
      mediaType: parsed?.mediaType || "image/png",
      approxBytes: parsed?.approxBytes || null,
      width: null,
      height: null,
      originalWidth: null,
      originalHeight: null,
      optimized: false
    };
  }

  try {
    const img = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = dataUrl;
    });

    const originalWidth = img.naturalWidth || img.width || null;
    const originalHeight = img.naturalHeight || img.height || null;
    const maxDimension = 1600;
    const scale = originalWidth && originalHeight
      ? Math.min(1, maxDimension / Math.max(originalWidth, originalHeight))
      : 1;
    const width = originalWidth ? Math.max(1, Math.round(originalWidth * scale)) : null;
    const height = originalHeight ? Math.max(1, Math.round(originalHeight * scale)) : null;

    const canvas = document.createElement("canvas");
    canvas.width = width || img.width;
    canvas.height = height || img.height;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2D canvas context unavailable");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const optimizedDataUrl = canvas.toDataURL("image/jpeg", 0.7);
    const optimizedParsed = _parseDataUrl(optimizedDataUrl);
    return {
      dataUrl: optimizedDataUrl,
      mediaType: optimizedParsed?.mediaType || "image/jpeg",
      approxBytes: optimizedParsed?.approxBytes || null,
      width: canvas.width,
      height: canvas.height,
      originalWidth,
      originalHeight,
      optimized: optimizedDataUrl.length < dataUrl.length || scale < 1
    };
  } catch (e) {
    return {
      dataUrl,
      mediaType: parsed.mediaType,
      approxBytes: parsed.approxBytes,
      width: null,
      height: null,
      originalWidth: null,
      originalHeight: null,
      optimized: false
    };
  }
}

/**
 * Normalize Chrome's lastAccessed field for tool responses.
 */
function _buildLastAccessed(lastAccessed) {
  if (typeof lastAccessed !== "number") {
    return { lastAccessed: null, lastAccessedIso: null };
  }
  return {
    lastAccessed,
    lastAccessedIso: new Date(lastAccessed).toISOString()
  };
}

/**
 * Normalize Chrome's groupId field for tool responses.
 */
function _normalizeGroupId(groupId) {
  return typeof groupId === "number" && groupId >= 0 ? groupId : null;
}

/**
 * Serialize common tab metadata for tool responses.
 */
function _serializeTabMetadata(tab) {
  return {
    id: tab.id,
    url: tab.url || "",
    title: tab.title || "",
    windowId: tab.windowId,
    groupId: _normalizeGroupId(tab.groupId),
    ..._buildLastAccessed(tab.lastAccessed)
  };
}

/**
 * Serialize common tab group metadata for tool responses.
 */
function _serializeGroupMetadata(group, tabs = [], currentWindowId = null) {
  return {
    id: group.id,
    windowId: group.windowId,
    currentWindow: currentWindowId != null ? group.windowId === currentWindowId : null,
    title: group.title || "",
    color: group.color || "",
    collapsed: !!group.collapsed,
    tabCount: tabs.length,
    tabs: tabs.map(tab => _serializeTabMetadata(tab))
  };
}

/**
 * Load every tab group snapshot in one pass.
 */
async function _loadAllGroupSnapshots() {
  const [groups, tabs, currentWindow] = await Promise.all([
    chrome.tabGroups.query({}),
    chrome.tabs.query({}),
    chrome.windows.getCurrent({})
  ]);

  const tabsByGroupId = new Map();
  for (const tab of tabs) {
    const groupId = _normalizeGroupId(tab.groupId);
    if (groupId == null) continue;
    if (!tabsByGroupId.has(groupId)) tabsByGroupId.set(groupId, []);
    tabsByGroupId.get(groupId).push(tab);
  }

  return groups.map(group => _serializeGroupMetadata(
    group,
    tabsByGroupId.get(group.id) || [],
    currentWindow?.id ?? null
  ));
}

/**
 * Load a single tab group snapshot by groupId.
 */
async function _loadGroupSnapshot(groupId) {
  const groups = await _loadAllGroupSnapshots();
  return groups.find(group => group.id === groupId) || null;
}

/**
 * Serialize common window metadata for tool responses.
 */
function _serializeWindowMetadata(win, currentWindowId = null) {
  return {
    id: win.id,
    focused: !!win.focused,
    current: currentWindowId != null ? win.id === currentWindowId : null,
    type: win.type || "",
    state: win.state || "",
    incognito: !!win.incognito,
    top: typeof win.top === "number" ? win.top : null,
    left: typeof win.left === "number" ? win.left : null,
    width: typeof win.width === "number" ? win.width : null,
    height: typeof win.height === "number" ? win.height : null,
    tabCount: Array.isArray(win.tabs) ? win.tabs.length : null,
    tabs: Array.isArray(win.tabs) ? win.tabs.map(tab => _serializeTabMetadata(tab)) : []
  };
}

/**
 * Get info about all currently open tabs.
 */
async function _execTabList() {
  const capturedAt = _buildCapturedAt();
  const tabs = await chrome.tabs.query({});
  return {
    capturedAt,
    count: tabs.length,
    tabs: tabs.map(tab => _serializeTabMetadata(tab))
  };
}

/**
 * Resolve a controllable http(s) tab, defaulting to the current active tab.
 */
async function _resolveControllableTab(tabId, actionLabel = "control") {
  let resolvedTabId = tabId;
  if (resolvedTabId == null) {
    const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!activeTab?.id) return { error: "No active tab found" };
    resolvedTabId = activeTab.id;
  }

  const tab = await chrome.tabs.get(resolvedTabId);
  if (!tab.url || !tab.url.startsWith("http")) {
    return { error: `Cannot ${actionLabel} this page (${tab.url?.split("://")[0] || "unknown"} protocol)` };
  }

  return { tab };
}

/**
 * Run a structured page action directly inside the target tab.
 */
async function _executePageAction(tab, action, params, failureHint) {
  try {
    const scriptPromise = chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async (pageAction, pageParams) => {
        const TEXT_LIMIT = 500;
        const HTML_LIMIT = 4000;
        const HIGHLIGHT_STYLE_ID = "__tab_manager_highlight_style__";
        const HIGHLIGHT_OVERLAY_ID = "__tab_manager_highlight_overlay__";

        function sleep(ms) {
          return new Promise(resolve => setTimeout(resolve, ms));
        }

        function truncateText(text, maxLength = TEXT_LIMIT) {
          const normalized = String(text || "").replace(/\s+/g, " ").trim();
          return normalized.length > maxLength ? normalized.slice(0, maxLength) + "..." : normalized;
        }

        function getScrollState() {
          const scroller = document.scrollingElement || document.documentElement || document.body;
          const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
          const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
          const documentHeight = Math.max(
            scroller?.scrollHeight || 0,
            document.documentElement?.scrollHeight || 0,
            document.body?.scrollHeight || 0
          );
          const documentWidth = Math.max(
            scroller?.scrollWidth || 0,
            document.documentElement?.scrollWidth || 0,
            document.body?.scrollWidth || 0
          );
          const scrollY = window.scrollY || scroller?.scrollTop || 0;
          const scrollX = window.scrollX || scroller?.scrollLeft || 0;
          const maxScrollY = Math.max(0, documentHeight - viewportHeight);
          const maxScrollX = Math.max(0, documentWidth - viewportWidth);

          return {
            url: document.URL,
            title: document.title,
            scrollX,
            scrollY,
            maxScrollX,
            maxScrollY,
            viewportWidth,
            viewportHeight,
            documentWidth,
            documentHeight,
            atTop: scrollY <= 0,
            atBottom: scrollY >= maxScrollY,
            atLeft: scrollX <= 0,
            atRight: scrollX >= maxScrollX
          };
        }

        function getSearchableText(element) {
          return truncateText([
            element.innerText,
            element.textContent,
            element.getAttribute("aria-label"),
            element.getAttribute("title"),
            element.getAttribute("placeholder"),
            element.getAttribute("alt"),
            element.getAttribute("value")
          ].filter(Boolean).join(" "), 2000).toLowerCase();
        }

        function isElementVisible(element) {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
            return false;
          }
          return rect.width > 0 && rect.height > 0;
        }

        function isElementClickable(element) {
          return Boolean(
            element.matches("a, button, input, select, textarea, summary, option, label") ||
            element.getAttribute("role") === "button" ||
            typeof element.onclick === "function"
          );
        }

        function serializeAttributes(element) {
          const importantNames = [
            "id",
            "class",
            "name",
            "type",
            "role",
            "href",
            "src",
            "placeholder",
            "aria-label",
            "for",
            "value"
          ];
          const attributes = {};

          for (const name of importantNames) {
            const value = element.getAttribute(name);
            if (value != null && value !== "") {
              attributes[name] = truncateText(value, 300);
            }
          }

          return attributes;
        }

        function serializeRect(element) {
          const rect = element.getBoundingClientRect();
          return {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            top: Math.round(rect.top),
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            bottom: Math.round(rect.bottom),
            pageX: Math.round(rect.left + window.scrollX),
            pageY: Math.round(rect.top + window.scrollY)
          };
        }

        function serializeElement(element, index) {
          return {
            index,
            tagName: element.tagName.toLowerCase(),
            text: truncateText(element.innerText || element.textContent || ""),
            value: truncateText(element.value || "", 300),
            visible: isElementVisible(element),
            clickable: isElementClickable(element),
            attributes: serializeAttributes(element),
            rect: serializeRect(element)
          };
        }

        function findMatchingElements(locator) {
          if (!locator.selector && !locator.text) {
            return { error: "Please provide at least one locator: selector or text" };
          }

          let elements;
          try {
            elements = locator.selector
              ? Array.from(document.querySelectorAll(locator.selector))
              : Array.from(document.querySelectorAll("body *"));
          } catch (e) {
            return { error: `Invalid selector: ${e.message}` };
          }

          if (!locator.text) {
            return { elements };
          }

          const search = String(locator.text).trim().toLowerCase();
          const filtered = elements.filter(element => {
            const candidate = getSearchableText(element);
            return locator.matchExact ? candidate === search : candidate.includes(search);
          });

          return { elements: filtered };
        }

        function resolveElement(locator) {
          const { elements, error } = findMatchingElements(locator);
          if (error) return { error };

          const index = Number.isInteger(locator.index) ? locator.index : 0;
          if (index < 0 || index >= elements.length) {
            return {
              error: elements.length === 0
                ? "No matching element found"
                : `Element index out of range: ${index}. Available matches: ${elements.length}`
            };
          }

          return { element: elements[index], index, totalMatches: elements.length };
        }

        function ensureHighlightStyles() {
          if (document.getElementById(HIGHLIGHT_STYLE_ID)) return;
          const style = document.createElement("style");
          style.id = HIGHLIGHT_STYLE_ID;
          style.textContent = `
            @keyframes tab-manager-highlight-pulse {
              0%, 100% { opacity: 0.2; transform: scale(0.98); }
              50% { opacity: 1; transform: scale(1); }
            }
            #${HIGHLIGHT_OVERLAY_ID} {
              position: fixed;
              pointer-events: none;
              z-index: 2147483647;
              border: 3px solid #ff5f2e;
              background: rgba(255, 95, 46, 0.12);
              box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.08);
              border-radius: 10px;
              animation: tab-manager-highlight-pulse 0.3s ease-in-out 3;
            }
          `;
          document.documentElement.appendChild(style);
        }

        function clearHighlightOverlay() {
          document.getElementById(HIGHLIGHT_OVERLAY_ID)?.remove();
        }

        function showHighlightOverlay(element, durationMs) {
          clearHighlightOverlay();
          ensureHighlightStyles();

          const rect = element.getBoundingClientRect();
          const overlay = document.createElement("div");
          overlay.id = HIGHLIGHT_OVERLAY_ID;
          overlay.style.top = `${Math.max(0, rect.top - 6)}px`;
          overlay.style.left = `${Math.max(0, rect.left - 6)}px`;
          overlay.style.width = `${Math.max(8, rect.width + 12)}px`;
          overlay.style.height = `${Math.max(8, rect.height + 12)}px`;
          document.documentElement.appendChild(overlay);
          window.setTimeout(() => overlay.remove(), durationMs);
        }

        function setFormElementValue(element, value) {
          const tagName = element.tagName.toLowerCase();
          const stringValue = String(value ?? "");
          let setter = null;

          if (tagName === "input") {
            setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
          } else if (tagName === "textarea") {
            setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
          } else if (tagName === "select") {
            setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set;
          }

          if (setter) setter.call(element, stringValue);
          else element.value = stringValue;

          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
        }

        try {
          if (pageAction === "tab_scroll") {
            const stateBefore = getScrollState();
            const behavior = pageParams.behavior === "smooth" ? "smooth" : "auto";
            const position = typeof pageParams.position === "string" ? pageParams.position : null;
            let top = null;

            if (position === "top") top = 0;
            else if (position === "bottom") top = stateBefore.maxScrollY;
            else if (typeof pageParams.deltaY === "number" && Number.isFinite(pageParams.deltaY)) {
              top = stateBefore.scrollY + pageParams.deltaY;
            } else if (typeof pageParams.pageFraction === "number" && Number.isFinite(pageParams.pageFraction)) {
              top = stateBefore.scrollY + (stateBefore.viewportHeight * pageParams.pageFraction);
            } else {
              top = stateBefore.scrollY + stateBefore.viewportHeight * 0.8;
            }

            top = Math.max(0, Math.min(stateBefore.maxScrollY, top));
            window.scrollTo({ top, behavior });
            await sleep(behavior === "smooth" ? 400 : 60);
            const stateAfter = getScrollState();
            return {
              success: true,
              action: position || "delta",
              requestedTop: top,
              moved: Math.abs(stateAfter.scrollY - stateBefore.scrollY) > 1,
              before: stateBefore,
              after: stateAfter
            };
          }

          if (pageAction === "dom_query") {
            const maxResults = Math.min(20, Math.max(1, Number.isInteger(pageParams.maxResults) ? pageParams.maxResults : 5));
            const { elements, error } = findMatchingElements(pageParams);
            if (error) return { error };
            return {
              success: true,
              selector: pageParams.selector || null,
              text: pageParams.text || null,
              count: elements.length,
              truncated: elements.length > maxResults,
              matches: elements.slice(0, maxResults).map((element, index) => serializeElement(element, index))
            };
          }

          if (pageAction === "dom_click") {
            const resolved = resolveElement(pageParams);
            if (resolved.error) return { error: resolved.error };
            const element = resolved.element;
            element.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
            if (typeof element.focus === "function") {
              try { element.focus({ preventScroll: true }); } catch (e) { element.focus(); }
            }
            await sleep(350);
            element.click();
            return {
              success: true,
              action: "click",
              totalMatches: resolved.totalMatches,
              target: serializeElement(element, resolved.index)
            };
          }

          if (pageAction === "dom_set_value") {
            const resolved = resolveElement(pageParams);
            if (resolved.error) return { error: resolved.error };
            const element = resolved.element;
            const tagName = element.tagName.toLowerCase();
            if (!["input", "textarea", "select"].includes(tagName)) {
              return { error: `Element is not a form field: <${tagName}>` };
            }
            element.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
            if (typeof element.focus === "function") {
              try { element.focus({ preventScroll: true }); } catch (e) { element.focus(); }
            }
            await sleep(350);
            setFormElementValue(element, pageParams.value);
            return {
              success: true,
              action: "set_value",
              totalMatches: resolved.totalMatches,
              value: truncateText(element.value || "", 500),
              target: serializeElement(element, resolved.index)
            };
          }

          if (pageAction === "dom_style") {
            const resolved = resolveElement(pageParams);
            if (resolved.error) return { error: resolved.error };
            if (!pageParams.styles || typeof pageParams.styles !== "object" || Array.isArray(pageParams.styles)) {
              return { error: "Please provide a styles object" };
            }
            const durationMs = Math.min(10000, Math.max(0, Number.isFinite(pageParams.durationMs) ? pageParams.durationMs : 2000));
            const element = resolved.element;
            const previous = {};
            element.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
            for (const [key, value] of Object.entries(pageParams.styles)) {
              previous[key] = element.style[key];
              element.style[key] = String(value);
            }
            if (durationMs > 0) {
              window.setTimeout(() => {
                for (const [key, value] of Object.entries(previous)) {
                  element.style[key] = value;
                }
              }, durationMs);
            }
            return {
              success: true,
              action: "style",
              durationMs,
              styles: pageParams.styles,
              target: serializeElement(element, resolved.index)
            };
          }

          if (pageAction === "dom_get_html") {
            const resolved = resolveElement(pageParams);
            if (resolved.error) return { error: resolved.error };
            const mode = pageParams.mode === "inner" ? "inner" : "outer";
            const maxLength = Math.min(20000, Math.max(200, Number.isInteger(pageParams.maxLength) ? pageParams.maxLength : HTML_LIMIT));
            const element = resolved.element;
            const html = mode === "inner" ? element.innerHTML : element.outerHTML;
            return {
              success: true,
              mode,
              truncated: html.length > maxLength,
              html: html.length > maxLength ? html.slice(0, maxLength) + "..." : html,
              target: serializeElement(element, resolved.index)
            };
          }

          if (pageAction === "dom_highlight") {
            const resolved = resolveElement(pageParams);
            if (resolved.error) return { error: resolved.error };
            const durationMs = Math.min(5000, Math.max(300, Number.isFinite(pageParams.durationMs) ? pageParams.durationMs : 1000));
            const element = resolved.element;
            element.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
            await sleep(350);
            showHighlightOverlay(element, durationMs);
            return {
              success: true,
              action: "highlight",
              durationMs,
              target: serializeElement(element, resolved.index),
              scroll: getScrollState()
            };
          }

          return { error: `Unknown page action: ${pageAction}` };
        } catch (error) {
          return { error: error.message || String(error) };
        }
      },
      args: [action, params]
    });

    const results = await Promise.race([
      scriptPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for page response")), 12000))
    ]);

    const data = results?.[0]?.result;
    if (!data) return { error: "Page action did not return a result" };
    if (data.error) return { error: data.error, hint: failureHint };

    return {
      tabId: tab.id,
      windowId: tab.windowId,
      groupId: _normalizeGroupId(tab.groupId),
      ..._buildLastAccessed(tab.lastAccessed),
      ...data
    };
  } catch (e) {
    return {
      error: e.message,
      hint: failureHint
    };
  }
}

/**
 * Extract text content from a browser tab via content script.
 */
async function _execTabExtract({ tabId }) {
  const resolved = await _resolveControllableTab(tabId, "read");
  if (resolved.error) return { error: resolved.error };
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: resolved.tab.id },
      func: () => {
        const textSource =
          document.body?.innerText ||
          document.documentElement?.innerText ||
          document.body?.textContent ||
          document.documentElement?.textContent ||
          "";
        return {
          url: document.URL,
          title: document.title,
          content: String(textSource).substring(0, 8000)
        };
      }
    });

    const data = results?.[0]?.result;
    if (!data) {
      return { error: "Failed to extract tab content" };
    }

    return {
      ...data,
      tabId: resolved.tab.id,
      windowId: resolved.tab.windowId,
      groupId: _normalizeGroupId(resolved.tab.groupId),
      ..._buildLastAccessed(resolved.tab.lastAccessed)
    };
  } catch (e) {
    return {
      error: e.message,
      hint: "This page may need to be refreshed before its content can be read."
    };
  }
}

/**
 * Scroll a browser tab and return the updated scroll state.
 */
async function _execTabScroll({ tabId, deltaY, pageFraction, position, behavior }) {
  const resolved = await _resolveControllableTab(tabId, "scroll");
  if (resolved.error) return { error: resolved.error };

  return _executePageAction(
    resolved.tab,
    "tab_scroll",
    { deltaY, pageFraction, position, behavior },
    "This page may need to be refreshed before scrolling can be controlled."
  );
}

/**
 * Query matching DOM elements on a page.
 */
async function _execDomQuery({ tabId, selector, text, matchExact, maxResults }) {
  const resolved = await _resolveControllableTab(tabId, "inspect");
  if (resolved.error) return { error: resolved.error };

  return _executePageAction(
    resolved.tab,
    "dom_query",
    { selector, text, matchExact, maxResults },
    "This page may need to be refreshed before DOM inspection can run."
  );
}

/**
 * Click a matching DOM element on a page.
 */
async function _execDomClick({ tabId, selector, text, matchExact, index }) {
  const resolved = await _resolveControllableTab(tabId, "interact with");
  if (resolved.error) return { error: resolved.error };

  return _executePageAction(
    resolved.tab,
    "dom_click",
    { selector, text, matchExact, index },
    "This page may need to be refreshed before DOM interactions can run."
  );
}

/**
 * Set the value of a form field on a page.
 */
async function _execDomSetValue({ tabId, selector, text, matchExact, index, value }) {
  const resolved = await _resolveControllableTab(tabId, "edit");
  if (resolved.error) return { error: resolved.error };

  return _executePageAction(
    resolved.tab,
    "dom_set_value",
    { selector, text, matchExact, index, value },
    "This page may need to be refreshed before form fields can be edited."
  );
}

/**
 * Temporarily style a DOM element on a page.
 */
async function _execDomStyle({ tabId, selector, text, matchExact, index, styles, durationMs }) {
  const resolved = await _resolveControllableTab(tabId, "style");
  if (resolved.error) return { error: resolved.error };

  return _executePageAction(
    resolved.tab,
    "dom_style",
    { selector, text, matchExact, index, styles, durationMs },
    "This page may need to be refreshed before styles can be modified."
  );
}

/**
 * Get HTML from a matched DOM element on a page.
 */
async function _execDomGetHtml({ tabId, selector, text, matchExact, index, mode, maxLength }) {
  const resolved = await _resolveControllableTab(tabId, "inspect");
  if (resolved.error) return { error: resolved.error };

  return _executePageAction(
    resolved.tab,
    "dom_get_html",
    { selector, text, matchExact, index, mode, maxLength },
    "This page may need to be refreshed before DOM HTML can be read."
  );
}

/**
 * Scroll to and visually highlight a DOM element on the page.
 */
async function _execDomHighlight({ tabId, selector, text, matchExact, index, durationMs }) {
  const resolved = await _resolveControllableTab(tabId, "highlight");
  if (resolved.error) return { error: resolved.error };

  return _executePageAction(
    resolved.tab,
    "dom_highlight",
    { selector, text, matchExact, index, durationMs },
    "This page may need to be refreshed before highlighting can run."
  );
}

/**
 * Execute arbitrary JavaScript on the current page.
 * Dangerous: should only be reached after explicit user approval.
 */
async function _execEvalJs({ jsScript }) {
  const resolved = await _resolveControllableTab(undefined, "run code on");
  if (resolved.error) return { error: resolved.error };

  const world = "MAIN";
  try {
    const runnerFunc = async (source) => {
      function normalizeResult(value) {
        if (value === undefined) return { kind: "undefined", value: null };
        if (value === null) return null;
        try {
          const json = JSON.stringify(value);
          if (json === undefined) {
            return { kind: typeof value, value: String(value) };
          }
          return JSON.parse(json);
        } catch (e) {
          return { kind: typeof value, value: String(value) };
        }
      }

      const channel = `__tab_manager_eval_js_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      return await new Promise((resolve) => {
        let settled = false;

        function finish(payload) {
          if (settled) return;
          settled = true;
          window.removeEventListener(channel, onResult);
          resolve(payload);
        }

        function onResult(event) {
          finish(event?.detail || { error: "No result returned from injected script" });
        }

        window.addEventListener(channel, onResult, { once: true });

        const script = document.createElement("script");
        script.type = "text/javascript";
        script.textContent = `
          (async () => {
            const channel = ${JSON.stringify(channel)};
            function normalizeResult(value) {
              if (value === undefined) return { kind: "undefined", value: null };
              if (value === null) return null;
              try {
                const json = JSON.stringify(value);
                if (json === undefined) {
                  return { kind: typeof value, value: String(value) };
                }
                return JSON.parse(json);
              } catch (e) {
                return { kind: typeof value, value: String(value) };
              }
            }

            try {
              const result = await (async () => {
                ${source}
              })();
              window.dispatchEvent(new CustomEvent(channel, {
                detail: {
                  success: true,
                  url: document.URL,
                  title: document.title,
                  result: normalizeResult(result)
                }
              }));
            } catch (error) {
              window.dispatchEvent(new CustomEvent(channel, {
                detail: {
                  error: error && error.message ? error.message : String(error),
                  stack: error && error.stack ? String(error.stack).slice(0, 4000) : null,
                  url: document.URL,
                  title: document.title
                }
              }));
            }
          })();
        `;

        const parent = document.documentElement || document.head || document.body;
        if (!parent) {
          finish({ error: "Unable to inject script into this page" });
          return;
        }

        parent.appendChild(script);
        script.remove();

        setTimeout(() => {
          finish({
            error: "Injected script did not return a result. It may have been blocked by the page CSP.",
            url: document.URL,
            title: document.title
          });
        }, 11000);
      });
    };

    const results = await Promise.race([
      chrome.scripting.executeScript({
        target: { tabId: resolved.tab.id },
        world,
        func: runnerFunc,
        args: [jsScript]
      }),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("Timed out waiting for JavaScript execution")), 12000);
      })
    ]);

    const data = results?.[0]?.result;
    if (!data) return { error: "No result returned from JavaScript execution" };

    return {
      world,
      tabId: resolved.tab.id,
      windowId: resolved.tab.windowId,
      groupId: _normalizeGroupId(resolved.tab.groupId),
      ..._buildLastAccessed(resolved.tab.lastAccessed),
      ...data
    };
  } catch (e) {
    return {
      error: e.message,
      world,
      hint: "The script could not be executed on this page."
    };
  }
}

/**
 * Open a new tab with the given URL. Optionally focus on it.
 */
async function _execTabOpen({ url, active }) {
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  const shouldFocus = active !== false; // default true
  const tab = await chrome.tabs.create({ url, active: shouldFocus });
  if (shouldFocus) await chrome.windows.update(tab.windowId, { focused: true });
  return {
    success: true,
    active: shouldFocus,
    tabId: tab.id,
    url: tab.pendingUrl || tab.url || url,
    title: tab.title || "",
    windowId: tab.windowId,
    groupId: _normalizeGroupId(tab.groupId),
    ..._buildLastAccessed(tab.lastAccessed)
  };
}

/**
 * Switch focus to an existing tab.
 */
async function _execTabFocus({ tabId }) {
  let tab = await chrome.tabs.get(tabId);
  const currentWindow = await chrome.windows.getCurrent({});
  const previousWindowId = tab.windowId;
  let movedToCurrentWindow = false;

  if (currentWindow?.id && tab.windowId !== currentWindow.id) {
    tab = await chrome.tabs.move(tabId, { windowId: currentWindow.id, index: -1 });
    movedToCurrentWindow = true;
  }

  tab = await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  return {
    success: true,
    tabId,
    title: tab.title,
    url: tab.url,
    windowId: tab.windowId,
    groupId: _normalizeGroupId(tab.groupId),
    previousWindowId,
    movedToCurrentWindow,
    ..._buildLastAccessed(tab.lastAccessed)
  };
}

/**
 * Close one or more tabs.
 */
async function _execTabClose({ tabIds }) {
  const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
  // Collect tab titles before closing
  const closed = [];
  for (const id of ids) {
    try {
      const tab = await chrome.tabs.get(id);
      closed.push(_serializeTabMetadata(tab));
    } catch (e) {
      closed.push({ id, error: "Tab not found" });
    }
  }
  await chrome.tabs.remove(ids.filter(id => closed.find(c => c.id === id && !c.error)));
  return { success: true, closed };
}

/**
 * Group tabs together with a name and optional color.
 */
async function _execTabGroup({ tabIds, name, color }) {
  const groupId = await chrome.tabs.group({ tabIds });
  const updateProps = { title: name };
  if (color) updateProps.color = color;
  await chrome.tabGroups.update(groupId, updateProps);
  const group = await _loadGroupSnapshot(groupId);
  return { success: true, groupId, name, tabCount: tabIds.length, group };
}

/**
 * Get info about all current tab groups.
 */
async function _execGroupList() {
  const capturedAt = _buildCapturedAt();
  const groups = await _loadAllGroupSnapshots();
  return {
    capturedAt,
    count: groups.length,
    groups
  };
}

/**
 * Get info about a specific tab group.
 */
async function _execGroupGet({ groupId }) {
  const group = await _loadGroupSnapshot(groupId);
  if (!group) return { error: `Tab group not found: ${groupId}` };
  return {
    capturedAt: _buildCapturedAt(),
    group
  };
}

/**
 * Update a tab group's title, color, or collapsed state.
 */
async function _execGroupUpdate({ groupId, name, color, collapsed }) {
  const updateProps = {};
  if (name != null) updateProps.title = name;
  if (color != null) updateProps.color = color;
  if (collapsed != null) updateProps.collapsed = collapsed;

  if (Object.keys(updateProps).length === 0) {
    return { error: "Please provide at least one field to update: name, color, or collapsed" };
  }

  await chrome.tabGroups.update(groupId, updateProps);
  const group = await _loadGroupSnapshot(groupId);
  if (!group) return { error: `Tab group not found after update: ${groupId}` };
  return {
    success: true,
    capturedAt: _buildCapturedAt(),
    group
  };
}

/**
 * Add tabs to an existing tab group.
 */
async function _execGroupAddTabs({ groupId, tabIds }) {
  const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
  await chrome.tabs.group({ groupId, tabIds: ids });
  const group = await _loadGroupSnapshot(groupId);
  if (!group) return { error: `Tab group not found after adding tabs: ${groupId}` };
  return {
    success: true,
    capturedAt: _buildCapturedAt(),
    groupId,
    addedCount: ids.length,
    group
  };
}

/**
 * Remove tabs from their current tab groups.
 */
async function _execGroupRemoveTabs({ tabIds }) {
  const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
  const beforeTabs = [];

  for (const id of ids) {
    try {
      beforeTabs.push(await chrome.tabs.get(id));
    } catch (e) {
      beforeTabs.push({ id, error: "Tab not found" });
    }
  }

  const validTabIds = beforeTabs.filter(tab => !tab.error).map(tab => tab.id);
  if (validTabIds.length > 0) {
    await chrome.tabs.ungroup(validTabIds);
  }

  const afterTabs = await Promise.all(validTabIds.map(async (id) => {
    try {
      return await chrome.tabs.get(id);
    } catch (e) {
      return null;
    }
  }));

  return {
    success: true,
    capturedAt: _buildCapturedAt(),
    requestedCount: ids.length,
    updatedCount: afterTabs.filter(Boolean).length,
    tabs: afterTabs.filter(Boolean).map(tab => _serializeTabMetadata(tab)),
    missing: beforeTabs.filter(tab => tab.error).map(tab => ({ id: tab.id, error: tab.error }))
  };
}

/**
 * Dissolve an entire tab group.
 */
async function _execGroupUngroup({ groupId }) {
  const group = await _loadGroupSnapshot(groupId);
  if (!group) return { error: `Tab group not found: ${groupId}` };

  const tabIds = group.tabs.map(tab => tab.id).filter(id => typeof id === "number");
  if (tabIds.length > 0) {
    await chrome.tabs.ungroup(tabIds);
  }

  const tabs = await Promise.all(tabIds.map(async (id) => {
    try {
      return await chrome.tabs.get(id);
    } catch (e) {
      return null;
    }
  }));

  return {
    success: true,
    capturedAt: _buildCapturedAt(),
    groupId,
    ungroupedCount: tabIds.length,
    group,
    tabs: tabs.filter(Boolean).map(tab => _serializeTabMetadata(tab))
  };
}

/**
 * Search browser history by keyword.
 */
async function _execHistorySearch({ query, maxResults }) {
  const results = await chrome.history.search({
    text: query,
    maxResults: maxResults || 10,
    startTime: Date.now() - 30 * 24 * 60 * 60 * 1000 // last 30 days
  });
  return results.map(r => ({
    url: r.url,
    title: r.title,
    lastVisit: new Date(r.lastVisitTime).toISOString(),
    visitCount: r.visitCount
  }));
}

/**
 * Get info about the currently active/focused tab.
 */
async function _execTabGetActive() {
  const capturedAt = _buildCapturedAt();
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return { error: "No active tab found" };
  return {
    capturedAt,
    tabId: tab.id,
    url: tab.url,
    title: tab.title,
    windowId: tab.windowId,
    groupId: _normalizeGroupId(tab.groupId),
    ..._buildLastAccessed(tab.lastAccessed)
  };
}

/**
 * Capture a screenshot of the currently visible tab.
 * Returns an optimized base64 image data URL.
 */
async function _execTabScreenshot({ windowId }) {
  const wid = windowId || chrome.windows.WINDOW_ID_CURRENT;
  const rawDataUrl = await chrome.tabs.captureVisibleTab(wid, { format: "png" });
  const optimized = await _optimizeScreenshotDataUrl(rawDataUrl);
  return {
    success: true,
    dataUrl: optimized.dataUrl,
    format: optimized.mediaType.split("/")[1] || "jpeg",
    mediaType: optimized.mediaType,
    approxBytes: optimized.approxBytes,
    width: optimized.width,
    height: optimized.height,
    originalWidth: optimized.originalWidth,
    originalHeight: optimized.originalHeight,
    optimized: optimized.optimized,
    note: "Optimized screenshot of the visible tab"
  };
}

/**
 * Get info about all browser windows.
 */
async function _execWindowList() {
  const capturedAt = _buildCapturedAt();
  const [windows, currentWindow] = await Promise.all([
    chrome.windows.getAll({ populate: true }),
    chrome.windows.getCurrent({})
  ]);
  return {
    capturedAt,
    count: windows.length,
    currentWindowId: currentWindow?.id ?? null,
    windows: windows.map(win => _serializeWindowMetadata(win, currentWindow?.id ?? null))
  };
}

/**
 * Get info about the current browser window.
 */
async function _execWindowGetCurrent() {
  const capturedAt = _buildCapturedAt();
  const win = await chrome.windows.getCurrent({ populate: true });
  return {
    capturedAt,
    window: _serializeWindowMetadata(win, win.id)
  };
}

/**
 * Focus a browser window by ID.
 */
async function _execWindowFocus({ windowId }) {
  const previousWindow = await chrome.windows.getCurrent({});
  await chrome.windows.update(windowId, { focused: true });
  const focusedWindow = await chrome.windows.get(windowId, { populate: true });
  return {
    success: true,
    capturedAt: _buildCapturedAt(),
    previousWindowId: previousWindow?.id ?? null,
    window: _serializeWindowMetadata(focusedWindow, windowId)
  };
}

/**
 * Move one or more tabs into a target window.
 */
async function _execWindowMoveTab({ tabIds, windowId }) {
  const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
  const moved = await chrome.tabs.move(ids, { windowId, index: -1 });
  const movedTabs = Array.isArray(moved) ? moved : [moved];
  const currentWindow = await chrome.windows.getCurrent({});
  const targetWindow = await chrome.windows.get(windowId, { populate: true });
  return {
    success: true,
    capturedAt: _buildCapturedAt(),
    windowId,
    movedCount: movedTabs.length,
    movedTabs: movedTabs.map(tab => _serializeTabMetadata(tab)),
    window: _serializeWindowMetadata(targetWindow, currentWindow?.id ?? null)
  };
}

/**
 * Create a new browser window.
 */
async function _execWindowCreate({ url, focused }) {
  const createData = {};
  if (url) createData.url = /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`;
  if (focused != null) createData.focused = focused;

  const createdWindow = await chrome.windows.create(createData);
  const win = await chrome.windows.get(createdWindow.id, { populate: true });
  return {
    success: true,
    capturedAt: _buildCapturedAt(),
    window: _serializeWindowMetadata(win, win.id)
  };
}

/**
 * Close a browser window by ID.
 */
async function _execWindowClose({ windowId }) {
  const currentWindow = await chrome.windows.getCurrent({});
  const win = await chrome.windows.get(windowId, { populate: true });
  const snapshot = _serializeWindowMetadata(win, currentWindow?.id ?? null);
  await chrome.windows.remove(windowId);
  return {
    success: true,
    capturedAt: _buildCapturedAt(),
    closedWindowId: windowId,
    window: snapshot
  };
}

/**
 * Get current date, time, timezone and unix timestamp.
 */
function _execGetCurrentTime() {
  const now = new Date();
  return {
    timestamp: now.getTime(),
    iso: now.toISOString(),
    local: now.toLocaleString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    timezoneOffset: now.getTimezoneOffset()
  };
}

// Scheduled tool calls registry (in-memory, survives within side panel session)
const _scheduled = [];

/**
 * Schedule a tool call to execute at a future time.
 * Validates that toolName is a known built-in or MCP tool.
 */
async function _execScheduleTool({ delaySeconds, timestamp, toolName, toolArgs, label, timeoutSeconds }, mcpRegistry) {
  // Validate toolName exists
  const builtinNames = TOOLS.map(t => t.name);
  const mcpNames = (mcpRegistry || []).map(t =>
    t._toolCallName || buildMcpToolCallName(t._serverName || "server", t.name)
  );
  const allNames = [...builtinNames, ...mcpNames];

  if (!allNames.includes(toolName)) {
    return { error: `Unknown tool: ${toolName}. Available: ${allNames.join(", ")}` };
  }

  const now = Date.now();
  let delayMs, fireTimestamp;

  if (delaySeconds != null && delaySeconds > 0) {
    delayMs = delaySeconds * 1000;
    fireTimestamp = now + delayMs;
  } else if (timestamp != null) {
    delayMs = timestamp - now;
    fireTimestamp = timestamp;
  } else {
    return { error: "Please provide either delaySeconds or timestamp" };
  }

  if (delayMs < 0) return { error: "The specified time is in the past" };

  const id = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const executeTimeoutMs = Math.max(
    1,
    Number(timeoutSeconds) || DEFAULT_SCHEDULE_TOOL_TIMEOUT_SECONDS
  ) * 1000;

  // Snapshot mcpRegistry at schedule time for MCP tool routing
  const mcpSnapshot = (mcpRegistry || []).slice();

  const timerId = setTimeout(async () => {
    try {
      await _executeToolWithTimeout(toolName, toolArgs, mcpSnapshot, executeTimeoutMs);
    } catch (e) { /* silently skip if tool fails */ }
    const idx = _scheduled.findIndex(s => s.id === id);
    if (idx >= 0) _scheduled.splice(idx, 1);
  }, delayMs);

  _scheduled.push({
    id,
    timerId,
    fireTimestamp,
    toolName,
    toolArgs,
    label: label || toolName,
    executeTimeoutMs
  });

  return {
    success: true,
    scheduleId: id,
    toolName,
    toolArgs,
    label: label || toolName,
    fireAt: new Date(fireTimestamp).toLocaleString(),
    delaySeconds: Math.round(delayMs / 1000),
    timeoutSeconds: Math.round(executeTimeoutMs / 1000)
  };
}

/**
 * List all pending scheduled tool calls.
 */
function _execListScheduled() {
  if (_scheduled.length === 0) return { scheduled: [], message: "No pending scheduled tasks" };
  return {
    scheduled: _scheduled.map(s => ({
      scheduleId: s.id,
      label: s.label,
      toolName: s.toolName,
      toolArgs: s.toolArgs,
      fireAt: new Date(s.fireTimestamp).toLocaleString(),
      remainingSeconds: Math.max(0, Math.round((s.fireTimestamp - Date.now()) / 1000)),
      timeoutSeconds: Math.round((s.executeTimeoutMs || (DEFAULT_SCHEDULE_TOOL_TIMEOUT_SECONDS * 1000)) / 1000)
    }))
  };
}

/**
 * Cancel a pending scheduled tool call by its ID.
 */
function _execCancelScheduled({ scheduleId }) {
  const idx = _scheduled.findIndex(s => s.id === scheduleId);
  if (idx < 0) return { error: `Schedule not found: ${scheduleId}` };

  clearTimeout(_scheduled[idx].timerId);
  const cancelled = _scheduled.splice(idx, 1)[0];
  return {
    success: true,
    cancelled: {
      scheduleId: cancelled.id,
      label: cancelled.label,
      toolName: cancelled.toolName,
      wasScheduledFor: new Date(cancelled.fireTimestamp).toLocaleString()
    }
  };
}

// ==================== Streaming Chat ====================

/**
 * Send a streaming chat request to an LLM.
 * Supports both OpenAI-compatible and Anthropic Messages API.
 *
 * Tool calls are collected and included in the onDone callback so the caller
 * can execute them all and send results back in a single round-trip.
 *
 * @param {Object} config - { apiType, baseUrl, apiKey, model }
 * @param {Array} messages - conversation messages
 * @param {Object} callbacks - { onText, onDone, onError }
 * @param {Array} [mcpTools] - MCP tools to include
 * @param {Object} [options]
 * @param {boolean} [options.includeBuiltins=true] - Whether to expose built-in browser tools
 * @returns {Function} abort
 */
export function streamChat(config, messages, { onText, onDone, onError }, mcpTools = [], options = {}) {
  const controller = new AbortController();

  if (config.apiType === "anthropic") {
    _streamAnthropic(config, messages, controller.signal, { onText, onDone, onError }, mcpTools, options);
  } else {
    _streamOpenAI(config, messages, controller.signal, { onText, onDone, onError }, mcpTools, options);
  }

  return () => controller.abort();
}

// ==================== OpenAI Compatible ====================

async function _streamOpenAI(config, messages, signal, { onText, onDone, onError }, mcpTools = [], options = {}) {
  try {
    const tools = getTools("openai", mcpTools, options);
    const url = `${config.baseUrl.replace(/\/$/, '')}/v1/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        tools,
        stream: true,
        stream_options: { include_usage: true }
      }),
      signal
    });

    if (!res.ok) {
      const errText = await res.text();
      onError(new Error(`API error ${res.status}: ${errText}`));
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = "";
    let toolCallsMap = {};
    let buffer = "";
    let sawToolCallDelta = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") continue;

        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            fullContent += delta.content;
            onText(delta.content);
          }

          if (delta.tool_calls) {
            sawToolCallDelta = true;
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCallsMap[idx]) toolCallsMap[idx] = { id: "", name: "", arguments: "" };
              if (tc.id) toolCallsMap[idx].id = tc.id;
              if (tc.function?.name) toolCallsMap[idx].name = tc.function.name;
              if (tc.function?.arguments) toolCallsMap[idx].arguments += tc.function.arguments;
            }
          }
        } catch (e) { /* skip */ }
      }
    }

    const rawToolCalls = Object.entries(toolCallsMap)
      .filter(([, tc]) => tc.name)
      .map(([idx, tc]) => ({
        index: Number(idx),
        id: tc.id || `toolcall_${idx}_${Date.now()}`,
        name: tc.name,
        arguments: tc.arguments
      }));

    const parseFailures = [];
    const toolCalls = rawToolCalls
      .map(tc => {
        try {
          return {
            id: tc.id,
            name: tc.name,
            args: JSON.parse(tc.arguments || "{}"),
            _raw: tc.arguments || "{}"
          };
        } catch (e) {
          parseFailures.push({ name: tc.name, arguments: tc.arguments, error: e.message });
          return null;
        }
      })
      .filter(Boolean);

    if (parseFailures.length > 0) {
      onError(new Error(`Failed to parse tool call arguments: ${parseFailures.map(f => f.name).join(", ")}`));
      return;
    }

    if (sawToolCallDelta && toolCalls.length === 0 && !fullContent) {
      onError(new Error("Model emitted tool call deltas but no valid tool calls could be reconstructed"));
      return;
    }

    onDone({
      role: "assistant",
      content: fullContent || null,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      _openaiToolCalls: toolCalls.length > 0 ? toolCalls.map(tc => ({
        id: tc.id, type: "function",
        function: { name: tc.name, arguments: tc._raw }
      })) : undefined
    });
  } catch (e) {
    if (e.name !== "AbortError") onError(e);
  }
}

// ==================== Anthropic Messages API ====================

async function _streamAnthropic(config, messages, signal, { onText, onDone, onError }, mcpTools = [], options = {}) {
  try {
    const tools = getTools("anthropic", mcpTools, options);

    let systemPrompt = "";
    const apiMessages = [];
    for (const msg of messages) {
      if (msg.role === "system") systemPrompt = msg.content;
      else apiMessages.push(msg);
    }

    const url = `${config.baseUrl.replace(/\/$/, '')}/v1/messages`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model: config.model, system: systemPrompt, messages: apiMessages,
        tools, max_tokens: 4096, stream: true
      }),
      signal
    });

    if (!res.ok) {
      const errText = await res.text();
      onError(new Error(`API error ${res.status}: ${errText}`));
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = "";
    let collectedToolUses = [];
    let currentToolUse = null;
    let buffer = "";
    let sawToolUseBlock = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);

        try {
          const json = JSON.parse(data);

          if (json.type === "content_block_start" && json.content_block?.type === "tool_use") {
            sawToolUseBlock = true;
            currentToolUse = { id: json.content_block.id, name: json.content_block.name, inputJson: "" };
          } else if (json.type === "content_block_delta") {
            if (json.delta?.type === "text_delta") {
              fullContent += json.delta.text;
              onText(json.delta.text);
            } else if (json.delta?.type === "input_json_delta" && currentToolUse) {
              currentToolUse.inputJson += json.delta.partial_json;
            }
          } else if (json.type === "content_block_stop" && currentToolUse) {
            collectedToolUses.push(currentToolUse);
            currentToolUse = null;
          }
        } catch (e) { /* skip */ }
      }
    }

    const parseFailures = [];
    const toolCalls = collectedToolUses
      .map((tu, index) => {
        try {
          return {
            id: tu.id || `tooluse_${index}_${Date.now()}`,
            name: tu.name,
            args: JSON.parse(tu.inputJson || "{}")
          };
        } catch (e) {
          parseFailures.push({ name: tu.name, inputJson: tu.inputJson, error: e.message });
          return null;
        }
      })
      .filter(Boolean);

    if (parseFailures.length > 0) {
      onError(new Error(`Failed to parse tool call arguments: ${parseFailures.map(f => f.name).join(", ")}`));
      return;
    }

    if (sawToolUseBlock && toolCalls.length === 0 && !fullContent) {
      onError(new Error("Model emitted tool_use blocks but no valid tool calls could be reconstructed"));
      return;
    }

    const contentBlocks = [];
    if (fullContent) contentBlocks.push({ type: "text", text: fullContent });
    for (const tc of toolCalls) {
      contentBlocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args });
    }

    onDone({
      role: "assistant",
      content: contentBlocks.length > 0 ? contentBlocks : null,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined
    });
  } catch (e) {
    if (e.name !== "AbortError") onError(e);
  }
}
