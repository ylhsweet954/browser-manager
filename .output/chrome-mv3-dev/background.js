var background = (function() {
	//#region node_modules/wxt/dist/utils/define-background.mjs
	function defineBackground(arg) {
		if (arg == null || typeof arg === "function") return { main: arg };
		return arg;
	}
	//#endregion
	//#region lib/api/tabReuse.ts
	var REUSE_DOMAIN_POLICIES_KEY = "reuseDomainPolicies";
	async function isTabReuseEnabled() {
		const { reuse } = await chrome.storage.local.get({ reuse: false });
		return !!reuse;
	}
	function getReuseDomainKey(url) {
		const normalizedUrl = normalizeReusableUrl(url);
		if (!normalizedUrl) return "";
		try {
			return new URL(normalizedUrl).hostname || "";
		} catch {
			return "";
		}
	}
	function normalizeReusableUrl(url) {
		const raw = String(url || "").trim();
		if (!/^https?:\/\//i.test(raw)) return "";
		try {
			const parsed = new URL(raw);
			parsed.hash = "";
			return parsed.toString();
		} catch {
			return raw.split("#")[0];
		}
	}
	async function findReusableTab(url, opts = {}) {
		const normalizedUrl = normalizeReusableUrl(url);
		if (!normalizedUrl) return null;
		return (await chrome.tabs.query({})).find((tab) => {
			if (!tab?.id || tab.id === opts.excludeTabId) return false;
			return normalizeReusableUrl(tab.pendingUrl || tab.url) === normalizedUrl;
		}) || null;
	}
	async function getReuseDomainPolicies() {
		const { [REUSE_DOMAIN_POLICIES_KEY]: reuseDomainPolicies } = await chrome.storage.local.get({ [REUSE_DOMAIN_POLICIES_KEY]: {} });
		return reuseDomainPolicies && typeof reuseDomainPolicies === "object" ? reuseDomainPolicies : {};
	}
	async function getReuseDomainPolicy(domainKey) {
		if (!domainKey) return "";
		const value = (await getReuseDomainPolicies())[domainKey];
		return value === "reuse" || value === "keep" ? value : "";
	}
	async function setReuseDomainPolicy(domainKey, decision) {
		if (!domainKey) return;
		const policies = await getReuseDomainPolicies();
		if (decision === "reuse" || decision === "keep") policies[domainKey] = decision;
		else delete policies[domainKey];
		await chrome.storage.local.set({ [REUSE_DOMAIN_POLICIES_KEY]: policies });
	}
	async function focusReusableTab(tab) {
		if (!tab?.id) return null;
		await chrome.windows.update(tab.windowId, { focused: true });
		const nextTab = await chrome.tabs.update(tab.id, { active: true });
		if (!nextTab?.windowId) return nextTab ?? null;
		await chrome.windows.update(nextTab.windowId, { focused: true });
		return nextTab;
	}
	//#endregion
	//#region lib/api/mcp.ts
	var _rpcId = 0;
	var DEFAULT_MCP_TOOL_TIMEOUT_MS = 6e4;
	async function rpcCall(url, headers, method, params, timeoutMs) {
		const body = {
			jsonrpc: "2.0",
			method,
			id: ++_rpcId,
			...params !== void 0 ? { params } : {}
		};
		const controller = new AbortController();
		const effectiveTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0;
		let timerId = null;
		if (effectiveTimeoutMs > 0) timerId = setTimeout(() => controller.abort(), effectiveTimeoutMs);
		let res;
		try {
			res = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
					...headers
				},
				body: JSON.stringify(body),
				signal: controller.signal
			});
		} catch (e) {
			if (timerId) clearTimeout(timerId);
			if (e.name === "AbortError") throw new Error(`MCP request timed out after ${effectiveTimeoutMs}ms`);
			throw e;
		}
		if (timerId) clearTimeout(timerId);
		if (!res.ok) {
			const errText = await res.text();
			throw new Error(`MCP error ${res.status}: ${errText}`);
		}
		if ((res.headers.get("content-type") || "").includes("text/event-stream")) return _parseSSEResponse(res);
		const json = await res.json();
		if (json.error) throw new Error(`MCP RPC error: ${json.error.message || JSON.stringify(json.error)}`);
		return json.result;
	}
	async function _parseSSEResponse(res) {
		const reader = res.body?.getReader();
		if (!reader) throw new Error("MCP SSE: no body");
		const decoder = new TextDecoder();
		let buffer = "";
		let lastResult = null;
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				const trimmed = line.trim();
				if (trimmed.startsWith("data: ")) try {
					const json = JSON.parse(trimmed.slice(6));
					if (json.result !== void 0) lastResult = json.result;
					if (json.error) throw new Error(`MCP RPC error: ${json.error.message || JSON.stringify(json.error)}`);
				} catch (e) {
					if ((e instanceof Error ? e.message : String(e)).startsWith("MCP RPC error")) throw e;
				}
			}
		}
		if (lastResult === null) throw new Error("MCP SSE response contained no result");
		return lastResult;
	}
	async function callMcpTool(url, headers, toolName, args, timeoutMs = DEFAULT_MCP_TOOL_TIMEOUT_MS) {
		const result = await rpcCall(url, headers, "tools/call", {
			name: toolName,
			arguments: args
		}, timeoutMs);
		if (result.content && Array.isArray(result.content)) {
			const texts = result.content.filter((c) => c.type === "text").map((c) => c.text);
			if (texts.length === 1) return { result: texts[0] };
			if (texts.length > 1) return { result: texts.join("\n") };
		}
		return result;
	}
	//#endregion
	//#region lib/api/llm.ts
	var DOM_LOCATOR_PROPERTIES = {
		tabId: {
			type: "number",
			description: "Optional browser tab ID. Defaults to the current active tab."
		},
		selector: {
			type: "string",
			description: "Optional CSS selector used to find elements."
		},
		text: {
			type: "string",
			description: "Optional text to match against element text or labels."
		},
		matchExact: {
			type: "boolean",
			description: "Whether text matching should be exact. Defaults to false."
		},
		index: {
			type: "number",
			description: "Zero-based index within the matched elements. Defaults to 0."
		}
	};
	var DEFAULT_SCHEDULE_TOOL_TIMEOUT_SECONDS = 30;
	var DEFAULT_MCP_TOOL_TIMEOUT_SECONDS = 60;
	var SCHEDULE_STORAGE_KEY = "scheduledJobs";
	var SCHEDULE_RETENTION_MS = 1440 * 60 * 1e3;
	var SCHEDULE_FIRE_ALARM_PREFIX = "schedule-fire:";
	var SCHEDULE_CLEANUP_ALARM_PREFIX = "schedule-cleanup:";
	var TERMINAL_SCHEDULE_STATUSES = new Set([
		"succeeded",
		"failed",
		"cancelled"
	]);
	var TOOLS = [
		{
			name: "tab_list",
			description: "Get a snapshot of all currently open browser tabs. Returns each tab's id, url, title, and lastAccessed, plus capturedAt timing fields so you can judge whether the tab state may be stale and refresh it again if needed. Use when the user asks about open tabs, browser context, or page-related questions and you need to identify the right tab first.",
			schema: {
				type: "object",
				properties: {
					maxSize: {
						type: "number",
						description: "Maximum number of tabs to return. Defaults to -1 (no limit)."
					},
					briefUrl: {
						type: "boolean",
						description: "If true, return only the hostname (domain) instead of the full URL. Useful to reduce response size when full URLs are not needed."
					}
				},
				required: []
			}
		},
		{
			name: "tab_extract",
			description: "Extract the text content of a browser tab. Also returns tab metadata including title, url, and lastAccessed when available. Use when you need to read page content to answer the user's question.",
			schema: {
				type: "object",
				properties: { tabId: {
					type: "number",
					description: "The browser tab ID to extract content from"
				} },
				required: ["tabId"]
			}
		},
		{
			name: "tab_scroll",
			description: "Scroll a browser tab and return the updated scroll position. Use when you need to inspect another part of the currently visible page before taking another screenshot or reading the layout. If tabId is omitted, scrolls the current active tab.",
			schema: {
				type: "object",
				properties: {
					tabId: {
						type: "number",
						description: "Optional browser tab ID. Defaults to the current active tab."
					},
					deltaY: {
						type: "number",
						description: "Optional vertical scroll delta in pixels. Positive scrolls down, negative scrolls up."
					},
					pageFraction: {
						type: "number",
						description: "Optional fraction of one viewport height to scroll, such as 0.8 or -1."
					},
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
					maxResults: {
						type: "number",
						description: "Maximum number of matching elements to return (default 5, max 20)."
					}
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
					value: {
						type: "string",
						description: "The value to set on the target form element."
					}
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
					durationMs: {
						type: "number",
						description: "How long to keep the styles before restoring them (default 2000ms)."
					}
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
					maxLength: {
						type: "number",
						description: "Maximum HTML length to return (default 4000, max 20000)."
					}
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
					durationMs: {
						type: "number",
						description: "How long the highlight should remain visible (default 1000ms)."
					}
				},
				required: []
			}
		},
		{
			name: "eval_js",
			description: "Dangerous tool. Execute arbitrary JavaScript on the current active page in the page's main JavaScript context. Use only when structured DOM tools are insufficient. The application will handle explicit user confirmation before execution, so do not ask the user for confirmation in natural language; call the tool directly when needed.",
			schema: {
				type: "object",
				properties: { jsScript: {
					type: "string",
					description: "JavaScript source code to execute in the page's main world. Use `return ...` if you want a result value back."
				} },
				required: ["jsScript"]
			}
		},
		{
			name: "tab_open",
			description: "Open a new browser tab with the given URL. By default focuses on the new tab. Returns tab metadata including lastAccessed when available.",
			schema: {
				type: "object",
				properties: {
					url: {
						type: "string",
						description: "The URL to open"
					},
					active: {
						type: "boolean",
						description: "Whether to focus on the new tab (default true). Set false to open in background."
					}
				},
				required: ["url"]
			}
		},
		{
			name: "tab_focus",
			description: "Switch focus to an existing browser tab by its ID. If the tab is in a different browser window, move it into the current window first, then focus it. Returns tab metadata including windowId and lastAccessed when available.",
			schema: {
				type: "object",
				properties: { tabId: {
					type: "number",
					description: "The tab ID to focus on"
				} },
				required: ["tabId"]
			}
		},
		{
			name: "tab_close",
			description: "Close one or more browser tabs by their IDs. Returns metadata for each tab before it was closed, including lastAccessed when available.",
			schema: {
				type: "object",
				properties: { tabIds: {
					type: "array",
					items: { type: "number" },
					description: "Array of tab IDs to close"
				} },
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
					name: {
						type: "string",
						description: "Display name for the tab group"
					},
					color: {
						type: "string",
						enum: [
							"grey",
							"blue",
							"red",
							"yellow",
							"green",
							"pink",
							"purple",
							"cyan",
							"orange"
						],
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
				properties: { groupId: {
					type: "number",
					description: "The browser tab group ID"
				} },
				required: ["groupId"]
			}
		},
		{
			name: "group_update",
			description: "Update a tab group's title, color, and/or collapsed state. Returns the updated group snapshot.",
			schema: {
				type: "object",
				properties: {
					groupId: {
						type: "number",
						description: "The browser tab group ID"
					},
					name: {
						type: "string",
						description: "New display title for the group"
					},
					color: {
						type: "string",
						enum: [
							"grey",
							"blue",
							"red",
							"yellow",
							"green",
							"pink",
							"purple",
							"cyan",
							"orange"
						],
						description: "New color for the tab group"
					},
					collapsed: {
						type: "boolean",
						description: "Whether the group should be collapsed"
					}
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
					groupId: {
						type: "number",
						description: "The browser tab group ID"
					},
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
				properties: { tabIds: {
					type: "array",
					items: { type: "number" },
					description: "Array of tab IDs to remove from their current groups"
				} },
				required: ["tabIds"]
			}
		},
		{
			name: "group_ungroup",
			description: "Dissolve an entire tab group by its groupId. Returns the group snapshot captured before ungrouping and the resulting tabs.",
			schema: {
				type: "object",
				properties: { groupId: {
					type: "number",
					description: "The browser tab group ID"
				} },
				required: ["groupId"]
			}
		},
		{
			name: "history_search",
			description: "Search browser history by keyword. Returns recent matching URLs with titles and visit times. Use when the user asks about previously visited pages.",
			schema: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description: "Search keyword"
					},
					maxResults: {
						type: "number",
						description: "Maximum number of results to return (default 10)"
					}
				},
				required: ["query"]
			}
		},
		{
			name: "history_recent",
			description: "List recent browser history entries within a time range. Use when the user asks for recently visited pages without a keyword filter.",
			schema: {
				type: "object",
				properties: {
					startTime: {
						type: "number",
						description: "Optional inclusive start timestamp in milliseconds. Defaults to 7 days ago."
					},
					endTime: {
						type: "number",
						description: "Optional inclusive end timestamp in milliseconds. Defaults to now."
					},
					maxResults: {
						type: "number",
						description: "Maximum number of results to return (default 100, max 100)."
					}
				},
				required: []
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
			description: "Capture a screenshot of a browser tab. By default captures only the visible viewport using Chrome's captureVisibleTab (requires that tab to be active in its window). Output is width-capped JPEG for readability.",
			schema: {
				type: "object",
				properties: {
					windowId: {
						type: "number",
						description: "Window ID passed to captureVisibleTab (default: the resolved tab's window)"
					},
					tabId: {
						type: "number",
						description: "Optional tab to capture. When omitted, uses the active tab in the last-focused window. When set, that tab is activated before capture."
					}
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
				properties: { windowId: {
					type: "number",
					description: "The browser window ID to focus"
				} },
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
					windowId: {
						type: "number",
						description: "The target browser window ID"
					}
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
					url: {
						type: "string",
						description: "Optional URL to open in the new window"
					},
					focused: {
						type: "boolean",
						description: "Whether the new window should be focused (default true)"
					}
				},
				required: []
			}
		},
		{
			name: "window_close",
			description: "Close a browser window by its ID. Returns the window snapshot captured before closing.",
			schema: {
				type: "object",
				properties: { windowId: {
					type: "number",
					description: "The browser window ID to close"
				} },
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
			description: "Schedule a tool call to execute at a future time. You MUST provide both toolName and toolArgs. toolName must be one of the available built-in tools or connected MCP tools. toolArgs must be a JSON object and must strictly match the input format required by the selected toolName. Provide EITHER delaySeconds (relative, preferred) OR timestamp (absolute). Example: schedule tab_open to open a URL in 5 minutes. Recommendation: because scheduled jobs run inside the Chrome host process, they will disappear and cannot execute after Chrome is closed, so avoid creating jobs too far in the future whenever possible.",
			schema: {
				type: "object",
				properties: {
					delaySeconds: {
						type: "number",
						description: "Seconds from now (e.g. 300 for 5 minutes). Preferred."
					},
					timestamp: {
						type: "number",
						description: "Absolute Unix timestamp in ms. Only if user gives exact datetime."
					},
					toolName: {
						type: "string",
						description: "Name of the tool to call (e.g. tab_open, tab_close, mcp__xxx)"
					},
					toolArgs: {
						type: "object",
						description: "Required JSON object of arguments for the selected toolName. The shape and field names must strictly match that tool's input schema."
					},
					label: {
						type: "string",
						description: "Short human-readable description of this scheduled task"
					},
					timeoutSeconds: {
						type: "number",
						description: `Maximum execution time after the schedule fires. Defaults to ${DEFAULT_SCHEDULE_TOOL_TIMEOUT_SECONDS} seconds.`
					}
				},
				required: ["toolName", "toolArgs"]
			}
		},
		{
			name: "list_scheduled",
			description: "List all scheduled jobs that are pending, running, or completed within the last 24 hours, including their IDs, labels, planned fire times, and statuses.",
			schema: {
				type: "object",
				properties: {},
				required: []
			}
		},
		{
			name: "cancel_scheduled",
			description: "Cancel a pending scheduled tool call by its ID. Cancelled jobs remain visible with status=cancelled for 24 hours before cleanup.",
			schema: {
				type: "object",
				properties: { scheduleId: {
					type: "string",
					description: "The schedule ID to cancel"
				} },
				required: ["scheduleId"]
			}
		},
		{
			name: "clear_completed_scheduled",
			description: "Manually clear completed scheduled jobs, including succeeded, failed, and cancelled entries.",
			schema: {
				type: "object",
				properties: {},
				required: []
			}
		}
	];
	TOOLS.length;
	var BUILTIN_TOOL_NAMES = TOOLS.map((t) => t.name);
	function buildMcpToolCallName(serverName, toolName) {
		return `mcp_${serverName}_${toolName}`;
	}
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
	async function executeTool(name, args, mcpRegistry = []) {
		try {
			if (name.startsWith("mcp_")) {
				const mcpTool = mcpRegistry.find((t) => (t._toolCallName || buildMcpToolCallName(t._serverName || "server", t.name)) === name);
				if (!mcpTool) return { error: `MCP tool not found: ${name}` };
				const { mcpToolTimeoutSeconds } = await chrome.storage.local.get({ mcpToolTimeoutSeconds: DEFAULT_MCP_TOOL_TIMEOUT_SECONDS });
				const timeoutMs = Math.max(1, Number(mcpToolTimeoutSeconds) || DEFAULT_MCP_TOOL_TIMEOUT_SECONDS) * 1e3;
				return await callMcpTool(mcpTool._serverUrl, mcpTool._serverHeaders, mcpTool.name, args, timeoutMs);
			}
			switch (name) {
				case "tab_list": return await _execTabList(args);
				case "tab_extract": return await _execTabExtract(args);
				case "tab_scroll": return await _execTabScroll(args);
				case "dom_query": return await _execDomQuery(args);
				case "dom_click": return await _execDomClick(args);
				case "dom_set_value": return await _execDomSetValue(args);
				case "dom_style": return await _execDomStyle(args);
				case "dom_get_html": return await _execDomGetHtml(args);
				case "dom_highlight": return await _execDomHighlight(args);
				case "eval_js": return await _execEvalJs(args);
				case "tab_open": return await _execTabOpen(args);
				case "tab_focus": return await _execTabFocus(args);
				case "tab_close": return await _execTabClose(args);
				case "tab_group": return await _execTabGroup(args);
				case "group_list": return await _execGroupList(args);
				case "group_get": return await _execGroupGet(args);
				case "group_update": return await _execGroupUpdate(args);
				case "group_add_tabs": return await _execGroupAddTabs(args);
				case "group_remove_tabs": return await _execGroupRemoveTabs(args);
				case "group_ungroup": return await _execGroupUngroup(args);
				case "history_search": return await _execHistorySearch(args);
				case "history_recent": return await _execHistoryRecent(args);
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
				case "clear_completed_scheduled": return _execClearCompletedScheduled();
				default: return { error: `Unknown tool: ${name}` };
			}
		} catch (e) {
			return {
				error: e instanceof Error ? e.message : String(e),
				hint: "The operation failed."
			};
		}
	}
	/**
	* Build consistent timing metadata for browser state snapshots.
	*/
	function _buildCapturedAt() {
		const now = /* @__PURE__ */ new Date();
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
		const padding = base64Data.endsWith("==") ? 2 : base64Data.endsWith("=") ? 1 : 0;
		return {
			mediaType,
			base64Data,
			approxBytes: Math.max(0, Math.floor(base64Data.length * 3 / 4) - padding)
		};
	}
	async function _optimizeScreenshotDataUrl(dataUrl, options = {}) {
		const parsed = _parseDataUrl(dataUrl);
		if (!parsed || typeof document === "undefined") return {
			dataUrl,
			mediaType: parsed?.mediaType || "image/png",
			approxBytes: parsed?.approxBytes || null,
			width: null,
			height: null,
			originalWidth: null,
			originalHeight: null,
			optimized: false
		};
		const strategy = options.strategy === "fitWidth" ? "fitWidth" : "fitMaxEdge";
		const jpegQuality = typeof options.jpegQuality === "number" ? Math.min(1, Math.max(.5, options.jpegQuality)) : strategy === "fitWidth" ? .88 : .7;
		try {
			const img = await new Promise((resolve, reject) => {
				const image = new Image();
				image.onload = () => resolve(image);
				image.onerror = reject;
				image.src = dataUrl;
			});
			const originalWidth = img.naturalWidth || img.width || null;
			const originalHeight = img.naturalHeight || img.height || null;
			let scale = 1;
			if (originalWidth && originalHeight) if (strategy === "fitWidth") {
				const maxW = Number.isFinite(options.maxWidth) ? Math.max(320, options.maxWidth) : 2048;
				const maxH = Number.isFinite(options.maxHeight) ? Math.max(800, options.maxHeight) : 24e3;
				if (originalWidth > maxW) scale = maxW / originalWidth;
				const hAfter = originalHeight * scale;
				if (hAfter > maxH) scale *= maxH / hAfter;
				scale = Math.min(1, scale);
			} else scale = Math.min(1, 1600 / Math.max(originalWidth, originalHeight));
			const width = originalWidth ? Math.max(1, Math.round(originalWidth * scale)) : null;
			const height = originalHeight ? Math.max(1, Math.round(originalHeight * scale)) : null;
			const canvas = document.createElement("canvas");
			canvas.width = width || img.width;
			canvas.height = height || img.height;
			const ctx = canvas.getContext("2d", { alpha: false });
			if (!ctx) throw new Error("2D canvas context unavailable");
			ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
			const optimizedDataUrl = canvas.toDataURL("image/jpeg", jpegQuality);
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
		if (typeof lastAccessed !== "number") return {
			lastAccessed: null,
			lastAccessedIso: null
		};
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
			tabs: tabs.map((tab) => _serializeTabMetadata(tab))
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
		const tabsByGroupId = /* @__PURE__ */ new Map();
		for (const tab of tabs) {
			const groupId = _normalizeGroupId(tab.groupId);
			if (groupId == null) continue;
			if (!tabsByGroupId.has(groupId)) tabsByGroupId.set(groupId, []);
			tabsByGroupId.get(groupId).push(tab);
		}
		return groups.map((group) => _serializeGroupMetadata(group, tabsByGroupId.get(group.id) || [], currentWindow?.id ?? null));
	}
	/**
	* Load a single tab group snapshot by groupId.
	*/
	async function _loadGroupSnapshot(groupId) {
		return (await _loadAllGroupSnapshots()).find((group) => group.id === groupId) || null;
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
			tabs: Array.isArray(win.tabs) ? win.tabs.map((tab) => _serializeTabMetadata(tab)) : []
		};
	}
	/**
	* Get info about all currently open tabs.
	*/
	async function _execTabList({ maxSize = -1, briefUrl = false } = {}) {
		const capturedAt = _buildCapturedAt();
		let tabs = await chrome.tabs.query({});
		if (maxSize > 0) tabs = tabs.slice(0, maxSize);
		return {
			capturedAt,
			count: tabs.length,
			tabs: tabs.map((tab) => {
				const meta = _serializeTabMetadata(tab);
				if (briefUrl) try {
					meta.url = new URL(meta.url).hostname;
				} catch {}
				return meta;
			})
		};
	}
	/**
	* Resolve a controllable http(s) tab, defaulting to the current active tab.
	*/
	async function _resolveControllableTab(tabId, actionLabel = "control") {
		let resolvedTabId = tabId;
		if (resolvedTabId == null) {
			const [activeTab] = await chrome.tabs.query({
				active: true,
				lastFocusedWindow: true
			});
			if (!activeTab?.id) return { error: "No active tab found" };
			resolvedTabId = activeTab.id;
		}
		const tab = await chrome.tabs.get(resolvedTabId);
		if (!tab.url || !tab.url.startsWith("http")) return { error: `Cannot ${actionLabel} this page (${tab.url?.split("://")[0] || "unknown"} protocol)` };
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
					const HTML_LIMIT = 4e3;
					const HIGHLIGHT_STYLE_ID = "__tab_manager_highlight_style__";
					const HIGHLIGHT_OVERLAY_ID = "__tab_manager_highlight_overlay__";
					function sleep(ms) {
						return new Promise((resolve) => setTimeout(resolve, ms));
					}
					function truncateText(text, maxLength = TEXT_LIMIT) {
						const normalized = String(text || "").replace(/\s+/g, " ").trim();
						return normalized.length > maxLength ? normalized.slice(0, maxLength) + "..." : normalized;
					}
					function getScrollState() {
						const scroller = document.scrollingElement || document.documentElement || document.body;
						const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
						const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
						const documentHeight = Math.max(scroller?.scrollHeight || 0, document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0);
						const documentWidth = Math.max(scroller?.scrollWidth || 0, document.documentElement?.scrollWidth || 0, document.body?.scrollWidth || 0);
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
						].filter(Boolean).join(" "), 2e3).toLowerCase();
					}
					function isElementVisible(element) {
						const rect = element.getBoundingClientRect();
						const style = window.getComputedStyle(element);
						if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
						return rect.width > 0 && rect.height > 0;
					}
					function isElementClickable(element) {
						return Boolean(element.matches("a, button, input, select, textarea, summary, option, label") || element.getAttribute("role") === "button" || typeof element.onclick === "function");
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
							if (value != null && value !== "") attributes[name] = truncateText(value, 300);
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
						if (!locator.selector && !locator.text) return { error: "Please provide at least one locator: selector or text" };
						let elements;
						try {
							elements = locator.selector ? Array.from(document.querySelectorAll(locator.selector)) : Array.from(document.querySelectorAll("body *"));
						} catch (e) {
							return { error: `Invalid selector: ${e.message}` };
						}
						if (!locator.text) return { elements };
						const search = String(locator.text).trim().toLowerCase();
						return { elements: elements.filter((element) => {
							const candidate = getSearchableText(element);
							return locator.matchExact ? candidate === search : candidate.includes(search);
						}) };
					}
					function resolveElement(locator) {
						const { elements, error } = findMatchingElements(locator);
						if (error) return { error };
						const index = Number.isInteger(locator.index) ? locator.index : 0;
						if (index < 0 || index >= elements.length) return { error: elements.length === 0 ? "No matching element found" : `Element index out of range: ${index}. Available matches: ${elements.length}` };
						return {
							element: elements[index],
							index,
							totalMatches: elements.length
						};
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
						if (tagName === "input") setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
						else if (tagName === "textarea") setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
						else if (tagName === "select") setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set;
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
							else if (typeof pageParams.deltaY === "number" && Number.isFinite(pageParams.deltaY)) top = stateBefore.scrollY + pageParams.deltaY;
							else if (typeof pageParams.pageFraction === "number" && Number.isFinite(pageParams.pageFraction)) top = stateBefore.scrollY + stateBefore.viewportHeight * pageParams.pageFraction;
							else top = stateBefore.scrollY + stateBefore.viewportHeight * .8;
							top = Math.max(0, Math.min(stateBefore.maxScrollY, top));
							window.scrollTo({
								top,
								behavior
							});
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
							element.scrollIntoView({
								block: "center",
								inline: "nearest",
								behavior: "smooth"
							});
							if (typeof element.focus === "function") try {
								element.focus({ preventScroll: true });
							} catch (e) {
								element.focus();
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
							if (![
								"input",
								"textarea",
								"select"
							].includes(tagName)) return { error: `Element is not a form field: <${tagName}>` };
							element.scrollIntoView({
								block: "center",
								inline: "nearest",
								behavior: "smooth"
							});
							if (typeof element.focus === "function") try {
								element.focus({ preventScroll: true });
							} catch (e) {
								element.focus();
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
							if (!pageParams.styles || typeof pageParams.styles !== "object" || Array.isArray(pageParams.styles)) return { error: "Please provide a styles object" };
							const durationMs = Math.min(1e4, Math.max(0, Number.isFinite(pageParams.durationMs) ? pageParams.durationMs : 2e3));
							const element = resolved.element;
							const previous = {};
							element.scrollIntoView({
								block: "center",
								inline: "nearest",
								behavior: "smooth"
							});
							for (const [key, value] of Object.entries(pageParams.styles)) {
								previous[key] = element.style[key];
								element.style[key] = String(value);
							}
							if (durationMs > 0) window.setTimeout(() => {
								for (const [key, value] of Object.entries(previous)) element.style[key] = value;
							}, durationMs);
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
							const maxLength = Math.min(2e4, Math.max(200, Number.isInteger(pageParams.maxLength) ? pageParams.maxLength : HTML_LIMIT));
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
							const durationMs = Math.min(5e3, Math.max(300, Number.isFinite(pageParams.durationMs) ? pageParams.durationMs : 1e3));
							const element = resolved.element;
							element.scrollIntoView({
								block: "center",
								inline: "nearest",
								behavior: "smooth"
							});
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
			const data = (await Promise.race([scriptPromise, new Promise((_, reject) => setTimeout(() => reject(/* @__PURE__ */ new Error("Timed out waiting for page response")), 12e3))]))?.[0]?.result;
			if (!data) return { error: "Page action did not return a result" };
			if (data.error) return {
				error: data.error,
				hint: failureHint
			};
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
			const data = (await chrome.scripting.executeScript({
				target: { tabId: resolved.tab.id },
				func: () => {
					const textSource = document.body?.innerText || document.documentElement?.innerText || document.body?.textContent || document.documentElement?.textContent || "";
					return {
						url: document.URL,
						title: document.title,
						content: String(textSource).substring(0, 8e3)
					};
				}
			}))?.[0]?.result;
			if (!data) return { error: "Failed to extract tab content" };
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
		return _executePageAction(resolved.tab, "tab_scroll", {
			deltaY,
			pageFraction,
			position,
			behavior
		}, "This page may need to be refreshed before scrolling can be controlled.");
	}
	/**
	* Query matching DOM elements on a page.
	*/
	async function _execDomQuery({ tabId, selector, text, matchExact, maxResults }) {
		const resolved = await _resolveControllableTab(tabId, "inspect");
		if (resolved.error) return { error: resolved.error };
		return _executePageAction(resolved.tab, "dom_query", {
			selector,
			text,
			matchExact,
			maxResults
		}, "This page may need to be refreshed before DOM inspection can run.");
	}
	/**
	* Click a matching DOM element on a page.
	*/
	async function _execDomClick({ tabId, selector, text, matchExact, index }) {
		const resolved = await _resolveControllableTab(tabId, "interact with");
		if (resolved.error) return { error: resolved.error };
		return _executePageAction(resolved.tab, "dom_click", {
			selector,
			text,
			matchExact,
			index
		}, "This page may need to be refreshed before DOM interactions can run.");
	}
	/**
	* Set the value of a form field on a page.
	*/
	async function _execDomSetValue({ tabId, selector, text, matchExact, index, value }) {
		const resolved = await _resolveControllableTab(tabId, "edit");
		if (resolved.error) return { error: resolved.error };
		return _executePageAction(resolved.tab, "dom_set_value", {
			selector,
			text,
			matchExact,
			index,
			value
		}, "This page may need to be refreshed before form fields can be edited.");
	}
	/**
	* Temporarily style a DOM element on a page.
	*/
	async function _execDomStyle({ tabId, selector, text, matchExact, index, styles, durationMs }) {
		const resolved = await _resolveControllableTab(tabId, "style");
		if (resolved.error) return { error: resolved.error };
		return _executePageAction(resolved.tab, "dom_style", {
			selector,
			text,
			matchExact,
			index,
			styles,
			durationMs
		}, "This page may need to be refreshed before styles can be modified.");
	}
	/**
	* Get HTML from a matched DOM element on a page.
	*/
	async function _execDomGetHtml({ tabId, selector, text, matchExact, index, mode, maxLength }) {
		const resolved = await _resolveControllableTab(tabId, "inspect");
		if (resolved.error) return { error: resolved.error };
		return _executePageAction(resolved.tab, "dom_get_html", {
			selector,
			text,
			matchExact,
			index,
			mode,
			maxLength
		}, "This page may need to be refreshed before DOM HTML can be read.");
	}
	/**
	* Scroll to and visually highlight a DOM element on the page.
	*/
	async function _execDomHighlight({ tabId, selector, text, matchExact, index, durationMs }) {
		const resolved = await _resolveControllableTab(tabId, "highlight");
		if (resolved.error) return { error: resolved.error };
		return _executePageAction(resolved.tab, "dom_highlight", {
			selector,
			text,
			matchExact,
			index,
			durationMs
		}, "This page may need to be refreshed before highlighting can run.");
	}
	/**
	* Execute arbitrary JavaScript on the current page.
	* Dangerous: should only be reached after explicit user approval.
	*/
	async function _execEvalJs({ jsScript }) {
		const resolved = await _resolveControllableTab(void 0, "run code on");
		if (resolved.error) return { error: resolved.error };
		const world = "MAIN";
		try {
			const runnerFunc = async (source) => {
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
					}, 11e3);
				});
			};
			const data = (await Promise.race([chrome.scripting.executeScript({
				target: { tabId: resolved.tab.id },
				world,
				func: runnerFunc,
				args: [jsScript]
			}), new Promise((_, reject) => {
				setTimeout(() => reject(/* @__PURE__ */ new Error("Timed out waiting for JavaScript execution")), 12e3);
			})]))?.[0]?.result;
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
		const shouldFocus = active !== false;
		const tab = await chrome.tabs.create({
			url,
			active: shouldFocus
		});
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
			tab = await chrome.tabs.move(tabId, {
				windowId: currentWindow.id,
				index: -1
			});
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
		const closed = [];
		for (const id of ids) try {
			const tab = await chrome.tabs.get(id);
			closed.push(_serializeTabMetadata(tab));
		} catch (e) {
			closed.push({
				id,
				error: "Tab not found"
			});
		}
		await chrome.tabs.remove(ids.filter((id) => closed.find((c) => c.id === id && !c.error)));
		return {
			success: true,
			closed
		};
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
		return {
			success: true,
			groupId,
			name,
			tabCount: tabIds.length,
			group
		};
	}
	/**
	* Get info about all current tab groups.
	*/
	async function _execGroupList(_args) {
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
		if (Object.keys(updateProps).length === 0) return { error: "Please provide at least one field to update: name, color, or collapsed" };
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
		await chrome.tabs.group({
			groupId,
			tabIds: ids
		});
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
		for (const id of ids) try {
			beforeTabs.push(await chrome.tabs.get(id));
		} catch (e) {
			beforeTabs.push({
				id,
				error: "Tab not found"
			});
		}
		const validTabIds = beforeTabs.filter((tab) => !tab.error).map((tab) => tab.id);
		if (validTabIds.length > 0) await chrome.tabs.ungroup(validTabIds);
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
			tabs: afterTabs.filter(Boolean).map((tab) => _serializeTabMetadata(tab)),
			missing: beforeTabs.filter((tab) => tab.error).map((tab) => ({
				id: tab.id,
				error: tab.error
			}))
		};
	}
	/**
	* Dissolve an entire tab group.
	*/
	async function _execGroupUngroup({ groupId }) {
		const group = await _loadGroupSnapshot(groupId);
		if (!group) return { error: `Tab group not found: ${groupId}` };
		const tabIds = group.tabs.map((tab) => tab.id).filter((id) => typeof id === "number");
		if (tabIds.length > 0) await chrome.tabs.ungroup(tabIds);
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
			tabs: tabs.filter(Boolean).map((tab) => _serializeTabMetadata(tab))
		};
	}
	/**
	* Search browser history by keyword.
	*/
	async function _execHistorySearch({ query, maxResults }) {
		return (await chrome.history.search({
			text: query,
			maxResults: maxResults || 10,
			startTime: Date.now() - 720 * 60 * 60 * 1e3
		})).map((r) => ({
			url: r.url,
			title: r.title,
			lastVisit: new Date(r.lastVisitTime).toISOString(),
			visitCount: r.visitCount
		}));
	}
	/**
	* List recent browser history within a time range.
	*/
	async function _execHistoryRecent({ startTime, endTime, maxResults }) {
		const now = Date.now();
		const resolvedEndTime = Number.isFinite(endTime) ? endTime : now;
		const resolvedStartTime = Number.isFinite(startTime) ? startTime : resolvedEndTime - 10080 * 60 * 1e3;
		const resolvedMaxResults = Math.min(100, Math.max(1, Number.isFinite(maxResults) ? Math.floor(maxResults) : 100));
		if (resolvedStartTime > resolvedEndTime) return { error: "startTime must be less than or equal to endTime" };
		const results = await chrome.history.search({
			text: "",
			maxResults: resolvedMaxResults,
			startTime: resolvedStartTime,
			endTime: resolvedEndTime
		});
		return {
			startTime: new Date(resolvedStartTime).toISOString(),
			endTime: new Date(resolvedEndTime).toISOString(),
			maxResults: resolvedMaxResults,
			results: results.map((r) => ({
				url: r.url,
				title: r.title,
				lastVisit: new Date(r.lastVisitTime).toISOString(),
				visitCount: r.visitCount
			}))
		};
	}
	/**
	* Get info about the currently active/focused tab.
	*/
	async function _execTabGetActive(_args) {
		const capturedAt = _buildCapturedAt();
		const [tab] = await chrome.tabs.query({
			active: true,
			lastFocusedWindow: true
		});
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
	function _sleepMs(ms) {
		const n = Math.max(0, Math.floor(ms));
		if (!n) return Promise.resolve();
		return new Promise((resolve) => setTimeout(resolve, n));
	}
	async function _readPageScrollMetrics(tab) {
		try {
			return (await chrome.scripting.executeScript({
				target: { tabId: tab.id },
				func: () => {
					const scroller = document.scrollingElement || document.documentElement || document.body;
					const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
					const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
					const documentHeight = Math.max(scroller?.scrollHeight || 0, document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0);
					const scrollY = window.scrollY || scroller?.scrollTop || 0;
					const maxScrollY = Math.max(0, documentHeight - viewportHeight);
					return {
						viewportHeight,
						viewportWidth,
						documentHeight,
						scrollY,
						maxScrollY,
						atBottom: scrollY >= maxScrollY - 1.5
					};
				}
			}))?.[0]?.result || null;
		} catch (_e) {
			return null;
		}
	}
	async function _setPageScrollTop(tab, top) {
		const y = Math.max(0, Number(top) || 0);
		await chrome.scripting.executeScript({
			target: { tabId: tab.id },
			func: (scrollTop) => {
				window.scrollTo({
					top: scrollTop,
					left: 0,
					behavior: "auto"
				});
			},
			args: [y]
		});
	}
	async function _readInnerHeightAndScrollY(tab) {
		try {
			return (await chrome.scripting.executeScript({
				target: { tabId: tab.id },
				func: () => {
					const scroller = document.scrollingElement || document.documentElement || document.body;
					const innerHeight = window.innerHeight || document.documentElement.clientHeight || 0;
					const documentHeight = Math.max(scroller?.scrollHeight || 0, document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0);
					return {
						innerHeight,
						scrollY: window.scrollY || scroller?.scrollTop || 0,
						maxScrollY: Math.max(0, documentHeight - innerHeight),
						documentHeight
					};
				}
			}))?.[0]?.result || null;
		} catch (_e) {
			return null;
		}
	}
	async function _loadImageFromDataUrl(dataUrl) {
		return await new Promise((resolve, reject) => {
			const image = new Image();
			image.onload = () => resolve(image);
			image.onerror = () => reject(/* @__PURE__ */ new Error("Failed to decode screenshot image"));
			image.src = dataUrl;
		});
	}
	var FULL_PAGE_MAX_STITCH_PX = 16e3;
	/**
	* Capture a screenshot of the currently visible tab (viewport), or full scroll height when fullPage is true.
	* Returns an optimized base64 image data URL.
	*/
	async function _execTabScreenshot(args = {}) {
		const { windowId, tabId, fullPage, maxScreens: maxScreensRaw, settleMs: settleMsRaw } = args;
		const resolved = await _resolveControllableTab(tabId, "screenshot");
		if (resolved.error) return { error: resolved.error };
		const tab = resolved.tab;
		const wid = typeof windowId === "number" ? windowId : tab.windowId;
		const maxScreens = Number.isFinite(maxScreensRaw) ? Math.max(1, Math.min(100, Math.floor(maxScreensRaw))) : 40;
		const settleMs = Number.isFinite(settleMsRaw) ? Math.max(0, Math.min(5e3, settleMsRaw)) : 250;
		const isFullPage = fullPage === true;
		const baseNote = isFullPage ? "Full-page stitch: tab window was focused; scroll position restored when possible." : "Optimized screenshot of the visible tab.";
		if (!isFullPage) try {
			if (tabId != null) {
				await chrome.tabs.update(tab.id, { active: true });
				await chrome.windows.update(tab.windowId, { focused: true });
				await _sleepMs(80);
			}
			const optimized = await _optimizeScreenshotDataUrl(await chrome.tabs.captureVisibleTab(wid, { format: "png" }));
			return {
				success: true,
				fullPage: false,
				tabId: tab.id,
				windowId: tab.windowId,
				dataUrl: optimized.dataUrl,
				format: optimized.mediaType.split("/")[1] || "jpeg",
				mediaType: optimized.mediaType,
				approxBytes: optimized.approxBytes,
				width: optimized.width,
				height: optimized.height,
				originalWidth: optimized.originalWidth,
				originalHeight: optimized.originalHeight,
				optimized: optimized.optimized,
				note: baseNote
			};
		} catch (e) {
			return {
				error: e?.message || String(e),
				hint: "captureVisibleTab requires the target tab to be active in its window. Pass tabId to focus that tab first."
			};
		}
		const m0 = await _readPageScrollMetrics(tab);
		if (!m0) return { error: "Unable to read scroll metrics for full-page screenshot." };
		const initialScrollY = m0.scrollY;
		let stoppedReason = "completed";
		let canvas = null;
		let ctx = null;
		let destY = 0;
		let slicesDrawn = 0;
		let exitedCaptureLoopEarly = false;
		try {
			await chrome.tabs.update(tab.id, { active: true });
			await chrome.windows.update(tab.windowId, { focused: true });
			await _sleepMs(80);
			await _setPageScrollTop(tab, 0);
			if (settleMs) await _sleepMs(settleMs);
			const hi0 = await _readInnerHeightAndScrollY(tab);
			if (!hi0) return { error: "Unable to read innerHeight/scrollY for full-page screenshot." };
			const windowHeight = Math.max(1, Math.round(hi0.innerHeight));
			let lastScrollAfterStitch = hi0.scrollY;
			/** Chrome throttles captureVisibleTab (~2/sec); stay under quota between real captures. */
			const MIN_CAPTURE_GAP_MS = 650;
			let lastCaptureAtMs = 0;
			async function captureVisibleThrottled() {
				const now = Date.now();
				if (lastCaptureAtMs > 0) {
					const waitMs = MIN_CAPTURE_GAP_MS - (now - lastCaptureAtMs);
					if (waitMs > 0) await _sleepMs(waitMs);
				}
				const url = await chrome.tabs.captureVisibleTab(wid, { format: "png" });
				lastCaptureAtMs = Date.now();
				return url;
			}
			const layoutAfterTop = await _readPageScrollMetrics(tab);
			const documentHeight = Math.max(windowHeight, layoutAfterTop?.documentHeight ?? windowHeight);
			const img0 = await _loadImageFromDataUrl(await captureVisibleThrottled());
			const iw0 = img0.naturalWidth || img0.width;
			const ih0 = img0.naturalHeight || img0.height;
			canvas = document.createElement("canvas");
			canvas.width = iw0;
			const estRows = Math.ceil(documentHeight / windowHeight);
			canvas.height = Math.min(FULL_PAGE_MAX_STITCH_PX, Math.max(ih0, Math.ceil(estRows * ih0)));
			ctx = canvas.getContext("2d", { alpha: false });
			if (!ctx) return { error: "2D canvas context unavailable for full-page stitch." };
			ctx.fillStyle = "#ffffff";
			ctx.fillRect(0, 0, canvas.width, canvas.height);
			ctx.drawImage(img0, 0, 0);
			destY = ih0;
			slicesDrawn = 1;
			let n = 1;
			while (slicesDrawn < maxScreens) {
				await _setPageScrollTop(tab, n * windowHeight);
				if (settleMs) await _sleepMs(settleMs);
				const st = await _readInnerHeightAndScrollY(tab);
				if (!st) {
					stoppedReason = "metrics_failed";
					exitedCaptureLoopEarly = true;
					break;
				}
				const vh = Math.max(1, Math.round(st.innerHeight));
				const sy = st.scrollY;
				const targetY = n * windowHeight;
				const maxScrollY = Math.max(0, Number(st.maxScrollY) || 0);
				const pinnedToMetricsBottom = maxScrollY > 0 && Number.isFinite(sy) && Math.abs(sy - maxScrollY) <= 24;
				/** Requested scroll target lies past the furthest scrollable Y — browser clamped, this tile needs bottom crop. */
				const requestPastDocumentEnd = targetY > maxScrollY + .5;
				if (sy <= lastScrollAfterStitch + .5) {
					stoppedReason = "completed";
					exitedCaptureLoopEarly = true;
					break;
				}
				const isLastPage = maxScrollY > 0 && requestPastDocumentEnd && pinnedToMetricsBottom;
				const img = await _loadImageFromDataUrl(await captureVisibleThrottled());
				const iw = img.naturalWidth || img.width;
				const ih = img.naturalHeight || img.height;
				let safeCropTop = 0;
				if (isLastPage) {
					const remainForLast = Math.max(0, targetY - sy);
					const cropTop = Math.round(ih - Math.min(vh, remainForLast) / vh * ih);
					safeCropTop = Math.min(Math.max(0, cropTop), Math.max(0, ih - 1));
				}
				const sliceH = ih - safeCropTop;
				if (destY + sliceH > FULL_PAGE_MAX_STITCH_PX) {
					stoppedReason = "max_canvas";
					exitedCaptureLoopEarly = true;
					break;
				}
				if (destY + sliceH > canvas.height) {
					const newH = Math.min(FULL_PAGE_MAX_STITCH_PX, Math.max(destY + sliceH, Math.ceil(canvas.height * 1.5)));
					if (newH < destY + sliceH) {
						stoppedReason = "max_canvas";
						exitedCaptureLoopEarly = true;
						break;
					}
					const newCanvas = document.createElement("canvas");
					newCanvas.width = canvas.width;
					newCanvas.height = newH;
					const nctx = newCanvas.getContext("2d", { alpha: false });
					if (!nctx) return { error: "2D canvas context unavailable while resizing stitch canvas." };
					nctx.fillStyle = "#ffffff";
					nctx.fillRect(0, 0, newCanvas.width, newCanvas.height);
					nctx.drawImage(canvas, 0, 0);
					canvas = newCanvas;
					ctx = nctx;
				}
				ctx.drawImage(img, 0, safeCropTop, iw, sliceH, 0, destY, canvas.width, sliceH);
				destY += sliceH;
				slicesDrawn++;
				lastScrollAfterStitch = sy;
				if (isLastPage) {
					stoppedReason = "completed";
					exitedCaptureLoopEarly = true;
					break;
				}
				n++;
			}
			if (slicesDrawn === 0) return {
				error: "No screenshots captured for full page.",
				hint: "Try a normal http(s) page with a scrollable document."
			};
			if (!exitedCaptureLoopEarly && stoppedReason === "completed" && maxScreens > 1 && slicesDrawn >= maxScreens) stoppedReason = "max_screens";
			const lastMetrics = await _readPageScrollMetrics(tab);
			const trimmed = document.createElement("canvas");
			trimmed.width = canvas.width;
			trimmed.height = destY;
			const tctx = trimmed.getContext("2d", { alpha: false });
			if (!tctx) return { error: "Unable to finalize full-page canvas." };
			tctx.drawImage(canvas, 0, 0);
			const optimized = await _optimizeScreenshotDataUrl(trimmed.toDataURL("image/png"), {
				strategy: "fitWidth",
				maxWidth: 2048,
				maxHeight: 24e3,
				jpegQuality: .88
			});
			return {
				success: true,
				fullPage: true,
				tabId: tab.id,
				windowId: tab.windowId,
				slices: slicesDrawn,
				stoppedReason,
				stitchMode: "pageAligned",
				pageViewportCssPx: windowHeight,
				maxScreens,
				settleMs,
				stitchedWidth: trimmed.width,
				stitchedHeight: trimmed.height,
				documentHeight: lastMetrics?.documentHeight ?? null,
				dataUrl: optimized.dataUrl,
				format: optimized.mediaType.split("/")[1] || "jpeg",
				mediaType: optimized.mediaType,
				approxBytes: optimized.approxBytes,
				width: optimized.width,
				height: optimized.height,
				originalWidth: optimized.originalWidth,
				originalHeight: optimized.originalHeight,
				optimized: optimized.optimized,
				note: baseNote
			};
		} catch (e) {
			return {
				error: e?.message || String(e),
				hint: "Full-page capture failed. Ensure the page allows scripting and the tab stays active."
			};
		} finally {
			try {
				await _setPageScrollTop(tab, initialScrollY);
			} catch (_e) {}
		}
	}
	/**
	* Get info about all browser windows.
	*/
	async function _execWindowList(_args) {
		const capturedAt = _buildCapturedAt();
		const [windows, currentWindow] = await Promise.all([chrome.windows.getAll({ populate: true }), chrome.windows.getCurrent({})]);
		return {
			capturedAt,
			count: windows.length,
			currentWindowId: currentWindow?.id ?? null,
			windows: windows.map((win) => _serializeWindowMetadata(win, currentWindow?.id ?? null))
		};
	}
	/**
	* Get info about the current browser window.
	*/
	async function _execWindowGetCurrent(_args) {
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
		const moved = await chrome.tabs.move(ids, {
			windowId,
			index: -1
		});
		const movedTabs = Array.isArray(moved) ? moved : [moved];
		const currentWindow = await chrome.windows.getCurrent({});
		const targetWindow = await chrome.windows.get(windowId, { populate: true });
		return {
			success: true,
			capturedAt: _buildCapturedAt(),
			windowId,
			movedCount: movedTabs.length,
			movedTabs: movedTabs.map((tab) => _serializeTabMetadata(tab)),
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
		const snapshot = _serializeWindowMetadata(await chrome.windows.get(windowId, { populate: true }), currentWindow?.id ?? null);
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
		const now = /* @__PURE__ */ new Date();
		return {
			timestamp: now.getTime(),
			iso: now.toISOString(),
			local: now.toLocaleString(),
			timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			timezoneOffset: now.getTimezoneOffset()
		};
	}
	function _snapshotScheduleMcpRegistry(mcpRegistry = []) {
		return (mcpRegistry || []).map((tool) => ({
			name: tool?.name,
			_serverName: tool?._serverName,
			_serverUrl: tool?._serverUrl,
			_serverHeaders: tool?._serverHeaders || {},
			_toolCallName: tool?._toolCallName || buildMcpToolCallName(tool?._serverName || "server", tool?.name)
		})).filter((tool) => tool.name && tool._toolCallName && tool._serverUrl);
	}
	function _isTerminalScheduledStatus(status) {
		return TERMINAL_SCHEDULE_STATUSES.has(status);
	}
	function _buildScheduleFireAlarmName(scheduleId) {
		return `${SCHEDULE_FIRE_ALARM_PREFIX}${scheduleId}`;
	}
	function _buildScheduleCleanupAlarmName(scheduleId) {
		return `${SCHEDULE_CLEANUP_ALARM_PREFIX}${scheduleId}`;
	}
	async function _loadScheduledJobsFromStorage() {
		const { [SCHEDULE_STORAGE_KEY]: jobs } = await chrome.storage.local.get({ [SCHEDULE_STORAGE_KEY]: [] });
		return Array.isArray(jobs) ? jobs : [];
	}
	async function _saveScheduledJobsToStorage(jobs) {
		await chrome.storage.local.set({ [SCHEDULE_STORAGE_KEY]: jobs });
	}
	async function _clearScheduledAlarms(scheduleId) {
		if (!chrome.alarms) return;
		await chrome.alarms.clear(_buildScheduleFireAlarmName(scheduleId));
		await chrome.alarms.clear(_buildScheduleCleanupAlarmName(scheduleId));
	}
	function _serializeScheduledJob(job) {
		const remainingSeconds = job.status === "pending" ? Math.max(0, Math.round((job.fireTimestamp - Date.now()) / 1e3)) : 0;
		return {
			id: job.id,
			scheduleId: job.id,
			label: job.label,
			toolName: job.toolName,
			toolArgs: job.toolArgs,
			fireAt: new Date(job.fireTimestamp).toLocaleString(),
			status: job.status,
			remainingSeconds,
			timeoutSeconds: Math.round((job.executeTimeoutMs || DEFAULT_SCHEDULE_TOOL_TIMEOUT_SECONDS * 1e3) / 1e3),
			startedAt: job.startedAt ? new Date(job.startedAt).toLocaleString() : null,
			finishedAt: job.finishedAt ? new Date(job.finishedAt).toLocaleString() : null,
			error: job.error || null,
			expiresAt: job.expiresAt ? new Date(job.expiresAt).toLocaleString() : null
		};
	}
	async function _pruneExpiredScheduledJobsInStorage() {
		const jobs = await _loadScheduledJobsFromStorage();
		const now = Date.now();
		const kept = [];
		for (const job of jobs) {
			if (_isTerminalScheduledStatus(job?.status) && Number.isFinite(job?.expiresAt) && job.expiresAt <= now) {
				await _clearScheduledAlarms(job.id);
				continue;
			}
			kept.push(job);
		}
		if (kept.length !== jobs.length) await _saveScheduledJobsToStorage(kept);
		return kept;
	}
	async function _sendScheduleMessage(action, payload = {}) {
		try {
			return await chrome.runtime.sendMessage({
				type: "schedule_manager",
				action,
				payload
			}) || { error: "No response from schedule manager" };
		} catch (error) {
			return { error: error?.message || String(error) };
		}
	}
	/**
	* Schedule a tool call to execute at a future time via the background service worker.
	*/
	async function _execScheduleTool({ delaySeconds, timestamp, toolName, toolArgs, label, timeoutSeconds }, mcpRegistry) {
		return await _sendScheduleMessage("schedule", {
			delaySeconds,
			timestamp,
			toolName,
			toolArgs,
			label,
			timeoutSeconds,
			mcpRegistry: _snapshotScheduleMcpRegistry(mcpRegistry)
		});
	}
	/**
	* List scheduled tool calls directly from storage to avoid MV3 service worker
	* wake-up / response jitter in the schedule management UI.
	*/
	async function _execListScheduled(_args) {
		const jobs = await _pruneExpiredScheduledJobsInStorage();
		if (jobs.length === 0) return {
			scheduled: [],
			message: "No scheduled tasks"
		};
		return { scheduled: jobs.slice().sort((a, b) => b.fireTimestamp - a.fireTimestamp).map(_serializeScheduledJob) };
	}
	/**
	* Cancel a pending scheduled tool call directly in storage.
	* The background service worker still owns creation and execution.
	*/
	async function _execCancelScheduled({ scheduleId }) {
		const jobs = await _pruneExpiredScheduledJobsInStorage();
		const index = jobs.findIndex((job) => job.id === scheduleId);
		if (index < 0) return { error: `Schedule not found: ${scheduleId}` };
		const cancelled = jobs[index];
		if (cancelled.status !== "pending") return { error: `Schedule ${scheduleId} is already ${cancelled.status}` };
		cancelled.status = "cancelled";
		cancelled.finishedAt = Date.now();
		cancelled.error = null;
		cancelled.expiresAt = cancelled.finishedAt + SCHEDULE_RETENTION_MS;
		await _saveScheduledJobsToStorage(jobs);
		await _clearScheduledAlarms(cancelled.id);
		if (chrome.alarms && Number.isFinite(cancelled.expiresAt)) await chrome.alarms.create(_buildScheduleCleanupAlarmName(cancelled.id), { when: Math.max(Date.now(), cancelled.expiresAt) });
		return {
			success: true,
			cancelled: {
				scheduleId: cancelled.id,
				label: cancelled.label,
				toolName: cancelled.toolName,
				wasScheduledFor: new Date(cancelled.fireTimestamp).toLocaleString(),
				status: cancelled.status,
				expiresAt: new Date(cancelled.expiresAt).toLocaleString()
			}
		};
	}
	/**
	* Clear completed scheduled jobs directly in storage.
	*/
	async function _execClearCompletedScheduled(_args) {
		const jobs = await _pruneExpiredScheduledJobsInStorage();
		const completedJobs = jobs.filter((job) => _isTerminalScheduledStatus(job?.status));
		if (completedJobs.length === 0) return {
			success: true,
			removedCount: 0,
			removedIds: []
		};
		await _saveScheduledJobsToStorage(jobs.filter((job) => !_isTerminalScheduledStatus(job?.status)));
		for (const job of completedJobs) await _clearScheduledAlarms(job.id);
		return {
			success: true,
			removedCount: completedJobs.length,
			removedIds: completedJobs.map((job) => job.id)
		};
	}
	//#endregion
	//#region entrypoints/background/index.ts
	var background_default = defineBackground(() => {
		const REUSE_PROMPT_TIMEOUT_MS = 3e4;
		const pendingReusePrompts = /* @__PURE__ */ new Map();
		const SCHEDULE_STORAGE_KEY = "scheduledJobs";
		const SCHEDULE_RETENTION_MS = 1440 * 60 * 1e3;
		const DEFAULT_SCHEDULE_TOOL_TIMEOUT_SECONDS = 30;
		const SCHEDULE_FIRE_ALARM_PREFIX = "schedule-fire:";
		const SCHEDULE_CLEANUP_ALARM_PREFIX = "schedule-cleanup:";
		const TERMINAL_SCHEDULE_STATUSES = new Set([
			"succeeded",
			"failed",
			"cancelled"
		]);
		function buildScheduleFireAlarmName(id) {
			return `${SCHEDULE_FIRE_ALARM_PREFIX}${id}`;
		}
		function buildScheduleCleanupAlarmName(id) {
			return `${SCHEDULE_CLEANUP_ALARM_PREFIX}${id}`;
		}
		function isTerminalScheduleStatus(status) {
			return TERMINAL_SCHEDULE_STATUSES.has(status);
		}
		async function loadScheduledJobs() {
			const { [SCHEDULE_STORAGE_KEY]: jobs } = await chrome.storage.local.get({ [SCHEDULE_STORAGE_KEY]: [] });
			return Array.isArray(jobs) ? jobs : [];
		}
		async function saveScheduledJobs(jobs) {
			await chrome.storage.local.set({ [SCHEDULE_STORAGE_KEY]: jobs });
		}
		function serializeScheduledJob(job) {
			const remainingSeconds = job.status === "pending" ? Math.max(0, Math.round((job.fireTimestamp - Date.now()) / 1e3)) : 0;
			return {
				id: job.id,
				scheduleId: job.id,
				label: job.label,
				toolName: job.toolName,
				toolArgs: job.toolArgs,
				fireAt: new Date(job.fireTimestamp).toLocaleString(),
				status: job.status,
				remainingSeconds,
				timeoutSeconds: Math.round((job.executeTimeoutMs || DEFAULT_SCHEDULE_TOOL_TIMEOUT_SECONDS * 1e3) / 1e3),
				startedAt: job.startedAt ? new Date(job.startedAt).toLocaleString() : null,
				finishedAt: job.finishedAt ? new Date(job.finishedAt).toLocaleString() : null,
				error: job.error || null,
				expiresAt: job.expiresAt ? new Date(job.expiresAt).toLocaleString() : null
			};
		}
		async function clearScheduleAlarms(scheduleId) {
			if (!chrome.alarms) return;
			await chrome.alarms.clear(buildScheduleFireAlarmName(scheduleId));
			await chrome.alarms.clear(buildScheduleCleanupAlarmName(scheduleId));
		}
		async function createScheduleFireAlarm(job) {
			if (!chrome.alarms || job.status !== "pending") return;
			await chrome.alarms.create(buildScheduleFireAlarmName(job.id), { when: Math.max(Date.now(), job.fireTimestamp) });
		}
		async function createScheduleCleanupAlarm(job) {
			if (!chrome.alarms || !isTerminalScheduleStatus(job.status) || !Number.isFinite(job.expiresAt)) return;
			await chrome.alarms.create(buildScheduleCleanupAlarmName(job.id), { when: Math.max(Date.now(), job.expiresAt) });
		}
		async function pruneExpiredScheduledJobs() {
			const jobs = await loadScheduledJobs();
			const now = Date.now();
			const kept = [];
			for (const job of jobs) {
				if (isTerminalScheduleStatus(job?.status) && Number.isFinite(job?.expiresAt) && job.expiresAt <= now) {
					await clearScheduleAlarms(job.id);
					continue;
				}
				kept.push(job);
			}
			if (kept.length !== jobs.length) await saveScheduledJobs(kept);
			return kept;
		}
		function buildScheduleMcpSnapshot(mcpRegistry = []) {
			return (mcpRegistry || []).map((tool) => ({
				name: tool?.name,
				_serverName: tool?._serverName,
				_serverUrl: tool?._serverUrl,
				_serverHeaders: tool?._serverHeaders || {},
				_toolCallName: tool?._toolCallName
			})).filter((tool) => tool.name && tool._toolCallName && tool._serverUrl);
		}
		function isKnownScheduledToolName(toolName, mcpRegistry = []) {
			if (BUILTIN_TOOL_NAMES.includes(toolName)) return true;
			return (mcpRegistry || []).some((tool) => tool?._toolCallName === toolName);
		}
		async function executeToolWithTimeout(name, args, mcpRegistry, timeoutMs) {
			if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return await executeTool(name, args, mcpRegistry);
			return await Promise.race([executeTool(name, args, mcpRegistry), new Promise((_, reject) => {
				setTimeout(() => reject(/* @__PURE__ */ new Error(`Tool execution timed out after ${Math.round(timeoutMs / 1e3)}s`)), timeoutMs);
			})]);
		}
		async function listScheduledJobs() {
			const jobs = await pruneExpiredScheduledJobs();
			if (jobs.length === 0) return {
				scheduled: [],
				message: "No scheduled tasks"
			};
			return { scheduled: jobs.slice().sort((a, b) => b.fireTimestamp - a.fireTimestamp).map(serializeScheduledJob) };
		}
		async function clearCompletedScheduledJobs() {
			const jobs = await pruneExpiredScheduledJobs();
			const completedJobs = jobs.filter((job) => isTerminalScheduleStatus(job?.status));
			if (completedJobs.length === 0) return {
				success: true,
				removedCount: 0,
				removedIds: []
			};
			await saveScheduledJobs(jobs.filter((job) => !isTerminalScheduleStatus(job?.status)));
			for (const job of completedJobs) await clearScheduleAlarms(job.id);
			return {
				success: true,
				removedCount: completedJobs.length,
				removedIds: completedJobs.map((job) => job.id)
			};
		}
		async function scheduleJob(payload = {}) {
			const { delaySeconds, timestamp, toolName, toolArgs, label, timeoutSeconds, mcpRegistry } = payload;
			const mcpSnapshot = buildScheduleMcpSnapshot(mcpRegistry);
			if (!isKnownScheduledToolName(toolName, mcpSnapshot)) return { error: `Unknown tool: ${toolName}` };
			if (toolArgs == null || typeof toolArgs !== "object" || Array.isArray(toolArgs)) return { error: "toolArgs is required and must be an object" };
			const now = Date.now();
			let delayMs;
			let fireTimestamp;
			if (delaySeconds != null && Number(delaySeconds) > 0) {
				delayMs = Number(delaySeconds) * 1e3;
				fireTimestamp = now + delayMs;
			} else if (timestamp != null && Number.isFinite(Number(timestamp))) {
				fireTimestamp = Number(timestamp);
				delayMs = fireTimestamp - now;
			} else return { error: "Please provide either delaySeconds or timestamp" };
			if (delayMs < 0) return { error: "The specified time is in the past" };
			const jobs = await pruneExpiredScheduledJobs();
			const id = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
			const executeTimeoutMs = Math.max(1, Number(timeoutSeconds) || DEFAULT_SCHEDULE_TOOL_TIMEOUT_SECONDS) * 1e3;
			const entry = {
				id,
				fireTimestamp,
				toolName,
				toolArgs,
				label: label || toolName,
				executeTimeoutMs,
				status: "pending",
				startedAt: null,
				finishedAt: null,
				error: null,
				expiresAt: null,
				mcpRegistry: mcpSnapshot
			};
			jobs.push(entry);
			await saveScheduledJobs(jobs);
			await createScheduleFireAlarm(entry);
			return {
				success: true,
				scheduleId: id,
				toolName,
				toolArgs,
				label: entry.label,
				fireAt: new Date(fireTimestamp).toLocaleString(),
				delaySeconds: Math.round(delayMs / 1e3),
				timeoutSeconds: Math.round(executeTimeoutMs / 1e3)
			};
		}
		async function cancelScheduledJob(scheduleId) {
			const jobs = await pruneExpiredScheduledJobs();
			const index = jobs.findIndex((job) => job.id === scheduleId);
			if (index < 0) return { error: `Schedule not found: ${scheduleId}` };
			const cancelled = jobs[index];
			if (cancelled.status !== "pending") return { error: `Schedule ${scheduleId} is already ${cancelled.status}` };
			cancelled.status = "cancelled";
			cancelled.finishedAt = Date.now();
			cancelled.error = null;
			cancelled.expiresAt = cancelled.finishedAt + SCHEDULE_RETENTION_MS;
			await saveScheduledJobs(jobs);
			await clearScheduleAlarms(cancelled.id);
			await createScheduleCleanupAlarm(cancelled);
			return {
				success: true,
				cancelled: {
					scheduleId: cancelled.id,
					label: cancelled.label,
					toolName: cancelled.toolName,
					wasScheduledFor: new Date(cancelled.fireTimestamp).toLocaleString(),
					status: cancelled.status,
					expiresAt: new Date(cancelled.expiresAt).toLocaleString()
				}
			};
		}
		async function finalizeScheduledJob(scheduleId, updater) {
			const jobs = await pruneExpiredScheduledJobs();
			const index = jobs.findIndex((job) => job.id === scheduleId);
			if (index < 0) return null;
			const job = jobs[index];
			updater(job);
			await saveScheduledJobs(jobs);
			return job;
		}
		async function runScheduledJob(scheduleId) {
			const jobs = await pruneExpiredScheduledJobs();
			const index = jobs.findIndex((job) => job.id === scheduleId);
			if (index < 0) return;
			const job = jobs[index];
			if (job.status !== "pending") return;
			job.status = "running";
			job.startedAt = Date.now();
			job.error = null;
			await saveScheduledJobs(jobs);
			await chrome.alarms?.clear(buildScheduleFireAlarmName(scheduleId));
			let nextStatus = "succeeded";
			let errorText = null;
			try {
				const result = await executeToolWithTimeout(job.toolName, job.toolArgs, job.mcpRegistry || [], job.executeTimeoutMs);
				if (result && typeof result === "object" && !Array.isArray(result) && result.error) {
					nextStatus = "failed";
					errorText = String(result.error);
				}
			} catch (error) {
				nextStatus = "failed";
				errorText = error?.message || String(error);
			}
			const finishedAt = Date.now();
			const updatedJob = await finalizeScheduledJob(scheduleId, (current) => {
				current.status = nextStatus;
				current.finishedAt = finishedAt;
				current.error = errorText;
				current.expiresAt = finishedAt + SCHEDULE_RETENTION_MS;
			});
			if (updatedJob) await createScheduleCleanupAlarm(updatedJob);
		}
		async function cleanupScheduledJob(scheduleId) {
			const jobs = await loadScheduledJobs();
			const kept = jobs.filter((job) => job.id !== scheduleId);
			if (kept.length === jobs.length) return;
			await saveScheduledJobs(kept);
			await clearScheduleAlarms(scheduleId);
		}
		async function restoreScheduledJobs() {
			const jobs = await pruneExpiredScheduledJobs();
			let changed = false;
			for (const job of jobs) if (job.status === "running") {
				job.status = "failed";
				job.finishedAt = Date.now();
				job.error = job.error || "Background worker restarted before the scheduled job completed";
				job.expiresAt = job.finishedAt + SCHEDULE_RETENTION_MS;
				changed = true;
			}
			if (changed) await saveScheduledJobs(jobs);
			for (const job of jobs) if (job.status === "pending") if (job.fireTimestamp <= Date.now()) await runScheduledJob(job.id);
			else await createScheduleFireAlarm(job);
			else if (isTerminalScheduleStatus(job.status) && Number.isFinite(job.expiresAt)) await createScheduleCleanupAlarm(job);
		}
		function clearPendingReusePrompt(tabId) {
			const pending = pendingReusePrompts.get(tabId);
			if (!pending) return null;
			clearTimeout(pending.timeoutId);
			pendingReusePrompts.delete(tabId);
			return pending;
		}
		async function closeTabIfExists(tabId) {
			if (!tabId) return;
			try {
				await chrome.tabs.remove(tabId);
			} catch (_error) {}
		}
		async function getTabIfExists(tabId) {
			if (!tabId) return null;
			try {
				return await chrome.tabs.get(tabId);
			} catch (_error) {
				return null;
			}
		}
		async function focusTabIfExists(tabId) {
			const tab = await getTabIfExists(tabId);
			if (!tab?.id || !tab.windowId) return null;
			await chrome.windows.update(tab.windowId, { focused: true });
			return await chrome.tabs.update(tab.id, { active: true });
		}
		async function tryShowReusePrompt(tabId, payload) {
			return await new Promise((resolve) => {
				chrome.tabs.sendMessage(tabId, payload, (response) => {
					if (chrome.runtime.lastError) {
						resolve({
							success: false,
							error: chrome.runtime.lastError.message
						});
						return;
					}
					if (!response?.success) {
						resolve({
							success: false,
							error: response?.error || "Prompt not acknowledged"
						});
						return;
					}
					resolve({ success: true });
				});
			});
		}
		async function applyReuseDecision(pending, decision, rememberChoice) {
			const normalizedDecision = decision === "keep" ? "keep" : "reuse";
			if (rememberChoice && pending.domainKey) await setReuseDomainPolicy(pending.domainKey, normalizedDecision);
			if (normalizedDecision === "reuse") {
				await focusTabIfExists(pending.existingTabId);
				await closeTabIfExists(pending.newTabId);
				return;
			}
			await focusTabIfExists(pending.newTabId);
		}
		/**
		* Handle messages from the side panel.
		* "tab_extract" sends a message to the target tab's content script
		* to extract page text content. Uses chrome.tabs.sendMessage which
		* communicates with the auto-injected content script (no host_permissions needed).
		*/
		chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
			if (msg?.type === "schedule_manager") {
				(async () => {
					try {
						switch (msg.action) {
							case "schedule":
								sendResponse(await scheduleJob(msg.payload || {}));
								break;
							case "list":
								sendResponse(await listScheduledJobs());
								break;
							case "cancel":
								sendResponse(await cancelScheduledJob(msg.payload?.scheduleId));
								break;
							case "clear_completed":
								sendResponse(await clearCompletedScheduledJobs());
								break;
							default:
								sendResponse({ error: `Unknown schedule action: ${msg.action}` });
								break;
						}
					} catch (error) {
						sendResponse({ error: error?.message || String(error) });
					}
				})();
				return true;
			}
			function forwardToTab(tabId, payload) {
				let responded = false;
				const timerId = setTimeout(() => {
					if (responded) return;
					responded = true;
					sendResponse({
						success: false,
						error: "Timed out waiting for content script response"
					});
				}, 1e4);
				chrome.tabs.sendMessage(tabId, payload, (response) => {
					if (responded) return;
					responded = true;
					clearTimeout(timerId);
					if (chrome.runtime.lastError) sendResponse({
						success: false,
						error: chrome.runtime.lastError.message
					});
					else if (response) sendResponse({
						success: true,
						data: response
					});
					else sendResponse({
						success: false,
						error: "Content script did not respond"
					});
				});
			}
			if (msg.type === "tab_extract" && msg.tabId) {
				forwardToTab(msg.tabId, { type: "tab_extract_content" });
				return true;
			}
			if (msg.type === "tab_scroll" && msg.tabId) {
				forwardToTab(msg.tabId, {
					type: "tab_scroll",
					deltaY: msg.deltaY,
					pageFraction: msg.pageFraction,
					position: msg.position,
					behavior: msg.behavior
				});
				return true;
			}
			if (msg.type === "dom_query" && msg.tabId) {
				forwardToTab(msg.tabId, {
					type: "dom_query",
					selector: msg.selector,
					text: msg.text,
					matchExact: msg.matchExact,
					maxResults: msg.maxResults
				});
				return true;
			}
			if (msg.type === "dom_click" && msg.tabId) {
				forwardToTab(msg.tabId, {
					type: "dom_click",
					selector: msg.selector,
					text: msg.text,
					matchExact: msg.matchExact,
					index: msg.index
				});
				return true;
			}
			if (msg.type === "dom_set_value" && msg.tabId) {
				forwardToTab(msg.tabId, {
					type: "dom_set_value",
					selector: msg.selector,
					text: msg.text,
					matchExact: msg.matchExact,
					index: msg.index,
					value: msg.value
				});
				return true;
			}
			if (msg.type === "dom_style" && msg.tabId) {
				forwardToTab(msg.tabId, {
					type: "dom_style",
					selector: msg.selector,
					text: msg.text,
					matchExact: msg.matchExact,
					index: msg.index,
					styles: msg.styles,
					durationMs: msg.durationMs
				});
				return true;
			}
			if (msg.type === "dom_get_html" && msg.tabId) {
				forwardToTab(msg.tabId, {
					type: "dom_get_html",
					selector: msg.selector,
					text: msg.text,
					matchExact: msg.matchExact,
					index: msg.index,
					mode: msg.mode,
					maxLength: msg.maxLength
				});
				return true;
			}
			if (msg.type === "dom_highlight" && msg.tabId) {
				forwardToTab(msg.tabId, {
					type: "dom_highlight",
					selector: msg.selector,
					text: msg.text,
					matchExact: msg.matchExact,
					index: msg.index,
					durationMs: msg.durationMs
				});
				return true;
			}
			if (msg.type === "tab_reuse_prompt_decision") {
				const pending = clearPendingReusePrompt(msg.newTabId);
				if (!pending) {
					sendResponse({
						success: false,
						error: "Reuse prompt is no longer pending"
					});
					return false;
				}
				applyReuseDecision(pending, msg.decision, !!msg.rememberChoice).then(() => sendResponse({ success: true })).catch((error) => sendResponse({
					success: false,
					error: error?.message || String(error)
				}));
				return true;
			}
			return false;
		});
		chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
		chrome.webNavigation.onDOMContentLoaded.addListener(async (e) => {
			try {
				if (!e?.tabId || e.frameId !== 0) return;
				if (!normalizeReusableUrl(e.url)) return;
				if (pendingReusePrompts.has(e.tabId)) return;
				if (!await isTabReuseEnabled()) return;
				const reusableTab = await findReusableTab(e.url, { excludeTabId: e.tabId });
				if (!reusableTab) return;
				const domainKey = getReuseDomainKey(e.url);
				const rememberedPolicy = await getReuseDomainPolicy(domainKey);
				if (rememberedPolicy === "keep") return;
				if (rememberedPolicy === "reuse") {
					await focusReusableTab(reusableTab);
					await closeTabIfExists(e.tabId);
					return;
				}
				const newTab = await getTabIfExists(e.tabId);
				const focusedReusableTab = await focusReusableTab(reusableTab);
				if (!(await tryShowReusePrompt(focusedReusableTab.id, {
					type: "show_tab_reuse_prompt",
					newTabId: e.tabId,
					existingTabId: focusedReusableTab.id,
					domainKey,
					newUrl: e.url,
					newTitle: newTab?.title || e.url,
					existingUrl: focusedReusableTab.url || e.url,
					existingTitle: focusedReusableTab.title || focusedReusableTab.url || e.url
				})).success) {
					await closeTabIfExists(e.tabId);
					return;
				}
				const timeoutId = setTimeout(() => {
					clearPendingReusePrompt(e.tabId);
				}, REUSE_PROMPT_TIMEOUT_MS);
				pendingReusePrompts.set(e.tabId, {
					newTabId: e.tabId,
					existingTabId: focusedReusableTab.id,
					domainKey,
					timeoutId
				});
			} catch (error) {
				console.warn("Tab reuse failed:", error);
			}
		});
		chrome.webNavigation.onCompleted.addListener(async (e) => {
			if (e.tabId && e.url && e.url.startsWith("http") && e.frameId === 0) try {
				await chrome.runtime.sendMessage({
					type: "open",
					tabId: e.tabId
				});
			} catch (e) {}
		});
		chrome.tabs.onRemoved.addListener(async function(tabId) {
			clearPendingReusePrompt(tabId);
			for (const [pendingTabId, pending] of pendingReusePrompts.entries()) if (pending.existingTabId === tabId) clearPendingReusePrompt(pendingTabId);
			try {
				await chrome.runtime.sendMessage({
					type: "close",
					tabId
				});
			} catch (e) {}
		});
		chrome.tabs.onActivated.addListener(async function(activeInfo) {
			try {
				await chrome.runtime.sendMessage({
					type: "active",
					tabId: activeInfo.tabId
				});
			} catch (e) {}
			let { tabActivity } = await chrome.storage.local.get({ tabActivity: {} });
			tabActivity[activeInfo.tabId] = Date.now();
			await chrome.storage.local.set({ tabActivity });
		});
		chrome.runtime.onInstalled.addListener(() => {
			chrome.alarms?.create("check-idle-tabs", { periodInMinutes: 1 });
			restoreScheduledJobs();
		});
		chrome.runtime.onStartup.addListener(() => {
			restoreScheduledJobs();
		});
		restoreScheduledJobs();
		if (chrome.alarms) {
			chrome.alarms.get("check-idle-tabs", (alarm) => {
				if (!alarm) chrome.alarms.create("check-idle-tabs", { periodInMinutes: 1 });
			});
			chrome.alarms.onAlarm.addListener(async (alarm) => {
				if (alarm.name.startsWith(SCHEDULE_FIRE_ALARM_PREFIX)) {
					await runScheduledJob(alarm.name.slice(14));
					return;
				}
				if (alarm.name.startsWith(SCHEDULE_CLEANUP_ALARM_PREFIX)) {
					await cleanupScheduledJob(alarm.name.slice(17));
					return;
				}
				if (alarm.name !== "check-idle-tabs") return;
				let { suspendTimeout, tabActivity } = await chrome.storage.local.get({
					suspendTimeout: 0,
					tabActivity: {}
				});
				if (!suspendTimeout || suspendTimeout <= 0) return;
				const now = Date.now();
				const timeoutMs = suspendTimeout * 60 * 1e3;
				const tabs = await chrome.tabs.query({});
				for (const tab of tabs) {
					if (tab.active || tab.pinned || tab.discarded || !tab.url || !tab.url.startsWith("http")) continue;
					const lastActive = tabActivity[tab.id] || 0;
					if (lastActive > 0 && now - lastActive > timeoutMs) try {
						await chrome.tabs.discard(tab.id);
					} catch (e) {}
				}
			});
		}
	});
	//#endregion
	//#region node_modules/wxt/dist/browser.mjs
	/**
	* Contains the `browser` export which you should use to access the extension
	* APIs in your project:
	*
	* ```ts
	* import { browser } from 'wxt/browser';
	*
	* browser.runtime.onInstalled.addListener(() => {
	*   // ...
	* });
	* ```
	*
	* @module wxt/browser
	*/
	var browser = globalThis.browser?.runtime?.id ? globalThis.browser : globalThis.chrome;
	//#endregion
	//#region node_modules/@webext-core/match-patterns/lib/index.js
	var _MatchPattern = class {
		constructor(matchPattern) {
			if (matchPattern === "<all_urls>") {
				this.isAllUrls = true;
				this.protocolMatches = [..._MatchPattern.PROTOCOLS];
				this.hostnameMatch = "*";
				this.pathnameMatch = "*";
			} else {
				const groups = /(.*):\/\/(.*?)(\/.*)/.exec(matchPattern);
				if (groups == null) throw new InvalidMatchPattern(matchPattern, "Incorrect format");
				const [_, protocol, hostname, pathname] = groups;
				validateProtocol(matchPattern, protocol);
				validateHostname(matchPattern, hostname);
				validatePathname(matchPattern, pathname);
				this.protocolMatches = protocol === "*" ? ["http", "https"] : [protocol];
				this.hostnameMatch = hostname;
				this.pathnameMatch = pathname;
			}
		}
		includes(url) {
			if (this.isAllUrls) return true;
			const u = typeof url === "string" ? new URL(url) : url instanceof Location ? new URL(url.href) : url;
			return !!this.protocolMatches.find((protocol) => {
				if (protocol === "http") return this.isHttpMatch(u);
				if (protocol === "https") return this.isHttpsMatch(u);
				if (protocol === "file") return this.isFileMatch(u);
				if (protocol === "ftp") return this.isFtpMatch(u);
				if (protocol === "urn") return this.isUrnMatch(u);
			});
		}
		isHttpMatch(url) {
			return url.protocol === "http:" && this.isHostPathMatch(url);
		}
		isHttpsMatch(url) {
			return url.protocol === "https:" && this.isHostPathMatch(url);
		}
		isHostPathMatch(url) {
			if (!this.hostnameMatch || !this.pathnameMatch) return false;
			const hostnameMatchRegexs = [this.convertPatternToRegex(this.hostnameMatch), this.convertPatternToRegex(this.hostnameMatch.replace(/^\*\./, ""))];
			const pathnameMatchRegex = this.convertPatternToRegex(this.pathnameMatch);
			return !!hostnameMatchRegexs.find((regex) => regex.test(url.hostname)) && pathnameMatchRegex.test(url.pathname);
		}
		isFileMatch(url) {
			throw Error("Not implemented: file:// pattern matching. Open a PR to add support");
		}
		isFtpMatch(url) {
			throw Error("Not implemented: ftp:// pattern matching. Open a PR to add support");
		}
		isUrnMatch(url) {
			throw Error("Not implemented: urn:// pattern matching. Open a PR to add support");
		}
		convertPatternToRegex(pattern) {
			const starsReplaced = this.escapeForRegex(pattern).replace(/\\\*/g, ".*");
			return RegExp(`^${starsReplaced}$`);
		}
		escapeForRegex(string) {
			return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		}
	};
	var MatchPattern = _MatchPattern;
	MatchPattern.PROTOCOLS = [
		"http",
		"https",
		"file",
		"ftp",
		"urn"
	];
	var InvalidMatchPattern = class extends Error {
		constructor(matchPattern, reason) {
			super(`Invalid match pattern "${matchPattern}": ${reason}`);
		}
	};
	function validateProtocol(matchPattern, protocol) {
		if (!MatchPattern.PROTOCOLS.includes(protocol) && protocol !== "*") throw new InvalidMatchPattern(matchPattern, `${protocol} not a valid protocol (${MatchPattern.PROTOCOLS.join(", ")})`);
	}
	function validateHostname(matchPattern, hostname) {
		if (hostname.includes(":")) throw new InvalidMatchPattern(matchPattern, `Hostname cannot include a port`);
		if (hostname.includes("*") && hostname.length > 1 && !hostname.startsWith("*.")) throw new InvalidMatchPattern(matchPattern, `If using a wildcard (*), it must go at the start of the hostname`);
	}
	function validatePathname(matchPattern, pathname) {}
	//#endregion
	//#region \0virtual:wxt-background-entrypoint?/home/0668001277/Projects/github/browser-manager/entrypoints/background/index.ts
	function print(method, ...args) {
		if (typeof args[0] === "string") method(`[wxt] ${args.shift()}`, ...args);
		else method("[wxt]", ...args);
	}
	/** Wrapper around `console` with a "[wxt]" prefix */
	var logger = {
		debug: (...args) => print(console.debug, ...args),
		log: (...args) => print(console.log, ...args),
		warn: (...args) => print(console.warn, ...args),
		error: (...args) => print(console.error, ...args)
	};
	var ws;
	/** Connect to the websocket and listen for messages. */
	function getDevServerWebSocket() {
		if (ws == null) {
			const serverUrl = "ws://localhost:3000";
			logger.debug("Connecting to dev server @", serverUrl);
			ws = new WebSocket(serverUrl, "vite-hmr");
			ws.addWxtEventListener = ws.addEventListener.bind(ws);
			ws.sendCustom = (event, payload) => ws?.send(JSON.stringify({
				type: "custom",
				event,
				payload
			}));
			ws.addEventListener("open", () => {
				logger.debug("Connected to dev server");
			});
			ws.addEventListener("close", () => {
				logger.debug("Disconnected from dev server");
			});
			ws.addEventListener("error", (event) => {
				logger.error("Failed to connect to dev server", event);
			});
			ws.addEventListener("message", (e) => {
				try {
					const message = JSON.parse(e.data);
					if (message.type === "custom") ws?.dispatchEvent(new CustomEvent(message.event, { detail: message.data }));
				} catch (err) {
					logger.error("Failed to handle message", err);
				}
			});
		}
		return ws;
	}
	/** https://developer.chrome.com/blog/longer-esw-lifetimes/ */
	function keepServiceWorkerAlive() {
		setInterval(async () => {
			await browser.runtime.getPlatformInfo();
		}, 5e3);
	}
	function reloadContentScript(payload) {
		if (browser.runtime.getManifest().manifest_version == 2) reloadContentScriptMv2(payload);
		else reloadContentScriptMv3(payload);
	}
	async function reloadContentScriptMv3({ registration, contentScript }) {
		if (registration === "runtime") await reloadRuntimeContentScriptMv3(contentScript);
		else await reloadManifestContentScriptMv3(contentScript);
	}
	async function reloadManifestContentScriptMv3(contentScript) {
		const id = `wxt:${contentScript.js[0]}`;
		logger.log("Reloading content script:", contentScript);
		const registered = await browser.scripting.getRegisteredContentScripts();
		logger.debug("Existing scripts:", registered);
		const existing = registered.find((cs) => cs.id === id);
		if (existing) {
			logger.debug("Updating content script", existing);
			await browser.scripting.updateContentScripts([{
				...contentScript,
				id,
				css: contentScript.css ?? []
			}]);
		} else {
			logger.debug("Registering new content script...");
			await browser.scripting.registerContentScripts([{
				...contentScript,
				id,
				css: contentScript.css ?? []
			}]);
		}
		await reloadTabsForContentScript(contentScript);
	}
	async function reloadRuntimeContentScriptMv3(contentScript) {
		logger.log("Reloading content script:", contentScript);
		const registered = await browser.scripting.getRegisteredContentScripts();
		logger.debug("Existing scripts:", registered);
		const matches = registered.filter((cs) => {
			const hasJs = contentScript.js?.find((js) => cs.js?.includes(js));
			const hasCss = contentScript.css?.find((css) => cs.css?.includes(css));
			return hasJs || hasCss;
		});
		if (matches.length === 0) {
			logger.log("Content script is not registered yet, nothing to reload", contentScript);
			return;
		}
		await browser.scripting.updateContentScripts(matches);
		await reloadTabsForContentScript(contentScript);
	}
	async function reloadTabsForContentScript(contentScript) {
		const allTabs = await browser.tabs.query({});
		const matchPatterns = contentScript.matches.map((match) => new MatchPattern(match));
		const matchingTabs = allTabs.filter((tab) => {
			const url = tab.url;
			if (!url) return false;
			return !!matchPatterns.find((pattern) => pattern.includes(url));
		});
		await Promise.all(matchingTabs.map(async (tab) => {
			try {
				await browser.tabs.reload(tab.id);
			} catch (err) {
				logger.warn("Failed to reload tab:", err);
			}
		}));
	}
	async function reloadContentScriptMv2(_payload) {
		throw Error("TODO: reloadContentScriptMv2");
	}
	try {
		const ws = getDevServerWebSocket();
		ws.addWxtEventListener("wxt:reload-extension", () => {
			browser.runtime.reload();
		});
		ws.addWxtEventListener("wxt:reload-content-script", (event) => {
			reloadContentScript(event.detail);
		});
		ws.addEventListener("open", () => ws.sendCustom("wxt:background-initialized"));
		keepServiceWorkerAlive();
	} catch (err) {
		logger.error("Failed to setup web socket connection with dev server", err);
	}
	browser.commands.onCommand.addListener((command) => {
		if (command === "wxt:reload-extension") browser.runtime.reload();
	});
	var result;
	try {
		result = background_default.main();
		if (result instanceof Promise) console.warn("The background's main() function return a promise, but it must be synchronous");
	} catch (err) {
		logger.error("The background crashed on startup!");
		throw err;
	}
	//#endregion
	return result;
})();

//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYmFja2dyb3VuZC5qcyIsIm5hbWVzIjpbImJyb3dzZXIiXSwic291cmNlcyI6WyIuLi8uLi9ub2RlX21vZHVsZXMvd3h0L2Rpc3QvdXRpbHMvZGVmaW5lLWJhY2tncm91bmQubWpzIiwiLi4vLi4vbGliL2FwaS90YWJSZXVzZS50cyIsIi4uLy4uL2xpYi9hcGkvbWNwLnRzIiwiLi4vLi4vbGliL2FwaS9sbG0udHMiLCIuLi8uLi9lbnRyeXBvaW50cy9iYWNrZ3JvdW5kL2luZGV4LnRzIiwiLi4vLi4vbm9kZV9tb2R1bGVzL0B3eHQtZGV2L2Jyb3dzZXIvc3JjL2luZGV4Lm1qcyIsIi4uLy4uL25vZGVfbW9kdWxlcy93eHQvZGlzdC9icm93c2VyLm1qcyIsIi4uLy4uL25vZGVfbW9kdWxlcy9Ad2ViZXh0LWNvcmUvbWF0Y2gtcGF0dGVybnMvbGliL2luZGV4LmpzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vI3JlZ2lvbiBzcmMvdXRpbHMvZGVmaW5lLWJhY2tncm91bmQudHNcbmZ1bmN0aW9uIGRlZmluZUJhY2tncm91bmQoYXJnKSB7XG5cdGlmIChhcmcgPT0gbnVsbCB8fCB0eXBlb2YgYXJnID09PSBcImZ1bmN0aW9uXCIpIHJldHVybiB7IG1haW46IGFyZyB9O1xuXHRyZXR1cm4gYXJnO1xufVxuLy8jZW5kcmVnaW9uXG5leHBvcnQgeyBkZWZpbmVCYWNrZ3JvdW5kIH07XG4iLCJjb25zdCBSRVVTRV9ET01BSU5fUE9MSUNJRVNfS0VZID0gXCJyZXVzZURvbWFpblBvbGljaWVzXCI7XG5cbmV4cG9ydCB0eXBlIFJldXNlRG9tYWluRGVjaXNpb24gPSBcInJldXNlXCIgfCBcImtlZXBcIjtcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGlzVGFiUmV1c2VFbmFibGVkKCk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBjb25zdCB7IHJldXNlIH0gPSBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoeyByZXVzZTogZmFsc2UgfSk7XG4gIHJldHVybiAhIXJldXNlO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0UmV1c2VEb21haW5LZXkodXJsOiBzdHJpbmcgfCB1bmRlZmluZWQpOiBzdHJpbmcge1xuICBjb25zdCBub3JtYWxpemVkVXJsID0gbm9ybWFsaXplUmV1c2FibGVVcmwodXJsKTtcbiAgaWYgKCFub3JtYWxpemVkVXJsKSByZXR1cm4gXCJcIjtcblxuICB0cnkge1xuICAgIHJldHVybiBuZXcgVVJMKG5vcm1hbGl6ZWRVcmwpLmhvc3RuYW1lIHx8IFwiXCI7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBcIlwiO1xuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBub3JtYWxpemVSZXVzYWJsZVVybCh1cmw6IHN0cmluZyB8IHVuZGVmaW5lZCk6IHN0cmluZyB7XG4gIGNvbnN0IHJhdyA9IFN0cmluZyh1cmwgfHwgXCJcIikudHJpbSgpO1xuICBpZiAoIS9eaHR0cHM/OlxcL1xcLy9pLnRlc3QocmF3KSkgcmV0dXJuIFwiXCI7XG5cbiAgdHJ5IHtcbiAgICBjb25zdCBwYXJzZWQgPSBuZXcgVVJMKHJhdyk7XG4gICAgcGFyc2VkLmhhc2ggPSBcIlwiO1xuICAgIHJldHVybiBwYXJzZWQudG9TdHJpbmcoKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIHJhdy5zcGxpdChcIiNcIilbMF07XG4gIH1cbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGZpbmRSZXVzYWJsZVRhYihcbiAgdXJsOiBzdHJpbmcsXG4gIG9wdHM6IHsgZXhjbHVkZVRhYklkPzogbnVtYmVyIH0gPSB7fVxuKTogUHJvbWlzZTxjaHJvbWUudGFicy5UYWIgfCBudWxsPiB7XG4gIGNvbnN0IG5vcm1hbGl6ZWRVcmwgPSBub3JtYWxpemVSZXVzYWJsZVVybCh1cmwpO1xuICBpZiAoIW5vcm1hbGl6ZWRVcmwpIHJldHVybiBudWxsO1xuXG4gIGNvbnN0IHRhYnMgPSBhd2FpdCBjaHJvbWUudGFicy5xdWVyeSh7fSk7XG4gIGNvbnN0IGZvdW5kID1cbiAgICB0YWJzLmZpbmQoKHRhYikgPT4ge1xuICAgICAgaWYgKCF0YWI/LmlkIHx8IHRhYi5pZCA9PT0gb3B0cy5leGNsdWRlVGFiSWQpIHJldHVybiBmYWxzZTtcbiAgICAgIGNvbnN0IGNhbmRpZGF0ZVVybCA9IG5vcm1hbGl6ZVJldXNhYmxlVXJsKHRhYi5wZW5kaW5nVXJsIHx8IHRhYi51cmwpO1xuICAgICAgcmV0dXJuIGNhbmRpZGF0ZVVybCA9PT0gbm9ybWFsaXplZFVybDtcbiAgICB9KSB8fCBudWxsO1xuICByZXR1cm4gZm91bmQ7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXRSZXVzZURvbWFpblBvbGljaWVzKCk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgc3RyaW5nPj4ge1xuICBjb25zdCB7IFtSRVVTRV9ET01BSU5fUE9MSUNJRVNfS0VZXTogcmV1c2VEb21haW5Qb2xpY2llcyB9ID0gYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KHtcbiAgICBbUkVVU0VfRE9NQUlOX1BPTElDSUVTX0tFWV06IHt9IGFzIFJlY29yZDxzdHJpbmcsIHN0cmluZz4sXG4gIH0pO1xuICByZXR1cm4gcmV1c2VEb21haW5Qb2xpY2llcyAmJiB0eXBlb2YgcmV1c2VEb21haW5Qb2xpY2llcyA9PT0gXCJvYmplY3RcIiA/IHJldXNlRG9tYWluUG9saWNpZXMgOiB7fTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldFJldXNlRG9tYWluUG9saWN5KGRvbWFpbktleTogc3RyaW5nKTogUHJvbWlzZTxSZXVzZURvbWFpbkRlY2lzaW9uIHwgXCJcIj4ge1xuICBpZiAoIWRvbWFpbktleSkgcmV0dXJuIFwiXCI7XG4gIGNvbnN0IHBvbGljaWVzID0gYXdhaXQgZ2V0UmV1c2VEb21haW5Qb2xpY2llcygpO1xuICBjb25zdCB2YWx1ZSA9IHBvbGljaWVzW2RvbWFpbktleV07XG4gIHJldHVybiB2YWx1ZSA9PT0gXCJyZXVzZVwiIHx8IHZhbHVlID09PSBcImtlZXBcIiA/IHZhbHVlIDogXCJcIjtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHNldFJldXNlRG9tYWluUG9saWN5KGRvbWFpbktleTogc3RyaW5nLCBkZWNpc2lvbjogUmV1c2VEb21haW5EZWNpc2lvbiB8IFwiXCIpOiBQcm9taXNlPHZvaWQ+IHtcbiAgaWYgKCFkb21haW5LZXkpIHJldHVybjtcbiAgY29uc3QgcG9saWNpZXMgPSBhd2FpdCBnZXRSZXVzZURvbWFpblBvbGljaWVzKCk7XG5cbiAgaWYgKGRlY2lzaW9uID09PSBcInJldXNlXCIgfHwgZGVjaXNpb24gPT09IFwia2VlcFwiKSB7XG4gICAgcG9saWNpZXNbZG9tYWluS2V5XSA9IGRlY2lzaW9uO1xuICB9IGVsc2Uge1xuICAgIGRlbGV0ZSBwb2xpY2llc1tkb21haW5LZXldO1xuICB9XG5cbiAgYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHsgW1JFVVNFX0RPTUFJTl9QT0xJQ0lFU19LRVldOiBwb2xpY2llcyB9KTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNsZWFyUmV1c2VEb21haW5Qb2xpY2llcygpOiBQcm9taXNlPHZvaWQ+IHtcbiAgYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHsgW1JFVVNFX0RPTUFJTl9QT0xJQ0lFU19LRVldOiB7fSB9KTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGZvY3VzUmV1c2FibGVUYWIodGFiOiBjaHJvbWUudGFicy5UYWIpOiBQcm9taXNlPGNocm9tZS50YWJzLlRhYiB8IG51bGw+IHtcbiAgaWYgKCF0YWI/LmlkKSByZXR1cm4gbnVsbDtcblxuICBhd2FpdCBjaHJvbWUud2luZG93cy51cGRhdGUodGFiLndpbmRvd0lkLCB7IGZvY3VzZWQ6IHRydWUgfSk7XG4gIGNvbnN0IG5leHRUYWIgPSBhd2FpdCBjaHJvbWUudGFicy51cGRhdGUodGFiLmlkLCB7IGFjdGl2ZTogdHJ1ZSB9KTtcbiAgaWYgKCFuZXh0VGFiPy53aW5kb3dJZCkgcmV0dXJuIG5leHRUYWIgPz8gbnVsbDtcbiAgYXdhaXQgY2hyb21lLndpbmRvd3MudXBkYXRlKG5leHRUYWIud2luZG93SWQsIHsgZm9jdXNlZDogdHJ1ZSB9KTtcbiAgcmV0dXJuIG5leHRUYWI7XG59XG4iLCJsZXQgX3JwY0lkID0gMDtcbmNvbnN0IERFRkFVTFRfTUNQX1RPT0xfVElNRU9VVF9NUyA9IDYwMDAwO1xuXG50eXBlIE1jcEhlYWRlcnMgPSBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuXG5pbnRlcmZhY2UgSnNvblJwY1JlcXVlc3RCb2R5IHtcbiAganNvbnJwYzogXCIyLjBcIjtcbiAgbWV0aG9kOiBzdHJpbmc7XG4gIGlkOiBudW1iZXI7XG4gIHBhcmFtcz86IHVua25vd247XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJwY0NhbGwoXG4gIHVybDogc3RyaW5nLFxuICBoZWFkZXJzOiBNY3BIZWFkZXJzLFxuICBtZXRob2Q6IHN0cmluZyxcbiAgcGFyYW1zPzogdW5rbm93bixcbiAgdGltZW91dE1zPzogbnVtYmVyXG4pOiBQcm9taXNlPHVua25vd24+IHtcbiAgY29uc3QgaWQgPSArK19ycGNJZDtcbiAgY29uc3QgYm9keTogSnNvblJwY1JlcXVlc3RCb2R5ID0ge1xuICAgIGpzb25ycGM6IFwiMi4wXCIsXG4gICAgbWV0aG9kLFxuICAgIGlkLFxuICAgIC4uLihwYXJhbXMgIT09IHVuZGVmaW5lZCA/IHsgcGFyYW1zIH0gOiB7fSksXG4gIH07XG5cbiAgY29uc3QgY29udHJvbGxlciA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgY29uc3QgZWZmZWN0aXZlVGltZW91dE1zID0gTnVtYmVyLmlzRmluaXRlKHRpbWVvdXRNcykgJiYgKHRpbWVvdXRNcyBhcyBudW1iZXIpID4gMCA/ICh0aW1lb3V0TXMgYXMgbnVtYmVyKSA6IDA7XG4gIGxldCB0aW1lcklkOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGwgPSBudWxsO1xuICBpZiAoZWZmZWN0aXZlVGltZW91dE1zID4gMCkge1xuICAgIHRpbWVySWQgPSBzZXRUaW1lb3V0KCgpID0+IGNvbnRyb2xsZXIuYWJvcnQoKSwgZWZmZWN0aXZlVGltZW91dE1zKTtcbiAgfVxuXG4gIGxldCByZXM6IFJlc3BvbnNlO1xuICB0cnkge1xuICAgIHJlcyA9IGF3YWl0IGZldGNoKHVybCwge1xuICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIsXG4gICAgICAgIEFjY2VwdDogXCJhcHBsaWNhdGlvbi9qc29uLCB0ZXh0L2V2ZW50LXN0cmVhbVwiLFxuICAgICAgICAuLi5oZWFkZXJzLFxuICAgICAgfSxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpLFxuICAgICAgc2lnbmFsOiBjb250cm9sbGVyLnNpZ25hbCxcbiAgICB9KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGlmICh0aW1lcklkKSBjbGVhclRpbWVvdXQodGltZXJJZCk7XG4gICAgY29uc3QgZXJyID0gZSBhcyB7IG5hbWU/OiBzdHJpbmcgfTtcbiAgICBpZiAoZXJyLm5hbWUgPT09IFwiQWJvcnRFcnJvclwiKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYE1DUCByZXF1ZXN0IHRpbWVkIG91dCBhZnRlciAke2VmZmVjdGl2ZVRpbWVvdXRNc31tc2ApO1xuICAgIH1cbiAgICB0aHJvdyBlO1xuICB9XG5cbiAgaWYgKHRpbWVySWQpIGNsZWFyVGltZW91dCh0aW1lcklkKTtcblxuICBpZiAoIXJlcy5vaykge1xuICAgIGNvbnN0IGVyclRleHQgPSBhd2FpdCByZXMudGV4dCgpO1xuICAgIHRocm93IG5ldyBFcnJvcihgTUNQIGVycm9yICR7cmVzLnN0YXR1c306ICR7ZXJyVGV4dH1gKTtcbiAgfVxuXG4gIGNvbnN0IGNvbnRlbnRUeXBlID0gcmVzLmhlYWRlcnMuZ2V0KFwiY29udGVudC10eXBlXCIpIHx8IFwiXCI7XG5cbiAgaWYgKGNvbnRlbnRUeXBlLmluY2x1ZGVzKFwidGV4dC9ldmVudC1zdHJlYW1cIikpIHtcbiAgICByZXR1cm4gX3BhcnNlU1NFUmVzcG9uc2UocmVzKTtcbiAgfVxuXG4gIGNvbnN0IGpzb24gPSAoYXdhaXQgcmVzLmpzb24oKSkgYXMgeyBlcnJvcj86IHsgbWVzc2FnZT86IHN0cmluZyB9OyByZXN1bHQ/OiB1bmtub3duIH07XG4gIGlmIChqc29uLmVycm9yKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBNQ1AgUlBDIGVycm9yOiAke2pzb24uZXJyb3IubWVzc2FnZSB8fCBKU09OLnN0cmluZ2lmeShqc29uLmVycm9yKX1gKTtcbiAgfVxuICByZXR1cm4ganNvbi5yZXN1bHQ7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIF9wYXJzZVNTRVJlc3BvbnNlKHJlczogUmVzcG9uc2UpOiBQcm9taXNlPHVua25vd24+IHtcbiAgY29uc3QgcmVhZGVyID0gcmVzLmJvZHk/LmdldFJlYWRlcigpO1xuICBpZiAoIXJlYWRlcikgdGhyb3cgbmV3IEVycm9yKFwiTUNQIFNTRTogbm8gYm9keVwiKTtcblxuICBjb25zdCBkZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKCk7XG4gIGxldCBidWZmZXIgPSBcIlwiO1xuICBsZXQgbGFzdFJlc3VsdDogdW5rbm93biA9IG51bGw7XG5cbiAgd2hpbGUgKHRydWUpIHtcbiAgICBjb25zdCB7IGRvbmUsIHZhbHVlIH0gPSBhd2FpdCByZWFkZXIucmVhZCgpO1xuICAgIGlmIChkb25lKSBicmVhaztcbiAgICBidWZmZXIgKz0gZGVjb2Rlci5kZWNvZGUodmFsdWUsIHsgc3RyZWFtOiB0cnVlIH0pO1xuXG4gICAgY29uc3QgbGluZXMgPSBidWZmZXIuc3BsaXQoXCJcXG5cIik7XG4gICAgYnVmZmVyID0gbGluZXMucG9wKCkgPz8gXCJcIjtcblxuICAgIGZvciAoY29uc3QgbGluZSBvZiBsaW5lcykge1xuICAgICAgY29uc3QgdHJpbW1lZCA9IGxpbmUudHJpbSgpO1xuICAgICAgaWYgKHRyaW1tZWQuc3RhcnRzV2l0aChcImRhdGE6IFwiKSkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IGpzb24gPSBKU09OLnBhcnNlKHRyaW1tZWQuc2xpY2UoNikpIGFzIHsgcmVzdWx0PzogdW5rbm93bjsgZXJyb3I/OiB7IG1lc3NhZ2U/OiBzdHJpbmcgfSB9O1xuICAgICAgICAgIGlmIChqc29uLnJlc3VsdCAhPT0gdW5kZWZpbmVkKSBsYXN0UmVzdWx0ID0ganNvbi5yZXN1bHQ7XG4gICAgICAgICAgaWYgKGpzb24uZXJyb3IpIHRocm93IG5ldyBFcnJvcihgTUNQIFJQQyBlcnJvcjogJHtqc29uLmVycm9yLm1lc3NhZ2UgfHwgSlNPTi5zdHJpbmdpZnkoanNvbi5lcnJvcil9YCk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICBjb25zdCBtc2cgPSBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSk7XG4gICAgICAgICAgaWYgKG1zZy5zdGFydHNXaXRoKFwiTUNQIFJQQyBlcnJvclwiKSkgdGhyb3cgZTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGlmIChsYXN0UmVzdWx0ID09PSBudWxsKSB0aHJvdyBuZXcgRXJyb3IoXCJNQ1AgU1NFIHJlc3BvbnNlIGNvbnRhaW5lZCBubyByZXN1bHRcIik7XG4gIHJldHVybiBsYXN0UmVzdWx0O1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaW5pdGlhbGl6ZU1jcChcbiAgdXJsOiBzdHJpbmcsXG4gIGhlYWRlcnM6IE1jcEhlYWRlcnMgPSB7fVxuKTogUHJvbWlzZTx7IHNlcnZlckluZm8/OiB7IG5hbWU/OiBzdHJpbmcgfTsgY2FwYWJpbGl0aWVzPzogdW5rbm93biB9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IChhd2FpdCBycGNDYWxsKHVybCwgaGVhZGVycywgXCJpbml0aWFsaXplXCIsIHtcbiAgICBwcm90b2NvbFZlcnNpb246IFwiMjAyNS0wMy0yNlwiLFxuICAgIGNhcGFiaWxpdGllczoge30sXG4gICAgY2xpZW50SW5mbzoge1xuICAgICAgbmFtZTogXCJUYWJNYW5hZ2VyXCIsXG4gICAgICB2ZXJzaW9uOiBcIjEuMFwiLFxuICAgIH0sXG4gIH0pKSBhcyB7IHNlcnZlckluZm8/OiB7IG5hbWU/OiBzdHJpbmcgfTsgY2FwYWJpbGl0aWVzPzogdW5rbm93biB9O1xuICByZXR1cm4gcmVzdWx0O1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbGlzdE1jcFRvb2xzKFxuICB1cmw6IHN0cmluZyxcbiAgaGVhZGVyczogTWNwSGVhZGVycyA9IHt9XG4pOiBQcm9taXNlPEFycmF5PHsgbmFtZTogc3RyaW5nOyBkZXNjcmlwdGlvbj86IHN0cmluZzsgaW5wdXRTY2hlbWE/OiB1bmtub3duIH0+PiB7XG4gIGNvbnN0IHJlc3VsdCA9IChhd2FpdCBycGNDYWxsKHVybCwgaGVhZGVycywgXCJ0b29scy9saXN0XCIpKSBhcyB7IHRvb2xzPzogQXJyYXk8eyBuYW1lOiBzdHJpbmc7IGRlc2NyaXB0aW9uPzogc3RyaW5nOyBpbnB1dFNjaGVtYT86IHVua25vd24gfT4gfTtcbiAgcmV0dXJuIHJlc3VsdC50b29scyB8fCBbXTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGxpc3RNY3BSZXNvdXJjZXMoXG4gIHVybDogc3RyaW5nLFxuICBoZWFkZXJzOiBNY3BIZWFkZXJzID0ge31cbik6IFByb21pc2U8QXJyYXk8eyBuYW1lPzogc3RyaW5nOyB1cmk6IHN0cmluZzsgZGVzY3JpcHRpb24/OiBzdHJpbmc7IG1pbWVUeXBlPzogc3RyaW5nIH0+PiB7XG4gIGNvbnN0IHJlc3VsdCA9IChhd2FpdCBycGNDYWxsKHVybCwgaGVhZGVycywgXCJyZXNvdXJjZXMvbGlzdFwiKSkgYXMge1xuICAgIHJlc291cmNlcz86IEFycmF5PHsgbmFtZT86IHN0cmluZzsgdXJpOiBzdHJpbmc7IGRlc2NyaXB0aW9uPzogc3RyaW5nOyBtaW1lVHlwZT86IHN0cmluZyB9PjtcbiAgfTtcbiAgcmV0dXJuIHJlc3VsdC5yZXNvdXJjZXMgfHwgW107XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWFkTWNwUmVzb3VyY2UodXJsOiBzdHJpbmcsIGhlYWRlcnM6IE1jcEhlYWRlcnMgPSB7fSwgdXJpOiBzdHJpbmcpOiBQcm9taXNlPHVua25vd24+IHtcbiAgcmV0dXJuIGF3YWl0IHJwY0NhbGwodXJsLCBoZWFkZXJzLCBcInJlc291cmNlcy9yZWFkXCIsIHsgdXJpIH0pO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY2FsbE1jcFRvb2woXG4gIHVybDogc3RyaW5nLFxuICBoZWFkZXJzOiBNY3BIZWFkZXJzLFxuICB0b29sTmFtZTogc3RyaW5nLFxuICBhcmdzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbiAgdGltZW91dE1zOiBudW1iZXIgPSBERUZBVUxUX01DUF9UT09MX1RJTUVPVVRfTVNcbik6IFByb21pc2U8dW5rbm93bj4ge1xuICBjb25zdCByZXN1bHQgPSAoYXdhaXQgcnBjQ2FsbChcbiAgICB1cmwsXG4gICAgaGVhZGVycyxcbiAgICBcInRvb2xzL2NhbGxcIixcbiAgICB7XG4gICAgICBuYW1lOiB0b29sTmFtZSxcbiAgICAgIGFyZ3VtZW50czogYXJncyxcbiAgICB9LFxuICAgIHRpbWVvdXRNc1xuICApKSBhcyB7XG4gICAgY29udGVudD86IEFycmF5PHsgdHlwZT86IHN0cmluZzsgdGV4dD86IHN0cmluZyB9PjtcbiAgICBba2V5OiBzdHJpbmddOiB1bmtub3duO1xuICB9O1xuXG4gIGlmIChyZXN1bHQuY29udGVudCAmJiBBcnJheS5pc0FycmF5KHJlc3VsdC5jb250ZW50KSkge1xuICAgIGNvbnN0IHRleHRzID0gcmVzdWx0LmNvbnRlbnQuZmlsdGVyKChjKSA9PiBjLnR5cGUgPT09IFwidGV4dFwiKS5tYXAoKGMpID0+IGMudGV4dCk7XG4gICAgaWYgKHRleHRzLmxlbmd0aCA9PT0gMSkgcmV0dXJuIHsgcmVzdWx0OiB0ZXh0c1swXSB9O1xuICAgIGlmICh0ZXh0cy5sZW5ndGggPiAxKSByZXR1cm4geyByZXN1bHQ6IHRleHRzLmpvaW4oXCJcXG5cIikgfTtcbiAgfVxuICByZXR1cm4gcmVzdWx0O1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY29ubmVjdE1jcFNlcnZlcihcbiAgdXJsOiBzdHJpbmcsXG4gIGhlYWRlcnM6IE1jcEhlYWRlcnMgPSB7fVxuKTogUHJvbWlzZTx7IG5hbWU6IHN0cmluZzsgdG9vbHM6IEFycmF5PHsgbmFtZTogc3RyaW5nOyBkZXNjcmlwdGlvbj86IHN0cmluZzsgaW5wdXRTY2hlbWE/OiB1bmtub3duIH0+OyBlcnJvcjogc3RyaW5nIHwgbnVsbCB9PiB7XG4gIHRyeSB7XG4gICAgY29uc3QgaW5mbyA9IGF3YWl0IGluaXRpYWxpemVNY3AodXJsLCBoZWFkZXJzKTtcbiAgICBjb25zdCB0b29scyA9IGF3YWl0IGxpc3RNY3BUb29scyh1cmwsIGhlYWRlcnMpO1xuICAgIHJldHVybiB7XG4gICAgICBuYW1lOiBpbmZvLnNlcnZlckluZm8/Lm5hbWUgfHwgXCJNQ1AgU2VydmVyXCIsXG4gICAgICB0b29scyxcbiAgICAgIGVycm9yOiBudWxsLFxuICAgIH07XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zdCBtc2cgPSBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSk7XG4gICAgcmV0dXJuIHtcbiAgICAgIG5hbWU6IFwiTUNQIFNlcnZlclwiLFxuICAgICAgdG9vbHM6IFtdLFxuICAgICAgZXJyb3I6IG1zZyxcbiAgICB9O1xuICB9XG59XG4iLCIvKiBnbG9iYWwgY2hyb21lICovXG5pbXBvcnQgeyBjYWxsTWNwVG9vbCB9IGZyb20gXCIuL21jcFwiO1xuaW1wb3J0IHsgcmVzb2x2ZUxsbVJlcXVlc3RVcmwgfSBmcm9tIFwiLi9sbG1FbmRwb2ludFwiO1xuXG5jb25zdCBET01fTE9DQVRPUl9QUk9QRVJUSUVTID0ge1xuICB0YWJJZDogeyB0eXBlOiBcIm51bWJlclwiLCBkZXNjcmlwdGlvbjogXCJPcHRpb25hbCBicm93c2VyIHRhYiBJRC4gRGVmYXVsdHMgdG8gdGhlIGN1cnJlbnQgYWN0aXZlIHRhYi5cIiB9LFxuICBzZWxlY3RvcjogeyB0eXBlOiBcInN0cmluZ1wiLCBkZXNjcmlwdGlvbjogXCJPcHRpb25hbCBDU1Mgc2VsZWN0b3IgdXNlZCB0byBmaW5kIGVsZW1lbnRzLlwiIH0sXG4gIHRleHQ6IHsgdHlwZTogXCJzdHJpbmdcIiwgZGVzY3JpcHRpb246IFwiT3B0aW9uYWwgdGV4dCB0byBtYXRjaCBhZ2FpbnN0IGVsZW1lbnQgdGV4dCBvciBsYWJlbHMuXCIgfSxcbiAgbWF0Y2hFeGFjdDogeyB0eXBlOiBcImJvb2xlYW5cIiwgZGVzY3JpcHRpb246IFwiV2hldGhlciB0ZXh0IG1hdGNoaW5nIHNob3VsZCBiZSBleGFjdC4gRGVmYXVsdHMgdG8gZmFsc2UuXCIgfSxcbiAgaW5kZXg6IHsgdHlwZTogXCJudW1iZXJcIiwgZGVzY3JpcHRpb246IFwiWmVyby1iYXNlZCBpbmRleCB3aXRoaW4gdGhlIG1hdGNoZWQgZWxlbWVudHMuIERlZmF1bHRzIHRvIDAuXCIgfVxufTtcbmNvbnN0IERFRkFVTFRfU0NIRURVTEVfVE9PTF9USU1FT1VUX1NFQ09ORFMgPSAzMDtcbmNvbnN0IERFRkFVTFRfTUNQX1RPT0xfVElNRU9VVF9TRUNPTkRTID0gNjA7XG5jb25zdCBERUZBVUxUX0xMTV9GSVJTVF9QQUNLRVRfVElNRU9VVF9TRUNPTkRTID0gMjA7XG5jb25zdCBNQVhfTExNX1NUUkVBTV9SRVRSSUVTID0gMztcbmNvbnN0IFNDSEVEVUxFX1NUT1JBR0VfS0VZID0gXCJzY2hlZHVsZWRKb2JzXCI7XG5jb25zdCBTQ0hFRFVMRV9SRVRFTlRJT05fTVMgPSAyNCAqIDYwICogNjAgKiAxMDAwO1xuY29uc3QgU0NIRURVTEVfRklSRV9BTEFSTV9QUkVGSVggPSBcInNjaGVkdWxlLWZpcmU6XCI7XG5jb25zdCBTQ0hFRFVMRV9DTEVBTlVQX0FMQVJNX1BSRUZJWCA9IFwic2NoZWR1bGUtY2xlYW51cDpcIjtcbmNvbnN0IFRFUk1JTkFMX1NDSEVEVUxFX1NUQVRVU0VTID0gbmV3IFNldChbXCJzdWNjZWVkZWRcIiwgXCJmYWlsZWRcIiwgXCJjYW5jZWxsZWRcIl0pO1xuXG4vLyA9PT09PT09PT09PT09PT09PT09PSBUb29sIERlZmluaXRpb25zID09PT09PT09PT09PT09PT09PT09XG5cbmNvbnN0IFRPT0xTID0gW1xuICB7XG4gICAgbmFtZTogXCJ0YWJfbGlzdFwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkdldCBhIHNuYXBzaG90IG9mIGFsbCBjdXJyZW50bHkgb3BlbiBicm93c2VyIHRhYnMuIFJldHVybnMgZWFjaCB0YWIncyBpZCwgdXJsLCB0aXRsZSwgYW5kIGxhc3RBY2Nlc3NlZCwgcGx1cyBjYXB0dXJlZEF0IHRpbWluZyBmaWVsZHMgc28geW91IGNhbiBqdWRnZSB3aGV0aGVyIHRoZSB0YWIgc3RhdGUgbWF5IGJlIHN0YWxlIGFuZCByZWZyZXNoIGl0IGFnYWluIGlmIG5lZWRlZC4gVXNlIHdoZW4gdGhlIHVzZXIgYXNrcyBhYm91dCBvcGVuIHRhYnMsIGJyb3dzZXIgY29udGV4dCwgb3IgcGFnZS1yZWxhdGVkIHF1ZXN0aW9ucyBhbmQgeW91IG5lZWQgdG8gaWRlbnRpZnkgdGhlIHJpZ2h0IHRhYiBmaXJzdC5cIixcbiAgICBzY2hlbWE6IHtcbiAgICAgIHR5cGU6IFwib2JqZWN0XCIsXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIG1heFNpemU6IHtcbiAgICAgICAgICB0eXBlOiBcIm51bWJlclwiLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiBcIk1heGltdW0gbnVtYmVyIG9mIHRhYnMgdG8gcmV0dXJuLiBEZWZhdWx0cyB0byAtMSAobm8gbGltaXQpLlwiXG4gICAgICAgIH0sXG4gICAgICAgIGJyaWVmVXJsOiB7XG4gICAgICAgICAgdHlwZTogXCJib29sZWFuXCIsXG4gICAgICAgICAgZGVzY3JpcHRpb246IFwiSWYgdHJ1ZSwgcmV0dXJuIG9ubHkgdGhlIGhvc3RuYW1lIChkb21haW4pIGluc3RlYWQgb2YgdGhlIGZ1bGwgVVJMLiBVc2VmdWwgdG8gcmVkdWNlIHJlc3BvbnNlIHNpemUgd2hlbiBmdWxsIFVSTHMgYXJlIG5vdCBuZWVkZWQuXCJcbiAgICAgICAgfVxuICAgICAgfSxcbiAgICAgIHJlcXVpcmVkOiBbXVxuICAgIH1cbiAgfSxcbiAge1xuICAgIG5hbWU6IFwidGFiX2V4dHJhY3RcIixcbiAgICBkZXNjcmlwdGlvbjogXCJFeHRyYWN0IHRoZSB0ZXh0IGNvbnRlbnQgb2YgYSBicm93c2VyIHRhYi4gQWxzbyByZXR1cm5zIHRhYiBtZXRhZGF0YSBpbmNsdWRpbmcgdGl0bGUsIHVybCwgYW5kIGxhc3RBY2Nlc3NlZCB3aGVuIGF2YWlsYWJsZS4gVXNlIHdoZW4geW91IG5lZWQgdG8gcmVhZCBwYWdlIGNvbnRlbnQgdG8gYW5zd2VyIHRoZSB1c2VyJ3MgcXVlc3Rpb24uXCIsXG4gICAgc2NoZW1hOiB7XG4gICAgICB0eXBlOiBcIm9iamVjdFwiLFxuICAgICAgcHJvcGVydGllczoge1xuICAgICAgICB0YWJJZDogeyB0eXBlOiBcIm51bWJlclwiLCBkZXNjcmlwdGlvbjogXCJUaGUgYnJvd3NlciB0YWIgSUQgdG8gZXh0cmFjdCBjb250ZW50IGZyb21cIiB9XG4gICAgICB9LFxuICAgICAgcmVxdWlyZWQ6IFtcInRhYklkXCJdXG4gICAgfVxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ0YWJfc2Nyb2xsXCIsXG4gICAgZGVzY3JpcHRpb246IFwiU2Nyb2xsIGEgYnJvd3NlciB0YWIgYW5kIHJldHVybiB0aGUgdXBkYXRlZCBzY3JvbGwgcG9zaXRpb24uIFVzZSB3aGVuIHlvdSBuZWVkIHRvIGluc3BlY3QgYW5vdGhlciBwYXJ0IG9mIHRoZSBjdXJyZW50bHkgdmlzaWJsZSBwYWdlIGJlZm9yZSB0YWtpbmcgYW5vdGhlciBzY3JlZW5zaG90IG9yIHJlYWRpbmcgdGhlIGxheW91dC4gSWYgdGFiSWQgaXMgb21pdHRlZCwgc2Nyb2xscyB0aGUgY3VycmVudCBhY3RpdmUgdGFiLlwiLFxuICAgIHNjaGVtYToge1xuICAgICAgdHlwZTogXCJvYmplY3RcIixcbiAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgdGFiSWQ6IHsgdHlwZTogXCJudW1iZXJcIiwgZGVzY3JpcHRpb246IFwiT3B0aW9uYWwgYnJvd3NlciB0YWIgSUQuIERlZmF1bHRzIHRvIHRoZSBjdXJyZW50IGFjdGl2ZSB0YWIuXCIgfSxcbiAgICAgICAgZGVsdGFZOiB7IHR5cGU6IFwibnVtYmVyXCIsIGRlc2NyaXB0aW9uOiBcIk9wdGlvbmFsIHZlcnRpY2FsIHNjcm9sbCBkZWx0YSBpbiBwaXhlbHMuIFBvc2l0aXZlIHNjcm9sbHMgZG93biwgbmVnYXRpdmUgc2Nyb2xscyB1cC5cIiB9LFxuICAgICAgICBwYWdlRnJhY3Rpb246IHsgdHlwZTogXCJudW1iZXJcIiwgZGVzY3JpcHRpb246IFwiT3B0aW9uYWwgZnJhY3Rpb24gb2Ygb25lIHZpZXdwb3J0IGhlaWdodCB0byBzY3JvbGwsIHN1Y2ggYXMgMC44IG9yIC0xLlwiIH0sXG4gICAgICAgIHBvc2l0aW9uOiB7XG4gICAgICAgICAgdHlwZTogXCJzdHJpbmdcIixcbiAgICAgICAgICBlbnVtOiBbXCJ0b3BcIiwgXCJib3R0b21cIl0sXG4gICAgICAgICAgZGVzY3JpcHRpb246IFwiT3B0aW9uYWwgYWJzb2x1dGUgc2Nyb2xsIHRhcmdldC4gVXNlICd0b3AnIG9yICdib3R0b20nLlwiXG4gICAgICAgIH0sXG4gICAgICAgIGJlaGF2aW9yOiB7XG4gICAgICAgICAgdHlwZTogXCJzdHJpbmdcIixcbiAgICAgICAgICBlbnVtOiBbXCJhdXRvXCIsIFwic21vb3RoXCJdLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiBcIlNjcm9sbCBiZWhhdmlvci4gRGVmYXVsdHMgdG8gJ2F1dG8nLlwiXG4gICAgICAgIH1cbiAgICAgIH0sXG4gICAgICByZXF1aXJlZDogW11cbiAgICB9XG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImRvbV9xdWVyeVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIlF1ZXJ5IHRoZSBjdXJyZW50IHBhZ2UgRE9NIGFuZCByZXR1cm4gbWF0Y2hpbmcgZWxlbWVudHMgd2l0aCB0ZXh0LCBhdHRyaWJ1dGVzLCBwb3NpdGlvbnMsIGFuZCBtYXRjaCBjb3VudC4gVXNlIHRoaXMgdG8gaW5zcGVjdCB0aGUgcGFnZSBzdHJ1Y3R1cmUgYmVmb3JlIGludGVyYWN0aW5nIHdpdGggaXQuXCIsXG4gICAgc2NoZW1hOiB7XG4gICAgICB0eXBlOiBcIm9iamVjdFwiLFxuICAgICAgcHJvcGVydGllczoge1xuICAgICAgICAuLi5ET01fTE9DQVRPUl9QUk9QRVJUSUVTLFxuICAgICAgICBtYXhSZXN1bHRzOiB7IHR5cGU6IFwibnVtYmVyXCIsIGRlc2NyaXB0aW9uOiBcIk1heGltdW0gbnVtYmVyIG9mIG1hdGNoaW5nIGVsZW1lbnRzIHRvIHJldHVybiAoZGVmYXVsdCA1LCBtYXggMjApLlwiIH1cbiAgICAgIH0sXG4gICAgICByZXF1aXJlZDogW11cbiAgICB9XG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImRvbV9jbGlja1wiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkNsaWNrIGEgRE9NIGVsZW1lbnQgb24gdGhlIHBhZ2UgYnkgc2VsZWN0b3Igb3IgdGV4dCBtYXRjaC4gVXNlIHRoaXMgZm9yIGJ1dHRvbnMsIGxpbmtzLCB0YWJzLCBtZW51cywgYW5kIG90aGVyIGNsaWNrYWJsZSBlbGVtZW50cy5cIixcbiAgICBzY2hlbWE6IHtcbiAgICAgIHR5cGU6IFwib2JqZWN0XCIsXG4gICAgICBwcm9wZXJ0aWVzOiBET01fTE9DQVRPUl9QUk9QRVJUSUVTLFxuICAgICAgcmVxdWlyZWQ6IFtdXG4gICAgfVxuICB9LFxuICB7XG4gICAgbmFtZTogXCJkb21fc2V0X3ZhbHVlXCIsXG4gICAgZGVzY3JpcHRpb246IFwiU2V0IHRoZSB2YWx1ZSBvZiBhbiBpbnB1dCwgdGV4dGFyZWEsIG9yIHNlbGVjdCBlbGVtZW50IGFuZCBkaXNwYXRjaCBpbnB1dC9jaGFuZ2UgZXZlbnRzLiBVc2UgdGhpcyB0byBmaWxsIGZvcm1zIG9yIHVwZGF0ZSBjb250cm9scy5cIixcbiAgICBzY2hlbWE6IHtcbiAgICAgIHR5cGU6IFwib2JqZWN0XCIsXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIC4uLkRPTV9MT0NBVE9SX1BST1BFUlRJRVMsXG4gICAgICAgIHZhbHVlOiB7IHR5cGU6IFwic3RyaW5nXCIsIGRlc2NyaXB0aW9uOiBcIlRoZSB2YWx1ZSB0byBzZXQgb24gdGhlIHRhcmdldCBmb3JtIGVsZW1lbnQuXCIgfVxuICAgICAgfSxcbiAgICAgIHJlcXVpcmVkOiBbXCJ2YWx1ZVwiXVxuICAgIH1cbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZG9tX3N0eWxlXCIsXG4gICAgZGVzY3JpcHRpb246IFwiVGVtcG9yYXJpbHkgYXBwbHkgaW5saW5lIENTUyBzdHlsZXMgdG8gYSBtYXRjaGVkIERPTSBlbGVtZW50LiBVc2VmdWwgZm9yIHZpc3VhbCBkZWJ1Z2dpbmcgb3IgZW1waGFzaXppbmcgYW4gZWxlbWVudCBmb3IgdGhlIHVzZXIuXCIsXG4gICAgc2NoZW1hOiB7XG4gICAgICB0eXBlOiBcIm9iamVjdFwiLFxuICAgICAgcHJvcGVydGllczoge1xuICAgICAgICAuLi5ET01fTE9DQVRPUl9QUk9QRVJUSUVTLFxuICAgICAgICBzdHlsZXM6IHtcbiAgICAgICAgICB0eXBlOiBcIm9iamVjdFwiLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiBcIk9iamVjdCBtYXBwaW5nIENTUyBwcm9wZXJ0eSBuYW1lcyB0byB2YWx1ZXMsIGUuZy4ge1xcXCJvdXRsaW5lXFxcIjpcXFwiM3B4IHNvbGlkIHJlZFxcXCJ9XCJcbiAgICAgICAgfSxcbiAgICAgICAgZHVyYXRpb25NczogeyB0eXBlOiBcIm51bWJlclwiLCBkZXNjcmlwdGlvbjogXCJIb3cgbG9uZyB0byBrZWVwIHRoZSBzdHlsZXMgYmVmb3JlIHJlc3RvcmluZyB0aGVtIChkZWZhdWx0IDIwMDBtcykuXCIgfVxuICAgICAgfSxcbiAgICAgIHJlcXVpcmVkOiBbXCJzdHlsZXNcIl1cbiAgICB9XG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImRvbV9nZXRfaHRtbFwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkdldCB0aGUgaW5uZXIgb3Igb3V0ZXIgSFRNTCBvZiBhIG1hdGNoZWQgRE9NIGVsZW1lbnQuIFVzZSB0aGlzIHdoZW4geW91IG5lZWQgbWFya3VwIGNvbnRleHQgZm9yIGEgc3BlY2lmaWMgcGFydCBvZiB0aGUgcGFnZS5cIixcbiAgICBzY2hlbWE6IHtcbiAgICAgIHR5cGU6IFwib2JqZWN0XCIsXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIC4uLkRPTV9MT0NBVE9SX1BST1BFUlRJRVMsXG4gICAgICAgIG1vZGU6IHtcbiAgICAgICAgICB0eXBlOiBcInN0cmluZ1wiLFxuICAgICAgICAgIGVudW06IFtcIm91dGVyXCIsIFwiaW5uZXJcIl0sXG4gICAgICAgICAgZGVzY3JpcHRpb246IFwiV2hldGhlciB0byByZXR1cm4gdGhlIGVsZW1lbnQncyBvdXRlckhUTUwgb3IgaW5uZXJIVE1MLiBEZWZhdWx0cyB0byBvdXRlci5cIlxuICAgICAgICB9LFxuICAgICAgICBtYXhMZW5ndGg6IHsgdHlwZTogXCJudW1iZXJcIiwgZGVzY3JpcHRpb246IFwiTWF4aW11bSBIVE1MIGxlbmd0aCB0byByZXR1cm4gKGRlZmF1bHQgNDAwMCwgbWF4IDIwMDAwKS5cIiB9XG4gICAgICB9LFxuICAgICAgcmVxdWlyZWQ6IFtdXG4gICAgfVxuICB9LFxuICB7XG4gICAgbmFtZTogXCJkb21faGlnaGxpZ2h0XCIsXG4gICAgZGVzY3JpcHRpb246IFwiU2Nyb2xsIHRoZSBwYWdlIHRvIGEgbWF0Y2hlZCBET00gZWxlbWVudCBhbmQgZmxhc2ggYSB2aXNpYmxlIGhpZ2hsaWdodCBhcm91bmQgaXQgZm9yIGFib3V0IG9uZSBzZWNvbmQgc28gdGhlIHVzZXIgY2FuIHNwb3QgaXQgb24gdGhlIHBhZ2UuXCIsXG4gICAgc2NoZW1hOiB7XG4gICAgICB0eXBlOiBcIm9iamVjdFwiLFxuICAgICAgcHJvcGVydGllczoge1xuICAgICAgICAuLi5ET01fTE9DQVRPUl9QUk9QRVJUSUVTLFxuICAgICAgICBkdXJhdGlvbk1zOiB7IHR5cGU6IFwibnVtYmVyXCIsIGRlc2NyaXB0aW9uOiBcIkhvdyBsb25nIHRoZSBoaWdobGlnaHQgc2hvdWxkIHJlbWFpbiB2aXNpYmxlIChkZWZhdWx0IDEwMDBtcykuXCIgfVxuICAgICAgfSxcbiAgICAgIHJlcXVpcmVkOiBbXVxuICAgIH1cbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZXZhbF9qc1wiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkRhbmdlcm91cyB0b29sLiBFeGVjdXRlIGFyYml0cmFyeSBKYXZhU2NyaXB0IG9uIHRoZSBjdXJyZW50IGFjdGl2ZSBwYWdlIGluIHRoZSBwYWdlJ3MgbWFpbiBKYXZhU2NyaXB0IGNvbnRleHQuIFVzZSBvbmx5IHdoZW4gc3RydWN0dXJlZCBET00gdG9vbHMgYXJlIGluc3VmZmljaWVudC4gVGhlIGFwcGxpY2F0aW9uIHdpbGwgaGFuZGxlIGV4cGxpY2l0IHVzZXIgY29uZmlybWF0aW9uIGJlZm9yZSBleGVjdXRpb24sIHNvIGRvIG5vdCBhc2sgdGhlIHVzZXIgZm9yIGNvbmZpcm1hdGlvbiBpbiBuYXR1cmFsIGxhbmd1YWdlOyBjYWxsIHRoZSB0b29sIGRpcmVjdGx5IHdoZW4gbmVlZGVkLlwiLFxuICAgIHNjaGVtYToge1xuICAgICAgdHlwZTogXCJvYmplY3RcIixcbiAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAganNTY3JpcHQ6IHsgdHlwZTogXCJzdHJpbmdcIiwgZGVzY3JpcHRpb246IFwiSmF2YVNjcmlwdCBzb3VyY2UgY29kZSB0byBleGVjdXRlIGluIHRoZSBwYWdlJ3MgbWFpbiB3b3JsZC4gVXNlIGByZXR1cm4gLi4uYCBpZiB5b3Ugd2FudCBhIHJlc3VsdCB2YWx1ZSBiYWNrLlwiIH1cbiAgICAgIH0sXG4gICAgICByZXF1aXJlZDogW1wianNTY3JpcHRcIl1cbiAgICB9XG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInRhYl9vcGVuXCIsXG4gICAgZGVzY3JpcHRpb246IFwiT3BlbiBhIG5ldyBicm93c2VyIHRhYiB3aXRoIHRoZSBnaXZlbiBVUkwuIEJ5IGRlZmF1bHQgZm9jdXNlcyBvbiB0aGUgbmV3IHRhYi4gUmV0dXJucyB0YWIgbWV0YWRhdGEgaW5jbHVkaW5nIGxhc3RBY2Nlc3NlZCB3aGVuIGF2YWlsYWJsZS5cIixcbiAgICBzY2hlbWE6IHtcbiAgICAgIHR5cGU6IFwib2JqZWN0XCIsXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIHVybDogeyB0eXBlOiBcInN0cmluZ1wiLCBkZXNjcmlwdGlvbjogXCJUaGUgVVJMIHRvIG9wZW5cIiB9LFxuICAgICAgICBhY3RpdmU6IHsgdHlwZTogXCJib29sZWFuXCIsIGRlc2NyaXB0aW9uOiBcIldoZXRoZXIgdG8gZm9jdXMgb24gdGhlIG5ldyB0YWIgKGRlZmF1bHQgdHJ1ZSkuIFNldCBmYWxzZSB0byBvcGVuIGluIGJhY2tncm91bmQuXCIgfVxuICAgICAgfSxcbiAgICAgIHJlcXVpcmVkOiBbXCJ1cmxcIl1cbiAgICB9XG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInRhYl9mb2N1c1wiLFxuICAgIGRlc2NyaXB0aW9uOiBcIlN3aXRjaCBmb2N1cyB0byBhbiBleGlzdGluZyBicm93c2VyIHRhYiBieSBpdHMgSUQuIElmIHRoZSB0YWIgaXMgaW4gYSBkaWZmZXJlbnQgYnJvd3NlciB3aW5kb3csIG1vdmUgaXQgaW50byB0aGUgY3VycmVudCB3aW5kb3cgZmlyc3QsIHRoZW4gZm9jdXMgaXQuIFJldHVybnMgdGFiIG1ldGFkYXRhIGluY2x1ZGluZyB3aW5kb3dJZCBhbmQgbGFzdEFjY2Vzc2VkIHdoZW4gYXZhaWxhYmxlLlwiLFxuICAgIHNjaGVtYToge1xuICAgICAgdHlwZTogXCJvYmplY3RcIixcbiAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgdGFiSWQ6IHsgdHlwZTogXCJudW1iZXJcIiwgZGVzY3JpcHRpb246IFwiVGhlIHRhYiBJRCB0byBmb2N1cyBvblwiIH1cbiAgICAgIH0sXG4gICAgICByZXF1aXJlZDogW1widGFiSWRcIl1cbiAgICB9XG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInRhYl9jbG9zZVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkNsb3NlIG9uZSBvciBtb3JlIGJyb3dzZXIgdGFicyBieSB0aGVpciBJRHMuIFJldHVybnMgbWV0YWRhdGEgZm9yIGVhY2ggdGFiIGJlZm9yZSBpdCB3YXMgY2xvc2VkLCBpbmNsdWRpbmcgbGFzdEFjY2Vzc2VkIHdoZW4gYXZhaWxhYmxlLlwiLFxuICAgIHNjaGVtYToge1xuICAgICAgdHlwZTogXCJvYmplY3RcIixcbiAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgdGFiSWRzOiB7XG4gICAgICAgICAgdHlwZTogXCJhcnJheVwiLFxuICAgICAgICAgIGl0ZW1zOiB7IHR5cGU6IFwibnVtYmVyXCIgfSxcbiAgICAgICAgICBkZXNjcmlwdGlvbjogXCJBcnJheSBvZiB0YWIgSURzIHRvIGNsb3NlXCJcbiAgICAgICAgfVxuICAgICAgfSxcbiAgICAgIHJlcXVpcmVkOiBbXCJ0YWJJZHNcIl1cbiAgICB9XG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInRhYl9ncm91cFwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkdyb3VwIG11bHRpcGxlIGJyb3dzZXIgdGFicyB0b2dldGhlciB3aXRoIGEgbGFiZWwgYW5kIGNvbG9yLiBVc2Ugd2hlbiB0aGUgdXNlciBhc2tzIHRvIG9yZ2FuaXplIHRhYnMuXCIsXG4gICAgc2NoZW1hOiB7XG4gICAgICB0eXBlOiBcIm9iamVjdFwiLFxuICAgICAgcHJvcGVydGllczoge1xuICAgICAgICB0YWJJZHM6IHtcbiAgICAgICAgICB0eXBlOiBcImFycmF5XCIsXG4gICAgICAgICAgaXRlbXM6IHsgdHlwZTogXCJudW1iZXJcIiB9LFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiBcIkFycmF5IG9mIHRhYiBJRHMgdG8gZ3JvdXAgdG9nZXRoZXJcIlxuICAgICAgICB9LFxuICAgICAgICBuYW1lOiB7IHR5cGU6IFwic3RyaW5nXCIsIGRlc2NyaXB0aW9uOiBcIkRpc3BsYXkgbmFtZSBmb3IgdGhlIHRhYiBncm91cFwiIH0sXG4gICAgICAgIGNvbG9yOiB7XG4gICAgICAgICAgdHlwZTogXCJzdHJpbmdcIixcbiAgICAgICAgICBlbnVtOiBbXCJncmV5XCIsIFwiYmx1ZVwiLCBcInJlZFwiLCBcInllbGxvd1wiLCBcImdyZWVuXCIsIFwicGlua1wiLCBcInB1cnBsZVwiLCBcImN5YW5cIiwgXCJvcmFuZ2VcIl0sXG4gICAgICAgICAgZGVzY3JpcHRpb246IFwiQ29sb3IgZm9yIHRoZSB0YWIgZ3JvdXBcIlxuICAgICAgICB9XG4gICAgICB9LFxuICAgICAgcmVxdWlyZWQ6IFtcInRhYklkc1wiLCBcIm5hbWVcIl1cbiAgICB9XG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImdyb3VwX2xpc3RcIixcbiAgICBkZXNjcmlwdGlvbjogXCJHZXQgYSBzbmFwc2hvdCBvZiBhbGwgdGFiIGdyb3VwcyBhY3Jvc3MgYnJvd3NlciB3aW5kb3dzLiBSZXR1cm5zIGVhY2ggZ3JvdXAncyBtZXRhZGF0YSBhbmQgY3VycmVudCB0YWJzLCBwbHVzIGNhcHR1cmVkQXQgdGltaW5nIGZpZWxkcy4gVXNlIHdoZW4gdGhlIHVzZXIgYXNrcyBhYm91dCBncm91cHMgb3IgdGFiIG9yZ2FuaXphdGlvbi5cIixcbiAgICBzY2hlbWE6IHtcbiAgICAgIHR5cGU6IFwib2JqZWN0XCIsXG4gICAgICBwcm9wZXJ0aWVzOiB7fSxcbiAgICAgIHJlcXVpcmVkOiBbXVxuICAgIH1cbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZ3JvdXBfZ2V0XCIsXG4gICAgZGVzY3JpcHRpb246IFwiR2V0IGEgc25hcHNob3Qgb2YgYSBzcGVjaWZpYyB0YWIgZ3JvdXAgYnkgaXRzIGdyb3VwSWQsIGluY2x1ZGluZyBjdXJyZW50IHRhYnMgYW5kIGNhcHR1cmVkQXQgdGltaW5nIGZpZWxkcy5cIixcbiAgICBzY2hlbWE6IHtcbiAgICAgIHR5cGU6IFwib2JqZWN0XCIsXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIGdyb3VwSWQ6IHsgdHlwZTogXCJudW1iZXJcIiwgZGVzY3JpcHRpb246IFwiVGhlIGJyb3dzZXIgdGFiIGdyb3VwIElEXCIgfVxuICAgICAgfSxcbiAgICAgIHJlcXVpcmVkOiBbXCJncm91cElkXCJdXG4gICAgfVxuICB9LFxuICB7XG4gICAgbmFtZTogXCJncm91cF91cGRhdGVcIixcbiAgICBkZXNjcmlwdGlvbjogXCJVcGRhdGUgYSB0YWIgZ3JvdXAncyB0aXRsZSwgY29sb3IsIGFuZC9vciBjb2xsYXBzZWQgc3RhdGUuIFJldHVybnMgdGhlIHVwZGF0ZWQgZ3JvdXAgc25hcHNob3QuXCIsXG4gICAgc2NoZW1hOiB7XG4gICAgICB0eXBlOiBcIm9iamVjdFwiLFxuICAgICAgcHJvcGVydGllczoge1xuICAgICAgICBncm91cElkOiB7IHR5cGU6IFwibnVtYmVyXCIsIGRlc2NyaXB0aW9uOiBcIlRoZSBicm93c2VyIHRhYiBncm91cCBJRFwiIH0sXG4gICAgICAgIG5hbWU6IHsgdHlwZTogXCJzdHJpbmdcIiwgZGVzY3JpcHRpb246IFwiTmV3IGRpc3BsYXkgdGl0bGUgZm9yIHRoZSBncm91cFwiIH0sXG4gICAgICAgIGNvbG9yOiB7XG4gICAgICAgICAgdHlwZTogXCJzdHJpbmdcIixcbiAgICAgICAgICBlbnVtOiBbXCJncmV5XCIsIFwiYmx1ZVwiLCBcInJlZFwiLCBcInllbGxvd1wiLCBcImdyZWVuXCIsIFwicGlua1wiLCBcInB1cnBsZVwiLCBcImN5YW5cIiwgXCJvcmFuZ2VcIl0sXG4gICAgICAgICAgZGVzY3JpcHRpb246IFwiTmV3IGNvbG9yIGZvciB0aGUgdGFiIGdyb3VwXCJcbiAgICAgICAgfSxcbiAgICAgICAgY29sbGFwc2VkOiB7IHR5cGU6IFwiYm9vbGVhblwiLCBkZXNjcmlwdGlvbjogXCJXaGV0aGVyIHRoZSBncm91cCBzaG91bGQgYmUgY29sbGFwc2VkXCIgfVxuICAgICAgfSxcbiAgICAgIHJlcXVpcmVkOiBbXCJncm91cElkXCJdXG4gICAgfVxuICB9LFxuICB7XG4gICAgbmFtZTogXCJncm91cF9hZGRfdGFic1wiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkFkZCBvbmUgb3IgbW9yZSB0YWJzIHRvIGFuIGV4aXN0aW5nIHRhYiBncm91cC4gUmV0dXJucyB0aGUgdXBkYXRlZCBncm91cCBzbmFwc2hvdC5cIixcbiAgICBzY2hlbWE6IHtcbiAgICAgIHR5cGU6IFwib2JqZWN0XCIsXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIGdyb3VwSWQ6IHsgdHlwZTogXCJudW1iZXJcIiwgZGVzY3JpcHRpb246IFwiVGhlIGJyb3dzZXIgdGFiIGdyb3VwIElEXCIgfSxcbiAgICAgICAgdGFiSWRzOiB7XG4gICAgICAgICAgdHlwZTogXCJhcnJheVwiLFxuICAgICAgICAgIGl0ZW1zOiB7IHR5cGU6IFwibnVtYmVyXCIgfSxcbiAgICAgICAgICBkZXNjcmlwdGlvbjogXCJBcnJheSBvZiB0YWIgSURzIHRvIGFkZCB0byB0aGUgZ3JvdXBcIlxuICAgICAgICB9XG4gICAgICB9LFxuICAgICAgcmVxdWlyZWQ6IFtcImdyb3VwSWRcIiwgXCJ0YWJJZHNcIl1cbiAgICB9XG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImdyb3VwX3JlbW92ZV90YWJzXCIsXG4gICAgZGVzY3JpcHRpb246IFwiUmVtb3ZlIG9uZSBvciBtb3JlIHRhYnMgZnJvbSB0aGVpciBjdXJyZW50IHRhYiBncm91cHMuIFJldHVybnMgdGhlIHVwZGF0ZWQgdGFiIG1ldGFkYXRhIGFmdGVyIHVuZ3JvdXBpbmcuXCIsXG4gICAgc2NoZW1hOiB7XG4gICAgICB0eXBlOiBcIm9iamVjdFwiLFxuICAgICAgcHJvcGVydGllczoge1xuICAgICAgICB0YWJJZHM6IHtcbiAgICAgICAgICB0eXBlOiBcImFycmF5XCIsXG4gICAgICAgICAgaXRlbXM6IHsgdHlwZTogXCJudW1iZXJcIiB9LFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiBcIkFycmF5IG9mIHRhYiBJRHMgdG8gcmVtb3ZlIGZyb20gdGhlaXIgY3VycmVudCBncm91cHNcIlxuICAgICAgICB9XG4gICAgICB9LFxuICAgICAgcmVxdWlyZWQ6IFtcInRhYklkc1wiXVxuICAgIH1cbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZ3JvdXBfdW5ncm91cFwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkRpc3NvbHZlIGFuIGVudGlyZSB0YWIgZ3JvdXAgYnkgaXRzIGdyb3VwSWQuIFJldHVybnMgdGhlIGdyb3VwIHNuYXBzaG90IGNhcHR1cmVkIGJlZm9yZSB1bmdyb3VwaW5nIGFuZCB0aGUgcmVzdWx0aW5nIHRhYnMuXCIsXG4gICAgc2NoZW1hOiB7XG4gICAgICB0eXBlOiBcIm9iamVjdFwiLFxuICAgICAgcHJvcGVydGllczoge1xuICAgICAgICBncm91cElkOiB7IHR5cGU6IFwibnVtYmVyXCIsIGRlc2NyaXB0aW9uOiBcIlRoZSBicm93c2VyIHRhYiBncm91cCBJRFwiIH1cbiAgICAgIH0sXG4gICAgICByZXF1aXJlZDogW1wiZ3JvdXBJZFwiXVxuICAgIH1cbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiaGlzdG9yeV9zZWFyY2hcIixcbiAgICBkZXNjcmlwdGlvbjogXCJTZWFyY2ggYnJvd3NlciBoaXN0b3J5IGJ5IGtleXdvcmQuIFJldHVybnMgcmVjZW50IG1hdGNoaW5nIFVSTHMgd2l0aCB0aXRsZXMgYW5kIHZpc2l0IHRpbWVzLiBVc2Ugd2hlbiB0aGUgdXNlciBhc2tzIGFib3V0IHByZXZpb3VzbHkgdmlzaXRlZCBwYWdlcy5cIixcbiAgICBzY2hlbWE6IHtcbiAgICAgIHR5cGU6IFwib2JqZWN0XCIsXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIHF1ZXJ5OiB7IHR5cGU6IFwic3RyaW5nXCIsIGRlc2NyaXB0aW9uOiBcIlNlYXJjaCBrZXl3b3JkXCIgfSxcbiAgICAgICAgbWF4UmVzdWx0czogeyB0eXBlOiBcIm51bWJlclwiLCBkZXNjcmlwdGlvbjogXCJNYXhpbXVtIG51bWJlciBvZiByZXN1bHRzIHRvIHJldHVybiAoZGVmYXVsdCAxMClcIiB9XG4gICAgICB9LFxuICAgICAgcmVxdWlyZWQ6IFtcInF1ZXJ5XCJdXG4gICAgfVxuICB9LFxuICB7XG4gICAgbmFtZTogXCJoaXN0b3J5X3JlY2VudFwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkxpc3QgcmVjZW50IGJyb3dzZXIgaGlzdG9yeSBlbnRyaWVzIHdpdGhpbiBhIHRpbWUgcmFuZ2UuIFVzZSB3aGVuIHRoZSB1c2VyIGFza3MgZm9yIHJlY2VudGx5IHZpc2l0ZWQgcGFnZXMgd2l0aG91dCBhIGtleXdvcmQgZmlsdGVyLlwiLFxuICAgIHNjaGVtYToge1xuICAgICAgdHlwZTogXCJvYmplY3RcIixcbiAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgc3RhcnRUaW1lOiB7IHR5cGU6IFwibnVtYmVyXCIsIGRlc2NyaXB0aW9uOiBcIk9wdGlvbmFsIGluY2x1c2l2ZSBzdGFydCB0aW1lc3RhbXAgaW4gbWlsbGlzZWNvbmRzLiBEZWZhdWx0cyB0byA3IGRheXMgYWdvLlwiIH0sXG4gICAgICAgIGVuZFRpbWU6IHsgdHlwZTogXCJudW1iZXJcIiwgZGVzY3JpcHRpb246IFwiT3B0aW9uYWwgaW5jbHVzaXZlIGVuZCB0aW1lc3RhbXAgaW4gbWlsbGlzZWNvbmRzLiBEZWZhdWx0cyB0byBub3cuXCIgfSxcbiAgICAgICAgbWF4UmVzdWx0czogeyB0eXBlOiBcIm51bWJlclwiLCBkZXNjcmlwdGlvbjogXCJNYXhpbXVtIG51bWJlciBvZiByZXN1bHRzIHRvIHJldHVybiAoZGVmYXVsdCAxMDAsIG1heCAxMDApLlwiIH1cbiAgICAgIH0sXG4gICAgICByZXF1aXJlZDogW11cbiAgICB9XG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInRhYl9nZXRfYWN0aXZlXCIsXG4gICAgZGVzY3JpcHRpb246IFwiR2V0IGEgc25hcHNob3Qgb2YgdGhlIGN1cnJlbnRseSBmb2N1c2VkL2FjdGl2ZSB0YWIuIFVzZSB3aGVuIHRoZSB1c2VyIHNheXMgJ3RoaXMgcGFnZScsICdjdXJyZW50IHBhZ2UnLCAndGhlIHBhZ2UgSSdtIGxvb2tpbmcgYXQnLCBldGMuIFJldHVybnMgdGhlIHRhYidzIElELCBVUkwsIHRpdGxlLCBsYXN0QWNjZXNzZWQsIGFuZCBjYXB0dXJlZEF0IHRpbWluZyBmaWVsZHMgc28geW91IGNhbiB0aGVuIHVzZSB0YWJfZXh0cmFjdCB0byByZWFkIGl0cyBjb250ZW50IGFuZCBqdWRnZSB3aGV0aGVyIHRoZSBzbmFwc2hvdCBtYXkgbmVlZCByZWZyZXNoaW5nLlwiLFxuICAgIHNjaGVtYToge1xuICAgICAgdHlwZTogXCJvYmplY3RcIixcbiAgICAgIHByb3BlcnRpZXM6IHt9LFxuICAgICAgcmVxdWlyZWQ6IFtdXG4gICAgfVxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ0YWJfc2NyZWVuc2hvdFwiLFxuICAgIGRlc2NyaXB0aW9uOlxuICAgICAgXCJDYXB0dXJlIGEgc2NyZWVuc2hvdCBvZiBhIGJyb3dzZXIgdGFiLiBCeSBkZWZhdWx0IGNhcHR1cmVzIG9ubHkgdGhlIHZpc2libGUgdmlld3BvcnQgdXNpbmcgQ2hyb21lJ3MgY2FwdHVyZVZpc2libGVUYWIgKHJlcXVpcmVzIHRoYXQgdGFiIHRvIGJlIGFjdGl2ZSBpbiBpdHMgd2luZG93KS4gT3V0cHV0IGlzIHdpZHRoLWNhcHBlZCBKUEVHIGZvciByZWFkYWJpbGl0eS5cIixcbiAgICBzY2hlbWE6IHtcbiAgICAgIHR5cGU6IFwib2JqZWN0XCIsXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIHdpbmRvd0lkOiB7IHR5cGU6IFwibnVtYmVyXCIsIGRlc2NyaXB0aW9uOiBcIldpbmRvdyBJRCBwYXNzZWQgdG8gY2FwdHVyZVZpc2libGVUYWIgKGRlZmF1bHQ6IHRoZSByZXNvbHZlZCB0YWIncyB3aW5kb3cpXCIgfSxcbiAgICAgICAgdGFiSWQ6IHsgdHlwZTogXCJudW1iZXJcIiwgZGVzY3JpcHRpb246IFwiT3B0aW9uYWwgdGFiIHRvIGNhcHR1cmUuIFdoZW4gb21pdHRlZCwgdXNlcyB0aGUgYWN0aXZlIHRhYiBpbiB0aGUgbGFzdC1mb2N1c2VkIHdpbmRvdy4gV2hlbiBzZXQsIHRoYXQgdGFiIGlzIGFjdGl2YXRlZCBiZWZvcmUgY2FwdHVyZS5cIiB9XG4gICAgICB9LFxuICAgICAgcmVxdWlyZWQ6IFtdXG4gICAgfVxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ3aW5kb3dfbGlzdFwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkdldCBhIHNuYXBzaG90IG9mIGFsbCBicm93c2VyIHdpbmRvd3MuIFJldHVybnMgZWFjaCB3aW5kb3cncyBtZXRhZGF0YSBhbmQgaXRzIGN1cnJlbnQgdGFicywgcGx1cyBjYXB0dXJlZEF0IHRpbWluZyBmaWVsZHMuIFVzZSB3aGVuIHRoZSB1c2VyIGFza3MgYWJvdXQgd2luZG93cywgY3Jvc3Mtd2luZG93IHRhYiBvcmdhbml6YXRpb24sIG9yIHdoaWNoIHdpbmRvdyBjb250YWlucyBhIHRhYi5cIixcbiAgICBzY2hlbWE6IHtcbiAgICAgIHR5cGU6IFwib2JqZWN0XCIsXG4gICAgICBwcm9wZXJ0aWVzOiB7fSxcbiAgICAgIHJlcXVpcmVkOiBbXVxuICAgIH1cbiAgfSxcbiAge1xuICAgIG5hbWU6IFwid2luZG93X2dldF9jdXJyZW50XCIsXG4gICAgZGVzY3JpcHRpb246IFwiR2V0IGEgc25hcHNob3Qgb2YgdGhlIGN1cnJlbnQgYnJvd3NlciB3aW5kb3csIGluY2x1ZGluZyBpdHMgdGFicyBhbmQgY2FwdHVyZWRBdCB0aW1pbmcgZmllbGRzLlwiLFxuICAgIHNjaGVtYToge1xuICAgICAgdHlwZTogXCJvYmplY3RcIixcbiAgICAgIHByb3BlcnRpZXM6IHt9LFxuICAgICAgcmVxdWlyZWQ6IFtdXG4gICAgfVxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ3aW5kb3dfZm9jdXNcIixcbiAgICBkZXNjcmlwdGlvbjogXCJGb2N1cyBhIGJyb3dzZXIgd2luZG93IGJ5IGl0cyBJRC4gUmV0dXJucyB0aGUgZm9jdXNlZCB3aW5kb3cgc25hcHNob3QuXCIsXG4gICAgc2NoZW1hOiB7XG4gICAgICB0eXBlOiBcIm9iamVjdFwiLFxuICAgICAgcHJvcGVydGllczoge1xuICAgICAgICB3aW5kb3dJZDogeyB0eXBlOiBcIm51bWJlclwiLCBkZXNjcmlwdGlvbjogXCJUaGUgYnJvd3NlciB3aW5kb3cgSUQgdG8gZm9jdXNcIiB9XG4gICAgICB9LFxuICAgICAgcmVxdWlyZWQ6IFtcIndpbmRvd0lkXCJdXG4gICAgfVxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ3aW5kb3dfbW92ZV90YWJcIixcbiAgICBkZXNjcmlwdGlvbjogXCJNb3ZlIG9uZSBvciBtb3JlIHRhYnMgaW50byBhIHRhcmdldCBicm93c2VyIHdpbmRvdy4gUmV0dXJucyBtZXRhZGF0YSBmb3IgdGhlIG1vdmVkIHRhYnMgYW5kIHRoZSB0YXJnZXQgd2luZG93IHNuYXBzaG90LlwiLFxuICAgIHNjaGVtYToge1xuICAgICAgdHlwZTogXCJvYmplY3RcIixcbiAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgdGFiSWRzOiB7XG4gICAgICAgICAgdHlwZTogXCJhcnJheVwiLFxuICAgICAgICAgIGl0ZW1zOiB7IHR5cGU6IFwibnVtYmVyXCIgfSxcbiAgICAgICAgICBkZXNjcmlwdGlvbjogXCJBcnJheSBvZiB0YWIgSURzIHRvIG1vdmVcIlxuICAgICAgICB9LFxuICAgICAgICB3aW5kb3dJZDogeyB0eXBlOiBcIm51bWJlclwiLCBkZXNjcmlwdGlvbjogXCJUaGUgdGFyZ2V0IGJyb3dzZXIgd2luZG93IElEXCIgfVxuICAgICAgfSxcbiAgICAgIHJlcXVpcmVkOiBbXCJ0YWJJZHNcIiwgXCJ3aW5kb3dJZFwiXVxuICAgIH1cbiAgfSxcbiAge1xuICAgIG5hbWU6IFwid2luZG93X2NyZWF0ZVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkNyZWF0ZSBhIG5ldyBicm93c2VyIHdpbmRvdy4gWW91IG1heSBvcHRpb25hbGx5IHByb3ZpZGUgYSBVUkwgdG8gb3BlbiBhbmQgd2hldGhlciB0aGUgbmV3IHdpbmRvdyBzaG91bGQgYmUgZm9jdXNlZC5cIixcbiAgICBzY2hlbWE6IHtcbiAgICAgIHR5cGU6IFwib2JqZWN0XCIsXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIHVybDogeyB0eXBlOiBcInN0cmluZ1wiLCBkZXNjcmlwdGlvbjogXCJPcHRpb25hbCBVUkwgdG8gb3BlbiBpbiB0aGUgbmV3IHdpbmRvd1wiIH0sXG4gICAgICAgIGZvY3VzZWQ6IHsgdHlwZTogXCJib29sZWFuXCIsIGRlc2NyaXB0aW9uOiBcIldoZXRoZXIgdGhlIG5ldyB3aW5kb3cgc2hvdWxkIGJlIGZvY3VzZWQgKGRlZmF1bHQgdHJ1ZSlcIiB9XG4gICAgICB9LFxuICAgICAgcmVxdWlyZWQ6IFtdXG4gICAgfVxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ3aW5kb3dfY2xvc2VcIixcbiAgICBkZXNjcmlwdGlvbjogXCJDbG9zZSBhIGJyb3dzZXIgd2luZG93IGJ5IGl0cyBJRC4gUmV0dXJucyB0aGUgd2luZG93IHNuYXBzaG90IGNhcHR1cmVkIGJlZm9yZSBjbG9zaW5nLlwiLFxuICAgIHNjaGVtYToge1xuICAgICAgdHlwZTogXCJvYmplY3RcIixcbiAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgd2luZG93SWQ6IHsgdHlwZTogXCJudW1iZXJcIiwgZGVzY3JpcHRpb246IFwiVGhlIGJyb3dzZXIgd2luZG93IElEIHRvIGNsb3NlXCIgfVxuICAgICAgfSxcbiAgICAgIHJlcXVpcmVkOiBbXCJ3aW5kb3dJZFwiXVxuICAgIH1cbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZ2V0X2N1cnJlbnRfdGltZVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkdldCB0aGUgY3VycmVudCBkYXRlLCB0aW1lIGFuZCB0aW1lem9uZS4gVXNlIHdoZW4geW91IG5lZWQgdG8ga25vdyB0aGUgY3VycmVudCB0aW1lLCBvciB3aGVuIHRoZSB1c2VyIGFza3MgYWJvdXQgdGltZSwgb3IgYmVmb3JlIHNldHRpbmcgYSByZW1pbmRlciB3aXRoIGFuIGFic29sdXRlIHRpbWVzdGFtcC5cIixcbiAgICBzY2hlbWE6IHtcbiAgICAgIHR5cGU6IFwib2JqZWN0XCIsXG4gICAgICBwcm9wZXJ0aWVzOiB7fSxcbiAgICAgIHJlcXVpcmVkOiBbXVxuICAgIH1cbiAgfSxcbiAge1xuICAgIG5hbWU6IFwic2NoZWR1bGVfdG9vbFwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIlNjaGVkdWxlIGEgdG9vbCBjYWxsIHRvIGV4ZWN1dGUgYXQgYSBmdXR1cmUgdGltZS4gWW91IE1VU1QgcHJvdmlkZSBib3RoIHRvb2xOYW1lIGFuZCB0b29sQXJncy4gdG9vbE5hbWUgbXVzdCBiZSBvbmUgb2YgdGhlIGF2YWlsYWJsZSBidWlsdC1pbiB0b29scyBvciBjb25uZWN0ZWQgTUNQIHRvb2xzLiB0b29sQXJncyBtdXN0IGJlIGEgSlNPTiBvYmplY3QgYW5kIG11c3Qgc3RyaWN0bHkgbWF0Y2ggdGhlIGlucHV0IGZvcm1hdCByZXF1aXJlZCBieSB0aGUgc2VsZWN0ZWQgdG9vbE5hbWUuIFByb3ZpZGUgRUlUSEVSIGRlbGF5U2Vjb25kcyAocmVsYXRpdmUsIHByZWZlcnJlZCkgT1IgdGltZXN0YW1wIChhYnNvbHV0ZSkuIEV4YW1wbGU6IHNjaGVkdWxlIHRhYl9vcGVuIHRvIG9wZW4gYSBVUkwgaW4gNSBtaW51dGVzLiBSZWNvbW1lbmRhdGlvbjogYmVjYXVzZSBzY2hlZHVsZWQgam9icyBydW4gaW5zaWRlIHRoZSBDaHJvbWUgaG9zdCBwcm9jZXNzLCB0aGV5IHdpbGwgZGlzYXBwZWFyIGFuZCBjYW5ub3QgZXhlY3V0ZSBhZnRlciBDaHJvbWUgaXMgY2xvc2VkLCBzbyBhdm9pZCBjcmVhdGluZyBqb2JzIHRvbyBmYXIgaW4gdGhlIGZ1dHVyZSB3aGVuZXZlciBwb3NzaWJsZS5cIixcbiAgICBzY2hlbWE6IHtcbiAgICAgIHR5cGU6IFwib2JqZWN0XCIsXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIGRlbGF5U2Vjb25kczogeyB0eXBlOiBcIm51bWJlclwiLCBkZXNjcmlwdGlvbjogXCJTZWNvbmRzIGZyb20gbm93IChlLmcuIDMwMCBmb3IgNSBtaW51dGVzKS4gUHJlZmVycmVkLlwiIH0sXG4gICAgICAgIHRpbWVzdGFtcDogeyB0eXBlOiBcIm51bWJlclwiLCBkZXNjcmlwdGlvbjogXCJBYnNvbHV0ZSBVbml4IHRpbWVzdGFtcCBpbiBtcy4gT25seSBpZiB1c2VyIGdpdmVzIGV4YWN0IGRhdGV0aW1lLlwiIH0sXG4gICAgICAgIHRvb2xOYW1lOiB7IHR5cGU6IFwic3RyaW5nXCIsIGRlc2NyaXB0aW9uOiBcIk5hbWUgb2YgdGhlIHRvb2wgdG8gY2FsbCAoZS5nLiB0YWJfb3BlbiwgdGFiX2Nsb3NlLCBtY3BfX3h4eClcIiB9LFxuICAgICAgICB0b29sQXJnczogeyB0eXBlOiBcIm9iamVjdFwiLCBkZXNjcmlwdGlvbjogXCJSZXF1aXJlZCBKU09OIG9iamVjdCBvZiBhcmd1bWVudHMgZm9yIHRoZSBzZWxlY3RlZCB0b29sTmFtZS4gVGhlIHNoYXBlIGFuZCBmaWVsZCBuYW1lcyBtdXN0IHN0cmljdGx5IG1hdGNoIHRoYXQgdG9vbCdzIGlucHV0IHNjaGVtYS5cIiB9LFxuICAgICAgICBsYWJlbDogeyB0eXBlOiBcInN0cmluZ1wiLCBkZXNjcmlwdGlvbjogXCJTaG9ydCBodW1hbi1yZWFkYWJsZSBkZXNjcmlwdGlvbiBvZiB0aGlzIHNjaGVkdWxlZCB0YXNrXCIgfSxcbiAgICAgICAgdGltZW91dFNlY29uZHM6IHsgdHlwZTogXCJudW1iZXJcIiwgZGVzY3JpcHRpb246IGBNYXhpbXVtIGV4ZWN1dGlvbiB0aW1lIGFmdGVyIHRoZSBzY2hlZHVsZSBmaXJlcy4gRGVmYXVsdHMgdG8gJHtERUZBVUxUX1NDSEVEVUxFX1RPT0xfVElNRU9VVF9TRUNPTkRTfSBzZWNvbmRzLmAgfVxuICAgICAgfSxcbiAgICAgIHJlcXVpcmVkOiBbXCJ0b29sTmFtZVwiLCBcInRvb2xBcmdzXCJdXG4gICAgfVxuICB9LFxuICB7XG4gICAgbmFtZTogXCJsaXN0X3NjaGVkdWxlZFwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkxpc3QgYWxsIHNjaGVkdWxlZCBqb2JzIHRoYXQgYXJlIHBlbmRpbmcsIHJ1bm5pbmcsIG9yIGNvbXBsZXRlZCB3aXRoaW4gdGhlIGxhc3QgMjQgaG91cnMsIGluY2x1ZGluZyB0aGVpciBJRHMsIGxhYmVscywgcGxhbm5lZCBmaXJlIHRpbWVzLCBhbmQgc3RhdHVzZXMuXCIsXG4gICAgc2NoZW1hOiB7XG4gICAgICB0eXBlOiBcIm9iamVjdFwiLFxuICAgICAgcHJvcGVydGllczoge30sXG4gICAgICByZXF1aXJlZDogW11cbiAgICB9XG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImNhbmNlbF9zY2hlZHVsZWRcIixcbiAgICBkZXNjcmlwdGlvbjogXCJDYW5jZWwgYSBwZW5kaW5nIHNjaGVkdWxlZCB0b29sIGNhbGwgYnkgaXRzIElELiBDYW5jZWxsZWQgam9icyByZW1haW4gdmlzaWJsZSB3aXRoIHN0YXR1cz1jYW5jZWxsZWQgZm9yIDI0IGhvdXJzIGJlZm9yZSBjbGVhbnVwLlwiLFxuICAgIHNjaGVtYToge1xuICAgICAgdHlwZTogXCJvYmplY3RcIixcbiAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgc2NoZWR1bGVJZDogeyB0eXBlOiBcInN0cmluZ1wiLCBkZXNjcmlwdGlvbjogXCJUaGUgc2NoZWR1bGUgSUQgdG8gY2FuY2VsXCIgfVxuICAgICAgfSxcbiAgICAgIHJlcXVpcmVkOiBbXCJzY2hlZHVsZUlkXCJdXG4gICAgfVxuICB9LFxuICB7XG4gICAgbmFtZTogXCJjbGVhcl9jb21wbGV0ZWRfc2NoZWR1bGVkXCIsXG4gICAgZGVzY3JpcHRpb246IFwiTWFudWFsbHkgY2xlYXIgY29tcGxldGVkIHNjaGVkdWxlZCBqb2JzLCBpbmNsdWRpbmcgc3VjY2VlZGVkLCBmYWlsZWQsIGFuZCBjYW5jZWxsZWQgZW50cmllcy5cIixcbiAgICBzY2hlbWE6IHtcbiAgICAgIHR5cGU6IFwib2JqZWN0XCIsXG4gICAgICBwcm9wZXJ0aWVzOiB7fSxcbiAgICAgIHJlcXVpcmVkOiBbXVxuICAgIH1cbiAgfVxuXTtcblxuZXhwb3J0IGNvbnN0IEJVSUxUSU5fVE9PTF9DT1VOVCA9IFRPT0xTLmxlbmd0aDtcbmV4cG9ydCBjb25zdCBCVUlMVElOX1RPT0xfTkFNRVMgPSBUT09MUy5tYXAodCA9PiB0Lm5hbWUpO1xuXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRNY3BUb29sQ2FsbE5hbWUoc2VydmVyTmFtZSwgdG9vbE5hbWUpIHtcbiAgcmV0dXJuIGBtY3BfJHtzZXJ2ZXJOYW1lfV8ke3Rvb2xOYW1lfWA7XG59XG5cbi8qKlxuICogR2V0IHRvb2wgZGVmaW5pdGlvbnMgZm9ybWF0dGVkIGZvciB0aGUgc3BlY2lmaWVkIEFQSSB0eXBlLlxuICogTWVyZ2VzIGJ1aWx0LWluIHRvb2xzIHdpdGggTUNQIHRvb2xzLlxuICogQHBhcmFtIHtzdHJpbmd9IGFwaVR5cGUgLSBcIm9wZW5haVwiIG9yIFwiYW50aHJvcGljXCJcbiAqIEBwYXJhbSB7QXJyYXl9IFttY3BUb29sc10gLSBNQ1AgdG9vbHMgZnJvbSBjb25uZWN0ZWQgc2VydmVycyBbe25hbWUsIGRlc2NyaXB0aW9uLCBpbnB1dFNjaGVtYSwgX3NlcnZlclVybCwgX3NlcnZlckhlYWRlcnMsIF90b29sQ2FsbE5hbWV9XVxuICogQHBhcmFtIHtPYmplY3R9IFtvcHRpb25zXVxuICogQHBhcmFtIHtib29sZWFufSBbb3B0aW9ucy5pbmNsdWRlQnVpbHRpbnM9dHJ1ZV0gLSBXaGV0aGVyIHRvIGluY2x1ZGUgYnVpbHQtaW4gYnJvd3NlciB0b29sc1xuICogQHBhcmFtIHtib29sZWFufSBbb3B0aW9ucy5zdXBwb3J0c0ltYWdlSW5wdXQ9dHJ1ZV0gLSBXaGV0aGVyIHRoZSBzZWxlY3RlZCBtb2RlbCBhY2NlcHRzIGltYWdlIGlucHV0c1xuICogQHJldHVybnMge0FycmF5fSBmb3JtYXR0ZWQgdG9vbCBkZWZpbml0aW9uc1xuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0VG9vbHMoYXBpVHlwZSwgbWNwVG9vbHMgPSBbXSwgeyBpbmNsdWRlQnVpbHRpbnMgPSB0cnVlLCBzdXBwb3J0c0ltYWdlSW5wdXQgPSB0cnVlIH0gPSB7fSkge1xuICAvLyBDb252ZXJ0IE1DUCB0b29scyB0byBvdXIgaW50ZXJuYWwgZm9ybWF0XG4gIGNvbnN0IGV4dGVybmFsVG9vbHMgPSBtY3BUb29scy5tYXAodCA9PiAoe1xuICAgIG5hbWU6IHQuX3Rvb2xDYWxsTmFtZSB8fCBidWlsZE1jcFRvb2xDYWxsTmFtZSh0Ll9zZXJ2ZXJOYW1lIHx8IFwic2VydmVyXCIsIHQubmFtZSksXG4gICAgZGVzY3JpcHRpb246IGBbTUNQXSAke3QuZGVzY3JpcHRpb24gfHwgdC5uYW1lfWAsXG4gICAgc2NoZW1hOiB0LmlucHV0U2NoZW1hIHx8IHsgdHlwZTogXCJvYmplY3RcIiwgcHJvcGVydGllczoge30gfVxuICB9KSk7XG5cbiAgY29uc3QgYnVpbHRJblRvb2xzID0gaW5jbHVkZUJ1aWx0aW5zXG4gICAgPyBUT09MUy5maWx0ZXIodG9vbCA9PiBzdXBwb3J0c0ltYWdlSW5wdXQgfHwgdG9vbC5uYW1lICE9PSBcInRhYl9zY3JlZW5zaG90XCIpXG4gICAgOiBbXTtcbiAgY29uc3QgYWxsVG9vbHMgPSBbLi4uYnVpbHRJblRvb2xzLCAuLi5leHRlcm5hbFRvb2xzXTtcblxuICBpZiAoYXBpVHlwZSA9PT0gXCJhbnRocm9waWNcIikge1xuICAgIHJldHVybiBhbGxUb29scy5tYXAodCA9PiAoe1xuICAgICAgbmFtZTogdC5uYW1lLFxuICAgICAgZGVzY3JpcHRpb246IHQuZGVzY3JpcHRpb24sXG4gICAgICBpbnB1dF9zY2hlbWE6IHQuc2NoZW1hXG4gICAgfSkpO1xuICB9XG4gIHJldHVybiBhbGxUb29scy5tYXAodCA9PiAoe1xuICAgIHR5cGU6IFwiZnVuY3Rpb25cIixcbiAgICBmdW5jdGlvbjoge1xuICAgICAgbmFtZTogdC5uYW1lLFxuICAgICAgZGVzY3JpcHRpb246IHQuZGVzY3JpcHRpb24sXG4gICAgICBwYXJhbWV0ZXJzOiB0LnNjaGVtYVxuICAgIH1cbiAgfSkpO1xufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PSBUb29sIEV4ZWN1dG9ycyA9PT09PT09PT09PT09PT09PT09PVxuXG4vKipcbiAqIEV4ZWN1dGUgYSB0b29sIGNhbGwgYnkgbmFtZS4gUm91dGVzIHRvIHRoZSBhcHByb3ByaWF0ZSBoYW5kbGVyLlxuICogTUNQIHRvb2wgbmFtZXMgdXNlIHRoZSBjb25maWd1cmVkIHNlcnZlciBuYW1lIG5hbWVzcGFjZSBhbmQgYXJlIHJvdXRlZFxuICogdG8gdGhlIGNvcnJlc3BvbmRpbmcgTUNQIHNlcnZlci5cbiAqIEFsbCBleGVjdXRvcnMgcmV0dXJuIGEgcmVzdWx0IG9iamVjdCAobmV2ZXIgdGhyb3cpLlxuICogQHBhcmFtIHtzdHJpbmd9IG5hbWUgLSB0b29sIG5hbWVcbiAqIEBwYXJhbSB7T2JqZWN0fSBhcmdzIC0gdG9vbCBhcmd1bWVudHNcbiAqIEBwYXJhbSB7QXJyYXl9IFttY3BSZWdpc3RyeV0gLSBNQ1AgdG9vbCByZWdpc3RyeSBbe25hbWUsIF9zZXJ2ZXJVcmwsIF9zZXJ2ZXJIZWFkZXJzLCBfdG9vbENhbGxOYW1lfV1cbiAqIEByZXR1cm5zIHtQcm9taXNlPE9iamVjdD59IHJlc3VsdCB0byBzZW5kIGJhY2sgdG8gTExNXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBleGVjdXRlVG9vbChuYW1lLCBhcmdzLCBtY3BSZWdpc3RyeSA9IFtdKSB7XG4gIHRyeSB7XG4gICAgLy8gUm91dGUgTUNQIHRvb2xzIHRvIGV4dGVybmFsIHNlcnZlclxuICAgIGlmIChuYW1lLnN0YXJ0c1dpdGgoXCJtY3BfXCIpKSB7XG4gICAgICBjb25zdCBtY3BUb29sID0gbWNwUmVnaXN0cnkuZmluZCh0ID0+XG4gICAgICAgICh0Ll90b29sQ2FsbE5hbWUgfHwgYnVpbGRNY3BUb29sQ2FsbE5hbWUodC5fc2VydmVyTmFtZSB8fCBcInNlcnZlclwiLCB0Lm5hbWUpKSA9PT0gbmFtZVxuICAgICAgKTtcbiAgICAgIGlmICghbWNwVG9vbCkgcmV0dXJuIHsgZXJyb3I6IGBNQ1AgdG9vbCBub3QgZm91bmQ6ICR7bmFtZX1gIH07XG4gICAgICBjb25zdCB7IG1jcFRvb2xUaW1lb3V0U2Vjb25kcyB9ID0gYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KHtcbiAgICAgICAgbWNwVG9vbFRpbWVvdXRTZWNvbmRzOiBERUZBVUxUX01DUF9UT09MX1RJTUVPVVRfU0VDT05EU1xuICAgICAgfSk7XG4gICAgICBjb25zdCB0aW1lb3V0TXMgPSBNYXRoLm1heCgxLCBOdW1iZXIobWNwVG9vbFRpbWVvdXRTZWNvbmRzKSB8fCBERUZBVUxUX01DUF9UT09MX1RJTUVPVVRfU0VDT05EUykgKiAxMDAwO1xuXG4gICAgICByZXR1cm4gYXdhaXQgY2FsbE1jcFRvb2wobWNwVG9vbC5fc2VydmVyVXJsLCBtY3BUb29sLl9zZXJ2ZXJIZWFkZXJzLCBtY3BUb29sLm5hbWUsIGFyZ3MsIHRpbWVvdXRNcyk7XG4gICAgfVxuXG4gICAgLy8gQnVpbHQtaW4gdG9vbHNcbiAgICBzd2l0Y2ggKG5hbWUpIHtcbiAgICAgIGNhc2UgXCJ0YWJfbGlzdFwiOiAgICByZXR1cm4gYXdhaXQgX2V4ZWNUYWJMaXN0KGFyZ3MpO1xuICAgICAgY2FzZSBcInRhYl9leHRyYWN0XCI6IHJldHVybiBhd2FpdCBfZXhlY1RhYkV4dHJhY3QoYXJncyk7XG4gICAgICBjYXNlIFwidGFiX3Njcm9sbFwiOiAgcmV0dXJuIGF3YWl0IF9leGVjVGFiU2Nyb2xsKGFyZ3MpO1xuICAgICAgY2FzZSBcImRvbV9xdWVyeVwiOiAgIHJldHVybiBhd2FpdCBfZXhlY0RvbVF1ZXJ5KGFyZ3MpO1xuICAgICAgY2FzZSBcImRvbV9jbGlja1wiOiAgIHJldHVybiBhd2FpdCBfZXhlY0RvbUNsaWNrKGFyZ3MpO1xuICAgICAgY2FzZSBcImRvbV9zZXRfdmFsdWVcIjogcmV0dXJuIGF3YWl0IF9leGVjRG9tU2V0VmFsdWUoYXJncyk7XG4gICAgICBjYXNlIFwiZG9tX3N0eWxlXCI6ICAgcmV0dXJuIGF3YWl0IF9leGVjRG9tU3R5bGUoYXJncyk7XG4gICAgICBjYXNlIFwiZG9tX2dldF9odG1sXCI6IHJldHVybiBhd2FpdCBfZXhlY0RvbUdldEh0bWwoYXJncyk7XG4gICAgICBjYXNlIFwiZG9tX2hpZ2hsaWdodFwiOiByZXR1cm4gYXdhaXQgX2V4ZWNEb21IaWdobGlnaHQoYXJncyk7XG4gICAgICBjYXNlIFwiZXZhbF9qc1wiOiAgICAgcmV0dXJuIGF3YWl0IF9leGVjRXZhbEpzKGFyZ3MpO1xuICAgICAgY2FzZSBcInRhYl9vcGVuXCI6ICAgIHJldHVybiBhd2FpdCBfZXhlY1RhYk9wZW4oYXJncyk7XG4gICAgICBjYXNlIFwidGFiX2ZvY3VzXCI6ICAgcmV0dXJuIGF3YWl0IF9leGVjVGFiRm9jdXMoYXJncyk7XG4gICAgICBjYXNlIFwidGFiX2Nsb3NlXCI6ICAgcmV0dXJuIGF3YWl0IF9leGVjVGFiQ2xvc2UoYXJncyk7XG4gICAgICBjYXNlIFwidGFiX2dyb3VwXCI6ICAgcmV0dXJuIGF3YWl0IF9leGVjVGFiR3JvdXAoYXJncyk7XG4gICAgICBjYXNlIFwiZ3JvdXBfbGlzdFwiOiByZXR1cm4gYXdhaXQgX2V4ZWNHcm91cExpc3QoYXJncyk7XG4gICAgICBjYXNlIFwiZ3JvdXBfZ2V0XCI6IHJldHVybiBhd2FpdCBfZXhlY0dyb3VwR2V0KGFyZ3MpO1xuICAgICAgY2FzZSBcImdyb3VwX3VwZGF0ZVwiOiByZXR1cm4gYXdhaXQgX2V4ZWNHcm91cFVwZGF0ZShhcmdzKTtcbiAgICAgIGNhc2UgXCJncm91cF9hZGRfdGFic1wiOiByZXR1cm4gYXdhaXQgX2V4ZWNHcm91cEFkZFRhYnMoYXJncyk7XG4gICAgICBjYXNlIFwiZ3JvdXBfcmVtb3ZlX3RhYnNcIjogcmV0dXJuIGF3YWl0IF9leGVjR3JvdXBSZW1vdmVUYWJzKGFyZ3MpO1xuICAgICAgY2FzZSBcImdyb3VwX3VuZ3JvdXBcIjogcmV0dXJuIGF3YWl0IF9leGVjR3JvdXBVbmdyb3VwKGFyZ3MpO1xuICAgICAgY2FzZSBcImhpc3Rvcnlfc2VhcmNoXCI6IHJldHVybiBhd2FpdCBfZXhlY0hpc3RvcnlTZWFyY2goYXJncyk7XG4gICAgICBjYXNlIFwiaGlzdG9yeV9yZWNlbnRcIjogcmV0dXJuIGF3YWl0IF9leGVjSGlzdG9yeVJlY2VudChhcmdzKTtcbiAgICAgIGNhc2UgXCJ0YWJfZ2V0X2FjdGl2ZVwiOiByZXR1cm4gYXdhaXQgX2V4ZWNUYWJHZXRBY3RpdmUoYXJncyk7XG4gICAgICBjYXNlIFwidGFiX3NjcmVlbnNob3RcIjogcmV0dXJuIGF3YWl0IF9leGVjVGFiU2NyZWVuc2hvdChhcmdzKTtcbiAgICAgIGNhc2UgXCJ3aW5kb3dfbGlzdFwiOiByZXR1cm4gYXdhaXQgX2V4ZWNXaW5kb3dMaXN0KGFyZ3MpO1xuICAgICAgY2FzZSBcIndpbmRvd19nZXRfY3VycmVudFwiOiByZXR1cm4gYXdhaXQgX2V4ZWNXaW5kb3dHZXRDdXJyZW50KGFyZ3MpO1xuICAgICAgY2FzZSBcIndpbmRvd19mb2N1c1wiOiByZXR1cm4gYXdhaXQgX2V4ZWNXaW5kb3dGb2N1cyhhcmdzKTtcbiAgICAgIGNhc2UgXCJ3aW5kb3dfbW92ZV90YWJcIjogcmV0dXJuIGF3YWl0IF9leGVjV2luZG93TW92ZVRhYihhcmdzKTtcbiAgICAgIGNhc2UgXCJ3aW5kb3dfY3JlYXRlXCI6IHJldHVybiBhd2FpdCBfZXhlY1dpbmRvd0NyZWF0ZShhcmdzKTtcbiAgICAgIGNhc2UgXCJ3aW5kb3dfY2xvc2VcIjogcmV0dXJuIGF3YWl0IF9leGVjV2luZG93Q2xvc2UoYXJncyk7XG4gICAgICBjYXNlIFwiZ2V0X2N1cnJlbnRfdGltZVwiOiByZXR1cm4gX2V4ZWNHZXRDdXJyZW50VGltZSgpO1xuICAgICAgY2FzZSBcInNjaGVkdWxlX3Rvb2xcIjogcmV0dXJuIGF3YWl0IF9leGVjU2NoZWR1bGVUb29sKGFyZ3MsIG1jcFJlZ2lzdHJ5KTtcbiAgICAgIGNhc2UgXCJsaXN0X3NjaGVkdWxlZFwiOiByZXR1cm4gX2V4ZWNMaXN0U2NoZWR1bGVkKCk7XG4gICAgICBjYXNlIFwiY2FuY2VsX3NjaGVkdWxlZFwiOiByZXR1cm4gX2V4ZWNDYW5jZWxTY2hlZHVsZWQoYXJncyk7XG4gICAgICBjYXNlIFwiY2xlYXJfY29tcGxldGVkX3NjaGVkdWxlZFwiOiByZXR1cm4gX2V4ZWNDbGVhckNvbXBsZXRlZFNjaGVkdWxlZCgpO1xuICAgICAgZGVmYXVsdDogcmV0dXJuIHsgZXJyb3I6IGBVbmtub3duIHRvb2w6ICR7bmFtZX1gIH07XG4gICAgfVxuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc3QgbXNnID0gZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpO1xuICAgIHJldHVybiB7XG4gICAgICBlcnJvcjogbXNnLFxuICAgICAgaGludDogXCJUaGUgb3BlcmF0aW9uIGZhaWxlZC5cIlxuICAgIH07XG4gIH1cbn1cblxuLyoqXG4gKiBCdWlsZCBjb25zaXN0ZW50IHRpbWluZyBtZXRhZGF0YSBmb3IgYnJvd3NlciBzdGF0ZSBzbmFwc2hvdHMuXG4gKi9cbmZ1bmN0aW9uIF9idWlsZENhcHR1cmVkQXQoKSB7XG4gIGNvbnN0IG5vdyA9IG5ldyBEYXRlKCk7XG4gIHJldHVybiB7XG4gICAgdGltZXN0YW1wOiBub3cuZ2V0VGltZSgpLFxuICAgIGlzbzogbm93LnRvSVNPU3RyaW5nKCksXG4gICAgbG9jYWw6IG5vdy50b0xvY2FsZVN0cmluZygpLFxuICAgIHRpbWV6b25lOiBJbnRsLkRhdGVUaW1lRm9ybWF0KCkucmVzb2x2ZWRPcHRpb25zKCkudGltZVpvbmVcbiAgfTtcbn1cblxuLyoqXG4gKiBQYXJzZSBhIGJhc2U2NCBkYXRhIFVSTCBhbmQgZXN0aW1hdGUgaXRzIGRlY29kZWQgYnl0ZSBzaXplLlxuICovXG5mdW5jdGlvbiBfcGFyc2VEYXRhVXJsKGRhdGFVcmw6IHN0cmluZykge1xuICBpZiAodHlwZW9mIGRhdGFVcmwgIT09IFwic3RyaW5nXCIpIHJldHVybiBudWxsO1xuICBjb25zdCBtYXRjaCA9IGRhdGFVcmwubWF0Y2goL15kYXRhOihbXjtdKyk7YmFzZTY0LCguKykkLyk7XG4gIGlmICghbWF0Y2gpIHJldHVybiBudWxsO1xuICBjb25zdCBbLCBtZWRpYVR5cGUsIGJhc2U2NERhdGFdID0gbWF0Y2g7XG4gIGNvbnN0IHBhZGRpbmcgPSBiYXNlNjREYXRhLmVuZHNXaXRoKFwiPT1cIikgPyAyIDogKGJhc2U2NERhdGEuZW5kc1dpdGgoXCI9XCIpID8gMSA6IDApO1xuICByZXR1cm4ge1xuICAgIG1lZGlhVHlwZSxcbiAgICBiYXNlNjREYXRhLFxuICAgIGFwcHJveEJ5dGVzOiBNYXRoLm1heCgwLCBNYXRoLmZsb29yKGJhc2U2NERhdGEubGVuZ3RoICogMyAvIDQpIC0gcGFkZGluZylcbiAgfTtcbn1cblxuLyoqXG4gKiBSZXNpemUgYW5kIHJlY29tcHJlc3Mgc2NyZWVuc2hvdHMgc28gdGhleSBhcmUgcHJhY3RpY2FsIGZvciBtdWx0aW1vZGFsIHRvb2wgcmVzdWx0cy5cbiAqXG4gKiBAcGFyYW0ge3N0cmluZ30gZGF0YVVybFxuICogQHBhcmFtIG9wdGlvbnNcbiAqICAgLSBmaXRNYXhFZGdlIChkZWZhdWx0KTogc2NhbGUgc28gbWF4KHdpZHRoLGhlaWdodCkgPD0gMTYwMCAoc2luZ2xlLXZpZXdwb3J0IHNob3RzKS5cbiAqICAgLSBmaXRXaWR0aDogb25seSBzaHJpbmsgd2hlbiB3aWR0aCBleGNlZWRzIG1heFdpZHRoOyBrZWVwcyB0YWxsIHN0aXRjaGVkIHBhZ2VzIHJlYWRhYmxlIChhdm9pZHMgY3J1c2hpbmcgaGVpZ2h0KS5cbiAqL1xuaW50ZXJmYWNlIFNjcmVlbnNob3RPcHRpbWl6ZU9wdGlvbnMge1xuICBzdHJhdGVneT86IFwiZml0TWF4RWRnZVwiIHwgXCJmaXRXaWR0aFwiO1xuICBtYXhXaWR0aD86IG51bWJlcjtcbiAgbWF4SGVpZ2h0PzogbnVtYmVyO1xuICBqcGVnUXVhbGl0eT86IG51bWJlcjtcbn1cblxuYXN5bmMgZnVuY3Rpb24gX29wdGltaXplU2NyZWVuc2hvdERhdGFVcmwoZGF0YVVybDogc3RyaW5nLCBvcHRpb25zOiBTY3JlZW5zaG90T3B0aW1pemVPcHRpb25zID0ge30pIHtcbiAgY29uc3QgcGFyc2VkID0gX3BhcnNlRGF0YVVybChkYXRhVXJsKTtcbiAgaWYgKCFwYXJzZWQgfHwgdHlwZW9mIGRvY3VtZW50ID09PSBcInVuZGVmaW5lZFwiKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGRhdGFVcmwsXG4gICAgICBtZWRpYVR5cGU6IHBhcnNlZD8ubWVkaWFUeXBlIHx8IFwiaW1hZ2UvcG5nXCIsXG4gICAgICBhcHByb3hCeXRlczogcGFyc2VkPy5hcHByb3hCeXRlcyB8fCBudWxsLFxuICAgICAgd2lkdGg6IG51bGwsXG4gICAgICBoZWlnaHQ6IG51bGwsXG4gICAgICBvcmlnaW5hbFdpZHRoOiBudWxsLFxuICAgICAgb3JpZ2luYWxIZWlnaHQ6IG51bGwsXG4gICAgICBvcHRpbWl6ZWQ6IGZhbHNlXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IHN0cmF0ZWd5ID0gb3B0aW9ucy5zdHJhdGVneSA9PT0gXCJmaXRXaWR0aFwiID8gXCJmaXRXaWR0aFwiIDogXCJmaXRNYXhFZGdlXCI7XG4gIGNvbnN0IGpwZWdRdWFsaXR5ID1cbiAgICB0eXBlb2Ygb3B0aW9ucy5qcGVnUXVhbGl0eSA9PT0gXCJudW1iZXJcIlxuICAgICAgPyBNYXRoLm1pbigxLCBNYXRoLm1heCgwLjUsIG9wdGlvbnMuanBlZ1F1YWxpdHkpKVxuICAgICAgOiBzdHJhdGVneSA9PT0gXCJmaXRXaWR0aFwiXG4gICAgICAgID8gMC44OFxuICAgICAgICA6IDAuNztcblxuICB0cnkge1xuICAgIGNvbnN0IGltZyA9IGF3YWl0IG5ldyBQcm9taXNlPEhUTUxJbWFnZUVsZW1lbnQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgIGNvbnN0IGltYWdlID0gbmV3IEltYWdlKCk7XG4gICAgICBpbWFnZS5vbmxvYWQgPSAoKSA9PiByZXNvbHZlKGltYWdlKTtcbiAgICAgIGltYWdlLm9uZXJyb3IgPSByZWplY3Q7XG4gICAgICBpbWFnZS5zcmMgPSBkYXRhVXJsO1xuICAgIH0pO1xuXG4gICAgY29uc3Qgb3JpZ2luYWxXaWR0aCA9IGltZy5uYXR1cmFsV2lkdGggfHwgaW1nLndpZHRoIHx8IG51bGw7XG4gICAgY29uc3Qgb3JpZ2luYWxIZWlnaHQgPSBpbWcubmF0dXJhbEhlaWdodCB8fCBpbWcuaGVpZ2h0IHx8IG51bGw7XG4gICAgbGV0IHNjYWxlID0gMTtcbiAgICBpZiAob3JpZ2luYWxXaWR0aCAmJiBvcmlnaW5hbEhlaWdodCkge1xuICAgICAgaWYgKHN0cmF0ZWd5ID09PSBcImZpdFdpZHRoXCIpIHtcbiAgICAgICAgY29uc3QgbWF4VyA9IE51bWJlci5pc0Zpbml0ZShvcHRpb25zLm1heFdpZHRoKSA/IE1hdGgubWF4KDMyMCwgb3B0aW9ucy5tYXhXaWR0aCkgOiAyMDQ4O1xuICAgICAgICBjb25zdCBtYXhIID0gTnVtYmVyLmlzRmluaXRlKG9wdGlvbnMubWF4SGVpZ2h0KSA/IE1hdGgubWF4KDgwMCwgb3B0aW9ucy5tYXhIZWlnaHQpIDogMjQwMDA7XG4gICAgICAgIGlmIChvcmlnaW5hbFdpZHRoID4gbWF4Vykgc2NhbGUgPSBtYXhXIC8gb3JpZ2luYWxXaWR0aDtcbiAgICAgICAgY29uc3QgaEFmdGVyID0gb3JpZ2luYWxIZWlnaHQgKiBzY2FsZTtcbiAgICAgICAgaWYgKGhBZnRlciA+IG1heEgpIHNjYWxlICo9IG1heEggLyBoQWZ0ZXI7XG4gICAgICAgIHNjYWxlID0gTWF0aC5taW4oMSwgc2NhbGUpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29uc3QgbWF4RGltZW5zaW9uID0gMTYwMDtcbiAgICAgICAgc2NhbGUgPSBNYXRoLm1pbigxLCBtYXhEaW1lbnNpb24gLyBNYXRoLm1heChvcmlnaW5hbFdpZHRoLCBvcmlnaW5hbEhlaWdodCkpO1xuICAgICAgfVxuICAgIH1cbiAgICBjb25zdCB3aWR0aCA9IG9yaWdpbmFsV2lkdGggPyBNYXRoLm1heCgxLCBNYXRoLnJvdW5kKG9yaWdpbmFsV2lkdGggKiBzY2FsZSkpIDogbnVsbDtcbiAgICBjb25zdCBoZWlnaHQgPSBvcmlnaW5hbEhlaWdodCA/IE1hdGgubWF4KDEsIE1hdGgucm91bmQob3JpZ2luYWxIZWlnaHQgKiBzY2FsZSkpIDogbnVsbDtcblxuICAgIGNvbnN0IGNhbnZhcyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJjYW52YXNcIik7XG4gICAgY2FudmFzLndpZHRoID0gd2lkdGggfHwgaW1nLndpZHRoO1xuICAgIGNhbnZhcy5oZWlnaHQgPSBoZWlnaHQgfHwgaW1nLmhlaWdodDtcbiAgICBjb25zdCBjdHggPSBjYW52YXMuZ2V0Q29udGV4dChcIjJkXCIsIHsgYWxwaGE6IGZhbHNlIH0pO1xuICAgIGlmICghY3R4KSB0aHJvdyBuZXcgRXJyb3IoXCIyRCBjYW52YXMgY29udGV4dCB1bmF2YWlsYWJsZVwiKTtcbiAgICBjdHguZHJhd0ltYWdlKGltZywgMCwgMCwgY2FudmFzLndpZHRoLCBjYW52YXMuaGVpZ2h0KTtcblxuICAgIGNvbnN0IG9wdGltaXplZERhdGFVcmwgPSBjYW52YXMudG9EYXRhVVJMKFwiaW1hZ2UvanBlZ1wiLCBqcGVnUXVhbGl0eSk7XG4gICAgY29uc3Qgb3B0aW1pemVkUGFyc2VkID0gX3BhcnNlRGF0YVVybChvcHRpbWl6ZWREYXRhVXJsKTtcbiAgICByZXR1cm4ge1xuICAgICAgZGF0YVVybDogb3B0aW1pemVkRGF0YVVybCxcbiAgICAgIG1lZGlhVHlwZTogb3B0aW1pemVkUGFyc2VkPy5tZWRpYVR5cGUgfHwgXCJpbWFnZS9qcGVnXCIsXG4gICAgICBhcHByb3hCeXRlczogb3B0aW1pemVkUGFyc2VkPy5hcHByb3hCeXRlcyB8fCBudWxsLFxuICAgICAgd2lkdGg6IGNhbnZhcy53aWR0aCxcbiAgICAgIGhlaWdodDogY2FudmFzLmhlaWdodCxcbiAgICAgIG9yaWdpbmFsV2lkdGgsXG4gICAgICBvcmlnaW5hbEhlaWdodCxcbiAgICAgIG9wdGltaXplZDogb3B0aW1pemVkRGF0YVVybC5sZW5ndGggPCBkYXRhVXJsLmxlbmd0aCB8fCBzY2FsZSA8IDFcbiAgICB9O1xuICB9IGNhdGNoIChlKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGRhdGFVcmwsXG4gICAgICBtZWRpYVR5cGU6IHBhcnNlZC5tZWRpYVR5cGUsXG4gICAgICBhcHByb3hCeXRlczogcGFyc2VkLmFwcHJveEJ5dGVzLFxuICAgICAgd2lkdGg6IG51bGwsXG4gICAgICBoZWlnaHQ6IG51bGwsXG4gICAgICBvcmlnaW5hbFdpZHRoOiBudWxsLFxuICAgICAgb3JpZ2luYWxIZWlnaHQ6IG51bGwsXG4gICAgICBvcHRpbWl6ZWQ6IGZhbHNlXG4gICAgfTtcbiAgfVxufVxuXG4vKipcbiAqIE5vcm1hbGl6ZSBDaHJvbWUncyBsYXN0QWNjZXNzZWQgZmllbGQgZm9yIHRvb2wgcmVzcG9uc2VzLlxuICovXG5mdW5jdGlvbiBfYnVpbGRMYXN0QWNjZXNzZWQobGFzdEFjY2Vzc2VkKSB7XG4gIGlmICh0eXBlb2YgbGFzdEFjY2Vzc2VkICE9PSBcIm51bWJlclwiKSB7XG4gICAgcmV0dXJuIHsgbGFzdEFjY2Vzc2VkOiBudWxsLCBsYXN0QWNjZXNzZWRJc286IG51bGwgfTtcbiAgfVxuICByZXR1cm4ge1xuICAgIGxhc3RBY2Nlc3NlZCxcbiAgICBsYXN0QWNjZXNzZWRJc286IG5ldyBEYXRlKGxhc3RBY2Nlc3NlZCkudG9JU09TdHJpbmcoKVxuICB9O1xufVxuXG4vKipcbiAqIE5vcm1hbGl6ZSBDaHJvbWUncyBncm91cElkIGZpZWxkIGZvciB0b29sIHJlc3BvbnNlcy5cbiAqL1xuZnVuY3Rpb24gX25vcm1hbGl6ZUdyb3VwSWQoZ3JvdXBJZCkge1xuICByZXR1cm4gdHlwZW9mIGdyb3VwSWQgPT09IFwibnVtYmVyXCIgJiYgZ3JvdXBJZCA+PSAwID8gZ3JvdXBJZCA6IG51bGw7XG59XG5cbi8qKlxuICogU2VyaWFsaXplIGNvbW1vbiB0YWIgbWV0YWRhdGEgZm9yIHRvb2wgcmVzcG9uc2VzLlxuICovXG5mdW5jdGlvbiBfc2VyaWFsaXplVGFiTWV0YWRhdGEodGFiKSB7XG4gIHJldHVybiB7XG4gICAgaWQ6IHRhYi5pZCxcbiAgICB1cmw6IHRhYi51cmwgfHwgXCJcIixcbiAgICB0aXRsZTogdGFiLnRpdGxlIHx8IFwiXCIsXG4gICAgd2luZG93SWQ6IHRhYi53aW5kb3dJZCxcbiAgICBncm91cElkOiBfbm9ybWFsaXplR3JvdXBJZCh0YWIuZ3JvdXBJZCksXG4gICAgLi4uX2J1aWxkTGFzdEFjY2Vzc2VkKHRhYi5sYXN0QWNjZXNzZWQpXG4gIH07XG59XG5cbi8qKlxuICogU2VyaWFsaXplIGNvbW1vbiB0YWIgZ3JvdXAgbWV0YWRhdGEgZm9yIHRvb2wgcmVzcG9uc2VzLlxuICovXG5mdW5jdGlvbiBfc2VyaWFsaXplR3JvdXBNZXRhZGF0YShncm91cCwgdGFicyA9IFtdLCBjdXJyZW50V2luZG93SWQgPSBudWxsKSB7XG4gIHJldHVybiB7XG4gICAgaWQ6IGdyb3VwLmlkLFxuICAgIHdpbmRvd0lkOiBncm91cC53aW5kb3dJZCxcbiAgICBjdXJyZW50V2luZG93OiBjdXJyZW50V2luZG93SWQgIT0gbnVsbCA/IGdyb3VwLndpbmRvd0lkID09PSBjdXJyZW50V2luZG93SWQgOiBudWxsLFxuICAgIHRpdGxlOiBncm91cC50aXRsZSB8fCBcIlwiLFxuICAgIGNvbG9yOiBncm91cC5jb2xvciB8fCBcIlwiLFxuICAgIGNvbGxhcHNlZDogISFncm91cC5jb2xsYXBzZWQsXG4gICAgdGFiQ291bnQ6IHRhYnMubGVuZ3RoLFxuICAgIHRhYnM6IHRhYnMubWFwKHRhYiA9PiBfc2VyaWFsaXplVGFiTWV0YWRhdGEodGFiKSlcbiAgfTtcbn1cblxuLyoqXG4gKiBMb2FkIGV2ZXJ5IHRhYiBncm91cCBzbmFwc2hvdCBpbiBvbmUgcGFzcy5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gX2xvYWRBbGxHcm91cFNuYXBzaG90cygpIHtcbiAgY29uc3QgW2dyb3VwcywgdGFicywgY3VycmVudFdpbmRvd10gPSBhd2FpdCBQcm9taXNlLmFsbChbXG4gICAgY2hyb21lLnRhYkdyb3Vwcy5xdWVyeSh7fSksXG4gICAgY2hyb21lLnRhYnMucXVlcnkoe30pLFxuICAgIGNocm9tZS53aW5kb3dzLmdldEN1cnJlbnQoe30pXG4gIF0pO1xuXG4gIGNvbnN0IHRhYnNCeUdyb3VwSWQgPSBuZXcgTWFwKCk7XG4gIGZvciAoY29uc3QgdGFiIG9mIHRhYnMpIHtcbiAgICBjb25zdCBncm91cElkID0gX25vcm1hbGl6ZUdyb3VwSWQodGFiLmdyb3VwSWQpO1xuICAgIGlmIChncm91cElkID09IG51bGwpIGNvbnRpbnVlO1xuICAgIGlmICghdGFic0J5R3JvdXBJZC5oYXMoZ3JvdXBJZCkpIHRhYnNCeUdyb3VwSWQuc2V0KGdyb3VwSWQsIFtdKTtcbiAgICB0YWJzQnlHcm91cElkLmdldChncm91cElkKS5wdXNoKHRhYik7XG4gIH1cblxuICByZXR1cm4gZ3JvdXBzLm1hcChncm91cCA9PiBfc2VyaWFsaXplR3JvdXBNZXRhZGF0YShcbiAgICBncm91cCxcbiAgICB0YWJzQnlHcm91cElkLmdldChncm91cC5pZCkgfHwgW10sXG4gICAgY3VycmVudFdpbmRvdz8uaWQgPz8gbnVsbFxuICApKTtcbn1cblxuLyoqXG4gKiBMb2FkIGEgc2luZ2xlIHRhYiBncm91cCBzbmFwc2hvdCBieSBncm91cElkLlxuICovXG5hc3luYyBmdW5jdGlvbiBfbG9hZEdyb3VwU25hcHNob3QoZ3JvdXBJZCkge1xuICBjb25zdCBncm91cHMgPSBhd2FpdCBfbG9hZEFsbEdyb3VwU25hcHNob3RzKCk7XG4gIHJldHVybiBncm91cHMuZmluZChncm91cCA9PiBncm91cC5pZCA9PT0gZ3JvdXBJZCkgfHwgbnVsbDtcbn1cblxuLyoqXG4gKiBTZXJpYWxpemUgY29tbW9uIHdpbmRvdyBtZXRhZGF0YSBmb3IgdG9vbCByZXNwb25zZXMuXG4gKi9cbmZ1bmN0aW9uIF9zZXJpYWxpemVXaW5kb3dNZXRhZGF0YSh3aW4sIGN1cnJlbnRXaW5kb3dJZCA9IG51bGwpIHtcbiAgcmV0dXJuIHtcbiAgICBpZDogd2luLmlkLFxuICAgIGZvY3VzZWQ6ICEhd2luLmZvY3VzZWQsXG4gICAgY3VycmVudDogY3VycmVudFdpbmRvd0lkICE9IG51bGwgPyB3aW4uaWQgPT09IGN1cnJlbnRXaW5kb3dJZCA6IG51bGwsXG4gICAgdHlwZTogd2luLnR5cGUgfHwgXCJcIixcbiAgICBzdGF0ZTogd2luLnN0YXRlIHx8IFwiXCIsXG4gICAgaW5jb2duaXRvOiAhIXdpbi5pbmNvZ25pdG8sXG4gICAgdG9wOiB0eXBlb2Ygd2luLnRvcCA9PT0gXCJudW1iZXJcIiA/IHdpbi50b3AgOiBudWxsLFxuICAgIGxlZnQ6IHR5cGVvZiB3aW4ubGVmdCA9PT0gXCJudW1iZXJcIiA/IHdpbi5sZWZ0IDogbnVsbCxcbiAgICB3aWR0aDogdHlwZW9mIHdpbi53aWR0aCA9PT0gXCJudW1iZXJcIiA/IHdpbi53aWR0aCA6IG51bGwsXG4gICAgaGVpZ2h0OiB0eXBlb2Ygd2luLmhlaWdodCA9PT0gXCJudW1iZXJcIiA/IHdpbi5oZWlnaHQgOiBudWxsLFxuICAgIHRhYkNvdW50OiBBcnJheS5pc0FycmF5KHdpbi50YWJzKSA/IHdpbi50YWJzLmxlbmd0aCA6IG51bGwsXG4gICAgdGFiczogQXJyYXkuaXNBcnJheSh3aW4udGFicykgPyB3aW4udGFicy5tYXAodGFiID0+IF9zZXJpYWxpemVUYWJNZXRhZGF0YSh0YWIpKSA6IFtdXG4gIH07XG59XG5cbi8qKlxuICogR2V0IGluZm8gYWJvdXQgYWxsIGN1cnJlbnRseSBvcGVuIHRhYnMuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIF9leGVjVGFiTGlzdCh7IG1heFNpemUgPSAtMSwgYnJpZWZVcmwgPSBmYWxzZSB9ID0ge30pIHtcbiAgY29uc3QgY2FwdHVyZWRBdCA9IF9idWlsZENhcHR1cmVkQXQoKTtcbiAgbGV0IHRhYnMgPSBhd2FpdCBjaHJvbWUudGFicy5xdWVyeSh7fSk7XG4gIGlmIChtYXhTaXplID4gMCkgdGFicyA9IHRhYnMuc2xpY2UoMCwgbWF4U2l6ZSk7XG4gIHJldHVybiB7XG4gICAgY2FwdHVyZWRBdCxcbiAgICBjb3VudDogdGFicy5sZW5ndGgsXG4gICAgdGFiczogdGFicy5tYXAodGFiID0+IHtcbiAgICAgIGNvbnN0IG1ldGEgPSBfc2VyaWFsaXplVGFiTWV0YWRhdGEodGFiKTtcbiAgICAgIGlmIChicmllZlVybCkge1xuICAgICAgICB0cnkgeyBtZXRhLnVybCA9IG5ldyBVUkwobWV0YS51cmwpLmhvc3RuYW1lOyB9IGNhdGNoIHsgLyoga2VlcCBvcmlnaW5hbCAqLyB9XG4gICAgICB9XG4gICAgICByZXR1cm4gbWV0YTtcbiAgICB9KVxuICB9O1xufVxuXG4vKipcbiAqIFJlc29sdmUgYSBjb250cm9sbGFibGUgaHR0cChzKSB0YWIsIGRlZmF1bHRpbmcgdG8gdGhlIGN1cnJlbnQgYWN0aXZlIHRhYi5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gX3Jlc29sdmVDb250cm9sbGFibGVUYWIodGFiSWQsIGFjdGlvbkxhYmVsID0gXCJjb250cm9sXCIpIHtcbiAgbGV0IHJlc29sdmVkVGFiSWQgPSB0YWJJZDtcbiAgaWYgKHJlc29sdmVkVGFiSWQgPT0gbnVsbCkge1xuICAgIGNvbnN0IFthY3RpdmVUYWJdID0gYXdhaXQgY2hyb21lLnRhYnMucXVlcnkoeyBhY3RpdmU6IHRydWUsIGxhc3RGb2N1c2VkV2luZG93OiB0cnVlIH0pO1xuICAgIGlmICghYWN0aXZlVGFiPy5pZCkgcmV0dXJuIHsgZXJyb3I6IFwiTm8gYWN0aXZlIHRhYiBmb3VuZFwiIH07XG4gICAgcmVzb2x2ZWRUYWJJZCA9IGFjdGl2ZVRhYi5pZDtcbiAgfVxuXG4gIGNvbnN0IHRhYiA9IGF3YWl0IGNocm9tZS50YWJzLmdldChyZXNvbHZlZFRhYklkKTtcbiAgaWYgKCF0YWIudXJsIHx8ICF0YWIudXJsLnN0YXJ0c1dpdGgoXCJodHRwXCIpKSB7XG4gICAgcmV0dXJuIHsgZXJyb3I6IGBDYW5ub3QgJHthY3Rpb25MYWJlbH0gdGhpcyBwYWdlICgke3RhYi51cmw/LnNwbGl0KFwiOi8vXCIpWzBdIHx8IFwidW5rbm93blwifSBwcm90b2NvbClgIH07XG4gIH1cblxuICByZXR1cm4geyB0YWIgfTtcbn1cblxuLyoqXG4gKiBSdW4gYSBzdHJ1Y3R1cmVkIHBhZ2UgYWN0aW9uIGRpcmVjdGx5IGluc2lkZSB0aGUgdGFyZ2V0IHRhYi5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gX2V4ZWN1dGVQYWdlQWN0aW9uKHRhYiwgYWN0aW9uLCBwYXJhbXMsIGZhaWx1cmVIaW50KSB7XG4gIHRyeSB7XG4gICAgY29uc3Qgc2NyaXB0UHJvbWlzZSA9IGNocm9tZS5zY3JpcHRpbmcuZXhlY3V0ZVNjcmlwdCh7XG4gICAgICB0YXJnZXQ6IHsgdGFiSWQ6IHRhYi5pZCB9LFxuICAgICAgZnVuYzogYXN5bmMgKHBhZ2VBY3Rpb24sIHBhZ2VQYXJhbXMpID0+IHtcbiAgICAgICAgY29uc3QgVEVYVF9MSU1JVCA9IDUwMDtcbiAgICAgICAgY29uc3QgSFRNTF9MSU1JVCA9IDQwMDA7XG4gICAgICAgIGNvbnN0IEhJR0hMSUdIVF9TVFlMRV9JRCA9IFwiX190YWJfbWFuYWdlcl9oaWdobGlnaHRfc3R5bGVfX1wiO1xuICAgICAgICBjb25zdCBISUdITElHSFRfT1ZFUkxBWV9JRCA9IFwiX190YWJfbWFuYWdlcl9oaWdobGlnaHRfb3ZlcmxheV9fXCI7XG5cbiAgICAgICAgZnVuY3Rpb24gc2xlZXAobXMpIHtcbiAgICAgICAgICByZXR1cm4gbmV3IFByb21pc2UocmVzb2x2ZSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIG1zKSk7XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiB0cnVuY2F0ZVRleHQodGV4dCwgbWF4TGVuZ3RoID0gVEVYVF9MSU1JVCkge1xuICAgICAgICAgIGNvbnN0IG5vcm1hbGl6ZWQgPSBTdHJpbmcodGV4dCB8fCBcIlwiKS5yZXBsYWNlKC9cXHMrL2csIFwiIFwiKS50cmltKCk7XG4gICAgICAgICAgcmV0dXJuIG5vcm1hbGl6ZWQubGVuZ3RoID4gbWF4TGVuZ3RoID8gbm9ybWFsaXplZC5zbGljZSgwLCBtYXhMZW5ndGgpICsgXCIuLi5cIiA6IG5vcm1hbGl6ZWQ7XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiBnZXRTY3JvbGxTdGF0ZSgpIHtcbiAgICAgICAgICBjb25zdCBzY3JvbGxlciA9IGRvY3VtZW50LnNjcm9sbGluZ0VsZW1lbnQgfHwgZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50IHx8IGRvY3VtZW50LmJvZHk7XG4gICAgICAgICAgY29uc3Qgdmlld3BvcnRIZWlnaHQgPSB3aW5kb3cuaW5uZXJIZWlnaHQgfHwgZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LmNsaWVudEhlaWdodCB8fCAwO1xuICAgICAgICAgIGNvbnN0IHZpZXdwb3J0V2lkdGggPSB3aW5kb3cuaW5uZXJXaWR0aCB8fCBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuY2xpZW50V2lkdGggfHwgMDtcbiAgICAgICAgICBjb25zdCBkb2N1bWVudEhlaWdodCA9IE1hdGgubWF4KFxuICAgICAgICAgICAgc2Nyb2xsZXI/LnNjcm9sbEhlaWdodCB8fCAwLFxuICAgICAgICAgICAgZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50Py5zY3JvbGxIZWlnaHQgfHwgMCxcbiAgICAgICAgICAgIGRvY3VtZW50LmJvZHk/LnNjcm9sbEhlaWdodCB8fCAwXG4gICAgICAgICAgKTtcbiAgICAgICAgICBjb25zdCBkb2N1bWVudFdpZHRoID0gTWF0aC5tYXgoXG4gICAgICAgICAgICBzY3JvbGxlcj8uc2Nyb2xsV2lkdGggfHwgMCxcbiAgICAgICAgICAgIGRvY3VtZW50LmRvY3VtZW50RWxlbWVudD8uc2Nyb2xsV2lkdGggfHwgMCxcbiAgICAgICAgICAgIGRvY3VtZW50LmJvZHk/LnNjcm9sbFdpZHRoIHx8IDBcbiAgICAgICAgICApO1xuICAgICAgICAgIGNvbnN0IHNjcm9sbFkgPSB3aW5kb3cuc2Nyb2xsWSB8fCBzY3JvbGxlcj8uc2Nyb2xsVG9wIHx8IDA7XG4gICAgICAgICAgY29uc3Qgc2Nyb2xsWCA9IHdpbmRvdy5zY3JvbGxYIHx8IHNjcm9sbGVyPy5zY3JvbGxMZWZ0IHx8IDA7XG4gICAgICAgICAgY29uc3QgbWF4U2Nyb2xsWSA9IE1hdGgubWF4KDAsIGRvY3VtZW50SGVpZ2h0IC0gdmlld3BvcnRIZWlnaHQpO1xuICAgICAgICAgIGNvbnN0IG1heFNjcm9sbFggPSBNYXRoLm1heCgwLCBkb2N1bWVudFdpZHRoIC0gdmlld3BvcnRXaWR0aCk7XG5cbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgdXJsOiBkb2N1bWVudC5VUkwsXG4gICAgICAgICAgICB0aXRsZTogZG9jdW1lbnQudGl0bGUsXG4gICAgICAgICAgICBzY3JvbGxYLFxuICAgICAgICAgICAgc2Nyb2xsWSxcbiAgICAgICAgICAgIG1heFNjcm9sbFgsXG4gICAgICAgICAgICBtYXhTY3JvbGxZLFxuICAgICAgICAgICAgdmlld3BvcnRXaWR0aCxcbiAgICAgICAgICAgIHZpZXdwb3J0SGVpZ2h0LFxuICAgICAgICAgICAgZG9jdW1lbnRXaWR0aCxcbiAgICAgICAgICAgIGRvY3VtZW50SGVpZ2h0LFxuICAgICAgICAgICAgYXRUb3A6IHNjcm9sbFkgPD0gMCxcbiAgICAgICAgICAgIGF0Qm90dG9tOiBzY3JvbGxZID49IG1heFNjcm9sbFksXG4gICAgICAgICAgICBhdExlZnQ6IHNjcm9sbFggPD0gMCxcbiAgICAgICAgICAgIGF0UmlnaHQ6IHNjcm9sbFggPj0gbWF4U2Nyb2xsWFxuICAgICAgICAgIH07XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiBnZXRTZWFyY2hhYmxlVGV4dChlbGVtZW50KSB7XG4gICAgICAgICAgcmV0dXJuIHRydW5jYXRlVGV4dChbXG4gICAgICAgICAgICBlbGVtZW50LmlubmVyVGV4dCxcbiAgICAgICAgICAgIGVsZW1lbnQudGV4dENvbnRlbnQsXG4gICAgICAgICAgICBlbGVtZW50LmdldEF0dHJpYnV0ZShcImFyaWEtbGFiZWxcIiksXG4gICAgICAgICAgICBlbGVtZW50LmdldEF0dHJpYnV0ZShcInRpdGxlXCIpLFxuICAgICAgICAgICAgZWxlbWVudC5nZXRBdHRyaWJ1dGUoXCJwbGFjZWhvbGRlclwiKSxcbiAgICAgICAgICAgIGVsZW1lbnQuZ2V0QXR0cmlidXRlKFwiYWx0XCIpLFxuICAgICAgICAgICAgZWxlbWVudC5nZXRBdHRyaWJ1dGUoXCJ2YWx1ZVwiKVxuICAgICAgICAgIF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oXCIgXCIpLCAyMDAwKS50b0xvd2VyQ2FzZSgpO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gaXNFbGVtZW50VmlzaWJsZShlbGVtZW50KSB7XG4gICAgICAgICAgY29uc3QgcmVjdCA9IGVsZW1lbnQuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG4gICAgICAgICAgY29uc3Qgc3R5bGUgPSB3aW5kb3cuZ2V0Q29tcHV0ZWRTdHlsZShlbGVtZW50KTtcbiAgICAgICAgICBpZiAoc3R5bGUuZGlzcGxheSA9PT0gXCJub25lXCIgfHwgc3R5bGUudmlzaWJpbGl0eSA9PT0gXCJoaWRkZW5cIiB8fCBOdW1iZXIoc3R5bGUub3BhY2l0eSkgPT09IDApIHtcbiAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIHJlY3Qud2lkdGggPiAwICYmIHJlY3QuaGVpZ2h0ID4gMDtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGlzRWxlbWVudENsaWNrYWJsZShlbGVtZW50KSB7XG4gICAgICAgICAgcmV0dXJuIEJvb2xlYW4oXG4gICAgICAgICAgICBlbGVtZW50Lm1hdGNoZXMoXCJhLCBidXR0b24sIGlucHV0LCBzZWxlY3QsIHRleHRhcmVhLCBzdW1tYXJ5LCBvcHRpb24sIGxhYmVsXCIpIHx8XG4gICAgICAgICAgICBlbGVtZW50LmdldEF0dHJpYnV0ZShcInJvbGVcIikgPT09IFwiYnV0dG9uXCIgfHxcbiAgICAgICAgICAgIHR5cGVvZiBlbGVtZW50Lm9uY2xpY2sgPT09IFwiZnVuY3Rpb25cIlxuICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiBzZXJpYWxpemVBdHRyaWJ1dGVzKGVsZW1lbnQpIHtcbiAgICAgICAgICBjb25zdCBpbXBvcnRhbnROYW1lcyA9IFtcbiAgICAgICAgICAgIFwiaWRcIixcbiAgICAgICAgICAgIFwiY2xhc3NcIixcbiAgICAgICAgICAgIFwibmFtZVwiLFxuICAgICAgICAgICAgXCJ0eXBlXCIsXG4gICAgICAgICAgICBcInJvbGVcIixcbiAgICAgICAgICAgIFwiaHJlZlwiLFxuICAgICAgICAgICAgXCJzcmNcIixcbiAgICAgICAgICAgIFwicGxhY2Vob2xkZXJcIixcbiAgICAgICAgICAgIFwiYXJpYS1sYWJlbFwiLFxuICAgICAgICAgICAgXCJmb3JcIixcbiAgICAgICAgICAgIFwidmFsdWVcIlxuICAgICAgICAgIF07XG4gICAgICAgICAgY29uc3QgYXR0cmlidXRlcyA9IHt9O1xuXG4gICAgICAgICAgZm9yIChjb25zdCBuYW1lIG9mIGltcG9ydGFudE5hbWVzKSB7XG4gICAgICAgICAgICBjb25zdCB2YWx1ZSA9IGVsZW1lbnQuZ2V0QXR0cmlidXRlKG5hbWUpO1xuICAgICAgICAgICAgaWYgKHZhbHVlICE9IG51bGwgJiYgdmFsdWUgIT09IFwiXCIpIHtcbiAgICAgICAgICAgICAgYXR0cmlidXRlc1tuYW1lXSA9IHRydW5jYXRlVGV4dCh2YWx1ZSwgMzAwKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG5cbiAgICAgICAgICByZXR1cm4gYXR0cmlidXRlcztcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHNlcmlhbGl6ZVJlY3QoZWxlbWVudCkge1xuICAgICAgICAgIGNvbnN0IHJlY3QgPSBlbGVtZW50LmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICB4OiBNYXRoLnJvdW5kKHJlY3QueCksXG4gICAgICAgICAgICB5OiBNYXRoLnJvdW5kKHJlY3QueSksXG4gICAgICAgICAgICB3aWR0aDogTWF0aC5yb3VuZChyZWN0LndpZHRoKSxcbiAgICAgICAgICAgIGhlaWdodDogTWF0aC5yb3VuZChyZWN0LmhlaWdodCksXG4gICAgICAgICAgICB0b3A6IE1hdGgucm91bmQocmVjdC50b3ApLFxuICAgICAgICAgICAgbGVmdDogTWF0aC5yb3VuZChyZWN0LmxlZnQpLFxuICAgICAgICAgICAgcmlnaHQ6IE1hdGgucm91bmQocmVjdC5yaWdodCksXG4gICAgICAgICAgICBib3R0b206IE1hdGgucm91bmQocmVjdC5ib3R0b20pLFxuICAgICAgICAgICAgcGFnZVg6IE1hdGgucm91bmQocmVjdC5sZWZ0ICsgd2luZG93LnNjcm9sbFgpLFxuICAgICAgICAgICAgcGFnZVk6IE1hdGgucm91bmQocmVjdC50b3AgKyB3aW5kb3cuc2Nyb2xsWSlcbiAgICAgICAgICB9O1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gc2VyaWFsaXplRWxlbWVudChlbGVtZW50LCBpbmRleCkge1xuICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBpbmRleCxcbiAgICAgICAgICAgIHRhZ05hbWU6IGVsZW1lbnQudGFnTmFtZS50b0xvd2VyQ2FzZSgpLFxuICAgICAgICAgICAgdGV4dDogdHJ1bmNhdGVUZXh0KGVsZW1lbnQuaW5uZXJUZXh0IHx8IGVsZW1lbnQudGV4dENvbnRlbnQgfHwgXCJcIiksXG4gICAgICAgICAgICB2YWx1ZTogdHJ1bmNhdGVUZXh0KGVsZW1lbnQudmFsdWUgfHwgXCJcIiwgMzAwKSxcbiAgICAgICAgICAgIHZpc2libGU6IGlzRWxlbWVudFZpc2libGUoZWxlbWVudCksXG4gICAgICAgICAgICBjbGlja2FibGU6IGlzRWxlbWVudENsaWNrYWJsZShlbGVtZW50KSxcbiAgICAgICAgICAgIGF0dHJpYnV0ZXM6IHNlcmlhbGl6ZUF0dHJpYnV0ZXMoZWxlbWVudCksXG4gICAgICAgICAgICByZWN0OiBzZXJpYWxpemVSZWN0KGVsZW1lbnQpXG4gICAgICAgICAgfTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGZpbmRNYXRjaGluZ0VsZW1lbnRzKGxvY2F0b3IpIHtcbiAgICAgICAgICBpZiAoIWxvY2F0b3Iuc2VsZWN0b3IgJiYgIWxvY2F0b3IudGV4dCkge1xuICAgICAgICAgICAgcmV0dXJuIHsgZXJyb3I6IFwiUGxlYXNlIHByb3ZpZGUgYXQgbGVhc3Qgb25lIGxvY2F0b3I6IHNlbGVjdG9yIG9yIHRleHRcIiB9O1xuICAgICAgICAgIH1cblxuICAgICAgICAgIGxldCBlbGVtZW50cztcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgZWxlbWVudHMgPSBsb2NhdG9yLnNlbGVjdG9yXG4gICAgICAgICAgICAgID8gQXJyYXkuZnJvbShkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKGxvY2F0b3Iuc2VsZWN0b3IpKVxuICAgICAgICAgICAgICA6IEFycmF5LmZyb20oZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbChcImJvZHkgKlwiKSk7XG4gICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgcmV0dXJuIHsgZXJyb3I6IGBJbnZhbGlkIHNlbGVjdG9yOiAke2UubWVzc2FnZX1gIH07XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgaWYgKCFsb2NhdG9yLnRleHQpIHtcbiAgICAgICAgICAgIHJldHVybiB7IGVsZW1lbnRzIH07XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgY29uc3Qgc2VhcmNoID0gU3RyaW5nKGxvY2F0b3IudGV4dCkudHJpbSgpLnRvTG93ZXJDYXNlKCk7XG4gICAgICAgICAgY29uc3QgZmlsdGVyZWQgPSBlbGVtZW50cy5maWx0ZXIoZWxlbWVudCA9PiB7XG4gICAgICAgICAgICBjb25zdCBjYW5kaWRhdGUgPSBnZXRTZWFyY2hhYmxlVGV4dChlbGVtZW50KTtcbiAgICAgICAgICAgIHJldHVybiBsb2NhdG9yLm1hdGNoRXhhY3QgPyBjYW5kaWRhdGUgPT09IHNlYXJjaCA6IGNhbmRpZGF0ZS5pbmNsdWRlcyhzZWFyY2gpO1xuICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgcmV0dXJuIHsgZWxlbWVudHM6IGZpbHRlcmVkIH07XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiByZXNvbHZlRWxlbWVudChsb2NhdG9yKSB7XG4gICAgICAgICAgY29uc3QgeyBlbGVtZW50cywgZXJyb3IgfSA9IGZpbmRNYXRjaGluZ0VsZW1lbnRzKGxvY2F0b3IpO1xuICAgICAgICAgIGlmIChlcnJvcikgcmV0dXJuIHsgZXJyb3IgfTtcblxuICAgICAgICAgIGNvbnN0IGluZGV4ID0gTnVtYmVyLmlzSW50ZWdlcihsb2NhdG9yLmluZGV4KSA/IGxvY2F0b3IuaW5kZXggOiAwO1xuICAgICAgICAgIGlmIChpbmRleCA8IDAgfHwgaW5kZXggPj0gZWxlbWVudHMubGVuZ3RoKSB7XG4gICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICBlcnJvcjogZWxlbWVudHMubGVuZ3RoID09PSAwXG4gICAgICAgICAgICAgICAgPyBcIk5vIG1hdGNoaW5nIGVsZW1lbnQgZm91bmRcIlxuICAgICAgICAgICAgICAgIDogYEVsZW1lbnQgaW5kZXggb3V0IG9mIHJhbmdlOiAke2luZGV4fS4gQXZhaWxhYmxlIG1hdGNoZXM6ICR7ZWxlbWVudHMubGVuZ3RofWBcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgcmV0dXJuIHsgZWxlbWVudDogZWxlbWVudHNbaW5kZXhdLCBpbmRleCwgdG90YWxNYXRjaGVzOiBlbGVtZW50cy5sZW5ndGggfTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGVuc3VyZUhpZ2hsaWdodFN0eWxlcygpIHtcbiAgICAgICAgICBpZiAoZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoSElHSExJR0hUX1NUWUxFX0lEKSkgcmV0dXJuO1xuICAgICAgICAgIGNvbnN0IHN0eWxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInN0eWxlXCIpO1xuICAgICAgICAgIHN0eWxlLmlkID0gSElHSExJR0hUX1NUWUxFX0lEO1xuICAgICAgICAgIHN0eWxlLnRleHRDb250ZW50ID0gYFxuICAgICAgICAgICAgQGtleWZyYW1lcyB0YWItbWFuYWdlci1oaWdobGlnaHQtcHVsc2Uge1xuICAgICAgICAgICAgICAwJSwgMTAwJSB7IG9wYWNpdHk6IDAuMjsgdHJhbnNmb3JtOiBzY2FsZSgwLjk4KTsgfVxuICAgICAgICAgICAgICA1MCUgeyBvcGFjaXR5OiAxOyB0cmFuc2Zvcm06IHNjYWxlKDEpOyB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAjJHtISUdITElHSFRfT1ZFUkxBWV9JRH0ge1xuICAgICAgICAgICAgICBwb3NpdGlvbjogZml4ZWQ7XG4gICAgICAgICAgICAgIHBvaW50ZXItZXZlbnRzOiBub25lO1xuICAgICAgICAgICAgICB6LWluZGV4OiAyMTQ3NDgzNjQ3O1xuICAgICAgICAgICAgICBib3JkZXI6IDNweCBzb2xpZCAjZmY1ZjJlO1xuICAgICAgICAgICAgICBiYWNrZ3JvdW5kOiByZ2JhKDI1NSwgOTUsIDQ2LCAwLjEyKTtcbiAgICAgICAgICAgICAgYm94LXNoYWRvdzogMCAwIDAgOTk5OXB4IHJnYmEoMCwgMCwgMCwgMC4wOCk7XG4gICAgICAgICAgICAgIGJvcmRlci1yYWRpdXM6IDEwcHg7XG4gICAgICAgICAgICAgIGFuaW1hdGlvbjogdGFiLW1hbmFnZXItaGlnaGxpZ2h0LXB1bHNlIDAuM3MgZWFzZS1pbi1vdXQgMztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICBgO1xuICAgICAgICAgIGRvY3VtZW50LmRvY3VtZW50RWxlbWVudC5hcHBlbmRDaGlsZChzdHlsZSk7XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiBjbGVhckhpZ2hsaWdodE92ZXJsYXkoKSB7XG4gICAgICAgICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoSElHSExJR0hUX09WRVJMQVlfSUQpPy5yZW1vdmUoKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHNob3dIaWdobGlnaHRPdmVybGF5KGVsZW1lbnQsIGR1cmF0aW9uTXMpIHtcbiAgICAgICAgICBjbGVhckhpZ2hsaWdodE92ZXJsYXkoKTtcbiAgICAgICAgICBlbnN1cmVIaWdobGlnaHRTdHlsZXMoKTtcblxuICAgICAgICAgIGNvbnN0IHJlY3QgPSBlbGVtZW50LmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICAgICAgICAgIGNvbnN0IG92ZXJsYXkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgICAgICAgIG92ZXJsYXkuaWQgPSBISUdITElHSFRfT1ZFUkxBWV9JRDtcbiAgICAgICAgICBvdmVybGF5LnN0eWxlLnRvcCA9IGAke01hdGgubWF4KDAsIHJlY3QudG9wIC0gNil9cHhgO1xuICAgICAgICAgIG92ZXJsYXkuc3R5bGUubGVmdCA9IGAke01hdGgubWF4KDAsIHJlY3QubGVmdCAtIDYpfXB4YDtcbiAgICAgICAgICBvdmVybGF5LnN0eWxlLndpZHRoID0gYCR7TWF0aC5tYXgoOCwgcmVjdC53aWR0aCArIDEyKX1weGA7XG4gICAgICAgICAgb3ZlcmxheS5zdHlsZS5oZWlnaHQgPSBgJHtNYXRoLm1heCg4LCByZWN0LmhlaWdodCArIDEyKX1weGA7XG4gICAgICAgICAgZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LmFwcGVuZENoaWxkKG92ZXJsYXkpO1xuICAgICAgICAgIHdpbmRvdy5zZXRUaW1lb3V0KCgpID0+IG92ZXJsYXkucmVtb3ZlKCksIGR1cmF0aW9uTXMpO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gc2V0Rm9ybUVsZW1lbnRWYWx1ZShlbGVtZW50LCB2YWx1ZSkge1xuICAgICAgICAgIGNvbnN0IHRhZ05hbWUgPSBlbGVtZW50LnRhZ05hbWUudG9Mb3dlckNhc2UoKTtcbiAgICAgICAgICBjb25zdCBzdHJpbmdWYWx1ZSA9IFN0cmluZyh2YWx1ZSA/PyBcIlwiKTtcbiAgICAgICAgICBsZXQgc2V0dGVyID0gbnVsbDtcblxuICAgICAgICAgIGlmICh0YWdOYW1lID09PSBcImlucHV0XCIpIHtcbiAgICAgICAgICAgIHNldHRlciA9IE9iamVjdC5nZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3Iod2luZG93LkhUTUxJbnB1dEVsZW1lbnQucHJvdG90eXBlLCBcInZhbHVlXCIpPy5zZXQ7XG4gICAgICAgICAgfSBlbHNlIGlmICh0YWdOYW1lID09PSBcInRleHRhcmVhXCIpIHtcbiAgICAgICAgICAgIHNldHRlciA9IE9iamVjdC5nZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3Iod2luZG93LkhUTUxUZXh0QXJlYUVsZW1lbnQucHJvdG90eXBlLCBcInZhbHVlXCIpPy5zZXQ7XG4gICAgICAgICAgfSBlbHNlIGlmICh0YWdOYW1lID09PSBcInNlbGVjdFwiKSB7XG4gICAgICAgICAgICBzZXR0ZXIgPSBPYmplY3QuZ2V0T3duUHJvcGVydHlEZXNjcmlwdG9yKHdpbmRvdy5IVE1MU2VsZWN0RWxlbWVudC5wcm90b3R5cGUsIFwidmFsdWVcIik/LnNldDtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBpZiAoc2V0dGVyKSBzZXR0ZXIuY2FsbChlbGVtZW50LCBzdHJpbmdWYWx1ZSk7XG4gICAgICAgICAgZWxzZSBlbGVtZW50LnZhbHVlID0gc3RyaW5nVmFsdWU7XG5cbiAgICAgICAgICBlbGVtZW50LmRpc3BhdGNoRXZlbnQobmV3IEV2ZW50KFwiaW5wdXRcIiwgeyBidWJibGVzOiB0cnVlIH0pKTtcbiAgICAgICAgICBlbGVtZW50LmRpc3BhdGNoRXZlbnQobmV3IEV2ZW50KFwiY2hhbmdlXCIsIHsgYnViYmxlczogdHJ1ZSB9KSk7XG4gICAgICAgIH1cblxuICAgICAgICB0cnkge1xuICAgICAgICAgIGlmIChwYWdlQWN0aW9uID09PSBcInRhYl9zY3JvbGxcIikge1xuICAgICAgICAgICAgY29uc3Qgc3RhdGVCZWZvcmUgPSBnZXRTY3JvbGxTdGF0ZSgpO1xuICAgICAgICAgICAgY29uc3QgYmVoYXZpb3IgPSBwYWdlUGFyYW1zLmJlaGF2aW9yID09PSBcInNtb290aFwiID8gXCJzbW9vdGhcIiA6IFwiYXV0b1wiO1xuICAgICAgICAgICAgY29uc3QgcG9zaXRpb24gPSB0eXBlb2YgcGFnZVBhcmFtcy5wb3NpdGlvbiA9PT0gXCJzdHJpbmdcIiA/IHBhZ2VQYXJhbXMucG9zaXRpb24gOiBudWxsO1xuICAgICAgICAgICAgbGV0IHRvcCA9IG51bGw7XG5cbiAgICAgICAgICAgIGlmIChwb3NpdGlvbiA9PT0gXCJ0b3BcIikgdG9wID0gMDtcbiAgICAgICAgICAgIGVsc2UgaWYgKHBvc2l0aW9uID09PSBcImJvdHRvbVwiKSB0b3AgPSBzdGF0ZUJlZm9yZS5tYXhTY3JvbGxZO1xuICAgICAgICAgICAgZWxzZSBpZiAodHlwZW9mIHBhZ2VQYXJhbXMuZGVsdGFZID09PSBcIm51bWJlclwiICYmIE51bWJlci5pc0Zpbml0ZShwYWdlUGFyYW1zLmRlbHRhWSkpIHtcbiAgICAgICAgICAgICAgdG9wID0gc3RhdGVCZWZvcmUuc2Nyb2xsWSArIHBhZ2VQYXJhbXMuZGVsdGFZO1xuICAgICAgICAgICAgfSBlbHNlIGlmICh0eXBlb2YgcGFnZVBhcmFtcy5wYWdlRnJhY3Rpb24gPT09IFwibnVtYmVyXCIgJiYgTnVtYmVyLmlzRmluaXRlKHBhZ2VQYXJhbXMucGFnZUZyYWN0aW9uKSkge1xuICAgICAgICAgICAgICB0b3AgPSBzdGF0ZUJlZm9yZS5zY3JvbGxZICsgKHN0YXRlQmVmb3JlLnZpZXdwb3J0SGVpZ2h0ICogcGFnZVBhcmFtcy5wYWdlRnJhY3Rpb24pO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgdG9wID0gc3RhdGVCZWZvcmUuc2Nyb2xsWSArIHN0YXRlQmVmb3JlLnZpZXdwb3J0SGVpZ2h0ICogMC44O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0b3AgPSBNYXRoLm1heCgwLCBNYXRoLm1pbihzdGF0ZUJlZm9yZS5tYXhTY3JvbGxZLCB0b3ApKTtcbiAgICAgICAgICAgIHdpbmRvdy5zY3JvbGxUbyh7IHRvcCwgYmVoYXZpb3IgfSk7XG4gICAgICAgICAgICBhd2FpdCBzbGVlcChiZWhhdmlvciA9PT0gXCJzbW9vdGhcIiA/IDQwMCA6IDYwKTtcbiAgICAgICAgICAgIGNvbnN0IHN0YXRlQWZ0ZXIgPSBnZXRTY3JvbGxTdGF0ZSgpO1xuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgc3VjY2VzczogdHJ1ZSxcbiAgICAgICAgICAgICAgYWN0aW9uOiBwb3NpdGlvbiB8fCBcImRlbHRhXCIsXG4gICAgICAgICAgICAgIHJlcXVlc3RlZFRvcDogdG9wLFxuICAgICAgICAgICAgICBtb3ZlZDogTWF0aC5hYnMoc3RhdGVBZnRlci5zY3JvbGxZIC0gc3RhdGVCZWZvcmUuc2Nyb2xsWSkgPiAxLFxuICAgICAgICAgICAgICBiZWZvcmU6IHN0YXRlQmVmb3JlLFxuICAgICAgICAgICAgICBhZnRlcjogc3RhdGVBZnRlclxuICAgICAgICAgICAgfTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBpZiAocGFnZUFjdGlvbiA9PT0gXCJkb21fcXVlcnlcIikge1xuICAgICAgICAgICAgY29uc3QgbWF4UmVzdWx0cyA9IE1hdGgubWluKDIwLCBNYXRoLm1heCgxLCBOdW1iZXIuaXNJbnRlZ2VyKHBhZ2VQYXJhbXMubWF4UmVzdWx0cykgPyBwYWdlUGFyYW1zLm1heFJlc3VsdHMgOiA1KSk7XG4gICAgICAgICAgICBjb25zdCB7IGVsZW1lbnRzLCBlcnJvciB9ID0gZmluZE1hdGNoaW5nRWxlbWVudHMocGFnZVBhcmFtcyk7XG4gICAgICAgICAgICBpZiAoZXJyb3IpIHJldHVybiB7IGVycm9yIH07XG4gICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICBzdWNjZXNzOiB0cnVlLFxuICAgICAgICAgICAgICBzZWxlY3RvcjogcGFnZVBhcmFtcy5zZWxlY3RvciB8fCBudWxsLFxuICAgICAgICAgICAgICB0ZXh0OiBwYWdlUGFyYW1zLnRleHQgfHwgbnVsbCxcbiAgICAgICAgICAgICAgY291bnQ6IGVsZW1lbnRzLmxlbmd0aCxcbiAgICAgICAgICAgICAgdHJ1bmNhdGVkOiBlbGVtZW50cy5sZW5ndGggPiBtYXhSZXN1bHRzLFxuICAgICAgICAgICAgICBtYXRjaGVzOiBlbGVtZW50cy5zbGljZSgwLCBtYXhSZXN1bHRzKS5tYXAoKGVsZW1lbnQsIGluZGV4KSA9PiBzZXJpYWxpemVFbGVtZW50KGVsZW1lbnQsIGluZGV4KSlcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgaWYgKHBhZ2VBY3Rpb24gPT09IFwiZG9tX2NsaWNrXCIpIHtcbiAgICAgICAgICAgIGNvbnN0IHJlc29sdmVkID0gcmVzb2x2ZUVsZW1lbnQocGFnZVBhcmFtcyk7XG4gICAgICAgICAgICBpZiAocmVzb2x2ZWQuZXJyb3IpIHJldHVybiB7IGVycm9yOiByZXNvbHZlZC5lcnJvciB9O1xuICAgICAgICAgICAgY29uc3QgZWxlbWVudCA9IHJlc29sdmVkLmVsZW1lbnQ7XG4gICAgICAgICAgICBlbGVtZW50LnNjcm9sbEludG9WaWV3KHsgYmxvY2s6IFwiY2VudGVyXCIsIGlubGluZTogXCJuZWFyZXN0XCIsIGJlaGF2aW9yOiBcInNtb290aFwiIH0pO1xuICAgICAgICAgICAgaWYgKHR5cGVvZiBlbGVtZW50LmZvY3VzID09PSBcImZ1bmN0aW9uXCIpIHtcbiAgICAgICAgICAgICAgdHJ5IHsgZWxlbWVudC5mb2N1cyh7IHByZXZlbnRTY3JvbGw6IHRydWUgfSk7IH0gY2F0Y2ggKGUpIHsgZWxlbWVudC5mb2N1cygpOyB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBhd2FpdCBzbGVlcCgzNTApO1xuICAgICAgICAgICAgZWxlbWVudC5jbGljaygpO1xuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgc3VjY2VzczogdHJ1ZSxcbiAgICAgICAgICAgICAgYWN0aW9uOiBcImNsaWNrXCIsXG4gICAgICAgICAgICAgIHRvdGFsTWF0Y2hlczogcmVzb2x2ZWQudG90YWxNYXRjaGVzLFxuICAgICAgICAgICAgICB0YXJnZXQ6IHNlcmlhbGl6ZUVsZW1lbnQoZWxlbWVudCwgcmVzb2x2ZWQuaW5kZXgpXG4gICAgICAgICAgICB9O1xuICAgICAgICAgIH1cblxuICAgICAgICAgIGlmIChwYWdlQWN0aW9uID09PSBcImRvbV9zZXRfdmFsdWVcIikge1xuICAgICAgICAgICAgY29uc3QgcmVzb2x2ZWQgPSByZXNvbHZlRWxlbWVudChwYWdlUGFyYW1zKTtcbiAgICAgICAgICAgIGlmIChyZXNvbHZlZC5lcnJvcikgcmV0dXJuIHsgZXJyb3I6IHJlc29sdmVkLmVycm9yIH07XG4gICAgICAgICAgICBjb25zdCBlbGVtZW50ID0gcmVzb2x2ZWQuZWxlbWVudDtcbiAgICAgICAgICAgIGNvbnN0IHRhZ05hbWUgPSBlbGVtZW50LnRhZ05hbWUudG9Mb3dlckNhc2UoKTtcbiAgICAgICAgICAgIGlmICghW1wiaW5wdXRcIiwgXCJ0ZXh0YXJlYVwiLCBcInNlbGVjdFwiXS5pbmNsdWRlcyh0YWdOYW1lKSkge1xuICAgICAgICAgICAgICByZXR1cm4geyBlcnJvcjogYEVsZW1lbnQgaXMgbm90IGEgZm9ybSBmaWVsZDogPCR7dGFnTmFtZX0+YCB9O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgZWxlbWVudC5zY3JvbGxJbnRvVmlldyh7IGJsb2NrOiBcImNlbnRlclwiLCBpbmxpbmU6IFwibmVhcmVzdFwiLCBiZWhhdmlvcjogXCJzbW9vdGhcIiB9KTtcbiAgICAgICAgICAgIGlmICh0eXBlb2YgZWxlbWVudC5mb2N1cyA9PT0gXCJmdW5jdGlvblwiKSB7XG4gICAgICAgICAgICAgIHRyeSB7IGVsZW1lbnQuZm9jdXMoeyBwcmV2ZW50U2Nyb2xsOiB0cnVlIH0pOyB9IGNhdGNoIChlKSB7IGVsZW1lbnQuZm9jdXMoKTsgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgYXdhaXQgc2xlZXAoMzUwKTtcbiAgICAgICAgICAgIHNldEZvcm1FbGVtZW50VmFsdWUoZWxlbWVudCwgcGFnZVBhcmFtcy52YWx1ZSk7XG4gICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICBzdWNjZXNzOiB0cnVlLFxuICAgICAgICAgICAgICBhY3Rpb246IFwic2V0X3ZhbHVlXCIsXG4gICAgICAgICAgICAgIHRvdGFsTWF0Y2hlczogcmVzb2x2ZWQudG90YWxNYXRjaGVzLFxuICAgICAgICAgICAgICB2YWx1ZTogdHJ1bmNhdGVUZXh0KGVsZW1lbnQudmFsdWUgfHwgXCJcIiwgNTAwKSxcbiAgICAgICAgICAgICAgdGFyZ2V0OiBzZXJpYWxpemVFbGVtZW50KGVsZW1lbnQsIHJlc29sdmVkLmluZGV4KVxuICAgICAgICAgICAgfTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBpZiAocGFnZUFjdGlvbiA9PT0gXCJkb21fc3R5bGVcIikge1xuICAgICAgICAgICAgY29uc3QgcmVzb2x2ZWQgPSByZXNvbHZlRWxlbWVudChwYWdlUGFyYW1zKTtcbiAgICAgICAgICAgIGlmIChyZXNvbHZlZC5lcnJvcikgcmV0dXJuIHsgZXJyb3I6IHJlc29sdmVkLmVycm9yIH07XG4gICAgICAgICAgICBpZiAoIXBhZ2VQYXJhbXMuc3R5bGVzIHx8IHR5cGVvZiBwYWdlUGFyYW1zLnN0eWxlcyAhPT0gXCJvYmplY3RcIiB8fCBBcnJheS5pc0FycmF5KHBhZ2VQYXJhbXMuc3R5bGVzKSkge1xuICAgICAgICAgICAgICByZXR1cm4geyBlcnJvcjogXCJQbGVhc2UgcHJvdmlkZSBhIHN0eWxlcyBvYmplY3RcIiB9O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgZHVyYXRpb25NcyA9IE1hdGgubWluKDEwMDAwLCBNYXRoLm1heCgwLCBOdW1iZXIuaXNGaW5pdGUocGFnZVBhcmFtcy5kdXJhdGlvbk1zKSA/IHBhZ2VQYXJhbXMuZHVyYXRpb25NcyA6IDIwMDApKTtcbiAgICAgICAgICAgIGNvbnN0IGVsZW1lbnQgPSByZXNvbHZlZC5lbGVtZW50O1xuICAgICAgICAgICAgY29uc3QgcHJldmlvdXMgPSB7fTtcbiAgICAgICAgICAgIGVsZW1lbnQuc2Nyb2xsSW50b1ZpZXcoeyBibG9jazogXCJjZW50ZXJcIiwgaW5saW5lOiBcIm5lYXJlc3RcIiwgYmVoYXZpb3I6IFwic21vb3RoXCIgfSk7XG4gICAgICAgICAgICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhwYWdlUGFyYW1zLnN0eWxlcykpIHtcbiAgICAgICAgICAgICAgcHJldmlvdXNba2V5XSA9IGVsZW1lbnQuc3R5bGVba2V5XTtcbiAgICAgICAgICAgICAgZWxlbWVudC5zdHlsZVtrZXldID0gU3RyaW5nKHZhbHVlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChkdXJhdGlvbk1zID4gMCkge1xuICAgICAgICAgICAgICB3aW5kb3cuc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMocHJldmlvdXMpKSB7XG4gICAgICAgICAgICAgICAgICBlbGVtZW50LnN0eWxlW2tleV0gPSB2YWx1ZTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH0sIGR1cmF0aW9uTXMpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgc3VjY2VzczogdHJ1ZSxcbiAgICAgICAgICAgICAgYWN0aW9uOiBcInN0eWxlXCIsXG4gICAgICAgICAgICAgIGR1cmF0aW9uTXMsXG4gICAgICAgICAgICAgIHN0eWxlczogcGFnZVBhcmFtcy5zdHlsZXMsXG4gICAgICAgICAgICAgIHRhcmdldDogc2VyaWFsaXplRWxlbWVudChlbGVtZW50LCByZXNvbHZlZC5pbmRleClcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgaWYgKHBhZ2VBY3Rpb24gPT09IFwiZG9tX2dldF9odG1sXCIpIHtcbiAgICAgICAgICAgIGNvbnN0IHJlc29sdmVkID0gcmVzb2x2ZUVsZW1lbnQocGFnZVBhcmFtcyk7XG4gICAgICAgICAgICBpZiAocmVzb2x2ZWQuZXJyb3IpIHJldHVybiB7IGVycm9yOiByZXNvbHZlZC5lcnJvciB9O1xuICAgICAgICAgICAgY29uc3QgbW9kZSA9IHBhZ2VQYXJhbXMubW9kZSA9PT0gXCJpbm5lclwiID8gXCJpbm5lclwiIDogXCJvdXRlclwiO1xuICAgICAgICAgICAgY29uc3QgbWF4TGVuZ3RoID0gTWF0aC5taW4oMjAwMDAsIE1hdGgubWF4KDIwMCwgTnVtYmVyLmlzSW50ZWdlcihwYWdlUGFyYW1zLm1heExlbmd0aCkgPyBwYWdlUGFyYW1zLm1heExlbmd0aCA6IEhUTUxfTElNSVQpKTtcbiAgICAgICAgICAgIGNvbnN0IGVsZW1lbnQgPSByZXNvbHZlZC5lbGVtZW50O1xuICAgICAgICAgICAgY29uc3QgaHRtbCA9IG1vZGUgPT09IFwiaW5uZXJcIiA/IGVsZW1lbnQuaW5uZXJIVE1MIDogZWxlbWVudC5vdXRlckhUTUw7XG4gICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICBzdWNjZXNzOiB0cnVlLFxuICAgICAgICAgICAgICBtb2RlLFxuICAgICAgICAgICAgICB0cnVuY2F0ZWQ6IGh0bWwubGVuZ3RoID4gbWF4TGVuZ3RoLFxuICAgICAgICAgICAgICBodG1sOiBodG1sLmxlbmd0aCA+IG1heExlbmd0aCA/IGh0bWwuc2xpY2UoMCwgbWF4TGVuZ3RoKSArIFwiLi4uXCIgOiBodG1sLFxuICAgICAgICAgICAgICB0YXJnZXQ6IHNlcmlhbGl6ZUVsZW1lbnQoZWxlbWVudCwgcmVzb2x2ZWQuaW5kZXgpXG4gICAgICAgICAgICB9O1xuICAgICAgICAgIH1cblxuICAgICAgICAgIGlmIChwYWdlQWN0aW9uID09PSBcImRvbV9oaWdobGlnaHRcIikge1xuICAgICAgICAgICAgY29uc3QgcmVzb2x2ZWQgPSByZXNvbHZlRWxlbWVudChwYWdlUGFyYW1zKTtcbiAgICAgICAgICAgIGlmIChyZXNvbHZlZC5lcnJvcikgcmV0dXJuIHsgZXJyb3I6IHJlc29sdmVkLmVycm9yIH07XG4gICAgICAgICAgICBjb25zdCBkdXJhdGlvbk1zID0gTWF0aC5taW4oNTAwMCwgTWF0aC5tYXgoMzAwLCBOdW1iZXIuaXNGaW5pdGUocGFnZVBhcmFtcy5kdXJhdGlvbk1zKSA/IHBhZ2VQYXJhbXMuZHVyYXRpb25NcyA6IDEwMDApKTtcbiAgICAgICAgICAgIGNvbnN0IGVsZW1lbnQgPSByZXNvbHZlZC5lbGVtZW50O1xuICAgICAgICAgICAgZWxlbWVudC5zY3JvbGxJbnRvVmlldyh7IGJsb2NrOiBcImNlbnRlclwiLCBpbmxpbmU6IFwibmVhcmVzdFwiLCBiZWhhdmlvcjogXCJzbW9vdGhcIiB9KTtcbiAgICAgICAgICAgIGF3YWl0IHNsZWVwKDM1MCk7XG4gICAgICAgICAgICBzaG93SGlnaGxpZ2h0T3ZlcmxheShlbGVtZW50LCBkdXJhdGlvbk1zKTtcbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgIHN1Y2Nlc3M6IHRydWUsXG4gICAgICAgICAgICAgIGFjdGlvbjogXCJoaWdobGlnaHRcIixcbiAgICAgICAgICAgICAgZHVyYXRpb25NcyxcbiAgICAgICAgICAgICAgdGFyZ2V0OiBzZXJpYWxpemVFbGVtZW50KGVsZW1lbnQsIHJlc29sdmVkLmluZGV4KSxcbiAgICAgICAgICAgICAgc2Nyb2xsOiBnZXRTY3JvbGxTdGF0ZSgpXG4gICAgICAgICAgICB9O1xuICAgICAgICAgIH1cblxuICAgICAgICAgIHJldHVybiB7IGVycm9yOiBgVW5rbm93biBwYWdlIGFjdGlvbjogJHtwYWdlQWN0aW9ufWAgfTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICByZXR1cm4geyBlcnJvcjogZXJyb3IubWVzc2FnZSB8fCBTdHJpbmcoZXJyb3IpIH07XG4gICAgICAgIH1cbiAgICAgIH0sXG4gICAgICBhcmdzOiBbYWN0aW9uLCBwYXJhbXNdXG4gICAgfSk7XG5cbiAgICBjb25zdCByZXN1bHRzID0gYXdhaXQgUHJvbWlzZS5yYWNlKFtcbiAgICAgIHNjcmlwdFByb21pc2UsXG4gICAgICBuZXcgUHJvbWlzZSgoXywgcmVqZWN0KSA9PiBzZXRUaW1lb3V0KCgpID0+IHJlamVjdChuZXcgRXJyb3IoXCJUaW1lZCBvdXQgd2FpdGluZyBmb3IgcGFnZSByZXNwb25zZVwiKSksIDEyMDAwKSlcbiAgICBdKTtcblxuICAgIGNvbnN0IGRhdGEgPSByZXN1bHRzPy5bMF0/LnJlc3VsdDtcbiAgICBpZiAoIWRhdGEpIHJldHVybiB7IGVycm9yOiBcIlBhZ2UgYWN0aW9uIGRpZCBub3QgcmV0dXJuIGEgcmVzdWx0XCIgfTtcbiAgICBpZiAoZGF0YS5lcnJvcikgcmV0dXJuIHsgZXJyb3I6IGRhdGEuZXJyb3IsIGhpbnQ6IGZhaWx1cmVIaW50IH07XG5cbiAgICByZXR1cm4ge1xuICAgICAgdGFiSWQ6IHRhYi5pZCxcbiAgICAgIHdpbmRvd0lkOiB0YWIud2luZG93SWQsXG4gICAgICBncm91cElkOiBfbm9ybWFsaXplR3JvdXBJZCh0YWIuZ3JvdXBJZCksXG4gICAgICAuLi5fYnVpbGRMYXN0QWNjZXNzZWQodGFiLmxhc3RBY2Nlc3NlZCksXG4gICAgICAuLi5kYXRhXG4gICAgfTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHJldHVybiB7XG4gICAgICBlcnJvcjogZS5tZXNzYWdlLFxuICAgICAgaGludDogZmFpbHVyZUhpbnRcbiAgICB9O1xuICB9XG59XG5cbi8qKlxuICogRXh0cmFjdCB0ZXh0IGNvbnRlbnQgZnJvbSBhIGJyb3dzZXIgdGFiIHZpYSBjb250ZW50IHNjcmlwdC5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gX2V4ZWNUYWJFeHRyYWN0KHsgdGFiSWQgfSkge1xuICBjb25zdCByZXNvbHZlZCA9IGF3YWl0IF9yZXNvbHZlQ29udHJvbGxhYmxlVGFiKHRhYklkLCBcInJlYWRcIik7XG4gIGlmIChyZXNvbHZlZC5lcnJvcikgcmV0dXJuIHsgZXJyb3I6IHJlc29sdmVkLmVycm9yIH07XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzdWx0cyA9IGF3YWl0IGNocm9tZS5zY3JpcHRpbmcuZXhlY3V0ZVNjcmlwdCh7XG4gICAgICB0YXJnZXQ6IHsgdGFiSWQ6IHJlc29sdmVkLnRhYi5pZCB9LFxuICAgICAgZnVuYzogKCkgPT4ge1xuICAgICAgICBjb25zdCB0ZXh0U291cmNlID1cbiAgICAgICAgICBkb2N1bWVudC5ib2R5Py5pbm5lclRleHQgfHxcbiAgICAgICAgICBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQ/LmlubmVyVGV4dCB8fFxuICAgICAgICAgIGRvY3VtZW50LmJvZHk/LnRleHRDb250ZW50IHx8XG4gICAgICAgICAgZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50Py50ZXh0Q29udGVudCB8fFxuICAgICAgICAgIFwiXCI7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgdXJsOiBkb2N1bWVudC5VUkwsXG4gICAgICAgICAgdGl0bGU6IGRvY3VtZW50LnRpdGxlLFxuICAgICAgICAgIGNvbnRlbnQ6IFN0cmluZyh0ZXh0U291cmNlKS5zdWJzdHJpbmcoMCwgODAwMClcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIGNvbnN0IGRhdGEgPSByZXN1bHRzPy5bMF0/LnJlc3VsdDtcbiAgICBpZiAoIWRhdGEpIHtcbiAgICAgIHJldHVybiB7IGVycm9yOiBcIkZhaWxlZCB0byBleHRyYWN0IHRhYiBjb250ZW50XCIgfTtcbiAgICB9XG5cbiAgICByZXR1cm4ge1xuICAgICAgLi4uZGF0YSxcbiAgICAgIHRhYklkOiByZXNvbHZlZC50YWIuaWQsXG4gICAgICB3aW5kb3dJZDogcmVzb2x2ZWQudGFiLndpbmRvd0lkLFxuICAgICAgZ3JvdXBJZDogX25vcm1hbGl6ZUdyb3VwSWQocmVzb2x2ZWQudGFiLmdyb3VwSWQpLFxuICAgICAgLi4uX2J1aWxkTGFzdEFjY2Vzc2VkKHJlc29sdmVkLnRhYi5sYXN0QWNjZXNzZWQpXG4gICAgfTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHJldHVybiB7XG4gICAgICBlcnJvcjogZS5tZXNzYWdlLFxuICAgICAgaGludDogXCJUaGlzIHBhZ2UgbWF5IG5lZWQgdG8gYmUgcmVmcmVzaGVkIGJlZm9yZSBpdHMgY29udGVudCBjYW4gYmUgcmVhZC5cIlxuICAgIH07XG4gIH1cbn1cblxuLyoqXG4gKiBTY3JvbGwgYSBicm93c2VyIHRhYiBhbmQgcmV0dXJuIHRoZSB1cGRhdGVkIHNjcm9sbCBzdGF0ZS5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gX2V4ZWNUYWJTY3JvbGwoeyB0YWJJZCwgZGVsdGFZLCBwYWdlRnJhY3Rpb24sIHBvc2l0aW9uLCBiZWhhdmlvciB9KSB7XG4gIGNvbnN0IHJlc29sdmVkID0gYXdhaXQgX3Jlc29sdmVDb250cm9sbGFibGVUYWIodGFiSWQsIFwic2Nyb2xsXCIpO1xuICBpZiAocmVzb2x2ZWQuZXJyb3IpIHJldHVybiB7IGVycm9yOiByZXNvbHZlZC5lcnJvciB9O1xuXG4gIHJldHVybiBfZXhlY3V0ZVBhZ2VBY3Rpb24oXG4gICAgcmVzb2x2ZWQudGFiLFxuICAgIFwidGFiX3Njcm9sbFwiLFxuICAgIHsgZGVsdGFZLCBwYWdlRnJhY3Rpb24sIHBvc2l0aW9uLCBiZWhhdmlvciB9LFxuICAgIFwiVGhpcyBwYWdlIG1heSBuZWVkIHRvIGJlIHJlZnJlc2hlZCBiZWZvcmUgc2Nyb2xsaW5nIGNhbiBiZSBjb250cm9sbGVkLlwiXG4gICk7XG59XG5cbi8qKlxuICogUXVlcnkgbWF0Y2hpbmcgRE9NIGVsZW1lbnRzIG9uIGEgcGFnZS5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gX2V4ZWNEb21RdWVyeSh7IHRhYklkLCBzZWxlY3RvciwgdGV4dCwgbWF0Y2hFeGFjdCwgbWF4UmVzdWx0cyB9KSB7XG4gIGNvbnN0IHJlc29sdmVkID0gYXdhaXQgX3Jlc29sdmVDb250cm9sbGFibGVUYWIodGFiSWQsIFwiaW5zcGVjdFwiKTtcbiAgaWYgKHJlc29sdmVkLmVycm9yKSByZXR1cm4geyBlcnJvcjogcmVzb2x2ZWQuZXJyb3IgfTtcblxuICByZXR1cm4gX2V4ZWN1dGVQYWdlQWN0aW9uKFxuICAgIHJlc29sdmVkLnRhYixcbiAgICBcImRvbV9xdWVyeVwiLFxuICAgIHsgc2VsZWN0b3IsIHRleHQsIG1hdGNoRXhhY3QsIG1heFJlc3VsdHMgfSxcbiAgICBcIlRoaXMgcGFnZSBtYXkgbmVlZCB0byBiZSByZWZyZXNoZWQgYmVmb3JlIERPTSBpbnNwZWN0aW9uIGNhbiBydW4uXCJcbiAgKTtcbn1cblxuLyoqXG4gKiBDbGljayBhIG1hdGNoaW5nIERPTSBlbGVtZW50IG9uIGEgcGFnZS5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gX2V4ZWNEb21DbGljayh7IHRhYklkLCBzZWxlY3RvciwgdGV4dCwgbWF0Y2hFeGFjdCwgaW5kZXggfSkge1xuICBjb25zdCByZXNvbHZlZCA9IGF3YWl0IF9yZXNvbHZlQ29udHJvbGxhYmxlVGFiKHRhYklkLCBcImludGVyYWN0IHdpdGhcIik7XG4gIGlmIChyZXNvbHZlZC5lcnJvcikgcmV0dXJuIHsgZXJyb3I6IHJlc29sdmVkLmVycm9yIH07XG5cbiAgcmV0dXJuIF9leGVjdXRlUGFnZUFjdGlvbihcbiAgICByZXNvbHZlZC50YWIsXG4gICAgXCJkb21fY2xpY2tcIixcbiAgICB7IHNlbGVjdG9yLCB0ZXh0LCBtYXRjaEV4YWN0LCBpbmRleCB9LFxuICAgIFwiVGhpcyBwYWdlIG1heSBuZWVkIHRvIGJlIHJlZnJlc2hlZCBiZWZvcmUgRE9NIGludGVyYWN0aW9ucyBjYW4gcnVuLlwiXG4gICk7XG59XG5cbi8qKlxuICogU2V0IHRoZSB2YWx1ZSBvZiBhIGZvcm0gZmllbGQgb24gYSBwYWdlLlxuICovXG5hc3luYyBmdW5jdGlvbiBfZXhlY0RvbVNldFZhbHVlKHsgdGFiSWQsIHNlbGVjdG9yLCB0ZXh0LCBtYXRjaEV4YWN0LCBpbmRleCwgdmFsdWUgfSkge1xuICBjb25zdCByZXNvbHZlZCA9IGF3YWl0IF9yZXNvbHZlQ29udHJvbGxhYmxlVGFiKHRhYklkLCBcImVkaXRcIik7XG4gIGlmIChyZXNvbHZlZC5lcnJvcikgcmV0dXJuIHsgZXJyb3I6IHJlc29sdmVkLmVycm9yIH07XG5cbiAgcmV0dXJuIF9leGVjdXRlUGFnZUFjdGlvbihcbiAgICByZXNvbHZlZC50YWIsXG4gICAgXCJkb21fc2V0X3ZhbHVlXCIsXG4gICAgeyBzZWxlY3RvciwgdGV4dCwgbWF0Y2hFeGFjdCwgaW5kZXgsIHZhbHVlIH0sXG4gICAgXCJUaGlzIHBhZ2UgbWF5IG5lZWQgdG8gYmUgcmVmcmVzaGVkIGJlZm9yZSBmb3JtIGZpZWxkcyBjYW4gYmUgZWRpdGVkLlwiXG4gICk7XG59XG5cbi8qKlxuICogVGVtcG9yYXJpbHkgc3R5bGUgYSBET00gZWxlbWVudCBvbiBhIHBhZ2UuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIF9leGVjRG9tU3R5bGUoeyB0YWJJZCwgc2VsZWN0b3IsIHRleHQsIG1hdGNoRXhhY3QsIGluZGV4LCBzdHlsZXMsIGR1cmF0aW9uTXMgfSkge1xuICBjb25zdCByZXNvbHZlZCA9IGF3YWl0IF9yZXNvbHZlQ29udHJvbGxhYmxlVGFiKHRhYklkLCBcInN0eWxlXCIpO1xuICBpZiAocmVzb2x2ZWQuZXJyb3IpIHJldHVybiB7IGVycm9yOiByZXNvbHZlZC5lcnJvciB9O1xuXG4gIHJldHVybiBfZXhlY3V0ZVBhZ2VBY3Rpb24oXG4gICAgcmVzb2x2ZWQudGFiLFxuICAgIFwiZG9tX3N0eWxlXCIsXG4gICAgeyBzZWxlY3RvciwgdGV4dCwgbWF0Y2hFeGFjdCwgaW5kZXgsIHN0eWxlcywgZHVyYXRpb25NcyB9LFxuICAgIFwiVGhpcyBwYWdlIG1heSBuZWVkIHRvIGJlIHJlZnJlc2hlZCBiZWZvcmUgc3R5bGVzIGNhbiBiZSBtb2RpZmllZC5cIlxuICApO1xufVxuXG4vKipcbiAqIEdldCBIVE1MIGZyb20gYSBtYXRjaGVkIERPTSBlbGVtZW50IG9uIGEgcGFnZS5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gX2V4ZWNEb21HZXRIdG1sKHsgdGFiSWQsIHNlbGVjdG9yLCB0ZXh0LCBtYXRjaEV4YWN0LCBpbmRleCwgbW9kZSwgbWF4TGVuZ3RoIH0pIHtcbiAgY29uc3QgcmVzb2x2ZWQgPSBhd2FpdCBfcmVzb2x2ZUNvbnRyb2xsYWJsZVRhYih0YWJJZCwgXCJpbnNwZWN0XCIpO1xuICBpZiAocmVzb2x2ZWQuZXJyb3IpIHJldHVybiB7IGVycm9yOiByZXNvbHZlZC5lcnJvciB9O1xuXG4gIHJldHVybiBfZXhlY3V0ZVBhZ2VBY3Rpb24oXG4gICAgcmVzb2x2ZWQudGFiLFxuICAgIFwiZG9tX2dldF9odG1sXCIsXG4gICAgeyBzZWxlY3RvciwgdGV4dCwgbWF0Y2hFeGFjdCwgaW5kZXgsIG1vZGUsIG1heExlbmd0aCB9LFxuICAgIFwiVGhpcyBwYWdlIG1heSBuZWVkIHRvIGJlIHJlZnJlc2hlZCBiZWZvcmUgRE9NIEhUTUwgY2FuIGJlIHJlYWQuXCJcbiAgKTtcbn1cblxuLyoqXG4gKiBTY3JvbGwgdG8gYW5kIHZpc3VhbGx5IGhpZ2hsaWdodCBhIERPTSBlbGVtZW50IG9uIHRoZSBwYWdlLlxuICovXG5hc3luYyBmdW5jdGlvbiBfZXhlY0RvbUhpZ2hsaWdodCh7IHRhYklkLCBzZWxlY3RvciwgdGV4dCwgbWF0Y2hFeGFjdCwgaW5kZXgsIGR1cmF0aW9uTXMgfSkge1xuICBjb25zdCByZXNvbHZlZCA9IGF3YWl0IF9yZXNvbHZlQ29udHJvbGxhYmxlVGFiKHRhYklkLCBcImhpZ2hsaWdodFwiKTtcbiAgaWYgKHJlc29sdmVkLmVycm9yKSByZXR1cm4geyBlcnJvcjogcmVzb2x2ZWQuZXJyb3IgfTtcblxuICByZXR1cm4gX2V4ZWN1dGVQYWdlQWN0aW9uKFxuICAgIHJlc29sdmVkLnRhYixcbiAgICBcImRvbV9oaWdobGlnaHRcIixcbiAgICB7IHNlbGVjdG9yLCB0ZXh0LCBtYXRjaEV4YWN0LCBpbmRleCwgZHVyYXRpb25NcyB9LFxuICAgIFwiVGhpcyBwYWdlIG1heSBuZWVkIHRvIGJlIHJlZnJlc2hlZCBiZWZvcmUgaGlnaGxpZ2h0aW5nIGNhbiBydW4uXCJcbiAgKTtcbn1cblxuLyoqXG4gKiBFeGVjdXRlIGFyYml0cmFyeSBKYXZhU2NyaXB0IG9uIHRoZSBjdXJyZW50IHBhZ2UuXG4gKiBEYW5nZXJvdXM6IHNob3VsZCBvbmx5IGJlIHJlYWNoZWQgYWZ0ZXIgZXhwbGljaXQgdXNlciBhcHByb3ZhbC5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gX2V4ZWNFdmFsSnMoeyBqc1NjcmlwdCB9KSB7XG4gIGNvbnN0IHJlc29sdmVkID0gYXdhaXQgX3Jlc29sdmVDb250cm9sbGFibGVUYWIodW5kZWZpbmVkLCBcInJ1biBjb2RlIG9uXCIpO1xuICBpZiAocmVzb2x2ZWQuZXJyb3IpIHJldHVybiB7IGVycm9yOiByZXNvbHZlZC5lcnJvciB9O1xuXG4gIGNvbnN0IHdvcmxkID0gXCJNQUlOXCI7XG4gIHRyeSB7XG4gICAgY29uc3QgcnVubmVyRnVuYyA9IGFzeW5jIChzb3VyY2UpID0+IHtcbiAgICAgIGNvbnN0IGNoYW5uZWwgPSBgX190YWJfbWFuYWdlcl9ldmFsX2pzXyR7RGF0ZS5ub3coKX1fJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyKX1gO1xuICAgICAgcmV0dXJuIGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG4gICAgICAgIGxldCBzZXR0bGVkID0gZmFsc2U7XG5cbiAgICAgICAgZnVuY3Rpb24gZmluaXNoKHBheWxvYWQpIHtcbiAgICAgICAgICBpZiAoc2V0dGxlZCkgcmV0dXJuO1xuICAgICAgICAgIHNldHRsZWQgPSB0cnVlO1xuICAgICAgICAgIHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKGNoYW5uZWwsIG9uUmVzdWx0KTtcbiAgICAgICAgICByZXNvbHZlKHBheWxvYWQpO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gb25SZXN1bHQoZXZlbnQpIHtcbiAgICAgICAgICBmaW5pc2goZXZlbnQ/LmRldGFpbCB8fCB7IGVycm9yOiBcIk5vIHJlc3VsdCByZXR1cm5lZCBmcm9tIGluamVjdGVkIHNjcmlwdFwiIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoY2hhbm5lbCwgb25SZXN1bHQsIHsgb25jZTogdHJ1ZSB9KTtcblxuICAgICAgICBjb25zdCBzY3JpcHQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2NyaXB0XCIpO1xuICAgICAgICBzY3JpcHQudHlwZSA9IFwidGV4dC9qYXZhc2NyaXB0XCI7XG4gICAgICAgIHNjcmlwdC50ZXh0Q29udGVudCA9IGBcbiAgICAgICAgICAoYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgY29uc3QgY2hhbm5lbCA9ICR7SlNPTi5zdHJpbmdpZnkoY2hhbm5lbCl9O1xuICAgICAgICAgICAgZnVuY3Rpb24gbm9ybWFsaXplUmVzdWx0KHZhbHVlKSB7XG4gICAgICAgICAgICAgIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkKSByZXR1cm4geyBraW5kOiBcInVuZGVmaW5lZFwiLCB2YWx1ZTogbnVsbCB9O1xuICAgICAgICAgICAgICBpZiAodmFsdWUgPT09IG51bGwpIHJldHVybiBudWxsO1xuICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGNvbnN0IGpzb24gPSBKU09OLnN0cmluZ2lmeSh2YWx1ZSk7XG4gICAgICAgICAgICAgICAgaWYgKGpzb24gPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgICAgICAgcmV0dXJuIHsga2luZDogdHlwZW9mIHZhbHVlLCB2YWx1ZTogU3RyaW5nKHZhbHVlKSB9O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICByZXR1cm4gSlNPTi5wYXJzZShqc29uKTtcbiAgICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICAgIHJldHVybiB7IGtpbmQ6IHR5cGVvZiB2YWx1ZSwgdmFsdWU6IFN0cmluZyh2YWx1ZSkgfTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCAoYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgICAgICR7c291cmNlfVxuICAgICAgICAgICAgICB9KSgpO1xuICAgICAgICAgICAgICB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgQ3VzdG9tRXZlbnQoY2hhbm5lbCwge1xuICAgICAgICAgICAgICAgIGRldGFpbDoge1xuICAgICAgICAgICAgICAgICAgc3VjY2VzczogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgIHVybDogZG9jdW1lbnQuVVJMLFxuICAgICAgICAgICAgICAgICAgdGl0bGU6IGRvY3VtZW50LnRpdGxlLFxuICAgICAgICAgICAgICAgICAgcmVzdWx0OiBub3JtYWxpemVSZXN1bHQocmVzdWx0KVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgfSkpO1xuICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgICAgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEN1c3RvbUV2ZW50KGNoYW5uZWwsIHtcbiAgICAgICAgICAgICAgICBkZXRhaWw6IHtcbiAgICAgICAgICAgICAgICAgIGVycm9yOiBlcnJvciAmJiBlcnJvci5tZXNzYWdlID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvciksXG4gICAgICAgICAgICAgICAgICBzdGFjazogZXJyb3IgJiYgZXJyb3Iuc3RhY2sgPyBTdHJpbmcoZXJyb3Iuc3RhY2spLnNsaWNlKDAsIDQwMDApIDogbnVsbCxcbiAgICAgICAgICAgICAgICAgIHVybDogZG9jdW1lbnQuVVJMLFxuICAgICAgICAgICAgICAgICAgdGl0bGU6IGRvY3VtZW50LnRpdGxlXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB9KSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSkoKTtcbiAgICAgICAgYDtcblxuICAgICAgICBjb25zdCBwYXJlbnQgPSBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQgfHwgZG9jdW1lbnQuaGVhZCB8fCBkb2N1bWVudC5ib2R5O1xuICAgICAgICBpZiAoIXBhcmVudCkge1xuICAgICAgICAgIGZpbmlzaCh7IGVycm9yOiBcIlVuYWJsZSB0byBpbmplY3Qgc2NyaXB0IGludG8gdGhpcyBwYWdlXCIgfSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgcGFyZW50LmFwcGVuZENoaWxkKHNjcmlwdCk7XG4gICAgICAgIHNjcmlwdC5yZW1vdmUoKTtcblxuICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgICBmaW5pc2goe1xuICAgICAgICAgICAgZXJyb3I6IFwiSW5qZWN0ZWQgc2NyaXB0IGRpZCBub3QgcmV0dXJuIGEgcmVzdWx0LiBJdCBtYXkgaGF2ZSBiZWVuIGJsb2NrZWQgYnkgdGhlIHBhZ2UgQ1NQLlwiLFxuICAgICAgICAgICAgdXJsOiBkb2N1bWVudC5VUkwsXG4gICAgICAgICAgICB0aXRsZTogZG9jdW1lbnQudGl0bGVcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSwgMTEwMDApO1xuICAgICAgfSk7XG4gICAgfTtcblxuICAgIGNvbnN0IHJlc3VsdHMgPSBhd2FpdCBQcm9taXNlLnJhY2UoW1xuICAgICAgY2hyb21lLnNjcmlwdGluZy5leGVjdXRlU2NyaXB0KHtcbiAgICAgICAgdGFyZ2V0OiB7IHRhYklkOiByZXNvbHZlZC50YWIuaWQgfSxcbiAgICAgICAgd29ybGQsXG4gICAgICAgIGZ1bmM6IHJ1bm5lckZ1bmMsXG4gICAgICAgIGFyZ3M6IFtqc1NjcmlwdF1cbiAgICAgIH0pLFxuICAgICAgbmV3IFByb21pc2UoKF8sIHJlamVjdCkgPT4ge1xuICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHJlamVjdChuZXcgRXJyb3IoXCJUaW1lZCBvdXQgd2FpdGluZyBmb3IgSmF2YVNjcmlwdCBleGVjdXRpb25cIikpLCAxMjAwMCk7XG4gICAgICB9KVxuICAgIF0pO1xuXG4gICAgY29uc3QgZGF0YSA9IHJlc3VsdHM/LlswXT8ucmVzdWx0O1xuICAgIGlmICghZGF0YSkgcmV0dXJuIHsgZXJyb3I6IFwiTm8gcmVzdWx0IHJldHVybmVkIGZyb20gSmF2YVNjcmlwdCBleGVjdXRpb25cIiB9O1xuXG4gICAgcmV0dXJuIHtcbiAgICAgIHdvcmxkLFxuICAgICAgdGFiSWQ6IHJlc29sdmVkLnRhYi5pZCxcbiAgICAgIHdpbmRvd0lkOiByZXNvbHZlZC50YWIud2luZG93SWQsXG4gICAgICBncm91cElkOiBfbm9ybWFsaXplR3JvdXBJZChyZXNvbHZlZC50YWIuZ3JvdXBJZCksXG4gICAgICAuLi5fYnVpbGRMYXN0QWNjZXNzZWQocmVzb2x2ZWQudGFiLmxhc3RBY2Nlc3NlZCksXG4gICAgICAuLi5kYXRhXG4gICAgfTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHJldHVybiB7XG4gICAgICBlcnJvcjogZS5tZXNzYWdlLFxuICAgICAgd29ybGQsXG4gICAgICBoaW50OiBcIlRoZSBzY3JpcHQgY291bGQgbm90IGJlIGV4ZWN1dGVkIG9uIHRoaXMgcGFnZS5cIlxuICAgIH07XG4gIH1cbn1cblxuLyoqXG4gKiBPcGVuIGEgbmV3IHRhYiB3aXRoIHRoZSBnaXZlbiBVUkwuIE9wdGlvbmFsbHkgZm9jdXMgb24gaXQuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIF9leGVjVGFiT3Blbih7IHVybCwgYWN0aXZlIH0pIHtcbiAgaWYgKCEvXmh0dHBzPzpcXC9cXC8vaS50ZXN0KHVybCkpIHVybCA9IFwiaHR0cHM6Ly9cIiArIHVybDtcbiAgY29uc3Qgc2hvdWxkRm9jdXMgPSBhY3RpdmUgIT09IGZhbHNlOyAvLyBkZWZhdWx0IHRydWVcbiAgY29uc3QgdGFiID0gYXdhaXQgY2hyb21lLnRhYnMuY3JlYXRlKHsgdXJsLCBhY3RpdmU6IHNob3VsZEZvY3VzIH0pO1xuICBpZiAoc2hvdWxkRm9jdXMpIGF3YWl0IGNocm9tZS53aW5kb3dzLnVwZGF0ZSh0YWIud2luZG93SWQsIHsgZm9jdXNlZDogdHJ1ZSB9KTtcbiAgcmV0dXJuIHtcbiAgICBzdWNjZXNzOiB0cnVlLFxuICAgIGFjdGl2ZTogc2hvdWxkRm9jdXMsXG4gICAgdGFiSWQ6IHRhYi5pZCxcbiAgICB1cmw6IHRhYi5wZW5kaW5nVXJsIHx8IHRhYi51cmwgfHwgdXJsLFxuICAgIHRpdGxlOiB0YWIudGl0bGUgfHwgXCJcIixcbiAgICB3aW5kb3dJZDogdGFiLndpbmRvd0lkLFxuICAgIGdyb3VwSWQ6IF9ub3JtYWxpemVHcm91cElkKHRhYi5ncm91cElkKSxcbiAgICAuLi5fYnVpbGRMYXN0QWNjZXNzZWQodGFiLmxhc3RBY2Nlc3NlZClcbiAgfTtcbn1cblxuLyoqXG4gKiBTd2l0Y2ggZm9jdXMgdG8gYW4gZXhpc3RpbmcgdGFiLlxuICovXG5hc3luYyBmdW5jdGlvbiBfZXhlY1RhYkZvY3VzKHsgdGFiSWQgfSkge1xuICBsZXQgdGFiID0gYXdhaXQgY2hyb21lLnRhYnMuZ2V0KHRhYklkKTtcbiAgY29uc3QgY3VycmVudFdpbmRvdyA9IGF3YWl0IGNocm9tZS53aW5kb3dzLmdldEN1cnJlbnQoe30pO1xuICBjb25zdCBwcmV2aW91c1dpbmRvd0lkID0gdGFiLndpbmRvd0lkO1xuICBsZXQgbW92ZWRUb0N1cnJlbnRXaW5kb3cgPSBmYWxzZTtcblxuICBpZiAoY3VycmVudFdpbmRvdz8uaWQgJiYgdGFiLndpbmRvd0lkICE9PSBjdXJyZW50V2luZG93LmlkKSB7XG4gICAgdGFiID0gYXdhaXQgY2hyb21lLnRhYnMubW92ZSh0YWJJZCwgeyB3aW5kb3dJZDogY3VycmVudFdpbmRvdy5pZCwgaW5kZXg6IC0xIH0pO1xuICAgIG1vdmVkVG9DdXJyZW50V2luZG93ID0gdHJ1ZTtcbiAgfVxuXG4gIHRhYiA9IGF3YWl0IGNocm9tZS50YWJzLnVwZGF0ZSh0YWJJZCwgeyBhY3RpdmU6IHRydWUgfSk7XG4gIGF3YWl0IGNocm9tZS53aW5kb3dzLnVwZGF0ZSh0YWIud2luZG93SWQsIHsgZm9jdXNlZDogdHJ1ZSB9KTtcbiAgcmV0dXJuIHtcbiAgICBzdWNjZXNzOiB0cnVlLFxuICAgIHRhYklkLFxuICAgIHRpdGxlOiB0YWIudGl0bGUsXG4gICAgdXJsOiB0YWIudXJsLFxuICAgIHdpbmRvd0lkOiB0YWIud2luZG93SWQsXG4gICAgZ3JvdXBJZDogX25vcm1hbGl6ZUdyb3VwSWQodGFiLmdyb3VwSWQpLFxuICAgIHByZXZpb3VzV2luZG93SWQsXG4gICAgbW92ZWRUb0N1cnJlbnRXaW5kb3csXG4gICAgLi4uX2J1aWxkTGFzdEFjY2Vzc2VkKHRhYi5sYXN0QWNjZXNzZWQpXG4gIH07XG59XG5cbi8qKlxuICogQ2xvc2Ugb25lIG9yIG1vcmUgdGFicy5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gX2V4ZWNUYWJDbG9zZSh7IHRhYklkcyB9KSB7XG4gIGNvbnN0IGlkcyA9IEFycmF5LmlzQXJyYXkodGFiSWRzKSA/IHRhYklkcyA6IFt0YWJJZHNdO1xuICAvLyBDb2xsZWN0IHRhYiB0aXRsZXMgYmVmb3JlIGNsb3NpbmdcbiAgY29uc3QgY2xvc2VkID0gW107XG4gIGZvciAoY29uc3QgaWQgb2YgaWRzKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHRhYiA9IGF3YWl0IGNocm9tZS50YWJzLmdldChpZCk7XG4gICAgICBjbG9zZWQucHVzaChfc2VyaWFsaXplVGFiTWV0YWRhdGEodGFiKSk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgY2xvc2VkLnB1c2goeyBpZCwgZXJyb3I6IFwiVGFiIG5vdCBmb3VuZFwiIH0pO1xuICAgIH1cbiAgfVxuICBhd2FpdCBjaHJvbWUudGFicy5yZW1vdmUoaWRzLmZpbHRlcihpZCA9PiBjbG9zZWQuZmluZChjID0+IGMuaWQgPT09IGlkICYmICFjLmVycm9yKSkpO1xuICByZXR1cm4geyBzdWNjZXNzOiB0cnVlLCBjbG9zZWQgfTtcbn1cblxuLyoqXG4gKiBHcm91cCB0YWJzIHRvZ2V0aGVyIHdpdGggYSBuYW1lIGFuZCBvcHRpb25hbCBjb2xvci5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gX2V4ZWNUYWJHcm91cCh7IHRhYklkcywgbmFtZSwgY29sb3IgfSkge1xuICBjb25zdCBncm91cElkID0gYXdhaXQgY2hyb21lLnRhYnMuZ3JvdXAoeyB0YWJJZHMgfSk7XG4gIGNvbnN0IHVwZGF0ZVByb3BzOiBjaHJvbWUudGFiR3JvdXBzLlVwZGF0ZVByb3BlcnRpZXMgPSB7IHRpdGxlOiBuYW1lIH07XG4gIGlmIChjb2xvcikgdXBkYXRlUHJvcHMuY29sb3IgPSBjb2xvciBhcyBjaHJvbWUudGFiR3JvdXBzLkNvbG9yRW51bTtcbiAgYXdhaXQgY2hyb21lLnRhYkdyb3Vwcy51cGRhdGUoZ3JvdXBJZCwgdXBkYXRlUHJvcHMpO1xuICBjb25zdCBncm91cCA9IGF3YWl0IF9sb2FkR3JvdXBTbmFwc2hvdChncm91cElkKTtcbiAgcmV0dXJuIHsgc3VjY2VzczogdHJ1ZSwgZ3JvdXBJZCwgbmFtZSwgdGFiQ291bnQ6IHRhYklkcy5sZW5ndGgsIGdyb3VwIH07XG59XG5cbi8qKlxuICogR2V0IGluZm8gYWJvdXQgYWxsIGN1cnJlbnQgdGFiIGdyb3Vwcy5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gX2V4ZWNHcm91cExpc3QoX2FyZ3M/OiB1bmtub3duKSB7XG4gIGNvbnN0IGNhcHR1cmVkQXQgPSBfYnVpbGRDYXB0dXJlZEF0KCk7XG4gIGNvbnN0IGdyb3VwcyA9IGF3YWl0IF9sb2FkQWxsR3JvdXBTbmFwc2hvdHMoKTtcbiAgcmV0dXJuIHtcbiAgICBjYXB0dXJlZEF0LFxuICAgIGNvdW50OiBncm91cHMubGVuZ3RoLFxuICAgIGdyb3Vwc1xuICB9O1xufVxuXG4vKipcbiAqIEdldCBpbmZvIGFib3V0IGEgc3BlY2lmaWMgdGFiIGdyb3VwLlxuICovXG5hc3luYyBmdW5jdGlvbiBfZXhlY0dyb3VwR2V0KHsgZ3JvdXBJZCB9KSB7XG4gIGNvbnN0IGdyb3VwID0gYXdhaXQgX2xvYWRHcm91cFNuYXBzaG90KGdyb3VwSWQpO1xuICBpZiAoIWdyb3VwKSByZXR1cm4geyBlcnJvcjogYFRhYiBncm91cCBub3QgZm91bmQ6ICR7Z3JvdXBJZH1gIH07XG4gIHJldHVybiB7XG4gICAgY2FwdHVyZWRBdDogX2J1aWxkQ2FwdHVyZWRBdCgpLFxuICAgIGdyb3VwXG4gIH07XG59XG5cbi8qKlxuICogVXBkYXRlIGEgdGFiIGdyb3VwJ3MgdGl0bGUsIGNvbG9yLCBvciBjb2xsYXBzZWQgc3RhdGUuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIF9leGVjR3JvdXBVcGRhdGUoeyBncm91cElkLCBuYW1lLCBjb2xvciwgY29sbGFwc2VkIH0pIHtcbiAgY29uc3QgdXBkYXRlUHJvcHM6IGNocm9tZS50YWJHcm91cHMuVXBkYXRlUHJvcGVydGllcyA9IHt9O1xuICBpZiAobmFtZSAhPSBudWxsKSB1cGRhdGVQcm9wcy50aXRsZSA9IG5hbWU7XG4gIGlmIChjb2xvciAhPSBudWxsKSB1cGRhdGVQcm9wcy5jb2xvciA9IGNvbG9yIGFzIGNocm9tZS50YWJHcm91cHMuQ29sb3JFbnVtO1xuICBpZiAoY29sbGFwc2VkICE9IG51bGwpIHVwZGF0ZVByb3BzLmNvbGxhcHNlZCA9IGNvbGxhcHNlZDtcblxuICBpZiAoT2JqZWN0LmtleXModXBkYXRlUHJvcHMpLmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiB7IGVycm9yOiBcIlBsZWFzZSBwcm92aWRlIGF0IGxlYXN0IG9uZSBmaWVsZCB0byB1cGRhdGU6IG5hbWUsIGNvbG9yLCBvciBjb2xsYXBzZWRcIiB9O1xuICB9XG5cbiAgYXdhaXQgY2hyb21lLnRhYkdyb3Vwcy51cGRhdGUoZ3JvdXBJZCwgdXBkYXRlUHJvcHMpO1xuICBjb25zdCBncm91cCA9IGF3YWl0IF9sb2FkR3JvdXBTbmFwc2hvdChncm91cElkKTtcbiAgaWYgKCFncm91cCkgcmV0dXJuIHsgZXJyb3I6IGBUYWIgZ3JvdXAgbm90IGZvdW5kIGFmdGVyIHVwZGF0ZTogJHtncm91cElkfWAgfTtcbiAgcmV0dXJuIHtcbiAgICBzdWNjZXNzOiB0cnVlLFxuICAgIGNhcHR1cmVkQXQ6IF9idWlsZENhcHR1cmVkQXQoKSxcbiAgICBncm91cFxuICB9O1xufVxuXG4vKipcbiAqIEFkZCB0YWJzIHRvIGFuIGV4aXN0aW5nIHRhYiBncm91cC5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gX2V4ZWNHcm91cEFkZFRhYnMoeyBncm91cElkLCB0YWJJZHMgfSkge1xuICBjb25zdCBpZHMgPSBBcnJheS5pc0FycmF5KHRhYklkcykgPyB0YWJJZHMgOiBbdGFiSWRzXTtcbiAgYXdhaXQgY2hyb21lLnRhYnMuZ3JvdXAoeyBncm91cElkLCB0YWJJZHM6IGlkcyB9KTtcbiAgY29uc3QgZ3JvdXAgPSBhd2FpdCBfbG9hZEdyb3VwU25hcHNob3QoZ3JvdXBJZCk7XG4gIGlmICghZ3JvdXApIHJldHVybiB7IGVycm9yOiBgVGFiIGdyb3VwIG5vdCBmb3VuZCBhZnRlciBhZGRpbmcgdGFiczogJHtncm91cElkfWAgfTtcbiAgcmV0dXJuIHtcbiAgICBzdWNjZXNzOiB0cnVlLFxuICAgIGNhcHR1cmVkQXQ6IF9idWlsZENhcHR1cmVkQXQoKSxcbiAgICBncm91cElkLFxuICAgIGFkZGVkQ291bnQ6IGlkcy5sZW5ndGgsXG4gICAgZ3JvdXBcbiAgfTtcbn1cblxuLyoqXG4gKiBSZW1vdmUgdGFicyBmcm9tIHRoZWlyIGN1cnJlbnQgdGFiIGdyb3Vwcy5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gX2V4ZWNHcm91cFJlbW92ZVRhYnMoeyB0YWJJZHMgfSkge1xuICBjb25zdCBpZHMgPSBBcnJheS5pc0FycmF5KHRhYklkcykgPyB0YWJJZHMgOiBbdGFiSWRzXTtcbiAgY29uc3QgYmVmb3JlVGFicyA9IFtdO1xuXG4gIGZvciAoY29uc3QgaWQgb2YgaWRzKSB7XG4gICAgdHJ5IHtcbiAgICAgIGJlZm9yZVRhYnMucHVzaChhd2FpdCBjaHJvbWUudGFicy5nZXQoaWQpKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBiZWZvcmVUYWJzLnB1c2goeyBpZCwgZXJyb3I6IFwiVGFiIG5vdCBmb3VuZFwiIH0pO1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IHZhbGlkVGFiSWRzID0gYmVmb3JlVGFicy5maWx0ZXIodGFiID0+ICF0YWIuZXJyb3IpLm1hcCh0YWIgPT4gdGFiLmlkKTtcbiAgaWYgKHZhbGlkVGFiSWRzLmxlbmd0aCA+IDApIHtcbiAgICBhd2FpdCBjaHJvbWUudGFicy51bmdyb3VwKHZhbGlkVGFiSWRzKTtcbiAgfVxuXG4gIGNvbnN0IGFmdGVyVGFicyA9IGF3YWl0IFByb21pc2UuYWxsKHZhbGlkVGFiSWRzLm1hcChhc3luYyAoaWQpID0+IHtcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIGF3YWl0IGNocm9tZS50YWJzLmdldChpZCk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICB9KSk7XG5cbiAgcmV0dXJuIHtcbiAgICBzdWNjZXNzOiB0cnVlLFxuICAgIGNhcHR1cmVkQXQ6IF9idWlsZENhcHR1cmVkQXQoKSxcbiAgICByZXF1ZXN0ZWRDb3VudDogaWRzLmxlbmd0aCxcbiAgICB1cGRhdGVkQ291bnQ6IGFmdGVyVGFicy5maWx0ZXIoQm9vbGVhbikubGVuZ3RoLFxuICAgIHRhYnM6IGFmdGVyVGFicy5maWx0ZXIoQm9vbGVhbikubWFwKHRhYiA9PiBfc2VyaWFsaXplVGFiTWV0YWRhdGEodGFiKSksXG4gICAgbWlzc2luZzogYmVmb3JlVGFicy5maWx0ZXIodGFiID0+IHRhYi5lcnJvcikubWFwKHRhYiA9PiAoeyBpZDogdGFiLmlkLCBlcnJvcjogdGFiLmVycm9yIH0pKVxuICB9O1xufVxuXG4vKipcbiAqIERpc3NvbHZlIGFuIGVudGlyZSB0YWIgZ3JvdXAuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIF9leGVjR3JvdXBVbmdyb3VwKHsgZ3JvdXBJZCB9KSB7XG4gIGNvbnN0IGdyb3VwID0gYXdhaXQgX2xvYWRHcm91cFNuYXBzaG90KGdyb3VwSWQpO1xuICBpZiAoIWdyb3VwKSByZXR1cm4geyBlcnJvcjogYFRhYiBncm91cCBub3QgZm91bmQ6ICR7Z3JvdXBJZH1gIH07XG5cbiAgY29uc3QgdGFiSWRzID0gZ3JvdXAudGFicy5tYXAodGFiID0+IHRhYi5pZCkuZmlsdGVyKGlkID0+IHR5cGVvZiBpZCA9PT0gXCJudW1iZXJcIik7XG4gIGlmICh0YWJJZHMubGVuZ3RoID4gMCkge1xuICAgIGF3YWl0IGNocm9tZS50YWJzLnVuZ3JvdXAodGFiSWRzKTtcbiAgfVxuXG4gIGNvbnN0IHRhYnMgPSBhd2FpdCBQcm9taXNlLmFsbCh0YWJJZHMubWFwKGFzeW5jIChpZCkgPT4ge1xuICAgIHRyeSB7XG4gICAgICByZXR1cm4gYXdhaXQgY2hyb21lLnRhYnMuZ2V0KGlkKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gIH0pKTtcblxuICByZXR1cm4ge1xuICAgIHN1Y2Nlc3M6IHRydWUsXG4gICAgY2FwdHVyZWRBdDogX2J1aWxkQ2FwdHVyZWRBdCgpLFxuICAgIGdyb3VwSWQsXG4gICAgdW5ncm91cGVkQ291bnQ6IHRhYklkcy5sZW5ndGgsXG4gICAgZ3JvdXAsXG4gICAgdGFiczogdGFicy5maWx0ZXIoQm9vbGVhbikubWFwKHRhYiA9PiBfc2VyaWFsaXplVGFiTWV0YWRhdGEodGFiKSlcbiAgfTtcbn1cblxuLyoqXG4gKiBTZWFyY2ggYnJvd3NlciBoaXN0b3J5IGJ5IGtleXdvcmQuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIF9leGVjSGlzdG9yeVNlYXJjaCh7IHF1ZXJ5LCBtYXhSZXN1bHRzIH0pIHtcbiAgY29uc3QgcmVzdWx0cyA9IGF3YWl0IGNocm9tZS5oaXN0b3J5LnNlYXJjaCh7XG4gICAgdGV4dDogcXVlcnksXG4gICAgbWF4UmVzdWx0czogbWF4UmVzdWx0cyB8fCAxMCxcbiAgICBzdGFydFRpbWU6IERhdGUubm93KCkgLSAzMCAqIDI0ICogNjAgKiA2MCAqIDEwMDAgLy8gbGFzdCAzMCBkYXlzXG4gIH0pO1xuICByZXR1cm4gcmVzdWx0cy5tYXAociA9PiAoe1xuICAgIHVybDogci51cmwsXG4gICAgdGl0bGU6IHIudGl0bGUsXG4gICAgbGFzdFZpc2l0OiBuZXcgRGF0ZShyLmxhc3RWaXNpdFRpbWUpLnRvSVNPU3RyaW5nKCksXG4gICAgdmlzaXRDb3VudDogci52aXNpdENvdW50XG4gIH0pKTtcbn1cblxuLyoqXG4gKiBMaXN0IHJlY2VudCBicm93c2VyIGhpc3Rvcnkgd2l0aGluIGEgdGltZSByYW5nZS5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gX2V4ZWNIaXN0b3J5UmVjZW50KHsgc3RhcnRUaW1lLCBlbmRUaW1lLCBtYXhSZXN1bHRzIH0pIHtcbiAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcbiAgY29uc3QgcmVzb2x2ZWRFbmRUaW1lID0gTnVtYmVyLmlzRmluaXRlKGVuZFRpbWUpID8gZW5kVGltZSA6IG5vdztcbiAgY29uc3QgcmVzb2x2ZWRTdGFydFRpbWUgPSBOdW1iZXIuaXNGaW5pdGUoc3RhcnRUaW1lKVxuICAgID8gc3RhcnRUaW1lXG4gICAgOiAocmVzb2x2ZWRFbmRUaW1lIC0gNyAqIDI0ICogNjAgKiA2MCAqIDEwMDApO1xuICBjb25zdCByZXNvbHZlZE1heFJlc3VsdHMgPSBNYXRoLm1pbigxMDAsIE1hdGgubWF4KDEsIE51bWJlci5pc0Zpbml0ZShtYXhSZXN1bHRzKSA/IE1hdGguZmxvb3IobWF4UmVzdWx0cykgOiAxMDApKTtcblxuICBpZiAocmVzb2x2ZWRTdGFydFRpbWUgPiByZXNvbHZlZEVuZFRpbWUpIHtcbiAgICByZXR1cm4geyBlcnJvcjogXCJzdGFydFRpbWUgbXVzdCBiZSBsZXNzIHRoYW4gb3IgZXF1YWwgdG8gZW5kVGltZVwiIH07XG4gIH1cblxuICBjb25zdCByZXN1bHRzID0gYXdhaXQgY2hyb21lLmhpc3Rvcnkuc2VhcmNoKHtcbiAgICB0ZXh0OiBcIlwiLFxuICAgIG1heFJlc3VsdHM6IHJlc29sdmVkTWF4UmVzdWx0cyxcbiAgICBzdGFydFRpbWU6IHJlc29sdmVkU3RhcnRUaW1lLFxuICAgIGVuZFRpbWU6IHJlc29sdmVkRW5kVGltZVxuICB9KTtcblxuICByZXR1cm4ge1xuICAgIHN0YXJ0VGltZTogbmV3IERhdGUocmVzb2x2ZWRTdGFydFRpbWUpLnRvSVNPU3RyaW5nKCksXG4gICAgZW5kVGltZTogbmV3IERhdGUocmVzb2x2ZWRFbmRUaW1lKS50b0lTT1N0cmluZygpLFxuICAgIG1heFJlc3VsdHM6IHJlc29sdmVkTWF4UmVzdWx0cyxcbiAgICByZXN1bHRzOiByZXN1bHRzLm1hcChyID0+ICh7XG4gICAgICB1cmw6IHIudXJsLFxuICAgICAgdGl0bGU6IHIudGl0bGUsXG4gICAgICBsYXN0VmlzaXQ6IG5ldyBEYXRlKHIubGFzdFZpc2l0VGltZSkudG9JU09TdHJpbmcoKSxcbiAgICAgIHZpc2l0Q291bnQ6IHIudmlzaXRDb3VudFxuICAgIH0pKVxuICB9O1xufVxuXG4vKipcbiAqIEdldCBpbmZvIGFib3V0IHRoZSBjdXJyZW50bHkgYWN0aXZlL2ZvY3VzZWQgdGFiLlxuICovXG5hc3luYyBmdW5jdGlvbiBfZXhlY1RhYkdldEFjdGl2ZShfYXJncz86IHVua25vd24pIHtcbiAgY29uc3QgY2FwdHVyZWRBdCA9IF9idWlsZENhcHR1cmVkQXQoKTtcbiAgY29uc3QgW3RhYl0gPSBhd2FpdCBjaHJvbWUudGFicy5xdWVyeSh7IGFjdGl2ZTogdHJ1ZSwgbGFzdEZvY3VzZWRXaW5kb3c6IHRydWUgfSk7XG4gIGlmICghdGFiKSByZXR1cm4geyBlcnJvcjogXCJObyBhY3RpdmUgdGFiIGZvdW5kXCIgfTtcbiAgcmV0dXJuIHtcbiAgICBjYXB0dXJlZEF0LFxuICAgIHRhYklkOiB0YWIuaWQsXG4gICAgdXJsOiB0YWIudXJsLFxuICAgIHRpdGxlOiB0YWIudGl0bGUsXG4gICAgd2luZG93SWQ6IHRhYi53aW5kb3dJZCxcbiAgICBncm91cElkOiBfbm9ybWFsaXplR3JvdXBJZCh0YWIuZ3JvdXBJZCksXG4gICAgLi4uX2J1aWxkTGFzdEFjY2Vzc2VkKHRhYi5sYXN0QWNjZXNzZWQpXG4gIH07XG59XG5cbmZ1bmN0aW9uIF9zbGVlcE1zKG1zKSB7XG4gIGNvbnN0IG4gPSBNYXRoLm1heCgwLCBNYXRoLmZsb29yKG1zKSk7XG4gIGlmICghbikgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgbikpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBfcmVhZFBhZ2VTY3JvbGxNZXRyaWNzKHRhYikge1xuICB0cnkge1xuICAgIGNvbnN0IHJlc3VsdHMgPSBhd2FpdCBjaHJvbWUuc2NyaXB0aW5nLmV4ZWN1dGVTY3JpcHQoe1xuICAgICAgdGFyZ2V0OiB7IHRhYklkOiB0YWIuaWQgfSxcbiAgICAgIGZ1bmM6ICgpID0+IHtcbiAgICAgICAgY29uc3Qgc2Nyb2xsZXIgPSBkb2N1bWVudC5zY3JvbGxpbmdFbGVtZW50IHx8IGRvY3VtZW50LmRvY3VtZW50RWxlbWVudCB8fCBkb2N1bWVudC5ib2R5O1xuICAgICAgICBjb25zdCB2aWV3cG9ydEhlaWdodCA9IHdpbmRvdy5pbm5lckhlaWdodCB8fCBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuY2xpZW50SGVpZ2h0IHx8IDA7XG4gICAgICAgIGNvbnN0IHZpZXdwb3J0V2lkdGggPSB3aW5kb3cuaW5uZXJXaWR0aCB8fCBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuY2xpZW50V2lkdGggfHwgMDtcbiAgICAgICAgY29uc3QgZG9jdW1lbnRIZWlnaHQgPSBNYXRoLm1heChcbiAgICAgICAgICBzY3JvbGxlcj8uc2Nyb2xsSGVpZ2h0IHx8IDAsXG4gICAgICAgICAgZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50Py5zY3JvbGxIZWlnaHQgfHwgMCxcbiAgICAgICAgICBkb2N1bWVudC5ib2R5Py5zY3JvbGxIZWlnaHQgfHwgMFxuICAgICAgICApO1xuICAgICAgICBjb25zdCBzY3JvbGxZID0gd2luZG93LnNjcm9sbFkgfHwgc2Nyb2xsZXI/LnNjcm9sbFRvcCB8fCAwO1xuICAgICAgICBjb25zdCBtYXhTY3JvbGxZID0gTWF0aC5tYXgoMCwgZG9jdW1lbnRIZWlnaHQgLSB2aWV3cG9ydEhlaWdodCk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgdmlld3BvcnRIZWlnaHQsXG4gICAgICAgICAgdmlld3BvcnRXaWR0aCxcbiAgICAgICAgICBkb2N1bWVudEhlaWdodCxcbiAgICAgICAgICBzY3JvbGxZLFxuICAgICAgICAgIG1heFNjcm9sbFksXG4gICAgICAgICAgYXRCb3R0b206IHNjcm9sbFkgPj0gbWF4U2Nyb2xsWSAtIDEuNVxuICAgICAgICB9O1xuICAgICAgfVxuICAgIH0pO1xuICAgIHJldHVybiByZXN1bHRzPy5bMF0/LnJlc3VsdCB8fCBudWxsO1xuICB9IGNhdGNoIChfZSkge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIF9zZXRQYWdlU2Nyb2xsVG9wKHRhYiwgdG9wKSB7XG4gIGNvbnN0IHkgPSBNYXRoLm1heCgwLCBOdW1iZXIodG9wKSB8fCAwKTtcbiAgYXdhaXQgY2hyb21lLnNjcmlwdGluZy5leGVjdXRlU2NyaXB0KHtcbiAgICB0YXJnZXQ6IHsgdGFiSWQ6IHRhYi5pZCB9LFxuICAgIGZ1bmM6IChzY3JvbGxUb3ApID0+IHtcbiAgICAgIHdpbmRvdy5zY3JvbGxUbyh7IHRvcDogc2Nyb2xsVG9wLCBsZWZ0OiAwLCBiZWhhdmlvcjogXCJhdXRvXCIgfSk7XG4gICAgfSxcbiAgICBhcmdzOiBbeV1cbiAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIF9yZWFkSW5uZXJIZWlnaHRBbmRTY3JvbGxZKHRhYikge1xuICB0cnkge1xuICAgIGNvbnN0IHJlc3VsdHMgPSBhd2FpdCBjaHJvbWUuc2NyaXB0aW5nLmV4ZWN1dGVTY3JpcHQoe1xuICAgICAgdGFyZ2V0OiB7IHRhYklkOiB0YWIuaWQgfSxcbiAgICAgIGZ1bmM6ICgpID0+IHtcbiAgICAgICAgY29uc3Qgc2Nyb2xsZXIgPSBkb2N1bWVudC5zY3JvbGxpbmdFbGVtZW50IHx8IGRvY3VtZW50LmRvY3VtZW50RWxlbWVudCB8fCBkb2N1bWVudC5ib2R5O1xuICAgICAgICBjb25zdCBpbm5lckhlaWdodCA9IHdpbmRvdy5pbm5lckhlaWdodCB8fCBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuY2xpZW50SGVpZ2h0IHx8IDA7XG4gICAgICAgIGNvbnN0IGRvY3VtZW50SGVpZ2h0ID0gTWF0aC5tYXgoXG4gICAgICAgICAgc2Nyb2xsZXI/LnNjcm9sbEhlaWdodCB8fCAwLFxuICAgICAgICAgIGRvY3VtZW50LmRvY3VtZW50RWxlbWVudD8uc2Nyb2xsSGVpZ2h0IHx8IDAsXG4gICAgICAgICAgZG9jdW1lbnQuYm9keT8uc2Nyb2xsSGVpZ2h0IHx8IDBcbiAgICAgICAgKTtcbiAgICAgICAgY29uc3Qgc2Nyb2xsWSA9IHdpbmRvdy5zY3JvbGxZIHx8IHNjcm9sbGVyPy5zY3JvbGxUb3AgfHwgMDtcbiAgICAgICAgY29uc3QgbWF4U2Nyb2xsWSA9IE1hdGgubWF4KDAsIGRvY3VtZW50SGVpZ2h0IC0gaW5uZXJIZWlnaHQpO1xuICAgICAgICByZXR1cm4geyBpbm5lckhlaWdodCwgc2Nyb2xsWSwgbWF4U2Nyb2xsWSwgZG9jdW1lbnRIZWlnaHQgfTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICByZXR1cm4gcmVzdWx0cz8uWzBdPy5yZXN1bHQgfHwgbnVsbDtcbiAgfSBjYXRjaCAoX2UpIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBfbG9hZEltYWdlRnJvbURhdGFVcmwoZGF0YVVybDogc3RyaW5nKTogUHJvbWlzZTxIVE1MSW1hZ2VFbGVtZW50PiB7XG4gIHJldHVybiBhd2FpdCBuZXcgUHJvbWlzZTxIVE1MSW1hZ2VFbGVtZW50PigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgY29uc3QgaW1hZ2UgPSBuZXcgSW1hZ2UoKTtcbiAgICBpbWFnZS5vbmxvYWQgPSAoKSA9PiByZXNvbHZlKGltYWdlKTtcbiAgICBpbWFnZS5vbmVycm9yID0gKCkgPT4gcmVqZWN0KG5ldyBFcnJvcihcIkZhaWxlZCB0byBkZWNvZGUgc2NyZWVuc2hvdCBpbWFnZVwiKSk7XG4gICAgaW1hZ2Uuc3JjID0gZGF0YVVybDtcbiAgfSk7XG59XG5cbmNvbnN0IEZVTExfUEFHRV9NQVhfU1RJVENIX1BYID0gMTYwMDA7XG4vKiogV2hlbiB0cnVlLCBkcmF3cyBhIDJweCByZWQgYmFyIGF0IGVhY2ggbmV3IHRpbGUgYm91bmRhcnkgKHRvcCBvZiBzdGl0Y2hlZCBzZWdtZW50KSBmb3IgZGVidWdnaW5nLiAqL1xuY29uc3QgRlVMTF9QQUdFX1NUSVRDSF9ERUJVR19CT1JERVIgPSBmYWxzZTtcblxuLyoqXG4gKiBDYXB0dXJlIGEgc2NyZWVuc2hvdCBvZiB0aGUgY3VycmVudGx5IHZpc2libGUgdGFiICh2aWV3cG9ydCksIG9yIGZ1bGwgc2Nyb2xsIGhlaWdodCB3aGVuIGZ1bGxQYWdlIGlzIHRydWUuXG4gKiBSZXR1cm5zIGFuIG9wdGltaXplZCBiYXNlNjQgaW1hZ2UgZGF0YSBVUkwuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIF9leGVjVGFiU2NyZWVuc2hvdChhcmdzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9KSB7XG4gIC8vIFRPRE86IEtlZXAgdGhlIGludGVybmFsIGZ1bGxQYWdlIHN0aXRjaGluZyBwYXRoIGZvciBmdXR1cmUgdXNlLCBidXQgZG8gbm90IGV4cG9zZVxuICAvLyBpdCB0byB0aGUgbW9kZWwgeWV0LiBUaGUgY3VycmVudCBmdWxsLXBhZ2UgcmVzdWx0IHF1YWxpdHkgc3RpbGwgbmVlZHMgaW1wcm92ZW1lbnQuXG4gIGNvbnN0IHtcbiAgICB3aW5kb3dJZCxcbiAgICB0YWJJZCxcbiAgICBmdWxsUGFnZSxcbiAgICBtYXhTY3JlZW5zOiBtYXhTY3JlZW5zUmF3LFxuICAgIHNldHRsZU1zOiBzZXR0bGVNc1Jhd1xuICB9ID0gYXJncyBhcyB7XG4gICAgd2luZG93SWQ/OiBudW1iZXI7XG4gICAgdGFiSWQ/OiBudW1iZXI7XG4gICAgZnVsbFBhZ2U/OiBib29sZWFuO1xuICAgIG1heFNjcmVlbnM/OiBudW1iZXI7XG4gICAgc2V0dGxlTXM/OiBudW1iZXI7XG4gIH07XG5cbiAgY29uc3QgcmVzb2x2ZWQgPSBhd2FpdCBfcmVzb2x2ZUNvbnRyb2xsYWJsZVRhYih0YWJJZCwgXCJzY3JlZW5zaG90XCIpO1xuICBpZiAocmVzb2x2ZWQuZXJyb3IpIHJldHVybiB7IGVycm9yOiByZXNvbHZlZC5lcnJvciB9O1xuXG4gIGNvbnN0IHRhYiA9IHJlc29sdmVkLnRhYjtcbiAgY29uc3Qgd2lkID0gdHlwZW9mIHdpbmRvd0lkID09PSBcIm51bWJlclwiID8gd2luZG93SWQgOiB0YWIud2luZG93SWQ7XG5cbiAgY29uc3QgbWF4U2NyZWVucyA9IE51bWJlci5pc0Zpbml0ZShtYXhTY3JlZW5zUmF3KSA/IE1hdGgubWF4KDEsIE1hdGgubWluKDEwMCwgTWF0aC5mbG9vcihtYXhTY3JlZW5zUmF3KSkpIDogNDA7XG4gIGNvbnN0IHNldHRsZU1zID0gTnVtYmVyLmlzRmluaXRlKHNldHRsZU1zUmF3KSA/IE1hdGgubWF4KDAsIE1hdGgubWluKDUwMDAsIHNldHRsZU1zUmF3KSkgOiAyNTA7XG5cbiAgY29uc3QgaXNGdWxsUGFnZSA9IGZ1bGxQYWdlID09PSB0cnVlO1xuXG4gIGNvbnN0IGJhc2VOb3RlID0gaXNGdWxsUGFnZVxuICAgID8gXCJGdWxsLXBhZ2Ugc3RpdGNoOiB0YWIgd2luZG93IHdhcyBmb2N1c2VkOyBzY3JvbGwgcG9zaXRpb24gcmVzdG9yZWQgd2hlbiBwb3NzaWJsZS5cIlxuICAgIDogXCJPcHRpbWl6ZWQgc2NyZWVuc2hvdCBvZiB0aGUgdmlzaWJsZSB0YWIuXCI7XG5cbiAgaWYgKCFpc0Z1bGxQYWdlKSB7XG4gICAgdHJ5IHtcbiAgICAgIGlmICh0YWJJZCAhPSBudWxsKSB7XG4gICAgICAgIGF3YWl0IGNocm9tZS50YWJzLnVwZGF0ZSh0YWIuaWQsIHsgYWN0aXZlOiB0cnVlIH0pO1xuICAgICAgICBhd2FpdCBjaHJvbWUud2luZG93cy51cGRhdGUodGFiLndpbmRvd0lkLCB7IGZvY3VzZWQ6IHRydWUgfSk7XG4gICAgICAgIGF3YWl0IF9zbGVlcE1zKDgwKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHJhd0RhdGFVcmwgPSBhd2FpdCBjaHJvbWUudGFicy5jYXB0dXJlVmlzaWJsZVRhYih3aWQsIHsgZm9ybWF0OiBcInBuZ1wiIH0pO1xuICAgICAgY29uc3Qgb3B0aW1pemVkID0gYXdhaXQgX29wdGltaXplU2NyZWVuc2hvdERhdGFVcmwocmF3RGF0YVVybCk7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBzdWNjZXNzOiB0cnVlLFxuICAgICAgICBmdWxsUGFnZTogZmFsc2UsXG4gICAgICAgIHRhYklkOiB0YWIuaWQsXG4gICAgICAgIHdpbmRvd0lkOiB0YWIud2luZG93SWQsXG4gICAgICAgIGRhdGFVcmw6IG9wdGltaXplZC5kYXRhVXJsLFxuICAgICAgICBmb3JtYXQ6IG9wdGltaXplZC5tZWRpYVR5cGUuc3BsaXQoXCIvXCIpWzFdIHx8IFwianBlZ1wiLFxuICAgICAgICBtZWRpYVR5cGU6IG9wdGltaXplZC5tZWRpYVR5cGUsXG4gICAgICAgIGFwcHJveEJ5dGVzOiBvcHRpbWl6ZWQuYXBwcm94Qnl0ZXMsXG4gICAgICAgIHdpZHRoOiBvcHRpbWl6ZWQud2lkdGgsXG4gICAgICAgIGhlaWdodDogb3B0aW1pemVkLmhlaWdodCxcbiAgICAgICAgb3JpZ2luYWxXaWR0aDogb3B0aW1pemVkLm9yaWdpbmFsV2lkdGgsXG4gICAgICAgIG9yaWdpbmFsSGVpZ2h0OiBvcHRpbWl6ZWQub3JpZ2luYWxIZWlnaHQsXG4gICAgICAgIG9wdGltaXplZDogb3B0aW1pemVkLm9wdGltaXplZCxcbiAgICAgICAgbm90ZTogYmFzZU5vdGVcbiAgICAgIH07XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgZXJyb3I6IGU/Lm1lc3NhZ2UgfHwgU3RyaW5nKGUpLFxuICAgICAgICBoaW50OiBcImNhcHR1cmVWaXNpYmxlVGFiIHJlcXVpcmVzIHRoZSB0YXJnZXQgdGFiIHRvIGJlIGFjdGl2ZSBpbiBpdHMgd2luZG93LiBQYXNzIHRhYklkIHRvIGZvY3VzIHRoYXQgdGFiIGZpcnN0LlwiXG4gICAgICB9O1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IG0wID0gYXdhaXQgX3JlYWRQYWdlU2Nyb2xsTWV0cmljcyh0YWIpO1xuICBpZiAoIW0wKSB7XG4gICAgcmV0dXJuIHsgZXJyb3I6IFwiVW5hYmxlIHRvIHJlYWQgc2Nyb2xsIG1ldHJpY3MgZm9yIGZ1bGwtcGFnZSBzY3JlZW5zaG90LlwiIH07XG4gIH1cbiAgY29uc3QgaW5pdGlhbFNjcm9sbFkgPSBtMC5zY3JvbGxZO1xuXG4gIGxldCBzdG9wcGVkUmVhc29uID0gXCJjb21wbGV0ZWRcIjtcbiAgbGV0IGNhbnZhcyA9IG51bGw7XG4gIGxldCBjdHggPSBudWxsO1xuICBsZXQgZGVzdFkgPSAwO1xuICBsZXQgc2xpY2VzRHJhd24gPSAwO1xuICBsZXQgZXhpdGVkQ2FwdHVyZUxvb3BFYXJseSA9IGZhbHNlO1xuXG4gIHRyeSB7XG4gICAgYXdhaXQgY2hyb21lLnRhYnMudXBkYXRlKHRhYi5pZCwgeyBhY3RpdmU6IHRydWUgfSk7XG4gICAgYXdhaXQgY2hyb21lLndpbmRvd3MudXBkYXRlKHRhYi53aW5kb3dJZCwgeyBmb2N1c2VkOiB0cnVlIH0pO1xuICAgIGF3YWl0IF9zbGVlcE1zKDgwKTtcblxuICAgIGF3YWl0IF9zZXRQYWdlU2Nyb2xsVG9wKHRhYiwgMCk7XG4gICAgaWYgKHNldHRsZU1zKSBhd2FpdCBfc2xlZXBNcyhzZXR0bGVNcyk7XG5cbiAgICBjb25zdCBoaTAgPSBhd2FpdCBfcmVhZElubmVySGVpZ2h0QW5kU2Nyb2xsWSh0YWIpO1xuICAgIGlmICghaGkwKSB7XG4gICAgICByZXR1cm4geyBlcnJvcjogXCJVbmFibGUgdG8gcmVhZCBpbm5lckhlaWdodC9zY3JvbGxZIGZvciBmdWxsLXBhZ2Ugc2NyZWVuc2hvdC5cIiB9O1xuICAgIH1cblxuICAgIGNvbnN0IHdpbmRvd0hlaWdodCA9IE1hdGgubWF4KDEsIE1hdGgucm91bmQoaGkwLmlubmVySGVpZ2h0KSk7XG4gICAgbGV0IGxhc3RTY3JvbGxBZnRlclN0aXRjaCA9IGhpMC5zY3JvbGxZO1xuXG4gICAgLyoqIENocm9tZSB0aHJvdHRsZXMgY2FwdHVyZVZpc2libGVUYWIgKH4yL3NlYyk7IHN0YXkgdW5kZXIgcXVvdGEgYmV0d2VlbiByZWFsIGNhcHR1cmVzLiAqL1xuICAgIGNvbnN0IE1JTl9DQVBUVVJFX0dBUF9NUyA9IDY1MDtcbiAgICBsZXQgbGFzdENhcHR1cmVBdE1zID0gMDtcblxuICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBuby1pbm5lci1kZWNsYXJhdGlvbnNcbiAgICBhc3luYyBmdW5jdGlvbiBjYXB0dXJlVmlzaWJsZVRocm90dGxlZCgpIHtcbiAgICAgIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gICAgICBpZiAobGFzdENhcHR1cmVBdE1zID4gMCkge1xuICAgICAgICBjb25zdCB3YWl0TXMgPSBNSU5fQ0FQVFVSRV9HQVBfTVMgLSAobm93IC0gbGFzdENhcHR1cmVBdE1zKTtcbiAgICAgICAgaWYgKHdhaXRNcyA+IDApIGF3YWl0IF9zbGVlcE1zKHdhaXRNcyk7XG4gICAgICB9XG4gICAgICBjb25zdCB1cmwgPSBhd2FpdCBjaHJvbWUudGFicy5jYXB0dXJlVmlzaWJsZVRhYih3aWQsIHsgZm9ybWF0OiBcInBuZ1wiIH0pO1xuICAgICAgbGFzdENhcHR1cmVBdE1zID0gRGF0ZS5ub3coKTtcbiAgICAgIHJldHVybiB1cmw7XG4gICAgfVxuXG4gICAgY29uc3QgbGF5b3V0QWZ0ZXJUb3AgPSBhd2FpdCBfcmVhZFBhZ2VTY3JvbGxNZXRyaWNzKHRhYik7XG4gICAgY29uc3QgZG9jdW1lbnRIZWlnaHQgPSBNYXRoLm1heCh3aW5kb3dIZWlnaHQsIGxheW91dEFmdGVyVG9wPy5kb2N1bWVudEhlaWdodCA/PyB3aW5kb3dIZWlnaHQpO1xuXG4gICAgY29uc3QgcmF3MCA9IGF3YWl0IGNhcHR1cmVWaXNpYmxlVGhyb3R0bGVkKCk7XG4gICAgY29uc3QgaW1nMCA9IGF3YWl0IF9sb2FkSW1hZ2VGcm9tRGF0YVVybChyYXcwKTtcbiAgICBjb25zdCBpdzAgPSBpbWcwLm5hdHVyYWxXaWR0aCB8fCBpbWcwLndpZHRoO1xuICAgIGNvbnN0IGloMCA9IGltZzAubmF0dXJhbEhlaWdodCB8fCBpbWcwLmhlaWdodDtcblxuICAgIGNhbnZhcyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJjYW52YXNcIik7XG4gICAgY2FudmFzLndpZHRoID0gaXcwO1xuICAgIGNvbnN0IGVzdFJvd3MgPSBNYXRoLmNlaWwoZG9jdW1lbnRIZWlnaHQgLyB3aW5kb3dIZWlnaHQpO1xuICAgIGNhbnZhcy5oZWlnaHQgPSBNYXRoLm1pbihcbiAgICAgIEZVTExfUEFHRV9NQVhfU1RJVENIX1BYLFxuICAgICAgTWF0aC5tYXgoaWgwLCBNYXRoLmNlaWwoZXN0Um93cyAqIGloMCkpXG4gICAgKTtcbiAgICBjdHggPSBjYW52YXMuZ2V0Q29udGV4dChcIjJkXCIsIHsgYWxwaGE6IGZhbHNlIH0pO1xuICAgIGlmICghY3R4KSB7XG4gICAgICByZXR1cm4geyBlcnJvcjogXCIyRCBjYW52YXMgY29udGV4dCB1bmF2YWlsYWJsZSBmb3IgZnVsbC1wYWdlIHN0aXRjaC5cIiB9O1xuICAgIH1cbiAgICBjdHguZmlsbFN0eWxlID0gXCIjZmZmZmZmXCI7XG4gICAgY3R4LmZpbGxSZWN0KDAsIDAsIGNhbnZhcy53aWR0aCwgY2FudmFzLmhlaWdodCk7XG4gICAgY3R4LmRyYXdJbWFnZShpbWcwLCAwLCAwKTtcbiAgICBkZXN0WSA9IGloMDtcbiAgICBzbGljZXNEcmF3biA9IDE7XG5cbiAgICBsZXQgbiA9IDE7XG4gICAgd2hpbGUgKHNsaWNlc0RyYXduIDwgbWF4U2NyZWVucykge1xuICAgICAgYXdhaXQgX3NldFBhZ2VTY3JvbGxUb3AodGFiLCBuICogd2luZG93SGVpZ2h0KTtcbiAgICAgIGlmIChzZXR0bGVNcykgYXdhaXQgX3NsZWVwTXMoc2V0dGxlTXMpO1xuXG4gICAgICBjb25zdCBzdCA9IGF3YWl0IF9yZWFkSW5uZXJIZWlnaHRBbmRTY3JvbGxZKHRhYik7XG4gICAgICBpZiAoIXN0KSB7XG4gICAgICAgIHN0b3BwZWRSZWFzb24gPSBcIm1ldHJpY3NfZmFpbGVkXCI7XG4gICAgICAgIGV4aXRlZENhcHR1cmVMb29wRWFybHkgPSB0cnVlO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNvbnN0IHZoID0gTWF0aC5tYXgoMSwgTWF0aC5yb3VuZChzdC5pbm5lckhlaWdodCkpO1xuICAgICAgY29uc3Qgc3kgPSBzdC5zY3JvbGxZO1xuICAgICAgY29uc3QgdGFyZ2V0WSA9IG4gKiB3aW5kb3dIZWlnaHQ7XG4gICAgICBjb25zdCBtYXhTY3JvbGxZID0gTWF0aC5tYXgoMCwgTnVtYmVyKHN0Lm1heFNjcm9sbFkpIHx8IDApO1xuICAgICAgLyoqXG4gICAgICAgKiBUcnVlIG9ubHkgd2hlbiBzY3JvbGxZIGlzIHBpbm5lZCBuZWFyIG1heFNjcm9sbFkgKHN5bW1ldHJpYyBiYW5kKS5cbiAgICAgICAqIFVzaW5nIG9ubHkgc3kgPj0gbWF4U2Nyb2xsWSAtIGVwcyBicmVha3Mgd2hlbiBtYXhTY3JvbGxZIGlzIHVuZGVyZXN0aW1hdGVkIChsYXp5IGxheW91dCk6XG4gICAgICAgKiBzeSBjYW4gYWxyZWFkeSBiZSBmYXIgYmVsb3cgYSB0b28tc21hbGwgbWF4U2Nyb2xsWSwgZmFsc2VseSBsb29raW5nIFwiYXQgYm90dG9tXCIuXG4gICAgICAgKi9cbiAgICAgIGNvbnN0IEVQU19QSU4gPSAyNDtcbiAgICAgIGNvbnN0IHBpbm5lZFRvTWV0cmljc0JvdHRvbSA9XG4gICAgICAgIG1heFNjcm9sbFkgPiAwICYmIE51bWJlci5pc0Zpbml0ZShzeSkgJiYgTWF0aC5hYnMoc3kgLSBtYXhTY3JvbGxZKSA8PSBFUFNfUElOO1xuICAgICAgLyoqIFJlcXVlc3RlZCBzY3JvbGwgdGFyZ2V0IGxpZXMgcGFzdCB0aGUgZnVydGhlc3Qgc2Nyb2xsYWJsZSBZIOKAlCBicm93c2VyIGNsYW1wZWQsIHRoaXMgdGlsZSBuZWVkcyBib3R0b20gY3JvcC4gKi9cbiAgICAgIGNvbnN0IHJlcXVlc3RQYXN0RG9jdW1lbnRFbmQgPSB0YXJnZXRZID4gbWF4U2Nyb2xsWSArIDAuNTtcblxuICAgICAgaWYgKHN5IDw9IGxhc3RTY3JvbGxBZnRlclN0aXRjaCArIDAuNSkge1xuICAgICAgICBzdG9wcGVkUmVhc29uID0gXCJjb21wbGV0ZWRcIjtcbiAgICAgICAgZXhpdGVkQ2FwdHVyZUxvb3BFYXJseSA9IHRydWU7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBpc0xhc3RQYWdlID0gbWF4U2Nyb2xsWSA+IDAgJiYgcmVxdWVzdFBhc3REb2N1bWVudEVuZCAmJiBwaW5uZWRUb01ldHJpY3NCb3R0b207XG5cbiAgICAgIGNvbnN0IHJhd0RhdGFVcmwgPSBhd2FpdCBjYXB0dXJlVmlzaWJsZVRocm90dGxlZCgpO1xuICAgICAgY29uc3QgaW1nID0gYXdhaXQgX2xvYWRJbWFnZUZyb21EYXRhVXJsKHJhd0RhdGFVcmwpO1xuICAgICAgY29uc3QgaXcgPSBpbWcubmF0dXJhbFdpZHRoIHx8IGltZy53aWR0aDtcbiAgICAgIGNvbnN0IGloID0gaW1nLm5hdHVyYWxIZWlnaHQgfHwgaW1nLmhlaWdodDtcblxuICAgICAgbGV0IHNhZmVDcm9wVG9wID0gMDtcbiAgICAgIGlmIChpc0xhc3RQYWdlKSB7XG4gICAgICAgIGNvbnN0IHJlbWFpbkZvckxhc3QgPSBNYXRoLm1heCgwLCB0YXJnZXRZIC0gc3kpO1xuICAgICAgICBjb25zdCBrZWVwRG9jUHggPSBNYXRoLm1pbih2aCwgcmVtYWluRm9yTGFzdCk7XG4gICAgICAgIGNvbnN0IGNyb3BUb3AgPSBNYXRoLnJvdW5kKGloIC0gKGtlZXBEb2NQeCAvIHZoKSAqIGloKTtcbiAgICAgICAgc2FmZUNyb3BUb3AgPSBNYXRoLm1pbihNYXRoLm1heCgwLCBjcm9wVG9wKSwgTWF0aC5tYXgoMCwgaWggLSAxKSk7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHNsaWNlSCA9IGloIC0gc2FmZUNyb3BUb3A7XG5cbiAgICAgIGlmIChkZXN0WSArIHNsaWNlSCA+IEZVTExfUEFHRV9NQVhfU1RJVENIX1BYKSB7XG4gICAgICAgIHN0b3BwZWRSZWFzb24gPSBcIm1heF9jYW52YXNcIjtcbiAgICAgICAgZXhpdGVkQ2FwdHVyZUxvb3BFYXJseSA9IHRydWU7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuXG4gICAgICBpZiAoZGVzdFkgKyBzbGljZUggPiBjYW52YXMuaGVpZ2h0KSB7XG4gICAgICAgIGNvbnN0IG5ld0ggPSBNYXRoLm1pbihcbiAgICAgICAgICBGVUxMX1BBR0VfTUFYX1NUSVRDSF9QWCxcbiAgICAgICAgICBNYXRoLm1heChkZXN0WSArIHNsaWNlSCwgTWF0aC5jZWlsKGNhbnZhcy5oZWlnaHQgKiAxLjUpKVxuICAgICAgICApO1xuICAgICAgICBpZiAobmV3SCA8IGRlc3RZICsgc2xpY2VIKSB7XG4gICAgICAgICAgc3RvcHBlZFJlYXNvbiA9IFwibWF4X2NhbnZhc1wiO1xuICAgICAgICAgIGV4aXRlZENhcHR1cmVMb29wRWFybHkgPSB0cnVlO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IG5ld0NhbnZhcyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJjYW52YXNcIik7XG4gICAgICAgIG5ld0NhbnZhcy53aWR0aCA9IGNhbnZhcy53aWR0aDtcbiAgICAgICAgbmV3Q2FudmFzLmhlaWdodCA9IG5ld0g7XG4gICAgICAgIGNvbnN0IG5jdHggPSBuZXdDYW52YXMuZ2V0Q29udGV4dChcIjJkXCIsIHsgYWxwaGE6IGZhbHNlIH0pO1xuICAgICAgICBpZiAoIW5jdHgpIHtcbiAgICAgICAgICByZXR1cm4geyBlcnJvcjogXCIyRCBjYW52YXMgY29udGV4dCB1bmF2YWlsYWJsZSB3aGlsZSByZXNpemluZyBzdGl0Y2ggY2FudmFzLlwiIH07XG4gICAgICAgIH1cbiAgICAgICAgbmN0eC5maWxsU3R5bGUgPSBcIiNmZmZmZmZcIjtcbiAgICAgICAgbmN0eC5maWxsUmVjdCgwLCAwLCBuZXdDYW52YXMud2lkdGgsIG5ld0NhbnZhcy5oZWlnaHQpO1xuICAgICAgICBuY3R4LmRyYXdJbWFnZShjYW52YXMsIDAsIDApO1xuICAgICAgICBjYW52YXMgPSBuZXdDYW52YXM7XG4gICAgICAgIGN0eCA9IG5jdHg7XG4gICAgICB9XG5cbiAgICAgIGlmIChGVUxMX1BBR0VfU1RJVENIX0RFQlVHX0JPUkRFUiAmJiBzbGljZXNEcmF3biA+IDAgJiYgZGVzdFkgPiAwKSB7XG4gICAgICAgIGN0eC5maWxsU3R5bGUgPSBcIiNmZjAwMDBcIjtcbiAgICAgICAgY3R4LmZpbGxSZWN0KDAsIGRlc3RZLCBjYW52YXMud2lkdGgsIDIpO1xuICAgICAgfVxuXG4gICAgICBjdHguZHJhd0ltYWdlKGltZywgMCwgc2FmZUNyb3BUb3AsIGl3LCBzbGljZUgsIDAsIGRlc3RZLCBjYW52YXMud2lkdGgsIHNsaWNlSCk7XG4gICAgICBkZXN0WSArPSBzbGljZUg7XG4gICAgICBzbGljZXNEcmF3bisrO1xuICAgICAgbGFzdFNjcm9sbEFmdGVyU3RpdGNoID0gc3k7XG5cbiAgICAgIGlmIChpc0xhc3RQYWdlKSB7XG4gICAgICAgIHN0b3BwZWRSZWFzb24gPSBcImNvbXBsZXRlZFwiO1xuICAgICAgICBleGl0ZWRDYXB0dXJlTG9vcEVhcmx5ID0gdHJ1ZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBuKys7XG4gICAgfVxuXG4gICAgaWYgKHNsaWNlc0RyYXduID09PSAwKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBlcnJvcjogXCJObyBzY3JlZW5zaG90cyBjYXB0dXJlZCBmb3IgZnVsbCBwYWdlLlwiLFxuICAgICAgICBoaW50OiBcIlRyeSBhIG5vcm1hbCBodHRwKHMpIHBhZ2Ugd2l0aCBhIHNjcm9sbGFibGUgZG9jdW1lbnQuXCJcbiAgICAgIH07XG4gICAgfVxuXG4gICAgaWYgKFxuICAgICAgIWV4aXRlZENhcHR1cmVMb29wRWFybHkgJiZcbiAgICAgIHN0b3BwZWRSZWFzb24gPT09IFwiY29tcGxldGVkXCIgJiZcbiAgICAgIG1heFNjcmVlbnMgPiAxICYmXG4gICAgICBzbGljZXNEcmF3biA+PSBtYXhTY3JlZW5zXG4gICAgKSB7XG4gICAgICBzdG9wcGVkUmVhc29uID0gXCJtYXhfc2NyZWVuc1wiO1xuICAgIH1cblxuICAgIGNvbnN0IGxhc3RNZXRyaWNzID0gYXdhaXQgX3JlYWRQYWdlU2Nyb2xsTWV0cmljcyh0YWIpO1xuICAgIGNvbnN0IHRyaW1tZWQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiY2FudmFzXCIpO1xuICAgIHRyaW1tZWQud2lkdGggPSBjYW52YXMud2lkdGg7XG4gICAgdHJpbW1lZC5oZWlnaHQgPSBkZXN0WTtcbiAgICBjb25zdCB0Y3R4ID0gdHJpbW1lZC5nZXRDb250ZXh0KFwiMmRcIiwgeyBhbHBoYTogZmFsc2UgfSk7XG4gICAgaWYgKCF0Y3R4KSB7XG4gICAgICByZXR1cm4geyBlcnJvcjogXCJVbmFibGUgdG8gZmluYWxpemUgZnVsbC1wYWdlIGNhbnZhcy5cIiB9O1xuICAgIH1cbiAgICB0Y3R4LmRyYXdJbWFnZShjYW52YXMsIDAsIDApO1xuXG4gICAgY29uc3Qgc3RpdGNoZWRQbmcgPSB0cmltbWVkLnRvRGF0YVVSTChcImltYWdlL3BuZ1wiKTtcbiAgICBjb25zdCBvcHRpbWl6ZWQgPSBhd2FpdCBfb3B0aW1pemVTY3JlZW5zaG90RGF0YVVybChzdGl0Y2hlZFBuZywge1xuICAgICAgc3RyYXRlZ3k6IFwiZml0V2lkdGhcIixcbiAgICAgIG1heFdpZHRoOiAyMDQ4LFxuICAgICAgbWF4SGVpZ2h0OiAyNDAwMCxcbiAgICAgIGpwZWdRdWFsaXR5OiAwLjg4XG4gICAgfSk7XG5cbiAgICByZXR1cm4ge1xuICAgICAgc3VjY2VzczogdHJ1ZSxcbiAgICAgIGZ1bGxQYWdlOiB0cnVlLFxuICAgICAgdGFiSWQ6IHRhYi5pZCxcbiAgICAgIHdpbmRvd0lkOiB0YWIud2luZG93SWQsXG4gICAgICBzbGljZXM6IHNsaWNlc0RyYXduLFxuICAgICAgc3RvcHBlZFJlYXNvbixcbiAgICAgIHN0aXRjaE1vZGU6IFwicGFnZUFsaWduZWRcIixcbiAgICAgIHBhZ2VWaWV3cG9ydENzc1B4OiB3aW5kb3dIZWlnaHQsXG4gICAgICBtYXhTY3JlZW5zLFxuICAgICAgc2V0dGxlTXMsXG4gICAgICBzdGl0Y2hlZFdpZHRoOiB0cmltbWVkLndpZHRoLFxuICAgICAgc3RpdGNoZWRIZWlnaHQ6IHRyaW1tZWQuaGVpZ2h0LFxuICAgICAgZG9jdW1lbnRIZWlnaHQ6IGxhc3RNZXRyaWNzPy5kb2N1bWVudEhlaWdodCA/PyBudWxsLFxuICAgICAgZGF0YVVybDogb3B0aW1pemVkLmRhdGFVcmwsXG4gICAgICBmb3JtYXQ6IG9wdGltaXplZC5tZWRpYVR5cGUuc3BsaXQoXCIvXCIpWzFdIHx8IFwianBlZ1wiLFxuICAgICAgbWVkaWFUeXBlOiBvcHRpbWl6ZWQubWVkaWFUeXBlLFxuICAgICAgYXBwcm94Qnl0ZXM6IG9wdGltaXplZC5hcHByb3hCeXRlcyxcbiAgICAgIHdpZHRoOiBvcHRpbWl6ZWQud2lkdGgsXG4gICAgICBoZWlnaHQ6IG9wdGltaXplZC5oZWlnaHQsXG4gICAgICBvcmlnaW5hbFdpZHRoOiBvcHRpbWl6ZWQub3JpZ2luYWxXaWR0aCxcbiAgICAgIG9yaWdpbmFsSGVpZ2h0OiBvcHRpbWl6ZWQub3JpZ2luYWxIZWlnaHQsXG4gICAgICBvcHRpbWl6ZWQ6IG9wdGltaXplZC5vcHRpbWl6ZWQsXG4gICAgICBub3RlOiBiYXNlTm90ZVxuICAgIH07XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICByZXR1cm4ge1xuICAgICAgZXJyb3I6IGU/Lm1lc3NhZ2UgfHwgU3RyaW5nKGUpLFxuICAgICAgaGludDogXCJGdWxsLXBhZ2UgY2FwdHVyZSBmYWlsZWQuIEVuc3VyZSB0aGUgcGFnZSBhbGxvd3Mgc2NyaXB0aW5nIGFuZCB0aGUgdGFiIHN0YXlzIGFjdGl2ZS5cIlxuICAgIH07XG4gIH0gZmluYWxseSB7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IF9zZXRQYWdlU2Nyb2xsVG9wKHRhYiwgaW5pdGlhbFNjcm9sbFkpO1xuICAgIH0gY2F0Y2ggKF9lKSB7XG4gICAgICAvKiBpZ25vcmUgKi9cbiAgICB9XG4gIH1cbn1cblxuLyoqXG4gKiBHZXQgaW5mbyBhYm91dCBhbGwgYnJvd3NlciB3aW5kb3dzLlxuICovXG5hc3luYyBmdW5jdGlvbiBfZXhlY1dpbmRvd0xpc3QoX2FyZ3M/OiB1bmtub3duKSB7XG4gIGNvbnN0IGNhcHR1cmVkQXQgPSBfYnVpbGRDYXB0dXJlZEF0KCk7XG4gIGNvbnN0IFt3aW5kb3dzLCBjdXJyZW50V2luZG93XSA9IGF3YWl0IFByb21pc2UuYWxsKFtcbiAgICBjaHJvbWUud2luZG93cy5nZXRBbGwoeyBwb3B1bGF0ZTogdHJ1ZSB9KSxcbiAgICBjaHJvbWUud2luZG93cy5nZXRDdXJyZW50KHt9KVxuICBdKTtcbiAgcmV0dXJuIHtcbiAgICBjYXB0dXJlZEF0LFxuICAgIGNvdW50OiB3aW5kb3dzLmxlbmd0aCxcbiAgICBjdXJyZW50V2luZG93SWQ6IGN1cnJlbnRXaW5kb3c/LmlkID8/IG51bGwsXG4gICAgd2luZG93czogd2luZG93cy5tYXAod2luID0+IF9zZXJpYWxpemVXaW5kb3dNZXRhZGF0YSh3aW4sIGN1cnJlbnRXaW5kb3c/LmlkID8/IG51bGwpKVxuICB9O1xufVxuXG4vKipcbiAqIEdldCBpbmZvIGFib3V0IHRoZSBjdXJyZW50IGJyb3dzZXIgd2luZG93LlxuICovXG5hc3luYyBmdW5jdGlvbiBfZXhlY1dpbmRvd0dldEN1cnJlbnQoX2FyZ3M/OiB1bmtub3duKSB7XG4gIGNvbnN0IGNhcHR1cmVkQXQgPSBfYnVpbGRDYXB0dXJlZEF0KCk7XG4gIGNvbnN0IHdpbiA9IGF3YWl0IGNocm9tZS53aW5kb3dzLmdldEN1cnJlbnQoeyBwb3B1bGF0ZTogdHJ1ZSB9KTtcbiAgcmV0dXJuIHtcbiAgICBjYXB0dXJlZEF0LFxuICAgIHdpbmRvdzogX3NlcmlhbGl6ZVdpbmRvd01ldGFkYXRhKHdpbiwgd2luLmlkKVxuICB9O1xufVxuXG4vKipcbiAqIEZvY3VzIGEgYnJvd3NlciB3aW5kb3cgYnkgSUQuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIF9leGVjV2luZG93Rm9jdXMoeyB3aW5kb3dJZCB9KSB7XG4gIGNvbnN0IHByZXZpb3VzV2luZG93ID0gYXdhaXQgY2hyb21lLndpbmRvd3MuZ2V0Q3VycmVudCh7fSk7XG4gIGF3YWl0IGNocm9tZS53aW5kb3dzLnVwZGF0ZSh3aW5kb3dJZCwgeyBmb2N1c2VkOiB0cnVlIH0pO1xuICBjb25zdCBmb2N1c2VkV2luZG93ID0gYXdhaXQgY2hyb21lLndpbmRvd3MuZ2V0KHdpbmRvd0lkLCB7IHBvcHVsYXRlOiB0cnVlIH0pO1xuICByZXR1cm4ge1xuICAgIHN1Y2Nlc3M6IHRydWUsXG4gICAgY2FwdHVyZWRBdDogX2J1aWxkQ2FwdHVyZWRBdCgpLFxuICAgIHByZXZpb3VzV2luZG93SWQ6IHByZXZpb3VzV2luZG93Py5pZCA/PyBudWxsLFxuICAgIHdpbmRvdzogX3NlcmlhbGl6ZVdpbmRvd01ldGFkYXRhKGZvY3VzZWRXaW5kb3csIHdpbmRvd0lkKVxuICB9O1xufVxuXG4vKipcbiAqIE1vdmUgb25lIG9yIG1vcmUgdGFicyBpbnRvIGEgdGFyZ2V0IHdpbmRvdy5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gX2V4ZWNXaW5kb3dNb3ZlVGFiKHsgdGFiSWRzLCB3aW5kb3dJZCB9KSB7XG4gIGNvbnN0IGlkcyA9IEFycmF5LmlzQXJyYXkodGFiSWRzKSA/IHRhYklkcyA6IFt0YWJJZHNdO1xuICBjb25zdCBtb3ZlZCA9IGF3YWl0IGNocm9tZS50YWJzLm1vdmUoaWRzLCB7IHdpbmRvd0lkLCBpbmRleDogLTEgfSk7XG4gIGNvbnN0IG1vdmVkVGFicyA9IEFycmF5LmlzQXJyYXkobW92ZWQpID8gbW92ZWQgOiBbbW92ZWRdO1xuICBjb25zdCBjdXJyZW50V2luZG93ID0gYXdhaXQgY2hyb21lLndpbmRvd3MuZ2V0Q3VycmVudCh7fSk7XG4gIGNvbnN0IHRhcmdldFdpbmRvdyA9IGF3YWl0IGNocm9tZS53aW5kb3dzLmdldCh3aW5kb3dJZCwgeyBwb3B1bGF0ZTogdHJ1ZSB9KTtcbiAgcmV0dXJuIHtcbiAgICBzdWNjZXNzOiB0cnVlLFxuICAgIGNhcHR1cmVkQXQ6IF9idWlsZENhcHR1cmVkQXQoKSxcbiAgICB3aW5kb3dJZCxcbiAgICBtb3ZlZENvdW50OiBtb3ZlZFRhYnMubGVuZ3RoLFxuICAgIG1vdmVkVGFiczogbW92ZWRUYWJzLm1hcCh0YWIgPT4gX3NlcmlhbGl6ZVRhYk1ldGFkYXRhKHRhYikpLFxuICAgIHdpbmRvdzogX3NlcmlhbGl6ZVdpbmRvd01ldGFkYXRhKHRhcmdldFdpbmRvdywgY3VycmVudFdpbmRvdz8uaWQgPz8gbnVsbClcbiAgfTtcbn1cblxuLyoqXG4gKiBDcmVhdGUgYSBuZXcgYnJvd3NlciB3aW5kb3cuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIF9leGVjV2luZG93Q3JlYXRlKHsgdXJsLCBmb2N1c2VkIH0pIHtcbiAgY29uc3QgY3JlYXRlRGF0YTogY2hyb21lLndpbmRvd3MuQ3JlYXRlRGF0YSA9IHt9O1xuICBpZiAodXJsKSBjcmVhdGVEYXRhLnVybCA9IC9eW2Etel0rOlxcL1xcLy9pLnRlc3QodXJsKSA/IHVybCA6IGBodHRwczovLyR7dXJsfWA7XG4gIGlmIChmb2N1c2VkICE9IG51bGwpIGNyZWF0ZURhdGEuZm9jdXNlZCA9IGZvY3VzZWQ7XG5cbiAgY29uc3QgY3JlYXRlZFdpbmRvdyA9IGF3YWl0IGNocm9tZS53aW5kb3dzLmNyZWF0ZShjcmVhdGVEYXRhKTtcbiAgY29uc3Qgd2luID0gYXdhaXQgY2hyb21lLndpbmRvd3MuZ2V0KGNyZWF0ZWRXaW5kb3cuaWQsIHsgcG9wdWxhdGU6IHRydWUgfSk7XG4gIHJldHVybiB7XG4gICAgc3VjY2VzczogdHJ1ZSxcbiAgICBjYXB0dXJlZEF0OiBfYnVpbGRDYXB0dXJlZEF0KCksXG4gICAgd2luZG93OiBfc2VyaWFsaXplV2luZG93TWV0YWRhdGEod2luLCB3aW4uaWQpXG4gIH07XG59XG5cbi8qKlxuICogQ2xvc2UgYSBicm93c2VyIHdpbmRvdyBieSBJRC5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gX2V4ZWNXaW5kb3dDbG9zZSh7IHdpbmRvd0lkIH0pIHtcbiAgY29uc3QgY3VycmVudFdpbmRvdyA9IGF3YWl0IGNocm9tZS53aW5kb3dzLmdldEN1cnJlbnQoe30pO1xuICBjb25zdCB3aW4gPSBhd2FpdCBjaHJvbWUud2luZG93cy5nZXQod2luZG93SWQsIHsgcG9wdWxhdGU6IHRydWUgfSk7XG4gIGNvbnN0IHNuYXBzaG90ID0gX3NlcmlhbGl6ZVdpbmRvd01ldGFkYXRhKHdpbiwgY3VycmVudFdpbmRvdz8uaWQgPz8gbnVsbCk7XG4gIGF3YWl0IGNocm9tZS53aW5kb3dzLnJlbW92ZSh3aW5kb3dJZCk7XG4gIHJldHVybiB7XG4gICAgc3VjY2VzczogdHJ1ZSxcbiAgICBjYXB0dXJlZEF0OiBfYnVpbGRDYXB0dXJlZEF0KCksXG4gICAgY2xvc2VkV2luZG93SWQ6IHdpbmRvd0lkLFxuICAgIHdpbmRvdzogc25hcHNob3RcbiAgfTtcbn1cblxuLyoqXG4gKiBHZXQgY3VycmVudCBkYXRlLCB0aW1lLCB0aW1lem9uZSBhbmQgdW5peCB0aW1lc3RhbXAuXG4gKi9cbmZ1bmN0aW9uIF9leGVjR2V0Q3VycmVudFRpbWUoKSB7XG4gIGNvbnN0IG5vdyA9IG5ldyBEYXRlKCk7XG4gIHJldHVybiB7XG4gICAgdGltZXN0YW1wOiBub3cuZ2V0VGltZSgpLFxuICAgIGlzbzogbm93LnRvSVNPU3RyaW5nKCksXG4gICAgbG9jYWw6IG5vdy50b0xvY2FsZVN0cmluZygpLFxuICAgIHRpbWV6b25lOiBJbnRsLkRhdGVUaW1lRm9ybWF0KCkucmVzb2x2ZWRPcHRpb25zKCkudGltZVpvbmUsXG4gICAgdGltZXpvbmVPZmZzZXQ6IG5vdy5nZXRUaW1lem9uZU9mZnNldCgpXG4gIH07XG59XG5cbmZ1bmN0aW9uIF9zbmFwc2hvdFNjaGVkdWxlTWNwUmVnaXN0cnkobWNwUmVnaXN0cnkgPSBbXSkge1xuICByZXR1cm4gKG1jcFJlZ2lzdHJ5IHx8IFtdKS5tYXAodG9vbCA9PiAoe1xuICAgIG5hbWU6IHRvb2w/Lm5hbWUsXG4gICAgX3NlcnZlck5hbWU6IHRvb2w/Ll9zZXJ2ZXJOYW1lLFxuICAgIF9zZXJ2ZXJVcmw6IHRvb2w/Ll9zZXJ2ZXJVcmwsXG4gICAgX3NlcnZlckhlYWRlcnM6IHRvb2w/Ll9zZXJ2ZXJIZWFkZXJzIHx8IHt9LFxuICAgIF90b29sQ2FsbE5hbWU6IHRvb2w/Ll90b29sQ2FsbE5hbWUgfHwgYnVpbGRNY3BUb29sQ2FsbE5hbWUodG9vbD8uX3NlcnZlck5hbWUgfHwgXCJzZXJ2ZXJcIiwgdG9vbD8ubmFtZSlcbiAgfSkpLmZpbHRlcih0b29sID0+IHRvb2wubmFtZSAmJiB0b29sLl90b29sQ2FsbE5hbWUgJiYgdG9vbC5fc2VydmVyVXJsKTtcbn1cblxuZnVuY3Rpb24gX2lzVGVybWluYWxTY2hlZHVsZWRTdGF0dXMoc3RhdHVzKSB7XG4gIHJldHVybiBURVJNSU5BTF9TQ0hFRFVMRV9TVEFUVVNFUy5oYXMoc3RhdHVzKTtcbn1cblxuZnVuY3Rpb24gX2J1aWxkU2NoZWR1bGVGaXJlQWxhcm1OYW1lKHNjaGVkdWxlSWQpIHtcbiAgcmV0dXJuIGAke1NDSEVEVUxFX0ZJUkVfQUxBUk1fUFJFRklYfSR7c2NoZWR1bGVJZH1gO1xufVxuXG5mdW5jdGlvbiBfYnVpbGRTY2hlZHVsZUNsZWFudXBBbGFybU5hbWUoc2NoZWR1bGVJZCkge1xuICByZXR1cm4gYCR7U0NIRURVTEVfQ0xFQU5VUF9BTEFSTV9QUkVGSVh9JHtzY2hlZHVsZUlkfWA7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIF9sb2FkU2NoZWR1bGVkSm9ic0Zyb21TdG9yYWdlKCkge1xuICBjb25zdCB7IFtTQ0hFRFVMRV9TVE9SQUdFX0tFWV06IGpvYnMgfSA9IGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldCh7IFtTQ0hFRFVMRV9TVE9SQUdFX0tFWV06IFtdIH0pO1xuICByZXR1cm4gQXJyYXkuaXNBcnJheShqb2JzKSA/IGpvYnMgOiBbXTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gX3NhdmVTY2hlZHVsZWRKb2JzVG9TdG9yYWdlKGpvYnMpIHtcbiAgYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHsgW1NDSEVEVUxFX1NUT1JBR0VfS0VZXTogam9icyB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gX2NsZWFyU2NoZWR1bGVkQWxhcm1zKHNjaGVkdWxlSWQpIHtcbiAgaWYgKCFjaHJvbWUuYWxhcm1zKSByZXR1cm47XG4gIGF3YWl0IGNocm9tZS5hbGFybXMuY2xlYXIoX2J1aWxkU2NoZWR1bGVGaXJlQWxhcm1OYW1lKHNjaGVkdWxlSWQpKTtcbiAgYXdhaXQgY2hyb21lLmFsYXJtcy5jbGVhcihfYnVpbGRTY2hlZHVsZUNsZWFudXBBbGFybU5hbWUoc2NoZWR1bGVJZCkpO1xufVxuXG5mdW5jdGlvbiBfc2VyaWFsaXplU2NoZWR1bGVkSm9iKGpvYikge1xuICBjb25zdCByZW1haW5pbmdTZWNvbmRzID0gam9iLnN0YXR1cyA9PT0gXCJwZW5kaW5nXCJcbiAgICA/IE1hdGgubWF4KDAsIE1hdGgucm91bmQoKGpvYi5maXJlVGltZXN0YW1wIC0gRGF0ZS5ub3coKSkgLyAxMDAwKSlcbiAgICA6IDA7XG5cbiAgcmV0dXJuIHtcbiAgICBpZDogam9iLmlkLFxuICAgIHNjaGVkdWxlSWQ6IGpvYi5pZCxcbiAgICBsYWJlbDogam9iLmxhYmVsLFxuICAgIHRvb2xOYW1lOiBqb2IudG9vbE5hbWUsXG4gICAgdG9vbEFyZ3M6IGpvYi50b29sQXJncyxcbiAgICBmaXJlQXQ6IG5ldyBEYXRlKGpvYi5maXJlVGltZXN0YW1wKS50b0xvY2FsZVN0cmluZygpLFxuICAgIHN0YXR1czogam9iLnN0YXR1cyxcbiAgICByZW1haW5pbmdTZWNvbmRzLFxuICAgIHRpbWVvdXRTZWNvbmRzOiBNYXRoLnJvdW5kKChqb2IuZXhlY3V0ZVRpbWVvdXRNcyB8fCAoREVGQVVMVF9TQ0hFRFVMRV9UT09MX1RJTUVPVVRfU0VDT05EUyAqIDEwMDApKSAvIDEwMDApLFxuICAgIHN0YXJ0ZWRBdDogam9iLnN0YXJ0ZWRBdCA/IG5ldyBEYXRlKGpvYi5zdGFydGVkQXQpLnRvTG9jYWxlU3RyaW5nKCkgOiBudWxsLFxuICAgIGZpbmlzaGVkQXQ6IGpvYi5maW5pc2hlZEF0ID8gbmV3IERhdGUoam9iLmZpbmlzaGVkQXQpLnRvTG9jYWxlU3RyaW5nKCkgOiBudWxsLFxuICAgIGVycm9yOiBqb2IuZXJyb3IgfHwgbnVsbCxcbiAgICBleHBpcmVzQXQ6IGpvYi5leHBpcmVzQXQgPyBuZXcgRGF0ZShqb2IuZXhwaXJlc0F0KS50b0xvY2FsZVN0cmluZygpIDogbnVsbFxuICB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBfcHJ1bmVFeHBpcmVkU2NoZWR1bGVkSm9ic0luU3RvcmFnZSgpIHtcbiAgY29uc3Qgam9icyA9IGF3YWl0IF9sb2FkU2NoZWR1bGVkSm9ic0Zyb21TdG9yYWdlKCk7XG4gIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gIGNvbnN0IGtlcHQgPSBbXTtcblxuICBmb3IgKGNvbnN0IGpvYiBvZiBqb2JzKSB7XG4gICAgaWYgKF9pc1Rlcm1pbmFsU2NoZWR1bGVkU3RhdHVzKGpvYj8uc3RhdHVzKSAmJiBOdW1iZXIuaXNGaW5pdGUoam9iPy5leHBpcmVzQXQpICYmIGpvYi5leHBpcmVzQXQgPD0gbm93KSB7XG4gICAgICBhd2FpdCBfY2xlYXJTY2hlZHVsZWRBbGFybXMoam9iLmlkKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBrZXB0LnB1c2goam9iKTtcbiAgfVxuXG4gIGlmIChrZXB0Lmxlbmd0aCAhPT0gam9icy5sZW5ndGgpIHtcbiAgICBhd2FpdCBfc2F2ZVNjaGVkdWxlZEpvYnNUb1N0b3JhZ2Uoa2VwdCk7XG4gIH1cblxuICByZXR1cm4ga2VwdDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gX3NlbmRTY2hlZHVsZU1lc3NhZ2UoYWN0aW9uLCBwYXlsb2FkID0ge30pIHtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGNocm9tZS5ydW50aW1lLnNlbmRNZXNzYWdlKHtcbiAgICAgIHR5cGU6IFwic2NoZWR1bGVfbWFuYWdlclwiLFxuICAgICAgYWN0aW9uLFxuICAgICAgcGF5bG9hZFxuICAgIH0pO1xuICAgIHJldHVybiByZXNwb25zZSB8fCB7IGVycm9yOiBcIk5vIHJlc3BvbnNlIGZyb20gc2NoZWR1bGUgbWFuYWdlclwiIH07XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgcmV0dXJuIHsgZXJyb3I6IGVycm9yPy5tZXNzYWdlIHx8IFN0cmluZyhlcnJvcikgfTtcbiAgfVxufVxuXG4vKipcbiAqIFNjaGVkdWxlIGEgdG9vbCBjYWxsIHRvIGV4ZWN1dGUgYXQgYSBmdXR1cmUgdGltZSB2aWEgdGhlIGJhY2tncm91bmQgc2VydmljZSB3b3JrZXIuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIF9leGVjU2NoZWR1bGVUb29sKHsgZGVsYXlTZWNvbmRzLCB0aW1lc3RhbXAsIHRvb2xOYW1lLCB0b29sQXJncywgbGFiZWwsIHRpbWVvdXRTZWNvbmRzIH0sIG1jcFJlZ2lzdHJ5KSB7XG4gIHJldHVybiBhd2FpdCBfc2VuZFNjaGVkdWxlTWVzc2FnZShcInNjaGVkdWxlXCIsIHtcbiAgICBkZWxheVNlY29uZHMsXG4gICAgdGltZXN0YW1wLFxuICAgIHRvb2xOYW1lLFxuICAgIHRvb2xBcmdzLFxuICAgIGxhYmVsLFxuICAgIHRpbWVvdXRTZWNvbmRzLFxuICAgIG1jcFJlZ2lzdHJ5OiBfc25hcHNob3RTY2hlZHVsZU1jcFJlZ2lzdHJ5KG1jcFJlZ2lzdHJ5KVxuICB9KTtcbn1cblxuLyoqXG4gKiBMaXN0IHNjaGVkdWxlZCB0b29sIGNhbGxzIGRpcmVjdGx5IGZyb20gc3RvcmFnZSB0byBhdm9pZCBNVjMgc2VydmljZSB3b3JrZXJcbiAqIHdha2UtdXAgLyByZXNwb25zZSBqaXR0ZXIgaW4gdGhlIHNjaGVkdWxlIG1hbmFnZW1lbnQgVUkuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIF9leGVjTGlzdFNjaGVkdWxlZChfYXJncz86IHVua25vd24pIHtcbiAgY29uc3Qgam9icyA9IGF3YWl0IF9wcnVuZUV4cGlyZWRTY2hlZHVsZWRKb2JzSW5TdG9yYWdlKCk7XG4gIGlmIChqb2JzLmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiB7IHNjaGVkdWxlZDogW10sIG1lc3NhZ2U6IFwiTm8gc2NoZWR1bGVkIHRhc2tzXCIgfTtcbiAgfVxuXG4gIHJldHVybiB7XG4gICAgc2NoZWR1bGVkOiBqb2JzXG4gICAgICAuc2xpY2UoKVxuICAgICAgLnNvcnQoKGEsIGIpID0+IGIuZmlyZVRpbWVzdGFtcCAtIGEuZmlyZVRpbWVzdGFtcClcbiAgICAgIC5tYXAoX3NlcmlhbGl6ZVNjaGVkdWxlZEpvYilcbiAgfTtcbn1cblxuLyoqXG4gKiBDYW5jZWwgYSBwZW5kaW5nIHNjaGVkdWxlZCB0b29sIGNhbGwgZGlyZWN0bHkgaW4gc3RvcmFnZS5cbiAqIFRoZSBiYWNrZ3JvdW5kIHNlcnZpY2Ugd29ya2VyIHN0aWxsIG93bnMgY3JlYXRpb24gYW5kIGV4ZWN1dGlvbi5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gX2V4ZWNDYW5jZWxTY2hlZHVsZWQoeyBzY2hlZHVsZUlkIH0pIHtcbiAgY29uc3Qgam9icyA9IGF3YWl0IF9wcnVuZUV4cGlyZWRTY2hlZHVsZWRKb2JzSW5TdG9yYWdlKCk7XG4gIGNvbnN0IGluZGV4ID0gam9icy5maW5kSW5kZXgoam9iID0+IGpvYi5pZCA9PT0gc2NoZWR1bGVJZCk7XG4gIGlmIChpbmRleCA8IDApIHtcbiAgICByZXR1cm4geyBlcnJvcjogYFNjaGVkdWxlIG5vdCBmb3VuZDogJHtzY2hlZHVsZUlkfWAgfTtcbiAgfVxuXG4gIGNvbnN0IGNhbmNlbGxlZCA9IGpvYnNbaW5kZXhdO1xuICBpZiAoY2FuY2VsbGVkLnN0YXR1cyAhPT0gXCJwZW5kaW5nXCIpIHtcbiAgICByZXR1cm4geyBlcnJvcjogYFNjaGVkdWxlICR7c2NoZWR1bGVJZH0gaXMgYWxyZWFkeSAke2NhbmNlbGxlZC5zdGF0dXN9YCB9O1xuICB9XG5cbiAgY2FuY2VsbGVkLnN0YXR1cyA9IFwiY2FuY2VsbGVkXCI7XG4gIGNhbmNlbGxlZC5maW5pc2hlZEF0ID0gRGF0ZS5ub3coKTtcbiAgY2FuY2VsbGVkLmVycm9yID0gbnVsbDtcbiAgY2FuY2VsbGVkLmV4cGlyZXNBdCA9IGNhbmNlbGxlZC5maW5pc2hlZEF0ICsgU0NIRURVTEVfUkVURU5USU9OX01TO1xuICBhd2FpdCBfc2F2ZVNjaGVkdWxlZEpvYnNUb1N0b3JhZ2Uoam9icyk7XG4gIGF3YWl0IF9jbGVhclNjaGVkdWxlZEFsYXJtcyhjYW5jZWxsZWQuaWQpO1xuXG4gIGlmIChjaHJvbWUuYWxhcm1zICYmIE51bWJlci5pc0Zpbml0ZShjYW5jZWxsZWQuZXhwaXJlc0F0KSkge1xuICAgIGF3YWl0IGNocm9tZS5hbGFybXMuY3JlYXRlKF9idWlsZFNjaGVkdWxlQ2xlYW51cEFsYXJtTmFtZShjYW5jZWxsZWQuaWQpLCB7XG4gICAgICB3aGVuOiBNYXRoLm1heChEYXRlLm5vdygpLCBjYW5jZWxsZWQuZXhwaXJlc0F0KVxuICAgIH0pO1xuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBzdWNjZXNzOiB0cnVlLFxuICAgIGNhbmNlbGxlZDoge1xuICAgICAgc2NoZWR1bGVJZDogY2FuY2VsbGVkLmlkLFxuICAgICAgbGFiZWw6IGNhbmNlbGxlZC5sYWJlbCxcbiAgICAgIHRvb2xOYW1lOiBjYW5jZWxsZWQudG9vbE5hbWUsXG4gICAgICB3YXNTY2hlZHVsZWRGb3I6IG5ldyBEYXRlKGNhbmNlbGxlZC5maXJlVGltZXN0YW1wKS50b0xvY2FsZVN0cmluZygpLFxuICAgICAgc3RhdHVzOiBjYW5jZWxsZWQuc3RhdHVzLFxuICAgICAgZXhwaXJlc0F0OiBuZXcgRGF0ZShjYW5jZWxsZWQuZXhwaXJlc0F0KS50b0xvY2FsZVN0cmluZygpXG4gICAgfVxuICB9O1xufVxuXG4vKipcbiAqIENsZWFyIGNvbXBsZXRlZCBzY2hlZHVsZWQgam9icyBkaXJlY3RseSBpbiBzdG9yYWdlLlxuICovXG5hc3luYyBmdW5jdGlvbiBfZXhlY0NsZWFyQ29tcGxldGVkU2NoZWR1bGVkKF9hcmdzPzogdW5rbm93bikge1xuICBjb25zdCBqb2JzID0gYXdhaXQgX3BydW5lRXhwaXJlZFNjaGVkdWxlZEpvYnNJblN0b3JhZ2UoKTtcbiAgY29uc3QgY29tcGxldGVkSm9icyA9IGpvYnMuZmlsdGVyKGpvYiA9PiBfaXNUZXJtaW5hbFNjaGVkdWxlZFN0YXR1cyhqb2I/LnN0YXR1cykpO1xuICBpZiAoY29tcGxldGVkSm9icy5sZW5ndGggPT09IDApIHtcbiAgICByZXR1cm4geyBzdWNjZXNzOiB0cnVlLCByZW1vdmVkQ291bnQ6IDAsIHJlbW92ZWRJZHM6IFtdIH07XG4gIH1cblxuICBjb25zdCBrZXB0ID0gam9icy5maWx0ZXIoam9iID0+ICFfaXNUZXJtaW5hbFNjaGVkdWxlZFN0YXR1cyhqb2I/LnN0YXR1cykpO1xuICBhd2FpdCBfc2F2ZVNjaGVkdWxlZEpvYnNUb1N0b3JhZ2Uoa2VwdCk7XG5cbiAgZm9yIChjb25zdCBqb2Igb2YgY29tcGxldGVkSm9icykge1xuICAgIGF3YWl0IF9jbGVhclNjaGVkdWxlZEFsYXJtcyhqb2IuaWQpO1xuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBzdWNjZXNzOiB0cnVlLFxuICAgIHJlbW92ZWRDb3VudDogY29tcGxldGVkSm9icy5sZW5ndGgsXG4gICAgcmVtb3ZlZElkczogY29tcGxldGVkSm9icy5tYXAoam9iID0+IGpvYi5pZClcbiAgfTtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT0gU3RyZWFtaW5nIENoYXQgPT09PT09PT09PT09PT09PT09PT1cblxuLyoqXG4gKiBTZW5kIGEgc3RyZWFtaW5nIGNoYXQgcmVxdWVzdCB0byBhbiBMTE0uXG4gKiBTdXBwb3J0cyBib3RoIE9wZW5BSS1jb21wYXRpYmxlIGFuZCBBbnRocm9waWMgTWVzc2FnZXMgQVBJLlxuICpcbiAqIFRvb2wgY2FsbHMgYXJlIGNvbGxlY3RlZCBhbmQgaW5jbHVkZWQgaW4gdGhlIG9uRG9uZSBjYWxsYmFjayBzbyB0aGUgY2FsbGVyXG4gKiBjYW4gZXhlY3V0ZSB0aGVtIGFsbCBhbmQgc2VuZCByZXN1bHRzIGJhY2sgaW4gYSBzaW5nbGUgcm91bmQtdHJpcC5cbiAqXG4gKiBAcGFyYW0ge09iamVjdH0gY29uZmlnIC0geyBhcGlUeXBlLCBiYXNlVXJsLCBhcGlLZXksIG1vZGVsIH1cbiAqIEBwYXJhbSB7QXJyYXl9IG1lc3NhZ2VzIC0gY29udmVyc2F0aW9uIG1lc3NhZ2VzXG4gKiBAcGFyYW0ge09iamVjdH0gY2FsbGJhY2tzIC0geyBvblRleHQsIG9uRG9uZSwgb25FcnJvciwgb25SZXRyeSB9XG4gKiBAcGFyYW0ge0FycmF5fSBbbWNwVG9vbHNdIC0gTUNQIHRvb2xzIHRvIGluY2x1ZGVcbiAqIEBwYXJhbSB7T2JqZWN0fSBbb3B0aW9uc11cbiAqIEBwYXJhbSB7Ym9vbGVhbn0gW29wdGlvbnMuaW5jbHVkZUJ1aWx0aW5zPXRydWVdIC0gV2hldGhlciB0byBleHBvc2UgYnVpbHQtaW4gYnJvd3NlciB0b29sc1xuICogQHJldHVybnMge0Z1bmN0aW9ufSBhYm9ydFxuICovXG5leHBvcnQgZnVuY3Rpb24gc3RyZWFtQ2hhdChjb25maWcsIG1lc3NhZ2VzLCB7IG9uVGV4dCwgb25Eb25lLCBvbkVycm9yLCBvblJldHJ5IH0sIG1jcFRvb2xzID0gW10sIG9wdGlvbnMgPSB7fSkge1xuICBjb25zdCBjb250cm9sbGVyID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuXG4gIHZvaWQgX3N0cmVhbVdpdGhSZXRyeShjb25maWcsIG1lc3NhZ2VzLCBjb250cm9sbGVyLnNpZ25hbCwgeyBvblRleHQsIG9uRG9uZSwgb25FcnJvciwgb25SZXRyeSB9LCBtY3BUb29scywgb3B0aW9ucyk7XG5cbiAgcmV0dXJuICgpID0+IGNvbnRyb2xsZXIuYWJvcnQoKTtcbn1cblxuY29uc3QgREVGQVVMVF9BTlRIUk9QSUNfQ0FDSEVfQ09OVFJPTCA9IHsgdHlwZTogXCJlcGhlbWVyYWxcIiB9O1xuXG5mdW5jdGlvbiBidWlsZE9wZW5BSUNhY2hlRmllbGRzKG9wdGlvbnM6IHsgc2Vzc2lvbklkPzogc3RyaW5nIH0gPSB7fSkge1xuICBjb25zdCBjYWNoZUtleSA9IFN0cmluZyhvcHRpb25zPy5zZXNzaW9uSWQgfHwgXCJcIikudHJpbSgpO1xuICByZXR1cm4gY2FjaGVLZXkgPyB7IHByb21wdF9jYWNoZV9rZXk6IGNhY2hlS2V5IH0gOiB7fTtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT0gT3BlbkFJIENvbXBhdGlibGUgPT09PT09PT09PT09PT09PT09PT1cblxuYXN5bmMgZnVuY3Rpb24gX3N0cmVhbVdpdGhSZXRyeShjb25maWcsIG1lc3NhZ2VzLCBzaWduYWwsIGNhbGxiYWNrcywgbWNwVG9vbHMgPSBbXSwgb3B0aW9ucyA9IHt9KSB7XG4gIGNvbnN0IGZhaWx1cmVzID0gW107XG5cbiAgZm9yIChsZXQgYXR0ZW1wdCA9IDE7IGF0dGVtcHQgPD0gTUFYX0xMTV9TVFJFQU1fUkVUUklFUzsgYXR0ZW1wdCsrKSB7XG4gICAgaWYgKHNpZ25hbC5hYm9ydGVkKSByZXR1cm47XG5cbiAgICB0cnkge1xuICAgICAgaWYgKGNvbmZpZy5hcGlUeXBlID09PSBcImFudGhyb3BpY1wiKSB7XG4gICAgICAgIGF3YWl0IF9zdHJlYW1BbnRocm9waWNBdHRlbXB0KGNvbmZpZywgbWVzc2FnZXMsIHNpZ25hbCwgY2FsbGJhY2tzLCBtY3BUb29scywgb3B0aW9ucyk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBhd2FpdCBfc3RyZWFtT3BlbkFJQXR0ZW1wdChjb25maWcsIG1lc3NhZ2VzLCBzaWduYWwsIGNhbGxiYWNrcywgbWNwVG9vbHMsIG9wdGlvbnMpO1xuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBpZiAoaXNBYm9ydEVycm9yKGVycm9yKSAmJiBzaWduYWwuYWJvcnRlZCkgcmV0dXJuO1xuXG4gICAgICBjb25zdCBub3JtYWxpemVkRXJyb3IgPSBub3JtYWxpemVMbG1TdHJlYW1FcnJvcihlcnJvciwge1xuICAgICAgICBhcGlUeXBlOiBjb25maWcuYXBpVHlwZSxcbiAgICAgICAgYXR0ZW1wdCxcbiAgICAgICAgbWF4QXR0ZW1wdHM6IE1BWF9MTE1fU1RSRUFNX1JFVFJJRVNcbiAgICAgIH0pO1xuXG4gICAgICBmYWlsdXJlcy5wdXNoKHtcbiAgICAgICAgYXR0ZW1wdCxcbiAgICAgICAgY29kZTogbm9ybWFsaXplZEVycm9yLmNvZGUgfHwgXCJMTE1fRVJST1JcIixcbiAgICAgICAgbWVzc2FnZTogbm9ybWFsaXplZEVycm9yLm1lc3NhZ2UgfHwgXCJMTE0gcmVxdWVzdCBmYWlsZWRcIixcbiAgICAgICAgc3RhdHVzOiBub3JtYWxpemVkRXJyb3Iuc3RhdHVzIHx8IG51bGwsXG4gICAgICAgIGRldGFpbDogbm9ybWFsaXplZEVycm9yLmRldGFpbCB8fCBudWxsXG4gICAgICB9KTtcblxuICAgICAgaWYgKGF0dGVtcHQgPCBNQVhfTExNX1NUUkVBTV9SRVRSSUVTKSB7XG4gICAgICAgIGNhbGxiYWNrcy5vblJldHJ5Py4oe1xuICAgICAgICAgIGF0dGVtcHQsXG4gICAgICAgICAgbmV4dEF0dGVtcHQ6IGF0dGVtcHQgKyAxLFxuICAgICAgICAgIG1heEF0dGVtcHRzOiBNQVhfTExNX1NUUkVBTV9SRVRSSUVTLFxuICAgICAgICAgIGVycm9yOiBub3JtYWxpemVkRXJyb3JcbiAgICAgICAgfSk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgYXdhaXQgZGVsYXlSZXRyeShhdHRlbXB0LCBzaWduYWwpO1xuICAgICAgICB9IGNhdGNoIChyZXRyeUVycm9yKSB7XG4gICAgICAgICAgaWYgKGlzQWJvcnRFcnJvcihyZXRyeUVycm9yKSkgcmV0dXJuO1xuICAgICAgICAgIHRocm93IHJldHJ5RXJyb3I7XG4gICAgICAgIH1cbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIG5vcm1hbGl6ZWRFcnJvci5hdHRlbXB0cyA9IGF0dGVtcHQ7XG4gICAgICBub3JtYWxpemVkRXJyb3IubWF4QXR0ZW1wdHMgPSBNQVhfTExNX1NUUkVBTV9SRVRSSUVTO1xuICAgICAgbm9ybWFsaXplZEVycm9yLmZhaWx1cmVzID0gZmFpbHVyZXM7XG4gICAgICBjYWxsYmFja3Mub25FcnJvcj8uKG5vcm1hbGl6ZWRFcnJvcik7XG4gICAgICByZXR1cm47XG4gICAgfVxuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIF9zdHJlYW1PcGVuQUlBdHRlbXB0KGNvbmZpZywgbWVzc2FnZXMsIHNpZ25hbCwgeyBvblRleHQsIG9uRG9uZSB9LCBtY3BUb29scyA9IFtdLCBvcHRpb25zID0ge30pIHtcbiAgY29uc3QgdG9vbHMgPSBnZXRUb29scyhcIm9wZW5haVwiLCBtY3BUb29scywgb3B0aW9ucyk7XG4gIGNvbnN0IHVybCA9IHJlc29sdmVMbG1SZXF1ZXN0VXJsKFwib3BlbmFpXCIsIGNvbmZpZy5iYXNlVXJsKTtcbiAgY29uc3QgdGltZW91dFN0YXRlID0gY3JlYXRlRmlyc3RQYWNrZXRUaW1lb3V0U3RhdGUoc2lnbmFsLCBnZXRGaXJzdFBhY2tldFRpbWVvdXRNcyhjb25maWcpKTtcblxuICB0cnkge1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKHVybCwge1xuICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIsXG4gICAgICAgIFwiQXV0aG9yaXphdGlvblwiOiBgQmVhcmVyICR7Y29uZmlnLmFwaUtleX1gXG4gICAgICB9LFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBtb2RlbDogY29uZmlnLm1vZGVsLFxuICAgICAgICBtZXNzYWdlcyxcbiAgICAgICAgdG9vbHMsXG4gICAgICAgIHN0cmVhbTogdHJ1ZSxcbiAgICAgICAgc3RyZWFtX29wdGlvbnM6IHsgaW5jbHVkZV91c2FnZTogdHJ1ZSB9LFxuICAgICAgICAuLi5idWlsZE9wZW5BSUNhY2hlRmllbGRzKG9wdGlvbnMpXG4gICAgICB9KSxcbiAgICAgIHNpZ25hbDogdGltZW91dFN0YXRlLnNpZ25hbFxuICAgIH0pO1xuXG4gICAgaWYgKCFyZXMub2spIHtcbiAgICAgIGNvbnN0IGVyclRleHQgPSBhd2FpdCByZXMudGV4dCgpLmNhdGNoKCgpID0+IFwiXCIpO1xuICAgICAgdGhyb3cgY3JlYXRlTGxtU3RyZWFtRXJyb3Ioe1xuICAgICAgICBjb2RlOiBgSFRUUF8ke3Jlcy5zdGF0dXN9YCxcbiAgICAgICAgbWVzc2FnZTogYExMTSDmjqXlj6Pov5Tlm54gSFRUUCAke3Jlcy5zdGF0dXN9YCxcbiAgICAgICAgc3RhdHVzOiByZXMuc3RhdHVzLFxuICAgICAgICBkZXRhaWw6IGVyclRleHQgfHwgYEhUVFAgJHtyZXMuc3RhdHVzfWBcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGNvbnN0IHJlYWRlciA9IHJlcy5ib2R5Py5nZXRSZWFkZXIoKTtcbiAgICBpZiAoIXJlYWRlcikge1xuICAgICAgdGhyb3cgY3JlYXRlTGxtU3RyZWFtRXJyb3Ioe1xuICAgICAgICBjb2RlOiBcIkVNUFRZX1JFU1BPTlNFX0JPRFlcIixcbiAgICAgICAgbWVzc2FnZTogXCJMTE0g5pyq6L+U5Zue5ZON5bqU5rWBXCJcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGNvbnN0IGRlY29kZXIgPSBuZXcgVGV4dERlY29kZXIoKTtcbiAgICBsZXQgZnVsbENvbnRlbnQgPSBcIlwiO1xuICAgIC8qKiBPcGVuQUkgc3RyZWFtIGFnZ3JlZ2F0ZXMgdG9vbCBjYWxsIGZyYWdtZW50cyBieSBpbmRleCAqL1xuICAgIGxldCB0b29sQ2FsbHNNYXA6IFJlY29yZDxudW1iZXIsIHsgaWQ6IHN0cmluZzsgbmFtZTogc3RyaW5nOyBhcmd1bWVudHM6IHN0cmluZyB9PiA9IHt9O1xuICAgIGxldCBidWZmZXIgPSBcIlwiO1xuICAgIGxldCBzYXdUb29sQ2FsbERlbHRhID0gZmFsc2U7XG5cbiAgICB3aGlsZSAodHJ1ZSkge1xuICAgICAgY29uc3QgeyBkb25lLCB2YWx1ZSB9ID0gYXdhaXQgcmVhZGVyLnJlYWQoKTtcbiAgICAgIGlmIChkb25lKSBicmVhaztcbiAgICAgIGlmICh2YWx1ZT8ubGVuZ3RoKSB7XG4gICAgICAgIHRpbWVvdXRTdGF0ZS5tYXJrRmlyc3RQYWNrZXRSZWNlaXZlZCgpO1xuICAgICAgfVxuICAgICAgYnVmZmVyICs9IGRlY29kZXIuZGVjb2RlKHZhbHVlLCB7IHN0cmVhbTogdHJ1ZSB9KTtcblxuICAgICAgY29uc3QgbGluZXMgPSBidWZmZXIuc3BsaXQoXCJcXG5cIik7XG4gICAgICBidWZmZXIgPSBsaW5lcy5wb3AoKSB8fCBcIlwiO1xuXG4gICAgICBmb3IgKGNvbnN0IGxpbmUgb2YgbGluZXMpIHtcbiAgICAgICAgY29uc3QgdHJpbW1lZCA9IGxpbmUudHJpbSgpO1xuICAgICAgICBpZiAoIXRyaW1tZWQgfHwgIXRyaW1tZWQuc3RhcnRzV2l0aChcImRhdGE6IFwiKSkgY29udGludWU7XG4gICAgICAgIGNvbnN0IGRhdGEgPSB0cmltbWVkLnNsaWNlKDYpO1xuICAgICAgICBpZiAoZGF0YSA9PT0gXCJbRE9ORV1cIikgY29udGludWU7XG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCBqc29uID0gSlNPTi5wYXJzZShkYXRhKTtcbiAgICAgICAgICBjb25zdCBkZWx0YSA9IGpzb24uY2hvaWNlcz8uWzBdPy5kZWx0YTtcbiAgICAgICAgICBpZiAoIWRlbHRhKSBjb250aW51ZTtcblxuICAgICAgICAgIGlmIChkZWx0YS5jb250ZW50KSB7XG4gICAgICAgICAgICBmdWxsQ29udGVudCArPSBkZWx0YS5jb250ZW50O1xuICAgICAgICAgICAgb25UZXh0Py4oZGVsdGEuY29udGVudCk7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgaWYgKGRlbHRhLnRvb2xfY2FsbHMpIHtcbiAgICAgICAgICAgIHNhd1Rvb2xDYWxsRGVsdGEgPSB0cnVlO1xuICAgICAgICAgICAgZm9yIChjb25zdCB0YyBvZiBkZWx0YS50b29sX2NhbGxzIGFzIEFycmF5PHtcbiAgICAgICAgICAgICAgaW5kZXg/OiBudW1iZXI7XG4gICAgICAgICAgICAgIGlkPzogc3RyaW5nO1xuICAgICAgICAgICAgICBmdW5jdGlvbj86IHsgbmFtZT86IHN0cmluZzsgYXJndW1lbnRzPzogc3RyaW5nIH07XG4gICAgICAgICAgICB9Pikge1xuICAgICAgICAgICAgICBjb25zdCBpZHggPSB0Yy5pbmRleCA/PyAwO1xuICAgICAgICAgICAgICBpZiAoIXRvb2xDYWxsc01hcFtpZHhdKSB0b29sQ2FsbHNNYXBbaWR4XSA9IHsgaWQ6IFwiXCIsIG5hbWU6IFwiXCIsIGFyZ3VtZW50czogXCJcIiB9O1xuICAgICAgICAgICAgICBpZiAodGMuaWQpIHRvb2xDYWxsc01hcFtpZHhdLmlkID0gdGMuaWQ7XG4gICAgICAgICAgICAgIGlmICh0Yy5mdW5jdGlvbj8ubmFtZSkgdG9vbENhbGxzTWFwW2lkeF0ubmFtZSA9IHRjLmZ1bmN0aW9uLm5hbWU7XG4gICAgICAgICAgICAgIGlmICh0Yy5mdW5jdGlvbj8uYXJndW1lbnRzKSB0b29sQ2FsbHNNYXBbaWR4XS5hcmd1bWVudHMgKz0gdGMuZnVuY3Rpb24uYXJndW1lbnRzO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICB0aHJvdyBjcmVhdGVMbG1TdHJlYW1FcnJvcih7XG4gICAgICAgICAgICBjb2RlOiBcIlNUUkVBTV9QQVJTRV9FUlJPUlwiLFxuICAgICAgICAgICAgbWVzc2FnZTogXCLop6PmnpAgT3BlbkFJIOa1geW8j+WTjeW6lOWksei0pVwiLFxuICAgICAgICAgICAgZGV0YWlsOiBlcnJvcj8ubWVzc2FnZSB8fCBTdHJpbmcoZXJyb3IpXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoIXRpbWVvdXRTdGF0ZS5maXJzdFBhY2tldFJlY2VpdmVkKSB7XG4gICAgICB0aHJvdyBidWlsZEZpcnN0UGFja2V0VGltZW91dEVycm9yKGNvbmZpZyk7XG4gICAgfVxuXG4gICAgY29uc3QgcmF3VG9vbENhbGxzID0gT2JqZWN0LmVudHJpZXModG9vbENhbGxzTWFwKVxuICAgICAgLmZpbHRlcigoWywgdGNdKSA9PiB0Yy5uYW1lKVxuICAgICAgLm1hcCgoW2lkeCwgdGNdKSA9PiAoe1xuICAgICAgICBpbmRleDogTnVtYmVyKGlkeCksXG4gICAgICAgIGlkOiB0Yy5pZCB8fCBgdG9vbGNhbGxfJHtpZHh9XyR7RGF0ZS5ub3coKX1gLFxuICAgICAgICBuYW1lOiB0Yy5uYW1lLFxuICAgICAgICBhcmd1bWVudHM6IHRjLmFyZ3VtZW50c1xuICAgICAgfSkpO1xuXG4gICAgY29uc3QgcGFyc2VGYWlsdXJlcyA9IFtdO1xuICAgIGNvbnN0IHRvb2xDYWxscyA9IHJhd1Rvb2xDYWxsc1xuICAgICAgLm1hcCh0YyA9PiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIGlkOiB0Yy5pZCxcbiAgICAgICAgICAgIG5hbWU6IHRjLm5hbWUsXG4gICAgICAgICAgICBhcmdzOiBKU09OLnBhcnNlKHRjLmFyZ3VtZW50cyB8fCBcInt9XCIpLFxuICAgICAgICAgICAgX3JhdzogdGMuYXJndW1lbnRzIHx8IFwie31cIlxuICAgICAgICAgIH07XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgcGFyc2VGYWlsdXJlcy5wdXNoKHsgbmFtZTogdGMubmFtZSwgYXJndW1lbnRzOiB0Yy5hcmd1bWVudHMsIGVycm9yOiBlcnJvci5tZXNzYWdlIH0pO1xuICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICB9XG4gICAgICB9KVxuICAgICAgLmZpbHRlcihCb29sZWFuKTtcblxuICAgIGlmIChwYXJzZUZhaWx1cmVzLmxlbmd0aCA+IDApIHtcbiAgICAgIHRocm93IGNyZWF0ZUxsbVN0cmVhbUVycm9yKHtcbiAgICAgICAgY29kZTogXCJUT09MX0NBTExfUEFSU0VfRVJST1JcIixcbiAgICAgICAgbWVzc2FnZTogXCLlt6XlhbfosIPnlKjlj4LmlbDop6PmnpDlpLHotKVcIixcbiAgICAgICAgZGV0YWlsOiBwYXJzZUZhaWx1cmVzXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICBpZiAoc2F3VG9vbENhbGxEZWx0YSAmJiB0b29sQ2FsbHMubGVuZ3RoID09PSAwICYmICFmdWxsQ29udGVudCkge1xuICAgICAgdGhyb3cgY3JlYXRlTGxtU3RyZWFtRXJyb3Ioe1xuICAgICAgICBjb2RlOiBcIkVNUFRZX1RPT0xfQ0FMTF9TVFJFQU1cIixcbiAgICAgICAgbWVzc2FnZTogXCLmqKHlnovov5Tlm57kuoblt6XlhbfosIPnlKjniYfmrrXvvIzkvYbmnKrog73ph43lu7rmnInmlYjlt6XlhbfosIPnlKhcIlxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgb25Eb25lPy4oe1xuICAgICAgcm9sZTogXCJhc3Npc3RhbnRcIixcbiAgICAgIGNvbnRlbnQ6IGZ1bGxDb250ZW50IHx8IG51bGwsXG4gICAgICB0b29sQ2FsbHM6IHRvb2xDYWxscy5sZW5ndGggPiAwID8gdG9vbENhbGxzIDogdW5kZWZpbmVkLFxuICAgICAgX29wZW5haVRvb2xDYWxsczogdG9vbENhbGxzLmxlbmd0aCA+IDAgPyB0b29sQ2FsbHMubWFwKHRjID0+ICh7XG4gICAgICAgIGlkOiB0Yy5pZCwgdHlwZTogXCJmdW5jdGlvblwiLFxuICAgICAgICBmdW5jdGlvbjogeyBuYW1lOiB0Yy5uYW1lLCBhcmd1bWVudHM6IHRjLl9yYXcgfVxuICAgICAgfSkpIDogdW5kZWZpbmVkXG4gICAgfSk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgaWYgKHRpbWVvdXRTdGF0ZS5kaWRUaW1lb3V0ICYmICFzaWduYWwuYWJvcnRlZCkge1xuICAgICAgdGhyb3cgYnVpbGRGaXJzdFBhY2tldFRpbWVvdXRFcnJvcihjb25maWcpO1xuICAgIH1cbiAgICBpZiAoaXNBYm9ydEVycm9yKGVycm9yKSAmJiBzaWduYWwuYWJvcnRlZCkge1xuICAgICAgdGhyb3cgZXJyb3I7XG4gICAgfVxuICAgIHRocm93IGVycm9yO1xuICB9IGZpbmFsbHkge1xuICAgIHRpbWVvdXRTdGF0ZS5jbGVhbnVwKCk7XG4gIH1cbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT0gQW50aHJvcGljIE1lc3NhZ2VzIEFQSSA9PT09PT09PT09PT09PT09PT09PVxuXG5hc3luYyBmdW5jdGlvbiBfc3RyZWFtQW50aHJvcGljQXR0ZW1wdChjb25maWcsIG1lc3NhZ2VzLCBzaWduYWwsIHsgb25UZXh0LCBvbkRvbmUgfSwgbWNwVG9vbHMgPSBbXSwgb3B0aW9ucyA9IHt9KSB7XG4gIGNvbnN0IHRvb2xzID0gZ2V0VG9vbHMoXCJhbnRocm9waWNcIiwgbWNwVG9vbHMsIG9wdGlvbnMpO1xuICBjb25zdCB0aW1lb3V0U3RhdGUgPSBjcmVhdGVGaXJzdFBhY2tldFRpbWVvdXRTdGF0ZShzaWduYWwsIGdldEZpcnN0UGFja2V0VGltZW91dE1zKGNvbmZpZykpO1xuXG4gIHRyeSB7XG4gICAgbGV0IHN5c3RlbVByb21wdCA9IFwiXCI7XG4gICAgY29uc3QgYXBpTWVzc2FnZXMgPSBbXTtcbiAgICBmb3IgKGNvbnN0IG1zZyBvZiBtZXNzYWdlcykge1xuICAgICAgaWYgKG1zZy5yb2xlID09PSBcInN5c3RlbVwiKSBzeXN0ZW1Qcm9tcHQgPSBtc2cuY29udGVudDtcbiAgICAgIGVsc2UgYXBpTWVzc2FnZXMucHVzaChtc2cpO1xuICAgIH1cblxuICAgIGNvbnN0IHVybCA9IHJlc29sdmVMbG1SZXF1ZXN0VXJsKFwiYW50aHJvcGljXCIsIGNvbmZpZy5iYXNlVXJsKTtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaCh1cmwsIHtcbiAgICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgICBoZWFkZXJzOiB7XG4gICAgICAgIFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiLFxuICAgICAgICBcIngtYXBpLWtleVwiOiBjb25maWcuYXBpS2V5LFxuICAgICAgICBcImFudGhyb3BpYy12ZXJzaW9uXCI6IFwiMjAyMy0wNi0wMVwiLFxuICAgICAgICBcImFudGhyb3BpYy1kYW5nZXJvdXMtZGlyZWN0LWJyb3dzZXItYWNjZXNzXCI6IFwidHJ1ZVwiXG4gICAgICB9LFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBtb2RlbDogY29uZmlnLm1vZGVsLFxuICAgICAgICBjYWNoZV9jb250cm9sOiBERUZBVUxUX0FOVEhST1BJQ19DQUNIRV9DT05UUk9MLFxuICAgICAgICBzeXN0ZW06IHN5c3RlbVByb21wdCxcbiAgICAgICAgbWVzc2FnZXM6IGFwaU1lc3NhZ2VzLFxuICAgICAgICB0b29scywgbWF4X3Rva2VuczogNDA5Niwgc3RyZWFtOiB0cnVlXG4gICAgICB9KSxcbiAgICAgIHNpZ25hbDogdGltZW91dFN0YXRlLnNpZ25hbFxuICAgIH0pO1xuXG4gICAgaWYgKCFyZXMub2spIHtcbiAgICAgIGNvbnN0IGVyclRleHQgPSBhd2FpdCByZXMudGV4dCgpLmNhdGNoKCgpID0+IFwiXCIpO1xuICAgICAgdGhyb3cgY3JlYXRlTGxtU3RyZWFtRXJyb3Ioe1xuICAgICAgICBjb2RlOiBgSFRUUF8ke3Jlcy5zdGF0dXN9YCxcbiAgICAgICAgbWVzc2FnZTogYExMTSDmjqXlj6Pov5Tlm54gSFRUUCAke3Jlcy5zdGF0dXN9YCxcbiAgICAgICAgc3RhdHVzOiByZXMuc3RhdHVzLFxuICAgICAgICBkZXRhaWw6IGVyclRleHQgfHwgYEhUVFAgJHtyZXMuc3RhdHVzfWBcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGNvbnN0IHJlYWRlciA9IHJlcy5ib2R5Py5nZXRSZWFkZXIoKTtcbiAgICBpZiAoIXJlYWRlcikge1xuICAgICAgdGhyb3cgY3JlYXRlTGxtU3RyZWFtRXJyb3Ioe1xuICAgICAgICBjb2RlOiBcIkVNUFRZX1JFU1BPTlNFX0JPRFlcIixcbiAgICAgICAgbWVzc2FnZTogXCJMTE0g5pyq6L+U5Zue5ZON5bqU5rWBXCJcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGNvbnN0IGRlY29kZXIgPSBuZXcgVGV4dERlY29kZXIoKTtcbiAgICBsZXQgZnVsbENvbnRlbnQgPSBcIlwiO1xuICAgIGxldCBjb2xsZWN0ZWRUb29sVXNlcyA9IFtdO1xuICAgIGxldCBjdXJyZW50VG9vbFVzZSA9IG51bGw7XG4gICAgbGV0IGJ1ZmZlciA9IFwiXCI7XG4gICAgbGV0IHNhd1Rvb2xVc2VCbG9jayA9IGZhbHNlO1xuXG4gICAgd2hpbGUgKHRydWUpIHtcbiAgICAgIGNvbnN0IHsgZG9uZSwgdmFsdWUgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICBpZiAoZG9uZSkgYnJlYWs7XG4gICAgICBpZiAodmFsdWU/Lmxlbmd0aCkge1xuICAgICAgICB0aW1lb3V0U3RhdGUubWFya0ZpcnN0UGFja2V0UmVjZWl2ZWQoKTtcbiAgICAgIH1cbiAgICAgIGJ1ZmZlciArPSBkZWNvZGVyLmRlY29kZSh2YWx1ZSwgeyBzdHJlYW06IHRydWUgfSk7XG5cbiAgICAgIGNvbnN0IGxpbmVzID0gYnVmZmVyLnNwbGl0KFwiXFxuXCIpO1xuICAgICAgYnVmZmVyID0gbGluZXMucG9wKCkgfHwgXCJcIjtcblxuICAgICAgZm9yIChjb25zdCBsaW5lIG9mIGxpbmVzKSB7XG4gICAgICAgIGNvbnN0IHRyaW1tZWQgPSBsaW5lLnRyaW0oKTtcbiAgICAgICAgaWYgKCF0cmltbWVkLnN0YXJ0c1dpdGgoXCJkYXRhOiBcIikpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCBkYXRhID0gdHJpbW1lZC5zbGljZSg2KTtcblxuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IGpzb24gPSBKU09OLnBhcnNlKGRhdGEpO1xuXG4gICAgICAgICAgaWYgKGpzb24udHlwZSA9PT0gXCJjb250ZW50X2Jsb2NrX3N0YXJ0XCIgJiYganNvbi5jb250ZW50X2Jsb2NrPy50eXBlID09PSBcInRvb2xfdXNlXCIpIHtcbiAgICAgICAgICAgIHNhd1Rvb2xVc2VCbG9jayA9IHRydWU7XG4gICAgICAgICAgICBjdXJyZW50VG9vbFVzZSA9IHsgaWQ6IGpzb24uY29udGVudF9ibG9jay5pZCwgbmFtZToganNvbi5jb250ZW50X2Jsb2NrLm5hbWUsIGlucHV0SnNvbjogXCJcIiB9O1xuICAgICAgICAgIH0gZWxzZSBpZiAoanNvbi50eXBlID09PSBcImNvbnRlbnRfYmxvY2tfZGVsdGFcIikge1xuICAgICAgICAgICAgaWYgKGpzb24uZGVsdGE/LnR5cGUgPT09IFwidGV4dF9kZWx0YVwiKSB7XG4gICAgICAgICAgICAgIGZ1bGxDb250ZW50ICs9IGpzb24uZGVsdGEudGV4dDtcbiAgICAgICAgICAgICAgb25UZXh0Py4oanNvbi5kZWx0YS50ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoanNvbi5kZWx0YT8udHlwZSA9PT0gXCJpbnB1dF9qc29uX2RlbHRhXCIgJiYgY3VycmVudFRvb2xVc2UpIHtcbiAgICAgICAgICAgICAgY3VycmVudFRvb2xVc2UuaW5wdXRKc29uICs9IGpzb24uZGVsdGEucGFydGlhbF9qc29uO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gZWxzZSBpZiAoanNvbi50eXBlID09PSBcImNvbnRlbnRfYmxvY2tfc3RvcFwiICYmIGN1cnJlbnRUb29sVXNlKSB7XG4gICAgICAgICAgICBjb2xsZWN0ZWRUb29sVXNlcy5wdXNoKGN1cnJlbnRUb29sVXNlKTtcbiAgICAgICAgICAgIGN1cnJlbnRUb29sVXNlID0gbnVsbDtcbiAgICAgICAgICB9XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgdGhyb3cgY3JlYXRlTGxtU3RyZWFtRXJyb3Ioe1xuICAgICAgICAgICAgY29kZTogXCJTVFJFQU1fUEFSU0VfRVJST1JcIixcbiAgICAgICAgICAgIG1lc3NhZ2U6IFwi6Kej5p6QIEFudGhyb3BpYyDmtYHlvI/lk43lupTlpLHotKVcIixcbiAgICAgICAgICAgIGRldGFpbDogZXJyb3I/Lm1lc3NhZ2UgfHwgU3RyaW5nKGVycm9yKVxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKCF0aW1lb3V0U3RhdGUuZmlyc3RQYWNrZXRSZWNlaXZlZCkge1xuICAgICAgdGhyb3cgYnVpbGRGaXJzdFBhY2tldFRpbWVvdXRFcnJvcihjb25maWcpO1xuICAgIH1cblxuICAgIGNvbnN0IHBhcnNlRmFpbHVyZXMgPSBbXTtcbiAgICBjb25zdCB0b29sQ2FsbHMgPSBjb2xsZWN0ZWRUb29sVXNlc1xuICAgICAgLm1hcCgodHUsIGluZGV4KSA9PiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIGlkOiB0dS5pZCB8fCBgdG9vbHVzZV8ke2luZGV4fV8ke0RhdGUubm93KCl9YCxcbiAgICAgICAgICAgIG5hbWU6IHR1Lm5hbWUsXG4gICAgICAgICAgICBhcmdzOiBKU09OLnBhcnNlKHR1LmlucHV0SnNvbiB8fCBcInt9XCIpXG4gICAgICAgICAgfTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICBwYXJzZUZhaWx1cmVzLnB1c2goeyBuYW1lOiB0dS5uYW1lLCBpbnB1dEpzb246IHR1LmlucHV0SnNvbiwgZXJyb3I6IGVycm9yLm1lc3NhZ2UgfSk7XG4gICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgIH1cbiAgICAgIH0pXG4gICAgICAuZmlsdGVyKEJvb2xlYW4pO1xuXG4gICAgaWYgKHBhcnNlRmFpbHVyZXMubGVuZ3RoID4gMCkge1xuICAgICAgdGhyb3cgY3JlYXRlTGxtU3RyZWFtRXJyb3Ioe1xuICAgICAgICBjb2RlOiBcIlRPT0xfQ0FMTF9QQVJTRV9FUlJPUlwiLFxuICAgICAgICBtZXNzYWdlOiBcIuW3peWFt+iwg+eUqOWPguaVsOino+aekOWksei0pVwiLFxuICAgICAgICBkZXRhaWw6IHBhcnNlRmFpbHVyZXNcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGlmIChzYXdUb29sVXNlQmxvY2sgJiYgdG9vbENhbGxzLmxlbmd0aCA9PT0gMCAmJiAhZnVsbENvbnRlbnQpIHtcbiAgICAgIHRocm93IGNyZWF0ZUxsbVN0cmVhbUVycm9yKHtcbiAgICAgICAgY29kZTogXCJFTVBUWV9UT09MX0NBTExfU1RSRUFNXCIsXG4gICAgICAgIG1lc3NhZ2U6IFwi5qih5Z6L6L+U5Zue5LqG5bel5YW36LCD55So54mH5q6177yM5L2G5pyq6IO96YeN5bu65pyJ5pWI5bel5YW36LCD55SoXCJcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGNvbnN0IGNvbnRlbnRCbG9ja3MgPSBbXTtcbiAgICBpZiAoZnVsbENvbnRlbnQpIGNvbnRlbnRCbG9ja3MucHVzaCh7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBmdWxsQ29udGVudCB9KTtcbiAgICBmb3IgKGNvbnN0IHRjIG9mIHRvb2xDYWxscykge1xuICAgICAgY29udGVudEJsb2Nrcy5wdXNoKHsgdHlwZTogXCJ0b29sX3VzZVwiLCBpZDogdGMuaWQsIG5hbWU6IHRjLm5hbWUsIGlucHV0OiB0Yy5hcmdzIH0pO1xuICAgIH1cblxuICAgIG9uRG9uZT8uKHtcbiAgICAgIHJvbGU6IFwiYXNzaXN0YW50XCIsXG4gICAgICBjb250ZW50OiBjb250ZW50QmxvY2tzLmxlbmd0aCA+IDAgPyBjb250ZW50QmxvY2tzIDogbnVsbCxcbiAgICAgIHRvb2xDYWxsczogdG9vbENhbGxzLmxlbmd0aCA+IDAgPyB0b29sQ2FsbHMgOiB1bmRlZmluZWRcbiAgICB9KTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBpZiAodGltZW91dFN0YXRlLmRpZFRpbWVvdXQgJiYgIXNpZ25hbC5hYm9ydGVkKSB7XG4gICAgICB0aHJvdyBidWlsZEZpcnN0UGFja2V0VGltZW91dEVycm9yKGNvbmZpZyk7XG4gICAgfVxuICAgIGlmIChpc0Fib3J0RXJyb3IoZXJyb3IpICYmIHNpZ25hbC5hYm9ydGVkKSB7XG4gICAgICB0aHJvdyBlcnJvcjtcbiAgICB9XG4gICAgdGhyb3cgZXJyb3I7XG4gIH0gZmluYWxseSB7XG4gICAgdGltZW91dFN0YXRlLmNsZWFudXAoKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBnZXRGaXJzdFBhY2tldFRpbWVvdXRNcyhjb25maWcpIHtcbiAgcmV0dXJuIE1hdGgubWF4KDEsIE51bWJlcihjb25maWc/LmZpcnN0UGFja2V0VGltZW91dFNlY29uZHMpIHx8IERFRkFVTFRfTExNX0ZJUlNUX1BBQ0tFVF9USU1FT1VUX1NFQ09ORFMpICogMTAwMDtcbn1cblxuZnVuY3Rpb24gY3JlYXRlRmlyc3RQYWNrZXRUaW1lb3V0U3RhdGUocGFyZW50U2lnbmFsLCB0aW1lb3V0TXMpIHtcbiAgY29uc3QgY29udHJvbGxlciA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgbGV0IGZpcnN0UGFja2V0UmVjZWl2ZWQgPSBmYWxzZTtcbiAgbGV0IGRpZFRpbWVvdXQgPSBmYWxzZTtcblxuICBjb25zdCBhYm9ydEZyb21QYXJlbnQgPSAoKSA9PiB7XG4gICAgY29udHJvbGxlci5hYm9ydChwYXJlbnRTaWduYWw/LnJlYXNvbik7XG4gIH07XG5cbiAgaWYgKHBhcmVudFNpZ25hbD8uYWJvcnRlZCkge1xuICAgIGFib3J0RnJvbVBhcmVudCgpO1xuICB9IGVsc2UgaWYgKHBhcmVudFNpZ25hbCkge1xuICAgIHBhcmVudFNpZ25hbC5hZGRFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgYWJvcnRGcm9tUGFyZW50LCB7IG9uY2U6IHRydWUgfSk7XG4gIH1cblxuICBjb25zdCB0aW1lb3V0SWQgPSBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICBkaWRUaW1lb3V0ID0gdHJ1ZTtcbiAgICBjb250cm9sbGVyLmFib3J0KCk7XG4gIH0sIHRpbWVvdXRNcyk7XG5cbiAgcmV0dXJuIHtcbiAgICBzaWduYWw6IGNvbnRyb2xsZXIuc2lnbmFsLFxuICAgIGdldCBmaXJzdFBhY2tldFJlY2VpdmVkKCkge1xuICAgICAgcmV0dXJuIGZpcnN0UGFja2V0UmVjZWl2ZWQ7XG4gICAgfSxcbiAgICBnZXQgZGlkVGltZW91dCgpIHtcbiAgICAgIHJldHVybiBkaWRUaW1lb3V0O1xuICAgIH0sXG4gICAgbWFya0ZpcnN0UGFja2V0UmVjZWl2ZWQoKSB7XG4gICAgICBpZiAoZmlyc3RQYWNrZXRSZWNlaXZlZCkgcmV0dXJuO1xuICAgICAgZmlyc3RQYWNrZXRSZWNlaXZlZCA9IHRydWU7XG4gICAgICBjbGVhclRpbWVvdXQodGltZW91dElkKTtcbiAgICB9LFxuICAgIGNsZWFudXAoKSB7XG4gICAgICBjbGVhclRpbWVvdXQodGltZW91dElkKTtcbiAgICAgIHBhcmVudFNpZ25hbD8ucmVtb3ZlRXZlbnRMaXN0ZW5lcj8uKFwiYWJvcnRcIiwgYWJvcnRGcm9tUGFyZW50KTtcbiAgICB9XG4gIH07XG59XG5cbmZ1bmN0aW9uIGJ1aWxkRmlyc3RQYWNrZXRUaW1lb3V0RXJyb3IoY29uZmlnKSB7XG4gIGNvbnN0IHRpbWVvdXRTZWNvbmRzID0gTWF0aC5tYXgoMSwgTnVtYmVyKGNvbmZpZz8uZmlyc3RQYWNrZXRUaW1lb3V0U2Vjb25kcykgfHwgREVGQVVMVF9MTE1fRklSU1RfUEFDS0VUX1RJTUVPVVRfU0VDT05EUyk7XG4gIHJldHVybiBjcmVhdGVMbG1TdHJlYW1FcnJvcih7XG4gICAgY29kZTogXCJGSVJTVF9QQUNLRVRfVElNRU9VVFwiLFxuICAgIG1lc3NhZ2U6IGDpppbljIXotoXml7bvvIwke3RpbWVvdXRTZWNvbmRzfSDnp5LlhoXmnKrmlLbliLDlk43lupRgLFxuICAgIGRldGFpbDogeyB0aW1lb3V0U2Vjb25kcyB9XG4gIH0pO1xufVxuXG4vKiogVGhyb3duIC8gcGFzc2VkIHRocm91Z2ggc3RyZWFtIHJldHJ5IGxheWVyICovXG5leHBvcnQgdHlwZSBMbG1TdHJlYW1FcnJvciA9IEVycm9yICYge1xuICBjb2RlOiBzdHJpbmc7XG4gIHN0YXR1cz86IG51bWJlcjtcbiAgZGV0YWlsPzogdW5rbm93bjtcbiAgYXBpVHlwZT86IHN0cmluZztcbiAgYXR0ZW1wdD86IG51bWJlcjtcbiAgbWF4QXR0ZW1wdHM/OiBudW1iZXI7XG4gIC8qKiBGaW5hbCBhdHRlbXB0IGNvdW50IHdoZW4gcmV0cmllcyBleGhhdXN0ZWQgKi9cbiAgYXR0ZW1wdHM/OiBudW1iZXI7XG4gIGZhaWx1cmVzPzogQXJyYXk8e1xuICAgIGF0dGVtcHQ6IG51bWJlcjtcbiAgICBjb2RlOiBzdHJpbmc7XG4gICAgbWVzc2FnZTogc3RyaW5nO1xuICAgIHN0YXR1czogbnVtYmVyIHwgbnVsbDtcbiAgICBkZXRhaWw6IHVua25vd24gfCBudWxsO1xuICB9Pjtcbn07XG5cbmZ1bmN0aW9uIGNyZWF0ZUxsbVN0cmVhbUVycm9yKGZpZWxkczoge1xuICBjb2RlOiBzdHJpbmc7XG4gIG1lc3NhZ2U6IHN0cmluZztcbiAgc3RhdHVzPzogbnVtYmVyO1xuICBkZXRhaWw/OiB1bmtub3duO1xufSk6IExsbVN0cmVhbUVycm9yIHtcbiAgY29uc3QgZXJyb3IgPSBuZXcgRXJyb3IoZmllbGRzLm1lc3NhZ2UgfHwgXCJMTE0gcmVxdWVzdCBmYWlsZWRcIikgYXMgTGxtU3RyZWFtRXJyb3I7XG4gIGVycm9yLmNvZGUgPSBmaWVsZHMuY29kZSB8fCBcIkxMTV9FUlJPUlwiO1xuICBpZiAoZmllbGRzLnN0YXR1cyAhPSBudWxsKSBlcnJvci5zdGF0dXMgPSBmaWVsZHMuc3RhdHVzO1xuICBpZiAoZmllbGRzLmRldGFpbCAhPSBudWxsKSBlcnJvci5kZXRhaWwgPSBmaWVsZHMuZGV0YWlsO1xuICByZXR1cm4gZXJyb3I7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUxsbVN0cmVhbUVycm9yKFxuICBlcnJvcjogdW5rbm93bixcbiAgeyBhcGlUeXBlLCBhdHRlbXB0LCBtYXhBdHRlbXB0cyB9OiB7IGFwaVR5cGU6IHN0cmluZzsgYXR0ZW1wdDogbnVtYmVyOyBtYXhBdHRlbXB0czogbnVtYmVyIH1cbik6IExsbVN0cmVhbUVycm9yIHtcbiAgY29uc3QgZXJyID0gZXJyb3IgYXMgTGxtU3RyZWFtRXJyb3I7XG4gIGlmIChlcnI/LmNvZGUpIHtcbiAgICBlcnIuYXBpVHlwZSA9IGFwaVR5cGU7XG4gICAgZXJyLmF0dGVtcHQgPSBhdHRlbXB0O1xuICAgIGVyci5tYXhBdHRlbXB0cyA9IG1heEF0dGVtcHRzO1xuICAgIHJldHVybiBlcnI7XG4gIH1cblxuICBjb25zdCBub3JtYWxpemVkID0gY3JlYXRlTGxtU3RyZWFtRXJyb3Ioe1xuICAgIGNvZGU6IGluZmVyTGxtRXJyb3JDb2RlKGVycm9yKSxcbiAgICBtZXNzYWdlOiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFwiTExNIOivt+axguWksei0pVwiLFxuICAgIGRldGFpbDogZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLnN0YWNrIHx8IFN0cmluZyhlcnJvcikgOiBTdHJpbmcoZXJyb3IpLFxuICB9KTtcbiAgbm9ybWFsaXplZC5hcGlUeXBlID0gYXBpVHlwZTtcbiAgbm9ybWFsaXplZC5hdHRlbXB0ID0gYXR0ZW1wdDtcbiAgbm9ybWFsaXplZC5tYXhBdHRlbXB0cyA9IG1heEF0dGVtcHRzO1xuICByZXR1cm4gbm9ybWFsaXplZDtcbn1cblxuZnVuY3Rpb24gaW5mZXJMbG1FcnJvckNvZGUoZXJyb3IpIHtcbiAgaWYgKGlzQWJvcnRFcnJvcihlcnJvcikpIHJldHVybiBcIlJFUVVFU1RfQUJPUlRFRFwiO1xuICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBUeXBlRXJyb3IpIHJldHVybiBcIk5FVFdPUktfRVJST1JcIjtcbiAgcmV0dXJuIFwiTExNX0VSUk9SXCI7XG59XG5cbmZ1bmN0aW9uIGlzQWJvcnRFcnJvcihlcnJvcikge1xuICByZXR1cm4gZXJyb3I/Lm5hbWUgPT09IFwiQWJvcnRFcnJvclwiO1xufVxuXG5hc3luYyBmdW5jdGlvbiBkZWxheVJldHJ5KGF0dGVtcHQ6IG51bWJlciwgc2lnbmFsOiBBYm9ydFNpZ25hbCB8IHVuZGVmaW5lZCkge1xuICBjb25zdCBkZWxheU1zID0gTWF0aC5taW4oODAwLCBhdHRlbXB0ICogMjUwKTtcbiAgYXdhaXQgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICBzaWduYWw/LnJlbW92ZUV2ZW50TGlzdGVuZXI/LihcImFib3J0XCIsIG9uQWJvcnQpO1xuICAgICAgcmVzb2x2ZSgpO1xuICAgIH0sIGRlbGF5TXMpO1xuXG4gICAgZnVuY3Rpb24gb25BYm9ydCgpIHtcbiAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICByZWplY3QobmV3IERPTUV4Y2VwdGlvbihcIkFib3J0ZWRcIiwgXCJBYm9ydEVycm9yXCIpKTtcbiAgICB9XG5cbiAgICBpZiAoc2lnbmFsPy5hYm9ydGVkKSB7XG4gICAgICBvbkFib3J0KCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHNpZ25hbD8uYWRkRXZlbnRMaXN0ZW5lcj8uKFwiYWJvcnRcIiwgb25BYm9ydCwgeyBvbmNlOiB0cnVlIH0pO1xuICB9KTtcbn1cbiIsImltcG9ydCB7IGRlZmluZUJhY2tncm91bmQgfSBmcm9tICd3eHQvdXRpbHMvZGVmaW5lLWJhY2tncm91bmQnXG5pbXBvcnQge1xuICAgIGZvY3VzUmV1c2FibGVUYWIsXG4gICAgaXNUYWJSZXVzZUVuYWJsZWQsXG4gICAgZmluZFJldXNhYmxlVGFiLFxuICAgIG5vcm1hbGl6ZVJldXNhYmxlVXJsLFxuICAgIGdldFJldXNlRG9tYWluS2V5LFxuICAgIGdldFJldXNlRG9tYWluUG9saWN5LFxuICAgIHNldFJldXNlRG9tYWluUG9saWN5XG59IGZyb20gXCJAL2xpYi9hcGkvdGFiUmV1c2VcIjtcbmltcG9ydCB7IEJVSUxUSU5fVE9PTF9OQU1FUywgZXhlY3V0ZVRvb2wgfSBmcm9tIFwiQC9saWIvYXBpL2xsbVwiO1xuXG5cbmV4cG9ydCBkZWZhdWx0IGRlZmluZUJhY2tncm91bmQoKCkgPT4ge1xuICBjb25zdCBSRVVTRV9QUk9NUFRfVElNRU9VVF9NUyA9IDMwMDAwO1xuICBjb25zdCBwZW5kaW5nUmV1c2VQcm9tcHRzID0gbmV3IE1hcCgpO1xuICBjb25zdCBTQ0hFRFVMRV9TVE9SQUdFX0tFWSA9IFwic2NoZWR1bGVkSm9ic1wiO1xuICBjb25zdCBTQ0hFRFVMRV9SRVRFTlRJT05fTVMgPSAyNCAqIDYwICogNjAgKiAxMDAwO1xuICBjb25zdCBERUZBVUxUX1NDSEVEVUxFX1RPT0xfVElNRU9VVF9TRUNPTkRTID0gMzA7XG4gIGNvbnN0IFNDSEVEVUxFX0ZJUkVfQUxBUk1fUFJFRklYID0gXCJzY2hlZHVsZS1maXJlOlwiO1xuICBjb25zdCBTQ0hFRFVMRV9DTEVBTlVQX0FMQVJNX1BSRUZJWCA9IFwic2NoZWR1bGUtY2xlYW51cDpcIjtcbiAgY29uc3QgVEVSTUlOQUxfU0NIRURVTEVfU1RBVFVTRVMgPSBuZXcgU2V0KFtcInN1Y2NlZWRlZFwiLCBcImZhaWxlZFwiLCBcImNhbmNlbGxlZFwiXSk7XG5cbiAgZnVuY3Rpb24gYnVpbGRTY2hlZHVsZUZpcmVBbGFybU5hbWUoaWQpIHtcbiAgICAgIHJldHVybiBgJHtTQ0hFRFVMRV9GSVJFX0FMQVJNX1BSRUZJWH0ke2lkfWA7XG4gIH1cblxuICBmdW5jdGlvbiBidWlsZFNjaGVkdWxlQ2xlYW51cEFsYXJtTmFtZShpZCkge1xuICAgICAgcmV0dXJuIGAke1NDSEVEVUxFX0NMRUFOVVBfQUxBUk1fUFJFRklYfSR7aWR9YDtcbiAgfVxuXG4gIGZ1bmN0aW9uIGlzVGVybWluYWxTY2hlZHVsZVN0YXR1cyhzdGF0dXMpIHtcbiAgICAgIHJldHVybiBURVJNSU5BTF9TQ0hFRFVMRV9TVEFUVVNFUy5oYXMoc3RhdHVzKTtcbiAgfVxuXG4gIGFzeW5jIGZ1bmN0aW9uIGxvYWRTY2hlZHVsZWRKb2JzKCkge1xuICAgICAgY29uc3QgeyBbU0NIRURVTEVfU1RPUkFHRV9LRVldOiBqb2JzIH0gPSBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoeyBbU0NIRURVTEVfU1RPUkFHRV9LRVldOiBbXSB9KTtcbiAgICAgIHJldHVybiBBcnJheS5pc0FycmF5KGpvYnMpID8gam9icyA6IFtdO1xuICB9XG5cbiAgYXN5bmMgZnVuY3Rpb24gc2F2ZVNjaGVkdWxlZEpvYnMoam9icykge1xuICAgICAgYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHsgW1NDSEVEVUxFX1NUT1JBR0VfS0VZXTogam9icyB9KTtcbiAgfVxuXG4gIGZ1bmN0aW9uIHNlcmlhbGl6ZVNjaGVkdWxlZEpvYihqb2IpIHtcbiAgICAgIGNvbnN0IHJlbWFpbmluZ1NlY29uZHMgPSBqb2Iuc3RhdHVzID09PSBcInBlbmRpbmdcIlxuICAgICAgICAgID8gTWF0aC5tYXgoMCwgTWF0aC5yb3VuZCgoam9iLmZpcmVUaW1lc3RhbXAgLSBEYXRlLm5vdygpKSAvIDEwMDApKVxuICAgICAgICAgIDogMDtcbiAgICAgIHJldHVybiB7XG4gICAgICAgICAgaWQ6IGpvYi5pZCxcbiAgICAgICAgICBzY2hlZHVsZUlkOiBqb2IuaWQsXG4gICAgICAgICAgbGFiZWw6IGpvYi5sYWJlbCxcbiAgICAgICAgICB0b29sTmFtZTogam9iLnRvb2xOYW1lLFxuICAgICAgICAgIHRvb2xBcmdzOiBqb2IudG9vbEFyZ3MsXG4gICAgICAgICAgZmlyZUF0OiBuZXcgRGF0ZShqb2IuZmlyZVRpbWVzdGFtcCkudG9Mb2NhbGVTdHJpbmcoKSxcbiAgICAgICAgICBzdGF0dXM6IGpvYi5zdGF0dXMsXG4gICAgICAgICAgcmVtYWluaW5nU2Vjb25kcyxcbiAgICAgICAgICB0aW1lb3V0U2Vjb25kczogTWF0aC5yb3VuZCgoam9iLmV4ZWN1dGVUaW1lb3V0TXMgfHwgKERFRkFVTFRfU0NIRURVTEVfVE9PTF9USU1FT1VUX1NFQ09ORFMgKiAxMDAwKSkgLyAxMDAwKSxcbiAgICAgICAgICBzdGFydGVkQXQ6IGpvYi5zdGFydGVkQXQgPyBuZXcgRGF0ZShqb2Iuc3RhcnRlZEF0KS50b0xvY2FsZVN0cmluZygpIDogbnVsbCxcbiAgICAgICAgICBmaW5pc2hlZEF0OiBqb2IuZmluaXNoZWRBdCA/IG5ldyBEYXRlKGpvYi5maW5pc2hlZEF0KS50b0xvY2FsZVN0cmluZygpIDogbnVsbCxcbiAgICAgICAgICBlcnJvcjogam9iLmVycm9yIHx8IG51bGwsXG4gICAgICAgICAgZXhwaXJlc0F0OiBqb2IuZXhwaXJlc0F0ID8gbmV3IERhdGUoam9iLmV4cGlyZXNBdCkudG9Mb2NhbGVTdHJpbmcoKSA6IG51bGxcbiAgICAgIH07XG4gIH1cblxuICBhc3luYyBmdW5jdGlvbiBjbGVhclNjaGVkdWxlQWxhcm1zKHNjaGVkdWxlSWQpIHtcbiAgICAgIGlmICghY2hyb21lLmFsYXJtcykgcmV0dXJuO1xuICAgICAgYXdhaXQgY2hyb21lLmFsYXJtcy5jbGVhcihidWlsZFNjaGVkdWxlRmlyZUFsYXJtTmFtZShzY2hlZHVsZUlkKSk7XG4gICAgICBhd2FpdCBjaHJvbWUuYWxhcm1zLmNsZWFyKGJ1aWxkU2NoZWR1bGVDbGVhbnVwQWxhcm1OYW1lKHNjaGVkdWxlSWQpKTtcbiAgfVxuXG4gIGFzeW5jIGZ1bmN0aW9uIGNyZWF0ZVNjaGVkdWxlRmlyZUFsYXJtKGpvYikge1xuICAgICAgaWYgKCFjaHJvbWUuYWxhcm1zIHx8IGpvYi5zdGF0dXMgIT09IFwicGVuZGluZ1wiKSByZXR1cm47XG4gICAgICBhd2FpdCBjaHJvbWUuYWxhcm1zLmNyZWF0ZShidWlsZFNjaGVkdWxlRmlyZUFsYXJtTmFtZShqb2IuaWQpLCB7IHdoZW46IE1hdGgubWF4KERhdGUubm93KCksIGpvYi5maXJlVGltZXN0YW1wKSB9KTtcbiAgfVxuXG4gIGFzeW5jIGZ1bmN0aW9uIGNyZWF0ZVNjaGVkdWxlQ2xlYW51cEFsYXJtKGpvYikge1xuICAgICAgaWYgKCFjaHJvbWUuYWxhcm1zIHx8ICFpc1Rlcm1pbmFsU2NoZWR1bGVTdGF0dXMoam9iLnN0YXR1cykgfHwgIU51bWJlci5pc0Zpbml0ZShqb2IuZXhwaXJlc0F0KSkgcmV0dXJuO1xuICAgICAgYXdhaXQgY2hyb21lLmFsYXJtcy5jcmVhdGUoYnVpbGRTY2hlZHVsZUNsZWFudXBBbGFybU5hbWUoam9iLmlkKSwgeyB3aGVuOiBNYXRoLm1heChEYXRlLm5vdygpLCBqb2IuZXhwaXJlc0F0KSB9KTtcbiAgfVxuXG4gIGFzeW5jIGZ1bmN0aW9uIHBydW5lRXhwaXJlZFNjaGVkdWxlZEpvYnMoKSB7XG4gICAgICBjb25zdCBqb2JzID0gYXdhaXQgbG9hZFNjaGVkdWxlZEpvYnMoKTtcbiAgICAgIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gICAgICBjb25zdCBrZXB0ID0gW107XG4gICAgICBmb3IgKGNvbnN0IGpvYiBvZiBqb2JzKSB7XG4gICAgICAgICAgaWYgKGlzVGVybWluYWxTY2hlZHVsZVN0YXR1cyhqb2I/LnN0YXR1cykgJiYgTnVtYmVyLmlzRmluaXRlKGpvYj8uZXhwaXJlc0F0KSAmJiBqb2IuZXhwaXJlc0F0IDw9IG5vdykge1xuICAgICAgICAgICAgICBhd2FpdCBjbGVhclNjaGVkdWxlQWxhcm1zKGpvYi5pZCk7XG4gICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgIH1cbiAgICAgICAgICBrZXB0LnB1c2goam9iKTtcbiAgICAgIH1cbiAgICAgIGlmIChrZXB0Lmxlbmd0aCAhPT0gam9icy5sZW5ndGgpIHtcbiAgICAgICAgICBhd2FpdCBzYXZlU2NoZWR1bGVkSm9icyhrZXB0KTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBrZXB0O1xuICB9XG5cbiAgZnVuY3Rpb24gYnVpbGRTY2hlZHVsZU1jcFNuYXBzaG90KG1jcFJlZ2lzdHJ5ID0gW10pIHtcbiAgICAgIHJldHVybiAobWNwUmVnaXN0cnkgfHwgW10pLm1hcCh0b29sID0+ICh7XG4gICAgICAgICAgbmFtZTogdG9vbD8ubmFtZSxcbiAgICAgICAgICBfc2VydmVyTmFtZTogdG9vbD8uX3NlcnZlck5hbWUsXG4gICAgICAgICAgX3NlcnZlclVybDogdG9vbD8uX3NlcnZlclVybCxcbiAgICAgICAgICBfc2VydmVySGVhZGVyczogdG9vbD8uX3NlcnZlckhlYWRlcnMgfHwge30sXG4gICAgICAgICAgX3Rvb2xDYWxsTmFtZTogdG9vbD8uX3Rvb2xDYWxsTmFtZVxuICAgICAgfSkpLmZpbHRlcih0b29sID0+IHRvb2wubmFtZSAmJiB0b29sLl90b29sQ2FsbE5hbWUgJiYgdG9vbC5fc2VydmVyVXJsKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGlzS25vd25TY2hlZHVsZWRUb29sTmFtZSh0b29sTmFtZSwgbWNwUmVnaXN0cnkgPSBbXSkge1xuICAgICAgaWYgKEJVSUxUSU5fVE9PTF9OQU1FUy5pbmNsdWRlcyh0b29sTmFtZSkpIHJldHVybiB0cnVlO1xuICAgICAgcmV0dXJuIChtY3BSZWdpc3RyeSB8fCBbXSkuc29tZSh0b29sID0+IHRvb2w/Ll90b29sQ2FsbE5hbWUgPT09IHRvb2xOYW1lKTtcbiAgfVxuXG4gIGFzeW5jIGZ1bmN0aW9uIGV4ZWN1dGVUb29sV2l0aFRpbWVvdXQobmFtZSwgYXJncywgbWNwUmVnaXN0cnksIHRpbWVvdXRNcykge1xuICAgICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUodGltZW91dE1zKSB8fCB0aW1lb3V0TXMgPD0gMCkge1xuICAgICAgICAgIHJldHVybiBhd2FpdCBleGVjdXRlVG9vbChuYW1lLCBhcmdzLCBtY3BSZWdpc3RyeSk7XG4gICAgICB9XG4gICAgICByZXR1cm4gYXdhaXQgUHJvbWlzZS5yYWNlKFtcbiAgICAgICAgICBleGVjdXRlVG9vbChuYW1lLCBhcmdzLCBtY3BSZWdpc3RyeSksXG4gICAgICAgICAgbmV3IFByb21pc2UoKF8sIHJlamVjdCkgPT4ge1xuICAgICAgICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHJlamVjdChuZXcgRXJyb3IoYFRvb2wgZXhlY3V0aW9uIHRpbWVkIG91dCBhZnRlciAke01hdGgucm91bmQodGltZW91dE1zIC8gMTAwMCl9c2ApKSwgdGltZW91dE1zKTtcbiAgICAgICAgICB9KVxuICAgICAgXSk7XG4gIH1cblxuICBhc3luYyBmdW5jdGlvbiBsaXN0U2NoZWR1bGVkSm9icygpIHtcbiAgICAgIGNvbnN0IGpvYnMgPSBhd2FpdCBwcnVuZUV4cGlyZWRTY2hlZHVsZWRKb2JzKCk7XG4gICAgICBpZiAoam9icy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICByZXR1cm4geyBzY2hlZHVsZWQ6IFtdLCBtZXNzYWdlOiBcIk5vIHNjaGVkdWxlZCB0YXNrc1wiIH07XG4gICAgICB9XG4gICAgICByZXR1cm4ge1xuICAgICAgICAgIHNjaGVkdWxlZDogam9ic1xuICAgICAgICAgICAgICAuc2xpY2UoKVxuICAgICAgICAgICAgICAuc29ydCgoYSwgYikgPT4gYi5maXJlVGltZXN0YW1wIC0gYS5maXJlVGltZXN0YW1wKVxuICAgICAgICAgICAgICAubWFwKHNlcmlhbGl6ZVNjaGVkdWxlZEpvYilcbiAgICAgIH07XG4gIH1cblxuICBhc3luYyBmdW5jdGlvbiBjbGVhckNvbXBsZXRlZFNjaGVkdWxlZEpvYnMoKSB7XG4gICAgICBjb25zdCBqb2JzID0gYXdhaXQgcHJ1bmVFeHBpcmVkU2NoZWR1bGVkSm9icygpO1xuICAgICAgY29uc3QgY29tcGxldGVkSm9icyA9IGpvYnMuZmlsdGVyKGpvYiA9PiBpc1Rlcm1pbmFsU2NoZWR1bGVTdGF0dXMoam9iPy5zdGF0dXMpKTtcbiAgICAgIGlmIChjb21wbGV0ZWRKb2JzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAgIHJldHVybiB7IHN1Y2Nlc3M6IHRydWUsIHJlbW92ZWRDb3VudDogMCwgcmVtb3ZlZElkczogW10gfTtcbiAgICAgIH1cblxuICAgICAgY29uc3Qga2VwdCA9IGpvYnMuZmlsdGVyKGpvYiA9PiAhaXNUZXJtaW5hbFNjaGVkdWxlU3RhdHVzKGpvYj8uc3RhdHVzKSk7XG4gICAgICBhd2FpdCBzYXZlU2NoZWR1bGVkSm9icyhrZXB0KTtcblxuICAgICAgZm9yIChjb25zdCBqb2Igb2YgY29tcGxldGVkSm9icykge1xuICAgICAgICAgIGF3YWl0IGNsZWFyU2NoZWR1bGVBbGFybXMoam9iLmlkKTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBzdWNjZXNzOiB0cnVlLFxuICAgICAgICAgIHJlbW92ZWRDb3VudDogY29tcGxldGVkSm9icy5sZW5ndGgsXG4gICAgICAgICAgcmVtb3ZlZElkczogY29tcGxldGVkSm9icy5tYXAoam9iID0+IGpvYi5pZClcbiAgICAgIH07XG4gIH1cblxuICBhc3luYyBmdW5jdGlvbiBzY2hlZHVsZUpvYihwYXlsb2FkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9KSB7XG4gICAgICBjb25zdCB7IGRlbGF5U2Vjb25kcywgdGltZXN0YW1wLCB0b29sTmFtZSwgdG9vbEFyZ3MsIGxhYmVsLCB0aW1lb3V0U2Vjb25kcywgbWNwUmVnaXN0cnkgfSA9IHBheWxvYWQ7XG4gICAgICBjb25zdCBtY3BTbmFwc2hvdCA9IGJ1aWxkU2NoZWR1bGVNY3BTbmFwc2hvdChtY3BSZWdpc3RyeSBhcyB1bmtub3duW10pO1xuXG4gICAgICBpZiAoIWlzS25vd25TY2hlZHVsZWRUb29sTmFtZSh0b29sTmFtZSwgbWNwU25hcHNob3QpKSB7XG4gICAgICAgICAgcmV0dXJuIHsgZXJyb3I6IGBVbmtub3duIHRvb2w6ICR7dG9vbE5hbWV9YCB9O1xuICAgICAgfVxuICAgICAgaWYgKHRvb2xBcmdzID09IG51bGwgfHwgdHlwZW9mIHRvb2xBcmdzICE9PSBcIm9iamVjdFwiIHx8IEFycmF5LmlzQXJyYXkodG9vbEFyZ3MpKSB7XG4gICAgICAgICAgcmV0dXJuIHsgZXJyb3I6IFwidG9vbEFyZ3MgaXMgcmVxdWlyZWQgYW5kIG11c3QgYmUgYW4gb2JqZWN0XCIgfTtcbiAgICAgIH1cblxuICAgICAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcbiAgICAgIGxldCBkZWxheU1zO1xuICAgICAgbGV0IGZpcmVUaW1lc3RhbXA7XG5cbiAgICAgIGlmIChkZWxheVNlY29uZHMgIT0gbnVsbCAmJiBOdW1iZXIoZGVsYXlTZWNvbmRzKSA+IDApIHtcbiAgICAgICAgICBkZWxheU1zID0gTnVtYmVyKGRlbGF5U2Vjb25kcykgKiAxMDAwO1xuICAgICAgICAgIGZpcmVUaW1lc3RhbXAgPSBub3cgKyBkZWxheU1zO1xuICAgICAgfSBlbHNlIGlmICh0aW1lc3RhbXAgIT0gbnVsbCAmJiBOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKHRpbWVzdGFtcCkpKSB7XG4gICAgICAgICAgZmlyZVRpbWVzdGFtcCA9IE51bWJlcih0aW1lc3RhbXApO1xuICAgICAgICAgIGRlbGF5TXMgPSBmaXJlVGltZXN0YW1wIC0gbm93O1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgICByZXR1cm4geyBlcnJvcjogXCJQbGVhc2UgcHJvdmlkZSBlaXRoZXIgZGVsYXlTZWNvbmRzIG9yIHRpbWVzdGFtcFwiIH07XG4gICAgICB9XG5cbiAgICAgIGlmIChkZWxheU1zIDwgMCkgcmV0dXJuIHsgZXJyb3I6IFwiVGhlIHNwZWNpZmllZCB0aW1lIGlzIGluIHRoZSBwYXN0XCIgfTtcblxuICAgICAgY29uc3Qgam9icyA9IGF3YWl0IHBydW5lRXhwaXJlZFNjaGVkdWxlZEpvYnMoKTtcbiAgICAgIGNvbnN0IGlkID0gYHNjaGVkXyR7RGF0ZS5ub3coKX1fJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCA2KX1gO1xuICAgICAgY29uc3QgZXhlY3V0ZVRpbWVvdXRNcyA9IE1hdGgubWF4KDEsIE51bWJlcih0aW1lb3V0U2Vjb25kcykgfHwgREVGQVVMVF9TQ0hFRFVMRV9UT09MX1RJTUVPVVRfU0VDT05EUykgKiAxMDAwO1xuICAgICAgY29uc3QgZW50cnkgPSB7XG4gICAgICAgICAgaWQsXG4gICAgICAgICAgZmlyZVRpbWVzdGFtcCxcbiAgICAgICAgICB0b29sTmFtZSxcbiAgICAgICAgICB0b29sQXJncyxcbiAgICAgICAgICBsYWJlbDogbGFiZWwgfHwgdG9vbE5hbWUsXG4gICAgICAgICAgZXhlY3V0ZVRpbWVvdXRNcyxcbiAgICAgICAgICBzdGF0dXM6IFwicGVuZGluZ1wiLFxuICAgICAgICAgIHN0YXJ0ZWRBdDogbnVsbCxcbiAgICAgICAgICBmaW5pc2hlZEF0OiBudWxsLFxuICAgICAgICAgIGVycm9yOiBudWxsLFxuICAgICAgICAgIGV4cGlyZXNBdDogbnVsbCxcbiAgICAgICAgICBtY3BSZWdpc3RyeTogbWNwU25hcHNob3RcbiAgICAgIH07XG5cbiAgICAgIGpvYnMucHVzaChlbnRyeSk7XG4gICAgICBhd2FpdCBzYXZlU2NoZWR1bGVkSm9icyhqb2JzKTtcbiAgICAgIGF3YWl0IGNyZWF0ZVNjaGVkdWxlRmlyZUFsYXJtKGVudHJ5KTtcblxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBzdWNjZXNzOiB0cnVlLFxuICAgICAgICAgIHNjaGVkdWxlSWQ6IGlkLFxuICAgICAgICAgIHRvb2xOYW1lLFxuICAgICAgICAgIHRvb2xBcmdzLFxuICAgICAgICAgIGxhYmVsOiBlbnRyeS5sYWJlbCxcbiAgICAgICAgICBmaXJlQXQ6IG5ldyBEYXRlKGZpcmVUaW1lc3RhbXApLnRvTG9jYWxlU3RyaW5nKCksXG4gICAgICAgICAgZGVsYXlTZWNvbmRzOiBNYXRoLnJvdW5kKGRlbGF5TXMgLyAxMDAwKSxcbiAgICAgICAgICB0aW1lb3V0U2Vjb25kczogTWF0aC5yb3VuZChleGVjdXRlVGltZW91dE1zIC8gMTAwMClcbiAgICAgIH07XG4gIH1cblxuICBhc3luYyBmdW5jdGlvbiBjYW5jZWxTY2hlZHVsZWRKb2Ioc2NoZWR1bGVJZCkge1xuICAgICAgY29uc3Qgam9icyA9IGF3YWl0IHBydW5lRXhwaXJlZFNjaGVkdWxlZEpvYnMoKTtcbiAgICAgIGNvbnN0IGluZGV4ID0gam9icy5maW5kSW5kZXgoam9iID0+IGpvYi5pZCA9PT0gc2NoZWR1bGVJZCk7XG4gICAgICBpZiAoaW5kZXggPCAwKSByZXR1cm4geyBlcnJvcjogYFNjaGVkdWxlIG5vdCBmb3VuZDogJHtzY2hlZHVsZUlkfWAgfTtcblxuICAgICAgY29uc3QgY2FuY2VsbGVkID0gam9ic1tpbmRleF07XG4gICAgICBpZiAoY2FuY2VsbGVkLnN0YXR1cyAhPT0gXCJwZW5kaW5nXCIpIHtcbiAgICAgICAgICByZXR1cm4geyBlcnJvcjogYFNjaGVkdWxlICR7c2NoZWR1bGVJZH0gaXMgYWxyZWFkeSAke2NhbmNlbGxlZC5zdGF0dXN9YCB9O1xuICAgICAgfVxuXG4gICAgICBjYW5jZWxsZWQuc3RhdHVzID0gXCJjYW5jZWxsZWRcIjtcbiAgICAgIGNhbmNlbGxlZC5maW5pc2hlZEF0ID0gRGF0ZS5ub3coKTtcbiAgICAgIGNhbmNlbGxlZC5lcnJvciA9IG51bGw7XG4gICAgICBjYW5jZWxsZWQuZXhwaXJlc0F0ID0gY2FuY2VsbGVkLmZpbmlzaGVkQXQgKyBTQ0hFRFVMRV9SRVRFTlRJT05fTVM7XG4gICAgICBhd2FpdCBzYXZlU2NoZWR1bGVkSm9icyhqb2JzKTtcbiAgICAgIGF3YWl0IGNsZWFyU2NoZWR1bGVBbGFybXMoY2FuY2VsbGVkLmlkKTtcbiAgICAgIGF3YWl0IGNyZWF0ZVNjaGVkdWxlQ2xlYW51cEFsYXJtKGNhbmNlbGxlZCk7XG5cbiAgICAgIHJldHVybiB7XG4gICAgICAgICAgc3VjY2VzczogdHJ1ZSxcbiAgICAgICAgICBjYW5jZWxsZWQ6IHtcbiAgICAgICAgICAgICAgc2NoZWR1bGVJZDogY2FuY2VsbGVkLmlkLFxuICAgICAgICAgICAgICBsYWJlbDogY2FuY2VsbGVkLmxhYmVsLFxuICAgICAgICAgICAgICB0b29sTmFtZTogY2FuY2VsbGVkLnRvb2xOYW1lLFxuICAgICAgICAgICAgICB3YXNTY2hlZHVsZWRGb3I6IG5ldyBEYXRlKGNhbmNlbGxlZC5maXJlVGltZXN0YW1wKS50b0xvY2FsZVN0cmluZygpLFxuICAgICAgICAgICAgICBzdGF0dXM6IGNhbmNlbGxlZC5zdGF0dXMsXG4gICAgICAgICAgICAgIGV4cGlyZXNBdDogbmV3IERhdGUoY2FuY2VsbGVkLmV4cGlyZXNBdCkudG9Mb2NhbGVTdHJpbmcoKVxuICAgICAgICAgIH1cbiAgICAgIH07XG4gIH1cblxuICBhc3luYyBmdW5jdGlvbiBmaW5hbGl6ZVNjaGVkdWxlZEpvYihzY2hlZHVsZUlkLCB1cGRhdGVyKSB7XG4gICAgICBjb25zdCBqb2JzID0gYXdhaXQgcHJ1bmVFeHBpcmVkU2NoZWR1bGVkSm9icygpO1xuICAgICAgY29uc3QgaW5kZXggPSBqb2JzLmZpbmRJbmRleChqb2IgPT4gam9iLmlkID09PSBzY2hlZHVsZUlkKTtcbiAgICAgIGlmIChpbmRleCA8IDApIHJldHVybiBudWxsO1xuICAgICAgY29uc3Qgam9iID0gam9ic1tpbmRleF07XG4gICAgICB1cGRhdGVyKGpvYik7XG4gICAgICBhd2FpdCBzYXZlU2NoZWR1bGVkSm9icyhqb2JzKTtcbiAgICAgIHJldHVybiBqb2I7XG4gIH1cblxuICBhc3luYyBmdW5jdGlvbiBydW5TY2hlZHVsZWRKb2Ioc2NoZWR1bGVJZCkge1xuICAgICAgY29uc3Qgam9icyA9IGF3YWl0IHBydW5lRXhwaXJlZFNjaGVkdWxlZEpvYnMoKTtcbiAgICAgIGNvbnN0IGluZGV4ID0gam9icy5maW5kSW5kZXgoam9iID0+IGpvYi5pZCA9PT0gc2NoZWR1bGVJZCk7XG4gICAgICBpZiAoaW5kZXggPCAwKSByZXR1cm47XG5cbiAgICAgIGNvbnN0IGpvYiA9IGpvYnNbaW5kZXhdO1xuICAgICAgaWYgKGpvYi5zdGF0dXMgIT09IFwicGVuZGluZ1wiKSByZXR1cm47XG5cbiAgICAgIGpvYi5zdGF0dXMgPSBcInJ1bm5pbmdcIjtcbiAgICAgIGpvYi5zdGFydGVkQXQgPSBEYXRlLm5vdygpO1xuICAgICAgam9iLmVycm9yID0gbnVsbDtcbiAgICAgIGF3YWl0IHNhdmVTY2hlZHVsZWRKb2JzKGpvYnMpO1xuICAgICAgYXdhaXQgY2hyb21lLmFsYXJtcz8uY2xlYXIoYnVpbGRTY2hlZHVsZUZpcmVBbGFybU5hbWUoc2NoZWR1bGVJZCkpO1xuXG4gICAgICBsZXQgbmV4dFN0YXR1cyA9IFwic3VjY2VlZGVkXCI7XG4gICAgICBsZXQgZXJyb3JUZXh0ID0gbnVsbDtcbiAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZXhlY3V0ZVRvb2xXaXRoVGltZW91dChqb2IudG9vbE5hbWUsIGpvYi50b29sQXJncywgam9iLm1jcFJlZ2lzdHJ5IHx8IFtdLCBqb2IuZXhlY3V0ZVRpbWVvdXRNcyk7XG4gICAgICAgICAgaWYgKHJlc3VsdCAmJiB0eXBlb2YgcmVzdWx0ID09PSBcIm9iamVjdFwiICYmICFBcnJheS5pc0FycmF5KHJlc3VsdCkgJiYgcmVzdWx0LmVycm9yKSB7XG4gICAgICAgICAgICAgIG5leHRTdGF0dXMgPSBcImZhaWxlZFwiO1xuICAgICAgICAgICAgICBlcnJvclRleHQgPSBTdHJpbmcocmVzdWx0LmVycm9yKTtcbiAgICAgICAgICB9XG4gICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgIG5leHRTdGF0dXMgPSBcImZhaWxlZFwiO1xuICAgICAgICAgIGVycm9yVGV4dCA9IGVycm9yPy5tZXNzYWdlIHx8IFN0cmluZyhlcnJvcik7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGZpbmlzaGVkQXQgPSBEYXRlLm5vdygpO1xuICAgICAgY29uc3QgdXBkYXRlZEpvYiA9IGF3YWl0IGZpbmFsaXplU2NoZWR1bGVkSm9iKHNjaGVkdWxlSWQsIChjdXJyZW50KSA9PiB7XG4gICAgICAgICAgY3VycmVudC5zdGF0dXMgPSBuZXh0U3RhdHVzO1xuICAgICAgICAgIGN1cnJlbnQuZmluaXNoZWRBdCA9IGZpbmlzaGVkQXQ7XG4gICAgICAgICAgY3VycmVudC5lcnJvciA9IGVycm9yVGV4dDtcbiAgICAgICAgICBjdXJyZW50LmV4cGlyZXNBdCA9IGZpbmlzaGVkQXQgKyBTQ0hFRFVMRV9SRVRFTlRJT05fTVM7XG4gICAgICB9KTtcbiAgICAgIGlmICh1cGRhdGVkSm9iKSB7XG4gICAgICAgICAgYXdhaXQgY3JlYXRlU2NoZWR1bGVDbGVhbnVwQWxhcm0odXBkYXRlZEpvYik7XG4gICAgICB9XG4gIH1cblxuICBhc3luYyBmdW5jdGlvbiBjbGVhbnVwU2NoZWR1bGVkSm9iKHNjaGVkdWxlSWQpIHtcbiAgICAgIGNvbnN0IGpvYnMgPSBhd2FpdCBsb2FkU2NoZWR1bGVkSm9icygpO1xuICAgICAgY29uc3Qga2VwdCA9IGpvYnMuZmlsdGVyKGpvYiA9PiBqb2IuaWQgIT09IHNjaGVkdWxlSWQpO1xuICAgICAgaWYgKGtlcHQubGVuZ3RoID09PSBqb2JzLmxlbmd0aCkgcmV0dXJuO1xuICAgICAgYXdhaXQgc2F2ZVNjaGVkdWxlZEpvYnMoa2VwdCk7XG4gICAgICBhd2FpdCBjbGVhclNjaGVkdWxlQWxhcm1zKHNjaGVkdWxlSWQpO1xuICB9XG5cbiAgYXN5bmMgZnVuY3Rpb24gcmVzdG9yZVNjaGVkdWxlZEpvYnMoKSB7XG4gICAgICBjb25zdCBqb2JzID0gYXdhaXQgcHJ1bmVFeHBpcmVkU2NoZWR1bGVkSm9icygpO1xuICAgICAgbGV0IGNoYW5nZWQgPSBmYWxzZTtcbiAgICAgIGZvciAoY29uc3Qgam9iIG9mIGpvYnMpIHtcbiAgICAgICAgICBpZiAoam9iLnN0YXR1cyA9PT0gXCJydW5uaW5nXCIpIHtcbiAgICAgICAgICAgICAgam9iLnN0YXR1cyA9IFwiZmFpbGVkXCI7XG4gICAgICAgICAgICAgIGpvYi5maW5pc2hlZEF0ID0gRGF0ZS5ub3coKTtcbiAgICAgICAgICAgICAgam9iLmVycm9yID0gam9iLmVycm9yIHx8IFwiQmFja2dyb3VuZCB3b3JrZXIgcmVzdGFydGVkIGJlZm9yZSB0aGUgc2NoZWR1bGVkIGpvYiBjb21wbGV0ZWRcIjtcbiAgICAgICAgICAgICAgam9iLmV4cGlyZXNBdCA9IGpvYi5maW5pc2hlZEF0ICsgU0NIRURVTEVfUkVURU5USU9OX01TO1xuICAgICAgICAgICAgICBjaGFuZ2VkID0gdHJ1ZTtcbiAgICAgICAgICB9XG4gICAgICB9XG4gICAgICBpZiAoY2hhbmdlZCkge1xuICAgICAgICAgIGF3YWl0IHNhdmVTY2hlZHVsZWRKb2JzKGpvYnMpO1xuICAgICAgfVxuXG4gICAgICBmb3IgKGNvbnN0IGpvYiBvZiBqb2JzKSB7XG4gICAgICAgICAgaWYgKGpvYi5zdGF0dXMgPT09IFwicGVuZGluZ1wiKSB7XG4gICAgICAgICAgICAgIGlmIChqb2IuZmlyZVRpbWVzdGFtcCA8PSBEYXRlLm5vdygpKSB7XG4gICAgICAgICAgICAgICAgICBhd2FpdCBydW5TY2hlZHVsZWRKb2Ioam9iLmlkKTtcbiAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgIGF3YWl0IGNyZWF0ZVNjaGVkdWxlRmlyZUFsYXJtKGpvYik7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGVsc2UgaWYgKGlzVGVybWluYWxTY2hlZHVsZVN0YXR1cyhqb2Iuc3RhdHVzKSAmJiBOdW1iZXIuaXNGaW5pdGUoam9iLmV4cGlyZXNBdCkpIHtcbiAgICAgICAgICAgICAgYXdhaXQgY3JlYXRlU2NoZWR1bGVDbGVhbnVwQWxhcm0oam9iKTtcbiAgICAgICAgICB9XG4gICAgICB9XG4gIH1cblxuICBmdW5jdGlvbiBjbGVhclBlbmRpbmdSZXVzZVByb21wdCh0YWJJZCkge1xuICAgICAgY29uc3QgcGVuZGluZyA9IHBlbmRpbmdSZXVzZVByb21wdHMuZ2V0KHRhYklkKTtcbiAgICAgIGlmICghcGVuZGluZykgcmV0dXJuIG51bGw7XG4gICAgICBjbGVhclRpbWVvdXQocGVuZGluZy50aW1lb3V0SWQpO1xuICAgICAgcGVuZGluZ1JldXNlUHJvbXB0cy5kZWxldGUodGFiSWQpO1xuICAgICAgcmV0dXJuIHBlbmRpbmc7XG4gIH1cblxuICBhc3luYyBmdW5jdGlvbiBjbG9zZVRhYklmRXhpc3RzKHRhYklkKSB7XG4gICAgICBpZiAoIXRhYklkKSByZXR1cm47XG4gICAgICB0cnkge1xuICAgICAgICAgIGF3YWl0IGNocm9tZS50YWJzLnJlbW92ZSh0YWJJZCk7XG4gICAgICB9IGNhdGNoIChfZXJyb3IpIHtcbiAgICAgICAgICAvLyBJZ25vcmUgbWlzc2luZy9hbHJlYWR5IGNsb3NlZCB0YWJzLlxuICAgICAgfVxuICB9XG5cbiAgYXN5bmMgZnVuY3Rpb24gZ2V0VGFiSWZFeGlzdHModGFiSWQpIHtcbiAgICAgIGlmICghdGFiSWQpIHJldHVybiBudWxsO1xuICAgICAgdHJ5IHtcbiAgICAgICAgICByZXR1cm4gYXdhaXQgY2hyb21lLnRhYnMuZ2V0KHRhYklkKTtcbiAgICAgIH0gY2F0Y2ggKF9lcnJvcikge1xuICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgfVxuICB9XG5cbiAgYXN5bmMgZnVuY3Rpb24gZm9jdXNUYWJJZkV4aXN0cyh0YWJJZCkge1xuICAgICAgY29uc3QgdGFiID0gYXdhaXQgZ2V0VGFiSWZFeGlzdHModGFiSWQpO1xuICAgICAgaWYgKCF0YWI/LmlkIHx8ICF0YWIud2luZG93SWQpIHJldHVybiBudWxsO1xuICAgICAgYXdhaXQgY2hyb21lLndpbmRvd3MudXBkYXRlKHRhYi53aW5kb3dJZCwgeyBmb2N1c2VkOiB0cnVlIH0pO1xuICAgICAgcmV0dXJuIGF3YWl0IGNocm9tZS50YWJzLnVwZGF0ZSh0YWIuaWQsIHsgYWN0aXZlOiB0cnVlIH0pO1xuICB9XG5cbiAgYXN5bmMgZnVuY3Rpb24gdHJ5U2hvd1JldXNlUHJvbXB0KHRhYklkLCBwYXlsb2FkKSB7XG4gICAgICByZXR1cm4gYXdhaXQgbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcbiAgICAgICAgICBjaHJvbWUudGFicy5zZW5kTWVzc2FnZSh0YWJJZCwgcGF5bG9hZCwgKHJlc3BvbnNlKSA9PiB7XG4gICAgICAgICAgICAgIGlmIChjaHJvbWUucnVudGltZS5sYXN0RXJyb3IpIHtcbiAgICAgICAgICAgICAgICAgIHJlc29sdmUoeyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6IGNocm9tZS5ydW50aW1lLmxhc3RFcnJvci5tZXNzYWdlIH0pO1xuICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIGlmICghcmVzcG9uc2U/LnN1Y2Nlc3MpIHtcbiAgICAgICAgICAgICAgICAgIHJlc29sdmUoeyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6IHJlc3BvbnNlPy5lcnJvciB8fCBcIlByb21wdCBub3QgYWNrbm93bGVkZ2VkXCIgfSk7XG4gICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgcmVzb2x2ZSh7IHN1Y2Nlc3M6IHRydWUgfSk7XG4gICAgICAgICAgfSk7XG4gICAgICB9KTtcbiAgfVxuXG4gIGFzeW5jIGZ1bmN0aW9uIGFwcGx5UmV1c2VEZWNpc2lvbihwZW5kaW5nLCBkZWNpc2lvbiwgcmVtZW1iZXJDaG9pY2UpIHtcbiAgICAgIGNvbnN0IG5vcm1hbGl6ZWREZWNpc2lvbiA9IGRlY2lzaW9uID09PSBcImtlZXBcIiA/IFwia2VlcFwiIDogXCJyZXVzZVwiO1xuXG4gICAgICBpZiAocmVtZW1iZXJDaG9pY2UgJiYgcGVuZGluZy5kb21haW5LZXkpIHtcbiAgICAgICAgICBhd2FpdCBzZXRSZXVzZURvbWFpblBvbGljeShwZW5kaW5nLmRvbWFpbktleSwgbm9ybWFsaXplZERlY2lzaW9uKTtcbiAgICAgIH1cblxuICAgICAgaWYgKG5vcm1hbGl6ZWREZWNpc2lvbiA9PT0gXCJyZXVzZVwiKSB7XG4gICAgICAgICAgYXdhaXQgZm9jdXNUYWJJZkV4aXN0cyhwZW5kaW5nLmV4aXN0aW5nVGFiSWQpO1xuICAgICAgICAgIGF3YWl0IGNsb3NlVGFiSWZFeGlzdHMocGVuZGluZy5uZXdUYWJJZCk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBhd2FpdCBmb2N1c1RhYklmRXhpc3RzKHBlbmRpbmcubmV3VGFiSWQpO1xuICB9XG5cbiAgLy8gPT09PT09PT09PSBNZXNzYWdlIGhhbmRsZXIgKG11c3QgYmUgcmVnaXN0ZXJlZCBmaXJzdCBmb3IgcmVsaWFibGUgd2FrZS11cCkgPT09PT09PT09PVxuXG4gIC8qKlxuICAgKiBIYW5kbGUgbWVzc2FnZXMgZnJvbSB0aGUgc2lkZSBwYW5lbC5cbiAgICogXCJ0YWJfZXh0cmFjdFwiIHNlbmRzIGEgbWVzc2FnZSB0byB0aGUgdGFyZ2V0IHRhYidzIGNvbnRlbnQgc2NyaXB0XG4gICAqIHRvIGV4dHJhY3QgcGFnZSB0ZXh0IGNvbnRlbnQuIFVzZXMgY2hyb21lLnRhYnMuc2VuZE1lc3NhZ2Ugd2hpY2hcbiAgICogY29tbXVuaWNhdGVzIHdpdGggdGhlIGF1dG8taW5qZWN0ZWQgY29udGVudCBzY3JpcHQgKG5vIGhvc3RfcGVybWlzc2lvbnMgbmVlZGVkKS5cbiAgICovXG4gIGNocm9tZS5ydW50aW1lLm9uTWVzc2FnZS5hZGRMaXN0ZW5lcigobXNnLCBzZW5kZXIsIHNlbmRSZXNwb25zZSkgPT4ge1xuICAgICAgaWYgKG1zZz8udHlwZSA9PT0gXCJzY2hlZHVsZV9tYW5hZ2VyXCIpIHtcbiAgICAgICAgICAoYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgc3dpdGNoIChtc2cuYWN0aW9uKSB7XG4gICAgICAgICAgICAgICAgICAgICAgY2FzZSBcInNjaGVkdWxlXCI6XG4gICAgICAgICAgICAgICAgICAgICAgICAgIHNlbmRSZXNwb25zZShhd2FpdCBzY2hlZHVsZUpvYihtc2cucGF5bG9hZCB8fCB7fSkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICAgICAgICBjYXNlIFwibGlzdFwiOlxuICAgICAgICAgICAgICAgICAgICAgICAgICBzZW5kUmVzcG9uc2UoYXdhaXQgbGlzdFNjaGVkdWxlZEpvYnMoKSk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgICAgICAgIGNhc2UgXCJjYW5jZWxcIjpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgc2VuZFJlc3BvbnNlKGF3YWl0IGNhbmNlbFNjaGVkdWxlZEpvYihtc2cucGF5bG9hZD8uc2NoZWR1bGVJZCkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICAgICAgICBjYXNlIFwiY2xlYXJfY29tcGxldGVkXCI6XG4gICAgICAgICAgICAgICAgICAgICAgICAgIHNlbmRSZXNwb25zZShhd2FpdCBjbGVhckNvbXBsZXRlZFNjaGVkdWxlZEpvYnMoKSk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgICAgICAgIHNlbmRSZXNwb25zZSh7IGVycm9yOiBgVW5rbm93biBzY2hlZHVsZSBhY3Rpb246ICR7bXNnLmFjdGlvbn1gIH0pO1xuICAgICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgICAgICAgIHNlbmRSZXNwb25zZSh7IGVycm9yOiBlcnJvcj8ubWVzc2FnZSB8fCBTdHJpbmcoZXJyb3IpIH0pO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgfSkoKTtcbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cblxuICAgICAgZnVuY3Rpb24gZm9yd2FyZFRvVGFiKHRhYklkLCBwYXlsb2FkKSB7XG4gICAgICAgICAgbGV0IHJlc3BvbmRlZCA9IGZhbHNlO1xuICAgICAgICAgIGNvbnN0IHRpbWVySWQgPSBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgICAgICAgaWYgKHJlc3BvbmRlZCkgcmV0dXJuO1xuICAgICAgICAgICAgICByZXNwb25kZWQgPSB0cnVlO1xuICAgICAgICAgICAgICBzZW5kUmVzcG9uc2UoeyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6IFwiVGltZWQgb3V0IHdhaXRpbmcgZm9yIGNvbnRlbnQgc2NyaXB0IHJlc3BvbnNlXCIgfSk7XG4gICAgICAgICAgfSwgMTAwMDApO1xuXG4gICAgICAgICAgY2hyb21lLnRhYnMuc2VuZE1lc3NhZ2UodGFiSWQsIHBheWxvYWQsIChyZXNwb25zZSkgPT4ge1xuICAgICAgICAgICAgICBpZiAocmVzcG9uZGVkKSByZXR1cm47XG4gICAgICAgICAgICAgIHJlc3BvbmRlZCA9IHRydWU7XG4gICAgICAgICAgICAgIGNsZWFyVGltZW91dCh0aW1lcklkKTtcbiAgICAgICAgICAgICAgaWYgKGNocm9tZS5ydW50aW1lLmxhc3RFcnJvcikge1xuICAgICAgICAgICAgICAgICAgc2VuZFJlc3BvbnNlKHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiBjaHJvbWUucnVudGltZS5sYXN0RXJyb3IubWVzc2FnZSB9KTtcbiAgICAgICAgICAgICAgfSBlbHNlIGlmIChyZXNwb25zZSkge1xuICAgICAgICAgICAgICAgICAgc2VuZFJlc3BvbnNlKHsgc3VjY2VzczogdHJ1ZSwgZGF0YTogcmVzcG9uc2UgfSk7XG4gICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICBzZW5kUmVzcG9uc2UoeyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6IFwiQ29udGVudCBzY3JpcHQgZGlkIG5vdCByZXNwb25kXCIgfSk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICB9KTtcbiAgICAgIH1cblxuICAgICAgaWYgKG1zZy50eXBlID09PSBcInRhYl9leHRyYWN0XCIgJiYgbXNnLnRhYklkKSB7XG4gICAgICAgICAgZm9yd2FyZFRvVGFiKG1zZy50YWJJZCwgeyB0eXBlOiBcInRhYl9leHRyYWN0X2NvbnRlbnRcIiB9KTtcbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cbiAgICAgIGlmIChtc2cudHlwZSA9PT0gXCJ0YWJfc2Nyb2xsXCIgJiYgbXNnLnRhYklkKSB7XG4gICAgICAgICAgZm9yd2FyZFRvVGFiKG1zZy50YWJJZCwge1xuICAgICAgICAgICAgICB0eXBlOiBcInRhYl9zY3JvbGxcIixcbiAgICAgICAgICAgICAgZGVsdGFZOiBtc2cuZGVsdGFZLFxuICAgICAgICAgICAgICBwYWdlRnJhY3Rpb246IG1zZy5wYWdlRnJhY3Rpb24sXG4gICAgICAgICAgICAgIHBvc2l0aW9uOiBtc2cucG9zaXRpb24sXG4gICAgICAgICAgICAgIGJlaGF2aW9yOiBtc2cuYmVoYXZpb3JcbiAgICAgICAgICB9KTtcbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cbiAgICAgIGlmIChtc2cudHlwZSA9PT0gXCJkb21fcXVlcnlcIiAmJiBtc2cudGFiSWQpIHtcbiAgICAgICAgICBmb3J3YXJkVG9UYWIobXNnLnRhYklkLCB7XG4gICAgICAgICAgICAgIHR5cGU6IFwiZG9tX3F1ZXJ5XCIsXG4gICAgICAgICAgICAgIHNlbGVjdG9yOiBtc2cuc2VsZWN0b3IsXG4gICAgICAgICAgICAgIHRleHQ6IG1zZy50ZXh0LFxuICAgICAgICAgICAgICBtYXRjaEV4YWN0OiBtc2cubWF0Y2hFeGFjdCxcbiAgICAgICAgICAgICAgbWF4UmVzdWx0czogbXNnLm1heFJlc3VsdHNcbiAgICAgICAgICB9KTtcbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cbiAgICAgIGlmIChtc2cudHlwZSA9PT0gXCJkb21fY2xpY2tcIiAmJiBtc2cudGFiSWQpIHtcbiAgICAgICAgICBmb3J3YXJkVG9UYWIobXNnLnRhYklkLCB7XG4gICAgICAgICAgICAgIHR5cGU6IFwiZG9tX2NsaWNrXCIsXG4gICAgICAgICAgICAgIHNlbGVjdG9yOiBtc2cuc2VsZWN0b3IsXG4gICAgICAgICAgICAgIHRleHQ6IG1zZy50ZXh0LFxuICAgICAgICAgICAgICBtYXRjaEV4YWN0OiBtc2cubWF0Y2hFeGFjdCxcbiAgICAgICAgICAgICAgaW5kZXg6IG1zZy5pbmRleFxuICAgICAgICAgIH0pO1xuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfVxuICAgICAgaWYgKG1zZy50eXBlID09PSBcImRvbV9zZXRfdmFsdWVcIiAmJiBtc2cudGFiSWQpIHtcbiAgICAgICAgICBmb3J3YXJkVG9UYWIobXNnLnRhYklkLCB7XG4gICAgICAgICAgICAgIHR5cGU6IFwiZG9tX3NldF92YWx1ZVwiLFxuICAgICAgICAgICAgICBzZWxlY3RvcjogbXNnLnNlbGVjdG9yLFxuICAgICAgICAgICAgICB0ZXh0OiBtc2cudGV4dCxcbiAgICAgICAgICAgICAgbWF0Y2hFeGFjdDogbXNnLm1hdGNoRXhhY3QsXG4gICAgICAgICAgICAgIGluZGV4OiBtc2cuaW5kZXgsXG4gICAgICAgICAgICAgIHZhbHVlOiBtc2cudmFsdWVcbiAgICAgICAgICB9KTtcbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cbiAgICAgIGlmIChtc2cudHlwZSA9PT0gXCJkb21fc3R5bGVcIiAmJiBtc2cudGFiSWQpIHtcbiAgICAgICAgICBmb3J3YXJkVG9UYWIobXNnLnRhYklkLCB7XG4gICAgICAgICAgICAgIHR5cGU6IFwiZG9tX3N0eWxlXCIsXG4gICAgICAgICAgICAgIHNlbGVjdG9yOiBtc2cuc2VsZWN0b3IsXG4gICAgICAgICAgICAgIHRleHQ6IG1zZy50ZXh0LFxuICAgICAgICAgICAgICBtYXRjaEV4YWN0OiBtc2cubWF0Y2hFeGFjdCxcbiAgICAgICAgICAgICAgaW5kZXg6IG1zZy5pbmRleCxcbiAgICAgICAgICAgICAgc3R5bGVzOiBtc2cuc3R5bGVzLFxuICAgICAgICAgICAgICBkdXJhdGlvbk1zOiBtc2cuZHVyYXRpb25Nc1xuICAgICAgICAgIH0pO1xuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfVxuICAgICAgaWYgKG1zZy50eXBlID09PSBcImRvbV9nZXRfaHRtbFwiICYmIG1zZy50YWJJZCkge1xuICAgICAgICAgIGZvcndhcmRUb1RhYihtc2cudGFiSWQsIHtcbiAgICAgICAgICAgICAgdHlwZTogXCJkb21fZ2V0X2h0bWxcIixcbiAgICAgICAgICAgICAgc2VsZWN0b3I6IG1zZy5zZWxlY3RvcixcbiAgICAgICAgICAgICAgdGV4dDogbXNnLnRleHQsXG4gICAgICAgICAgICAgIG1hdGNoRXhhY3Q6IG1zZy5tYXRjaEV4YWN0LFxuICAgICAgICAgICAgICBpbmRleDogbXNnLmluZGV4LFxuICAgICAgICAgICAgICBtb2RlOiBtc2cubW9kZSxcbiAgICAgICAgICAgICAgbWF4TGVuZ3RoOiBtc2cubWF4TGVuZ3RoXG4gICAgICAgICAgfSk7XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9XG4gICAgICBpZiAobXNnLnR5cGUgPT09IFwiZG9tX2hpZ2hsaWdodFwiICYmIG1zZy50YWJJZCkge1xuICAgICAgICAgIGZvcndhcmRUb1RhYihtc2cudGFiSWQsIHtcbiAgICAgICAgICAgICAgdHlwZTogXCJkb21faGlnaGxpZ2h0XCIsXG4gICAgICAgICAgICAgIHNlbGVjdG9yOiBtc2cuc2VsZWN0b3IsXG4gICAgICAgICAgICAgIHRleHQ6IG1zZy50ZXh0LFxuICAgICAgICAgICAgICBtYXRjaEV4YWN0OiBtc2cubWF0Y2hFeGFjdCxcbiAgICAgICAgICAgICAgaW5kZXg6IG1zZy5pbmRleCxcbiAgICAgICAgICAgICAgZHVyYXRpb25NczogbXNnLmR1cmF0aW9uTXNcbiAgICAgICAgICB9KTtcbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cbiAgICAgIGlmIChtc2cudHlwZSA9PT0gXCJ0YWJfcmV1c2VfcHJvbXB0X2RlY2lzaW9uXCIpIHtcbiAgICAgICAgICBjb25zdCBwZW5kaW5nID0gY2xlYXJQZW5kaW5nUmV1c2VQcm9tcHQobXNnLm5ld1RhYklkKTtcbiAgICAgICAgICBpZiAoIXBlbmRpbmcpIHtcbiAgICAgICAgICAgICAgc2VuZFJlc3BvbnNlKHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiBcIlJldXNlIHByb21wdCBpcyBubyBsb25nZXIgcGVuZGluZ1wiIH0pO1xuICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgYXBwbHlSZXVzZURlY2lzaW9uKHBlbmRpbmcsIG1zZy5kZWNpc2lvbiwgISFtc2cucmVtZW1iZXJDaG9pY2UpXG4gICAgICAgICAgICAgIC50aGVuKCgpID0+IHNlbmRSZXNwb25zZSh7IHN1Y2Nlc3M6IHRydWUgfSkpXG4gICAgICAgICAgICAgIC5jYXRjaCgoZXJyb3IpID0+IHNlbmRSZXNwb25zZSh7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogZXJyb3I/Lm1lc3NhZ2UgfHwgU3RyaW5nKGVycm9yKSB9KSk7XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9XG4gICAgICByZXR1cm4gZmFsc2U7XG4gIH0pO1xuXG4gIC8vID09PT09PT09PT0gU2lkZSBwYW5lbCBzZXR1cCA9PT09PT09PT09XG5cbiAgLy8gT3BlbiBzaWRlIHBhbmVsIHdoZW4gZXh0ZW5zaW9uIGljb24gaXMgY2xpY2tlZFxuICBjaHJvbWUuc2lkZVBhbmVsPy5zZXRQYW5lbEJlaGF2aW9yKHsgb3BlblBhbmVsT25BY3Rpb25DbGljazogdHJ1ZSB9KS5jYXRjaCgoKSA9PiB7XG4gICAgICAvLyBJZ25vcmUgdW5zdXBwb3J0ZWQvdGVtcG9yYXJ5IHNpZGUgcGFuZWwgaW5pdGlhbGl6YXRpb24gZmFpbHVyZXMuXG4gIH0pO1xuXG4gIC8vID09PT09PT09PT0gVGFiIHJldXNlID09PT09PT09PT1cblxuICAvLyBXaGVuIG5hdmlnYXRpbmcgdG8gYSBVUkwgYWxyZWFkeSBvcGVuLCBzd2l0Y2ggdG8gdGhhdCB0YWIgaW5zdGVhZFxuICBjaHJvbWUud2ViTmF2aWdhdGlvbi5vbkRPTUNvbnRlbnRMb2FkZWQuYWRkTGlzdGVuZXIoYXN5bmMgZSA9PiB7XG4gICAgICB0cnkge1xuICAgICAgICAgIGlmICghZT8udGFiSWQgfHwgZS5mcmFtZUlkICE9PSAwKSByZXR1cm47XG4gICAgICAgICAgaWYgKCFub3JtYWxpemVSZXVzYWJsZVVybChlLnVybCkpIHJldHVybjtcbiAgICAgICAgICBpZiAocGVuZGluZ1JldXNlUHJvbXB0cy5oYXMoZS50YWJJZCkpIHJldHVybjtcblxuICAgICAgICAgIGNvbnN0IHJldXNlID0gYXdhaXQgaXNUYWJSZXVzZUVuYWJsZWQoKTtcbiAgICAgICAgICBpZiAoIXJldXNlKSByZXR1cm47XG5cbiAgICAgICAgICBjb25zdCByZXVzYWJsZVRhYiA9IGF3YWl0IGZpbmRSZXVzYWJsZVRhYihlLnVybCwgeyBleGNsdWRlVGFiSWQ6IGUudGFiSWQgfSk7XG4gICAgICAgICAgaWYgKCFyZXVzYWJsZVRhYikgcmV0dXJuO1xuXG4gICAgICAgICAgY29uc3QgZG9tYWluS2V5ID0gZ2V0UmV1c2VEb21haW5LZXkoZS51cmwpO1xuICAgICAgICAgIGNvbnN0IHJlbWVtYmVyZWRQb2xpY3kgPSBhd2FpdCBnZXRSZXVzZURvbWFpblBvbGljeShkb21haW5LZXkpO1xuICAgICAgICAgIGlmIChyZW1lbWJlcmVkUG9saWN5ID09PSBcImtlZXBcIikgcmV0dXJuO1xuICAgICAgICAgIGlmIChyZW1lbWJlcmVkUG9saWN5ID09PSBcInJldXNlXCIpIHtcbiAgICAgICAgICAgICAgYXdhaXQgZm9jdXNSZXVzYWJsZVRhYihyZXVzYWJsZVRhYik7XG4gICAgICAgICAgICAgIGF3YWl0IGNsb3NlVGFiSWZFeGlzdHMoZS50YWJJZCk7XG4gICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBjb25zdCBuZXdUYWIgPSBhd2FpdCBnZXRUYWJJZkV4aXN0cyhlLnRhYklkKTtcbiAgICAgICAgICBjb25zdCBmb2N1c2VkUmV1c2FibGVUYWIgPSBhd2FpdCBmb2N1c1JldXNhYmxlVGFiKHJldXNhYmxlVGFiKTtcbiAgICAgICAgICBjb25zdCBwcm9tcHRSZXN1bHQgPSAoYXdhaXQgdHJ5U2hvd1JldXNlUHJvbXB0KGZvY3VzZWRSZXVzYWJsZVRhYi5pZCwge1xuICAgICAgICAgICAgICB0eXBlOiBcInNob3dfdGFiX3JldXNlX3Byb21wdFwiLFxuICAgICAgICAgICAgICBuZXdUYWJJZDogZS50YWJJZCxcbiAgICAgICAgICAgICAgZXhpc3RpbmdUYWJJZDogZm9jdXNlZFJldXNhYmxlVGFiLmlkLFxuICAgICAgICAgICAgICBkb21haW5LZXksXG4gICAgICAgICAgICAgIG5ld1VybDogZS51cmwsXG4gICAgICAgICAgICAgIG5ld1RpdGxlOiBuZXdUYWI/LnRpdGxlIHx8IGUudXJsLFxuICAgICAgICAgICAgICBleGlzdGluZ1VybDogZm9jdXNlZFJldXNhYmxlVGFiLnVybCB8fCBlLnVybCxcbiAgICAgICAgICAgICAgZXhpc3RpbmdUaXRsZTogZm9jdXNlZFJldXNhYmxlVGFiLnRpdGxlIHx8IGZvY3VzZWRSZXVzYWJsZVRhYi51cmwgfHwgZS51cmxcbiAgICAgICAgICB9KSkgYXMgeyBzdWNjZXNzOiBib29sZWFuIH07XG5cbiAgICAgICAgICBpZiAoIXByb21wdFJlc3VsdC5zdWNjZXNzKSB7XG4gICAgICAgICAgICAgIGF3YWl0IGNsb3NlVGFiSWZFeGlzdHMoZS50YWJJZCk7XG4gICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBjb25zdCB0aW1lb3V0SWQgPSBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgICAgICAgY2xlYXJQZW5kaW5nUmV1c2VQcm9tcHQoZS50YWJJZCk7XG4gICAgICAgICAgfSwgUkVVU0VfUFJPTVBUX1RJTUVPVVRfTVMpO1xuXG4gICAgICAgICAgcGVuZGluZ1JldXNlUHJvbXB0cy5zZXQoZS50YWJJZCwge1xuICAgICAgICAgICAgICBuZXdUYWJJZDogZS50YWJJZCxcbiAgICAgICAgICAgICAgZXhpc3RpbmdUYWJJZDogZm9jdXNlZFJldXNhYmxlVGFiLmlkLFxuICAgICAgICAgICAgICBkb21haW5LZXksXG4gICAgICAgICAgICAgIHRpbWVvdXRJZFxuICAgICAgICAgIH0pO1xuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICBjb25zb2xlLndhcm4oXCJUYWIgcmV1c2UgZmFpbGVkOlwiLCBlcnJvcik7XG4gICAgICB9XG4gIH0pO1xuXG4gIC8vID09PT09PT09PT0gVGFiIGV2ZW50IG5vdGlmaWNhdGlvbnMgdG8gc2lkZSBwYW5lbCA9PT09PT09PT09XG5cbiAgY2hyb21lLndlYk5hdmlnYXRpb24ub25Db21wbGV0ZWQuYWRkTGlzdGVuZXIoYXN5bmMgZSA9PiB7XG4gICAgICBpZiAoZS50YWJJZCAmJiBlLnVybCAmJiBlLnVybC5zdGFydHNXaXRoKFwiaHR0cFwiKSAmJiBlLmZyYW1lSWQgPT09IDApIHtcbiAgICAgICAgICB0cnkgeyBhd2FpdCBjaHJvbWUucnVudGltZS5zZW5kTWVzc2FnZSh7IHR5cGU6ICdvcGVuJywgdGFiSWQ6IGUudGFiSWQgfSk7IH0gY2F0Y2ggKGUpIHsvKiBpZ25vcmUgKi99XG4gICAgICB9XG4gIH0pO1xuXG4gIGNocm9tZS50YWJzLm9uUmVtb3ZlZC5hZGRMaXN0ZW5lcihhc3luYyBmdW5jdGlvbiAodGFiSWQpIHtcbiAgICAgIGNsZWFyUGVuZGluZ1JldXNlUHJvbXB0KHRhYklkKTtcbiAgICAgIGZvciAoY29uc3QgW3BlbmRpbmdUYWJJZCwgcGVuZGluZ10gb2YgcGVuZGluZ1JldXNlUHJvbXB0cy5lbnRyaWVzKCkpIHtcbiAgICAgICAgICBpZiAocGVuZGluZy5leGlzdGluZ1RhYklkID09PSB0YWJJZCkge1xuICAgICAgICAgICAgICBjbGVhclBlbmRpbmdSZXVzZVByb21wdChwZW5kaW5nVGFiSWQpO1xuICAgICAgICAgIH1cbiAgICAgIH1cbiAgICAgIHRyeSB7IGF3YWl0IGNocm9tZS5ydW50aW1lLnNlbmRNZXNzYWdlKHsgdHlwZTogJ2Nsb3NlJywgdGFiSWQgfSk7IH0gY2F0Y2ggKGUpIHsvKiBpZ25vcmUgKi99XG4gIH0pO1xuXG4gIGNocm9tZS50YWJzLm9uQWN0aXZhdGVkLmFkZExpc3RlbmVyKGFzeW5jIGZ1bmN0aW9uIChhY3RpdmVJbmZvKSB7XG4gICAgICB0cnkgeyBhd2FpdCBjaHJvbWUucnVudGltZS5zZW5kTWVzc2FnZSh7IHR5cGU6ICdhY3RpdmUnLCB0YWJJZDogYWN0aXZlSW5mby50YWJJZCB9KTsgfSBjYXRjaCAoZSkgey8qIGlnbm9yZSAqL31cbiAgICAgIGxldCB7IHRhYkFjdGl2aXR5IH0gPSBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoeyB0YWJBY3Rpdml0eToge30gfSk7XG4gICAgICB0YWJBY3Rpdml0eVthY3RpdmVJbmZvLnRhYklkXSA9IERhdGUubm93KCk7XG4gICAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyB0YWJBY3Rpdml0eSB9KTtcbiAgfSk7XG5cbiAgLy8gPT09PT09PT09PSBBdXRvIG1lbW9yeSByZWxlYXNlID09PT09PT09PT1cblxuICBjaHJvbWUucnVudGltZS5vbkluc3RhbGxlZC5hZGRMaXN0ZW5lcigoKSA9PiB7XG4gICAgICBjaHJvbWUuYWxhcm1zPy5jcmVhdGUoXCJjaGVjay1pZGxlLXRhYnNcIiwgeyBwZXJpb2RJbk1pbnV0ZXM6IDEgfSk7XG4gICAgICB2b2lkIHJlc3RvcmVTY2hlZHVsZWRKb2JzKCk7XG4gIH0pO1xuXG4gIGNocm9tZS5ydW50aW1lLm9uU3RhcnR1cC5hZGRMaXN0ZW5lcigoKSA9PiB7XG4gICAgICB2b2lkIHJlc3RvcmVTY2hlZHVsZWRKb2JzKCk7XG4gIH0pO1xuXG4gIHZvaWQgcmVzdG9yZVNjaGVkdWxlZEpvYnMoKTtcblxuICBpZiAoY2hyb21lLmFsYXJtcykge1xuICAgICAgY2hyb21lLmFsYXJtcy5nZXQoXCJjaGVjay1pZGxlLXRhYnNcIiwgKGFsYXJtKSA9PiB7XG4gICAgICAgICAgaWYgKCFhbGFybSkgY2hyb21lLmFsYXJtcy5jcmVhdGUoXCJjaGVjay1pZGxlLXRhYnNcIiwgeyBwZXJpb2RJbk1pbnV0ZXM6IDEgfSk7XG4gICAgICB9KTtcblxuICAgICAgY2hyb21lLmFsYXJtcy5vbkFsYXJtLmFkZExpc3RlbmVyKGFzeW5jIChhbGFybSkgPT4ge1xuICAgICAgICAgIGlmIChhbGFybS5uYW1lLnN0YXJ0c1dpdGgoU0NIRURVTEVfRklSRV9BTEFSTV9QUkVGSVgpKSB7XG4gICAgICAgICAgICAgIGF3YWl0IHJ1blNjaGVkdWxlZEpvYihhbGFybS5uYW1lLnNsaWNlKFNDSEVEVUxFX0ZJUkVfQUxBUk1fUFJFRklYLmxlbmd0aCkpO1xuICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgaWYgKGFsYXJtLm5hbWUuc3RhcnRzV2l0aChTQ0hFRFVMRV9DTEVBTlVQX0FMQVJNX1BSRUZJWCkpIHtcbiAgICAgICAgICAgICAgYXdhaXQgY2xlYW51cFNjaGVkdWxlZEpvYihhbGFybS5uYW1lLnNsaWNlKFNDSEVEVUxFX0NMRUFOVVBfQUxBUk1fUFJFRklYLmxlbmd0aCkpO1xuICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgaWYgKGFsYXJtLm5hbWUgIT09IFwiY2hlY2staWRsZS10YWJzXCIpIHJldHVybjtcblxuICAgICAgICAgIGxldCB7IHN1c3BlbmRUaW1lb3V0LCB0YWJBY3Rpdml0eSB9ID0gYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KHtcbiAgICAgICAgICAgICAgc3VzcGVuZFRpbWVvdXQ6IDAsXG4gICAgICAgICAgICAgIHRhYkFjdGl2aXR5OiB7fVxuICAgICAgICAgIH0pO1xuICAgICAgICAgIGlmICghc3VzcGVuZFRpbWVvdXQgfHwgc3VzcGVuZFRpbWVvdXQgPD0gMCkgcmV0dXJuO1xuXG4gICAgICAgICAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcbiAgICAgICAgICBjb25zdCB0aW1lb3V0TXMgPSBzdXNwZW5kVGltZW91dCAqIDYwICogMTAwMDtcbiAgICAgICAgICBjb25zdCB0YWJzID0gYXdhaXQgY2hyb21lLnRhYnMucXVlcnkoe30pO1xuXG4gICAgICAgICAgZm9yIChjb25zdCB0YWIgb2YgdGFicykge1xuICAgICAgICAgICAgICBpZiAodGFiLmFjdGl2ZSB8fCB0YWIucGlubmVkIHx8IHRhYi5kaXNjYXJkZWQgfHwgIXRhYi51cmwgfHwgIXRhYi51cmwuc3RhcnRzV2l0aChcImh0dHBcIikpIGNvbnRpbnVlO1xuICAgICAgICAgICAgICBjb25zdCBsYXN0QWN0aXZlID0gdGFiQWN0aXZpdHlbdGFiLmlkXSB8fCAwO1xuICAgICAgICAgICAgICBpZiAobGFzdEFjdGl2ZSA+IDAgJiYgKG5vdyAtIGxhc3RBY3RpdmUpID4gdGltZW91dE1zKSB7XG4gICAgICAgICAgICAgICAgICB0cnkgeyBhd2FpdCBjaHJvbWUudGFicy5kaXNjYXJkKHRhYi5pZCk7IH0gY2F0Y2ggKGUpIHsvKiBpZ25vcmUgKi99XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICB9KTtcbiAgfVxuXG59KVxuIiwiLy8gI3JlZ2lvbiBzbmlwcGV0XG5leHBvcnQgY29uc3QgYnJvd3NlciA9IGdsb2JhbFRoaXMuYnJvd3Nlcj8ucnVudGltZT8uaWRcbiAgPyBnbG9iYWxUaGlzLmJyb3dzZXJcbiAgOiBnbG9iYWxUaGlzLmNocm9tZTtcbi8vICNlbmRyZWdpb24gc25pcHBldFxuIiwiaW1wb3J0IHsgYnJvd3NlciBhcyBicm93c2VyJDEgfSBmcm9tIFwiQHd4dC1kZXYvYnJvd3NlclwiO1xuLy8jcmVnaW9uIHNyYy9icm93c2VyLnRzXG4vKipcbiogQ29udGFpbnMgdGhlIGBicm93c2VyYCBleHBvcnQgd2hpY2ggeW91IHNob3VsZCB1c2UgdG8gYWNjZXNzIHRoZSBleHRlbnNpb25cbiogQVBJcyBpbiB5b3VyIHByb2plY3Q6XG4qXG4qIGBgYHRzXG4qIGltcG9ydCB7IGJyb3dzZXIgfSBmcm9tICd3eHQvYnJvd3Nlcic7XG4qXG4qIGJyb3dzZXIucnVudGltZS5vbkluc3RhbGxlZC5hZGRMaXN0ZW5lcigoKSA9PiB7XG4qICAgLy8gLi4uXG4qIH0pO1xuKiBgYGBcbipcbiogQG1vZHVsZSB3eHQvYnJvd3NlclxuKi9cbmNvbnN0IGJyb3dzZXIgPSBicm93c2VyJDE7XG4vLyNlbmRyZWdpb25cbmV4cG9ydCB7IGJyb3dzZXIgfTtcbiIsIi8vIHNyYy9pbmRleC50c1xudmFyIF9NYXRjaFBhdHRlcm4gPSBjbGFzcyB7XG4gIGNvbnN0cnVjdG9yKG1hdGNoUGF0dGVybikge1xuICAgIGlmIChtYXRjaFBhdHRlcm4gPT09IFwiPGFsbF91cmxzPlwiKSB7XG4gICAgICB0aGlzLmlzQWxsVXJscyA9IHRydWU7XG4gICAgICB0aGlzLnByb3RvY29sTWF0Y2hlcyA9IFsuLi5fTWF0Y2hQYXR0ZXJuLlBST1RPQ09MU107XG4gICAgICB0aGlzLmhvc3RuYW1lTWF0Y2ggPSBcIipcIjtcbiAgICAgIHRoaXMucGF0aG5hbWVNYXRjaCA9IFwiKlwiO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBncm91cHMgPSAvKC4qKTpcXC9cXC8oLio/KShcXC8uKikvLmV4ZWMobWF0Y2hQYXR0ZXJuKTtcbiAgICAgIGlmIChncm91cHMgPT0gbnVsbClcbiAgICAgICAgdGhyb3cgbmV3IEludmFsaWRNYXRjaFBhdHRlcm4obWF0Y2hQYXR0ZXJuLCBcIkluY29ycmVjdCBmb3JtYXRcIik7XG4gICAgICBjb25zdCBbXywgcHJvdG9jb2wsIGhvc3RuYW1lLCBwYXRobmFtZV0gPSBncm91cHM7XG4gICAgICB2YWxpZGF0ZVByb3RvY29sKG1hdGNoUGF0dGVybiwgcHJvdG9jb2wpO1xuICAgICAgdmFsaWRhdGVIb3N0bmFtZShtYXRjaFBhdHRlcm4sIGhvc3RuYW1lKTtcbiAgICAgIHZhbGlkYXRlUGF0aG5hbWUobWF0Y2hQYXR0ZXJuLCBwYXRobmFtZSk7XG4gICAgICB0aGlzLnByb3RvY29sTWF0Y2hlcyA9IHByb3RvY29sID09PSBcIipcIiA/IFtcImh0dHBcIiwgXCJodHRwc1wiXSA6IFtwcm90b2NvbF07XG4gICAgICB0aGlzLmhvc3RuYW1lTWF0Y2ggPSBob3N0bmFtZTtcbiAgICAgIHRoaXMucGF0aG5hbWVNYXRjaCA9IHBhdGhuYW1lO1xuICAgIH1cbiAgfVxuICBpbmNsdWRlcyh1cmwpIHtcbiAgICBpZiAodGhpcy5pc0FsbFVybHMpXG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICBjb25zdCB1ID0gdHlwZW9mIHVybCA9PT0gXCJzdHJpbmdcIiA/IG5ldyBVUkwodXJsKSA6IHVybCBpbnN0YW5jZW9mIExvY2F0aW9uID8gbmV3IFVSTCh1cmwuaHJlZikgOiB1cmw7XG4gICAgcmV0dXJuICEhdGhpcy5wcm90b2NvbE1hdGNoZXMuZmluZCgocHJvdG9jb2wpID0+IHtcbiAgICAgIGlmIChwcm90b2NvbCA9PT0gXCJodHRwXCIpXG4gICAgICAgIHJldHVybiB0aGlzLmlzSHR0cE1hdGNoKHUpO1xuICAgICAgaWYgKHByb3RvY29sID09PSBcImh0dHBzXCIpXG4gICAgICAgIHJldHVybiB0aGlzLmlzSHR0cHNNYXRjaCh1KTtcbiAgICAgIGlmIChwcm90b2NvbCA9PT0gXCJmaWxlXCIpXG4gICAgICAgIHJldHVybiB0aGlzLmlzRmlsZU1hdGNoKHUpO1xuICAgICAgaWYgKHByb3RvY29sID09PSBcImZ0cFwiKVxuICAgICAgICByZXR1cm4gdGhpcy5pc0Z0cE1hdGNoKHUpO1xuICAgICAgaWYgKHByb3RvY29sID09PSBcInVyblwiKVxuICAgICAgICByZXR1cm4gdGhpcy5pc1Vybk1hdGNoKHUpO1xuICAgIH0pO1xuICB9XG4gIGlzSHR0cE1hdGNoKHVybCkge1xuICAgIHJldHVybiB1cmwucHJvdG9jb2wgPT09IFwiaHR0cDpcIiAmJiB0aGlzLmlzSG9zdFBhdGhNYXRjaCh1cmwpO1xuICB9XG4gIGlzSHR0cHNNYXRjaCh1cmwpIHtcbiAgICByZXR1cm4gdXJsLnByb3RvY29sID09PSBcImh0dHBzOlwiICYmIHRoaXMuaXNIb3N0UGF0aE1hdGNoKHVybCk7XG4gIH1cbiAgaXNIb3N0UGF0aE1hdGNoKHVybCkge1xuICAgIGlmICghdGhpcy5ob3N0bmFtZU1hdGNoIHx8ICF0aGlzLnBhdGhuYW1lTWF0Y2gpXG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgY29uc3QgaG9zdG5hbWVNYXRjaFJlZ2V4cyA9IFtcbiAgICAgIHRoaXMuY29udmVydFBhdHRlcm5Ub1JlZ2V4KHRoaXMuaG9zdG5hbWVNYXRjaCksXG4gICAgICB0aGlzLmNvbnZlcnRQYXR0ZXJuVG9SZWdleCh0aGlzLmhvc3RuYW1lTWF0Y2gucmVwbGFjZSgvXlxcKlxcLi8sIFwiXCIpKVxuICAgIF07XG4gICAgY29uc3QgcGF0aG5hbWVNYXRjaFJlZ2V4ID0gdGhpcy5jb252ZXJ0UGF0dGVyblRvUmVnZXgodGhpcy5wYXRobmFtZU1hdGNoKTtcbiAgICByZXR1cm4gISFob3N0bmFtZU1hdGNoUmVnZXhzLmZpbmQoKHJlZ2V4KSA9PiByZWdleC50ZXN0KHVybC5ob3N0bmFtZSkpICYmIHBhdGhuYW1lTWF0Y2hSZWdleC50ZXN0KHVybC5wYXRobmFtZSk7XG4gIH1cbiAgaXNGaWxlTWF0Y2godXJsKSB7XG4gICAgdGhyb3cgRXJyb3IoXCJOb3QgaW1wbGVtZW50ZWQ6IGZpbGU6Ly8gcGF0dGVybiBtYXRjaGluZy4gT3BlbiBhIFBSIHRvIGFkZCBzdXBwb3J0XCIpO1xuICB9XG4gIGlzRnRwTWF0Y2godXJsKSB7XG4gICAgdGhyb3cgRXJyb3IoXCJOb3QgaW1wbGVtZW50ZWQ6IGZ0cDovLyBwYXR0ZXJuIG1hdGNoaW5nLiBPcGVuIGEgUFIgdG8gYWRkIHN1cHBvcnRcIik7XG4gIH1cbiAgaXNVcm5NYXRjaCh1cmwpIHtcbiAgICB0aHJvdyBFcnJvcihcIk5vdCBpbXBsZW1lbnRlZDogdXJuOi8vIHBhdHRlcm4gbWF0Y2hpbmcuIE9wZW4gYSBQUiB0byBhZGQgc3VwcG9ydFwiKTtcbiAgfVxuICBjb252ZXJ0UGF0dGVyblRvUmVnZXgocGF0dGVybikge1xuICAgIGNvbnN0IGVzY2FwZWQgPSB0aGlzLmVzY2FwZUZvclJlZ2V4KHBhdHRlcm4pO1xuICAgIGNvbnN0IHN0YXJzUmVwbGFjZWQgPSBlc2NhcGVkLnJlcGxhY2UoL1xcXFxcXCovZywgXCIuKlwiKTtcbiAgICByZXR1cm4gUmVnRXhwKGBeJHtzdGFyc1JlcGxhY2VkfSRgKTtcbiAgfVxuICBlc2NhcGVGb3JSZWdleChzdHJpbmcpIHtcbiAgICByZXR1cm4gc3RyaW5nLnJlcGxhY2UoL1suKis/XiR7fSgpfFtcXF1cXFxcXS9nLCBcIlxcXFwkJlwiKTtcbiAgfVxufTtcbnZhciBNYXRjaFBhdHRlcm4gPSBfTWF0Y2hQYXR0ZXJuO1xuTWF0Y2hQYXR0ZXJuLlBST1RPQ09MUyA9IFtcImh0dHBcIiwgXCJodHRwc1wiLCBcImZpbGVcIiwgXCJmdHBcIiwgXCJ1cm5cIl07XG52YXIgSW52YWxpZE1hdGNoUGF0dGVybiA9IGNsYXNzIGV4dGVuZHMgRXJyb3Ige1xuICBjb25zdHJ1Y3RvcihtYXRjaFBhdHRlcm4sIHJlYXNvbikge1xuICAgIHN1cGVyKGBJbnZhbGlkIG1hdGNoIHBhdHRlcm4gXCIke21hdGNoUGF0dGVybn1cIjogJHtyZWFzb259YCk7XG4gIH1cbn07XG5mdW5jdGlvbiB2YWxpZGF0ZVByb3RvY29sKG1hdGNoUGF0dGVybiwgcHJvdG9jb2wpIHtcbiAgaWYgKCFNYXRjaFBhdHRlcm4uUFJPVE9DT0xTLmluY2x1ZGVzKHByb3RvY29sKSAmJiBwcm90b2NvbCAhPT0gXCIqXCIpXG4gICAgdGhyb3cgbmV3IEludmFsaWRNYXRjaFBhdHRlcm4oXG4gICAgICBtYXRjaFBhdHRlcm4sXG4gICAgICBgJHtwcm90b2NvbH0gbm90IGEgdmFsaWQgcHJvdG9jb2wgKCR7TWF0Y2hQYXR0ZXJuLlBST1RPQ09MUy5qb2luKFwiLCBcIil9KWBcbiAgICApO1xufVxuZnVuY3Rpb24gdmFsaWRhdGVIb3N0bmFtZShtYXRjaFBhdHRlcm4sIGhvc3RuYW1lKSB7XG4gIGlmIChob3N0bmFtZS5pbmNsdWRlcyhcIjpcIikpXG4gICAgdGhyb3cgbmV3IEludmFsaWRNYXRjaFBhdHRlcm4obWF0Y2hQYXR0ZXJuLCBgSG9zdG5hbWUgY2Fubm90IGluY2x1ZGUgYSBwb3J0YCk7XG4gIGlmIChob3N0bmFtZS5pbmNsdWRlcyhcIipcIikgJiYgaG9zdG5hbWUubGVuZ3RoID4gMSAmJiAhaG9zdG5hbWUuc3RhcnRzV2l0aChcIiouXCIpKVxuICAgIHRocm93IG5ldyBJbnZhbGlkTWF0Y2hQYXR0ZXJuKFxuICAgICAgbWF0Y2hQYXR0ZXJuLFxuICAgICAgYElmIHVzaW5nIGEgd2lsZGNhcmQgKCopLCBpdCBtdXN0IGdvIGF0IHRoZSBzdGFydCBvZiB0aGUgaG9zdG5hbWVgXG4gICAgKTtcbn1cbmZ1bmN0aW9uIHZhbGlkYXRlUGF0aG5hbWUobWF0Y2hQYXR0ZXJuLCBwYXRobmFtZSkge1xuICByZXR1cm47XG59XG5leHBvcnQge1xuICBJbnZhbGlkTWF0Y2hQYXR0ZXJuLFxuICBNYXRjaFBhdHRlcm5cbn07XG4iXSwieF9nb29nbGVfaWdub3JlTGlzdCI6WzAsNSw2LDddLCJtYXBwaW5ncyI6Ijs7Q0FDQSxTQUFTLGlCQUFpQixLQUFLO0FBQzlCLE1BQUksT0FBTyxRQUFRLE9BQU8sUUFBUSxXQUFZLFFBQU8sRUFBRSxNQUFNLEtBQUs7QUFDbEUsU0FBTzs7OztDQ0hS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