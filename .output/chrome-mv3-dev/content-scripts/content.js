var content = (function() {
	//#region \0rolldown/runtime.js
	var __defProp = Object.defineProperty;
	var __esmMin = (fn, res) => () => (fn && (res = fn(fn = 0)), res);
	var __exportAll = (all, no_symbols) => {
		let target = {};
		for (var name in all) __defProp(target, name, {
			get: all[name],
			enumerable: true
		});
		if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
		return target;
	};
	//#endregion
	//#region node_modules/wxt/dist/utils/define-content-script.mjs
	function defineContentScript(definition) {
		return definition;
	}
	//#endregion
	//#region entrypoints/content/content-impl.ts
	var content_impl_exports = /* @__PURE__ */ __exportAll({});
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
	function findMatchingElements({ selector, text, matchExact }) {
		if (!selector && !text) return { error: "Please provide at least one locator: selector or text" };
		let elements;
		try {
			elements = selector ? Array.from(document.querySelectorAll(selector)) : Array.from(document.querySelectorAll("body *"));
		} catch (e) {
			return { error: `Invalid selector: ${e.message}` };
		}
		if (!text) return { elements };
		const search = String(text).trim().toLowerCase();
		return { elements: elements.filter((element) => {
			const candidate = getSearchableText(element);
			return matchExact ? candidate === search : candidate.includes(search);
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
		if (highlightTimerId) {
			clearTimeout(highlightTimerId);
			highlightTimerId = null;
		}
		document.getElementById(HIGHLIGHT_OVERLAY_ID)?.remove();
	}
	function ensureReusePromptStyles() {
		if (document.getElementById(REUSE_PROMPT_STYLE_ID)) return;
		const style = document.createElement("style");
		style.id = REUSE_PROMPT_STYLE_ID;
		style.textContent = `
    #${REUSE_PROMPT_ID} {
      position: fixed;
      top: 20px;
      right: 20px;
      width: min(380px, calc(100vw - 24px));
      z-index: 2147483647;
      background: #fffdf5;
      border: 2px solid #111827;
      border-radius: 14px;
      box-shadow: 8px 8px 0 rgba(17, 24, 39, 0.16);
      color: #111827;
      font-family: ui-sans-serif, system-ui, sans-serif;
      overflow: hidden;
    }
    #${REUSE_PROMPT_ID} * {
      box-sizing: border-box;
    }
    #${REUSE_PROMPT_ID} .tm-reuse-header {
      padding: 14px 16px 10px;
      background: linear-gradient(135deg, #fde68a 0%, #fef3c7 100%);
      border-bottom: 1px solid #f59e0b;
      font-weight: 700;
      font-size: 14px;
    }
    #${REUSE_PROMPT_ID} .tm-reuse-body {
      padding: 14px 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      font-size: 13px;
      line-height: 1.5;
    }
    #${REUSE_PROMPT_ID} .tm-reuse-card {
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid #e5e7eb;
      background: #ffffff;
    }
    #${REUSE_PROMPT_ID} .tm-reuse-label {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.04em;
      color: #92400e;
      text-transform: uppercase;
      margin-bottom: 4px;
    }
    #${REUSE_PROMPT_ID} .tm-reuse-title {
      font-weight: 600;
      word-break: break-word;
    }
    #${REUSE_PROMPT_ID} .tm-reuse-url {
      margin-top: 4px;
      color: #6b7280;
      word-break: break-all;
      font-size: 12px;
    }
    #${REUSE_PROMPT_ID} .tm-reuse-domain {
      display: inline-flex;
      align-items: center;
      width: fit-content;
      padding: 4px 8px;
      border-radius: 999px;
      background: #fffbeb;
      border: 1px solid #fcd34d;
      font-size: 12px;
      color: #92400e;
      font-weight: 600;
    }
    #${REUSE_PROMPT_ID} .tm-reuse-remember {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: #374151;
      margin-top: 2px;
    }
    #${REUSE_PROMPT_ID} .tm-reuse-actions {
      display: flex;
      gap: 10px;
      margin-top: 4px;
    }
    #${REUSE_PROMPT_ID} button {
      appearance: none;
      border: 1px solid #111827;
      border-radius: 10px;
      padding: 10px 12px;
      min-height: 40px;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      transition: transform 0.12s ease, box-shadow 0.12s ease, background 0.12s ease;
    }
    #${REUSE_PROMPT_ID} button:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 0 rgba(17, 24, 39, 0.12);
    }
    #${REUSE_PROMPT_ID} .tm-reuse-btn-primary {
      flex: 1;
      background: #f59e0b;
      color: #111827;
    }
    #${REUSE_PROMPT_ID} .tm-reuse-btn-secondary {
      flex: 1;
      background: #ffffff;
      color: #111827;
    }
  `;
		document.documentElement.appendChild(style);
	}
	function removeReusePrompt() {
		document.getElementById(REUSE_PROMPT_ID)?.remove();
	}
	function createReusePromptRow(label, title, url) {
		const card = document.createElement("div");
		card.className = "tm-reuse-card";
		const labelEl = document.createElement("div");
		labelEl.className = "tm-reuse-label";
		labelEl.textContent = label;
		const titleEl = document.createElement("div");
		titleEl.className = "tm-reuse-title";
		titleEl.textContent = truncateText(title || url || "", 200);
		const urlEl = document.createElement("div");
		urlEl.className = "tm-reuse-url";
		urlEl.textContent = truncateText(url || "", 500);
		card.append(labelEl, titleEl, urlEl);
		return card;
	}
	function handleShowTabReusePrompt(msg, sendResponse) {
		ensureReusePromptStyles();
		removeReusePrompt();
		const overlay = document.createElement("div");
		overlay.id = REUSE_PROMPT_ID;
		const header = document.createElement("div");
		header.className = "tm-reuse-header";
		header.textContent = "检测到已打开的相同页面";
		const body = document.createElement("div");
		body.className = "tm-reuse-body";
		const description = document.createElement("div");
		description.textContent = "要复用这个历史 Tab 吗？如果不复用，我们会切回刚打开的新页面。";
		const domain = document.createElement("div");
		domain.className = "tm-reuse-domain";
		domain.textContent = `域名：${msg.domainKey || "未知"}`;
		const existingRow = createReusePromptRow("已存在的页面", msg.existingTitle, msg.existingUrl);
		const newRow = createReusePromptRow("刚打开的新页面", msg.newTitle, msg.newUrl);
		const rememberLabel = document.createElement("label");
		rememberLabel.className = "tm-reuse-remember";
		const rememberCheckbox = document.createElement("input");
		rememberCheckbox.type = "checkbox";
		const rememberText = document.createElement("span");
		rememberText.textContent = "记住当前域名的选择";
		rememberLabel.append(rememberCheckbox, rememberText);
		const actions = document.createElement("div");
		actions.className = "tm-reuse-actions";
		const reuseButton = document.createElement("button");
		reuseButton.type = "button";
		reuseButton.className = "tm-reuse-btn-primary";
		reuseButton.textContent = "复用历史 Tab";
		const keepButton = document.createElement("button");
		keepButton.type = "button";
		keepButton.className = "tm-reuse-btn-secondary";
		keepButton.textContent = "不复用";
		const submitDecision = (decision) => {
			chrome.runtime.sendMessage({
				type: "tab_reuse_prompt_decision",
				decision,
				rememberChoice: rememberCheckbox.checked,
				newTabId: msg.newTabId,
				existingTabId: msg.existingTabId,
				domainKey: msg.domainKey || ""
			}, () => {
				removeReusePrompt();
			});
		};
		reuseButton.addEventListener("click", () => submitDecision("reuse"));
		keepButton.addEventListener("click", () => submitDecision("keep"));
		actions.append(reuseButton, keepButton);
		body.append(description, domain, existingRow, newRow, rememberLabel, actions);
		overlay.append(header, body);
		document.documentElement.appendChild(overlay);
		sendResponse({ success: true });
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
		highlightTimerId = window.setTimeout(() => {
			overlay.remove();
			highlightTimerId = null;
		}, durationMs);
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
	function handleDomQuery(msg) {
		const maxResults = Math.min(20, Math.max(1, Number.isInteger(msg.maxResults) ? msg.maxResults : 5));
		const { elements, error } = findMatchingElements(msg);
		if (error) return { error };
		return {
			success: true,
			selector: msg.selector || null,
			text: msg.text || null,
			count: elements.length,
			truncated: elements.length > maxResults,
			matches: elements.slice(0, maxResults).map((element, index) => serializeElement(element, index))
		};
	}
	function handleDomClick(msg) {
		const resolved = resolveElement(msg);
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
		element.click();
		return {
			success: true,
			action: "click",
			totalMatches: resolved.totalMatches,
			target: serializeElement(element, resolved.index)
		};
	}
	function handleDomSetValue(msg) {
		const resolved = resolveElement(msg);
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
		setFormElementValue(element, msg.value);
		return {
			success: true,
			action: "set_value",
			totalMatches: resolved.totalMatches,
			value: truncateText(element.value || "", 500),
			target: serializeElement(element, resolved.index)
		};
	}
	function handleDomStyle(msg) {
		const resolved = resolveElement(msg);
		if (resolved.error) return { error: resolved.error };
		if (!msg.styles || typeof msg.styles !== "object" || Array.isArray(msg.styles)) return { error: "Please provide a styles object" };
		const durationMs = Math.min(1e4, Math.max(0, Number.isFinite(msg.durationMs) ? msg.durationMs : 2e3));
		const element = resolved.element;
		const previous = {};
		element.scrollIntoView({
			block: "center",
			inline: "nearest",
			behavior: "smooth"
		});
		for (const [key, value] of Object.entries(msg.styles)) {
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
			styles: msg.styles,
			target: serializeElement(element, resolved.index)
		};
	}
	function handleDomGetHtml(msg) {
		const resolved = resolveElement(msg);
		if (resolved.error) return { error: resolved.error };
		const mode = msg.mode === "inner" ? "inner" : "outer";
		const maxLength = Math.min(2e4, Math.max(200, Number.isInteger(msg.maxLength) ? msg.maxLength : HTML_LIMIT));
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
	function handleDomHighlight(msg, sendResponse) {
		const resolved = resolveElement(msg);
		if (resolved.error) {
			sendResponse({ error: resolved.error });
			return;
		}
		const durationMs = Math.min(5e3, Math.max(300, Number.isFinite(msg.durationMs) ? msg.durationMs : 1e3));
		const element = resolved.element;
		element.scrollIntoView({
			block: "center",
			inline: "nearest",
			behavior: "smooth"
		});
		window.setTimeout(() => {
			showHighlightOverlay(element, durationMs);
			sendResponse({
				success: true,
				action: "highlight",
				durationMs,
				target: serializeElement(element, resolved.index),
				scroll: getScrollState()
			});
		}, 350);
	}
	var TEXT_LIMIT, HTML_LIMIT, HIGHLIGHT_STYLE_ID, HIGHLIGHT_OVERLAY_ID, REUSE_PROMPT_STYLE_ID, REUSE_PROMPT_ID, highlightTimerId;
	var init_content_impl = __esmMin((() => {
		TEXT_LIMIT = 500;
		HTML_LIMIT = 4e3;
		HIGHLIGHT_STYLE_ID = "__tab_manager_highlight_style__";
		HIGHLIGHT_OVERLAY_ID = "__tab_manager_highlight_overlay__";
		REUSE_PROMPT_STYLE_ID = "__tab_manager_reuse_prompt_style__";
		REUSE_PROMPT_ID = "__tab_manager_reuse_prompt__";
		highlightTimerId = null;
		/**
		* Content script injected into all http/https pages.
		* Responds to messages for page extraction, scrolling, and structured DOM actions.
		*/
		chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
			if (msg.type === "tab_extract_content") {
				sendResponse({
					url: document.URL,
					title: document.title,
					content: document.body.innerText.substring(0, 8e3)
				});
				return false;
			}
			if (msg.type === "tab_scroll") {
				const stateBefore = getScrollState();
				const behavior = msg.behavior === "smooth" ? "smooth" : "auto";
				const position = typeof msg.position === "string" ? msg.position : null;
				let top = null;
				if (position === "top") top = 0;
				else if (position === "bottom") top = stateBefore.maxScrollY;
				else if (typeof msg.deltaY === "number" && Number.isFinite(msg.deltaY)) top = stateBefore.scrollY + msg.deltaY;
				else if (typeof msg.pageFraction === "number" && Number.isFinite(msg.pageFraction)) top = stateBefore.scrollY + stateBefore.viewportHeight * msg.pageFraction;
				else top = stateBefore.scrollY + stateBefore.viewportHeight * .8;
				top = Math.max(0, Math.min(stateBefore.maxScrollY, top));
				window.scrollTo({
					top,
					behavior
				});
				const delay = behavior === "smooth" ? 400 : 60;
				window.setTimeout(() => {
					const stateAfter = getScrollState();
					sendResponse({
						success: true,
						action: position || "delta",
						requestedTop: top,
						moved: Math.abs(stateAfter.scrollY - stateBefore.scrollY) > 1,
						before: stateBefore,
						after: stateAfter
					});
				}, delay);
				return true;
			}
			if (msg.type === "dom_query") {
				sendResponse(handleDomQuery(msg));
				return false;
			}
			if (msg.type === "dom_click") {
				sendResponse(handleDomClick(msg));
				return false;
			}
			if (msg.type === "dom_set_value") {
				sendResponse(handleDomSetValue(msg));
				return false;
			}
			if (msg.type === "dom_style") {
				sendResponse(handleDomStyle(msg));
				return false;
			}
			if (msg.type === "dom_get_html") {
				sendResponse(handleDomGetHtml(msg));
				return false;
			}
			if (msg.type === "dom_highlight") {
				handleDomHighlight(msg, sendResponse);
				return true;
			}
			if (msg.type === "show_tab_reuse_prompt") {
				handleShowTabReusePrompt(msg, sendResponse);
				return false;
			}
			return false;
		});
	}));
	//#endregion
	//#region entrypoints/content/index.ts
	var content_default = defineContentScript({
		matches: ["http://*/*", "https://*/*"],
		runAt: "document_idle",
		async main() {
			await Promise.resolve().then(() => (init_content_impl(), content_impl_exports));
		}
	});
	//#endregion
	//#region node_modules/wxt/dist/utils/internal/logger.mjs
	function print$1(method, ...args) {
		if (typeof args[0] === "string") method(`[wxt] ${args.shift()}`, ...args);
		else method("[wxt]", ...args);
	}
	/** Wrapper around `console` with a "[wxt]" prefix */
	var logger$1 = {
		debug: (...args) => print$1(console.debug, ...args),
		log: (...args) => print$1(console.log, ...args),
		warn: (...args) => print$1(console.warn, ...args),
		error: (...args) => print$1(console.error, ...args)
	};
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
	//#region node_modules/wxt/dist/utils/internal/custom-events.mjs
	var WxtLocationChangeEvent = class WxtLocationChangeEvent extends Event {
		static EVENT_NAME = getUniqueEventName("wxt:locationchange");
		constructor(newUrl, oldUrl) {
			super(WxtLocationChangeEvent.EVENT_NAME, {});
			this.newUrl = newUrl;
			this.oldUrl = oldUrl;
		}
	};
	/**
	* Returns an event name unique to the extension and content script that's
	* running.
	*/
	function getUniqueEventName(eventName) {
		return `${browser?.runtime?.id}:content:${eventName}`;
	}
	//#endregion
	//#region node_modules/wxt/dist/utils/internal/location-watcher.mjs
	var supportsNavigationApi = typeof globalThis.navigation?.addEventListener === "function";
	/**
	* Create a util that watches for URL changes, dispatching the custom event when
	* detected. Stops watching when content script is invalidated. Uses Navigation
	* API when available, otherwise falls back to polling.
	*/
	function createLocationWatcher(ctx) {
		let lastUrl;
		let watching = false;
		return { run() {
			if (watching) return;
			watching = true;
			lastUrl = new URL(location.href);
			if (supportsNavigationApi) globalThis.navigation.addEventListener("navigate", (event) => {
				const newUrl = new URL(event.destination.url);
				if (newUrl.href === lastUrl.href) return;
				window.dispatchEvent(new WxtLocationChangeEvent(newUrl, lastUrl));
				lastUrl = newUrl;
			}, { signal: ctx.signal });
			else ctx.setInterval(() => {
				const newUrl = new URL(location.href);
				if (newUrl.href !== lastUrl.href) {
					window.dispatchEvent(new WxtLocationChangeEvent(newUrl, lastUrl));
					lastUrl = newUrl;
				}
			}, 1e3);
		} };
	}
	//#endregion
	//#region node_modules/wxt/dist/utils/content-script-context.mjs
	/**
	* Implements
	* [`AbortController`](https://developer.mozilla.org/en-US/docs/Web/API/AbortController).
	* Used to detect and stop content script code when the script is invalidated.
	*
	* It also provides several utilities like `ctx.setTimeout` and
	* `ctx.setInterval` that should be used in content scripts instead of
	* `window.setTimeout` or `window.setInterval`.
	*
	* To create context for testing, you can use the class's constructor:
	*
	* ```ts
	* import { ContentScriptContext } from 'wxt/utils/content-scripts-context';
	*
	* test('storage listener should be removed when context is invalidated', () => {
	*   const ctx = new ContentScriptContext('test');
	*   const item = storage.defineItem('local:count', { defaultValue: 0 });
	*   const watcher = vi.fn();
	*
	*   const unwatch = item.watch(watcher);
	*   ctx.onInvalidated(unwatch); // Listen for invalidate here
	*
	*   await item.setValue(1);
	*   expect(watcher).toBeCalledTimes(1);
	*   expect(watcher).toBeCalledWith(1, 0);
	*
	*   ctx.notifyInvalidated(); // Use this function to invalidate the context
	*   await item.setValue(2);
	*   expect(watcher).toBeCalledTimes(1);
	* });
	* ```
	*/
	var ContentScriptContext = class ContentScriptContext {
		static SCRIPT_STARTED_MESSAGE_TYPE = getUniqueEventName("wxt:content-script-started");
		id;
		abortController;
		locationWatcher = createLocationWatcher(this);
		constructor(contentScriptName, options) {
			this.contentScriptName = contentScriptName;
			this.options = options;
			this.id = Math.random().toString(36).slice(2);
			this.abortController = new AbortController();
			this.stopOldScripts();
			this.listenForNewerScripts();
		}
		get signal() {
			return this.abortController.signal;
		}
		abort(reason) {
			return this.abortController.abort(reason);
		}
		get isInvalid() {
			if (browser.runtime?.id == null) this.notifyInvalidated();
			return this.signal.aborted;
		}
		get isValid() {
			return !this.isInvalid;
		}
		/**
		* Add a listener that is called when the content script's context is
		* invalidated.
		*
		* @example
		*   browser.runtime.onMessage.addListener(cb);
		*   const removeInvalidatedListener = ctx.onInvalidated(() => {
		*     browser.runtime.onMessage.removeListener(cb);
		*   });
		*   // ...
		*   removeInvalidatedListener();
		*
		* @returns A function to remove the listener.
		*/
		onInvalidated(cb) {
			this.signal.addEventListener("abort", cb);
			return () => this.signal.removeEventListener("abort", cb);
		}
		/**
		* Return a promise that never resolves. Useful if you have an async function
		* that shouldn't run after the context is expired.
		*
		* @example
		*   const getValueFromStorage = async () => {
		*     if (ctx.isInvalid) return ctx.block();
		*
		*     // ...
		*   };
		*/
		block() {
			return new Promise(() => {});
		}
		/**
		* Wrapper around `window.setInterval` that automatically clears the interval
		* when invalidated.
		*
		* Intervals can be cleared by calling the normal `clearInterval` function.
		*/
		setInterval(handler, timeout) {
			const id = setInterval(() => {
				if (this.isValid) handler();
			}, timeout);
			this.onInvalidated(() => clearInterval(id));
			return id;
		}
		/**
		* Wrapper around `window.setTimeout` that automatically clears the interval
		* when invalidated.
		*
		* Timeouts can be cleared by calling the normal `setTimeout` function.
		*/
		setTimeout(handler, timeout) {
			const id = setTimeout(() => {
				if (this.isValid) handler();
			}, timeout);
			this.onInvalidated(() => clearTimeout(id));
			return id;
		}
		/**
		* Wrapper around `window.requestAnimationFrame` that automatically cancels
		* the request when invalidated.
		*
		* Callbacks can be canceled by calling the normal `cancelAnimationFrame`
		* function.
		*/
		requestAnimationFrame(callback) {
			const id = requestAnimationFrame((...args) => {
				if (this.isValid) callback(...args);
			});
			this.onInvalidated(() => cancelAnimationFrame(id));
			return id;
		}
		/**
		* Wrapper around `window.requestIdleCallback` that automatically cancels the
		* request when invalidated.
		*
		* Callbacks can be canceled by calling the normal `cancelIdleCallback`
		* function.
		*/
		requestIdleCallback(callback, options) {
			const id = requestIdleCallback((...args) => {
				if (!this.signal.aborted) callback(...args);
			}, options);
			this.onInvalidated(() => cancelIdleCallback(id));
			return id;
		}
		addEventListener(target, type, handler, options) {
			if (type === "wxt:locationchange") {
				if (this.isValid) this.locationWatcher.run();
			}
			target.addEventListener?.(type.startsWith("wxt:") ? getUniqueEventName(type) : type, handler, {
				...options,
				signal: this.signal
			});
		}
		/**
		* @internal
		* Abort the abort controller and execute all `onInvalidated` listeners.
		*/
		notifyInvalidated() {
			this.abort("Content script context invalidated");
			logger$1.debug(`Content script "${this.contentScriptName}" context invalidated`);
		}
		stopOldScripts() {
			document.dispatchEvent(new CustomEvent(ContentScriptContext.SCRIPT_STARTED_MESSAGE_TYPE, { detail: {
				contentScriptName: this.contentScriptName,
				messageId: this.id
			} }));
			window.postMessage({
				type: ContentScriptContext.SCRIPT_STARTED_MESSAGE_TYPE,
				contentScriptName: this.contentScriptName,
				messageId: this.id
			}, "*");
		}
		verifyScriptStartedEvent(event) {
			const isSameContentScript = event.detail?.contentScriptName === this.contentScriptName;
			const isFromSelf = event.detail?.messageId === this.id;
			return isSameContentScript && !isFromSelf;
		}
		listenForNewerScripts() {
			const cb = (event) => {
				if (!(event instanceof CustomEvent) || !this.verifyScriptStartedEvent(event)) return;
				this.notifyInvalidated();
			};
			document.addEventListener(ContentScriptContext.SCRIPT_STARTED_MESSAGE_TYPE, cb);
			this.onInvalidated(() => document.removeEventListener(ContentScriptContext.SCRIPT_STARTED_MESSAGE_TYPE, cb));
		}
	};
	//#endregion
	//#region \0virtual:wxt-content-script-isolated-world-entrypoint?/home/0668001277/Projects/github/browser-manager/entrypoints/content/index.ts
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
	//#endregion
	return (async () => {
		try {
			const { main, ...options } = content_default;
			return await main(new ContentScriptContext("content", options));
		} catch (err) {
			logger.error(`The content script "content" crashed on startup!`, err);
			throw err;
		}
	})();
})();

content;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY29udGVudC5qcyIsIm5hbWVzIjpbInByaW50IiwibG9nZ2VyIiwiYnJvd3NlciJdLCJzb3VyY2VzIjpbIi4uLy4uLy4uL25vZGVfbW9kdWxlcy93eHQvZGlzdC91dGlscy9kZWZpbmUtY29udGVudC1zY3JpcHQubWpzIiwiLi4vLi4vLi4vZW50cnlwb2ludHMvY29udGVudC9jb250ZW50LWltcGwudHMiLCIuLi8uLi8uLi9lbnRyeXBvaW50cy9jb250ZW50L2luZGV4LnRzIiwiLi4vLi4vLi4vbm9kZV9tb2R1bGVzL3d4dC9kaXN0L3V0aWxzL2ludGVybmFsL2xvZ2dlci5tanMiLCIuLi8uLi8uLi9ub2RlX21vZHVsZXMvQHd4dC1kZXYvYnJvd3Nlci9zcmMvaW5kZXgubWpzIiwiLi4vLi4vLi4vbm9kZV9tb2R1bGVzL3d4dC9kaXN0L2Jyb3dzZXIubWpzIiwiLi4vLi4vLi4vbm9kZV9tb2R1bGVzL3d4dC9kaXN0L3V0aWxzL2ludGVybmFsL2N1c3RvbS1ldmVudHMubWpzIiwiLi4vLi4vLi4vbm9kZV9tb2R1bGVzL3d4dC9kaXN0L3V0aWxzL2ludGVybmFsL2xvY2F0aW9uLXdhdGNoZXIubWpzIiwiLi4vLi4vLi4vbm9kZV9tb2R1bGVzL3d4dC9kaXN0L3V0aWxzL2NvbnRlbnQtc2NyaXB0LWNvbnRleHQubWpzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vI3JlZ2lvbiBzcmMvdXRpbHMvZGVmaW5lLWNvbnRlbnQtc2NyaXB0LnRzXG5mdW5jdGlvbiBkZWZpbmVDb250ZW50U2NyaXB0KGRlZmluaXRpb24pIHtcblx0cmV0dXJuIGRlZmluaXRpb247XG59XG4vLyNlbmRyZWdpb25cbmV4cG9ydCB7IGRlZmluZUNvbnRlbnRTY3JpcHQgfTtcbiIsIi8qIGdsb2JhbCBjaHJvbWUgKi9cblxuY29uc3QgVEVYVF9MSU1JVCA9IDUwMDtcbmNvbnN0IEhUTUxfTElNSVQgPSA0MDAwO1xuY29uc3QgSElHSExJR0hUX1NUWUxFX0lEID0gXCJfX3RhYl9tYW5hZ2VyX2hpZ2hsaWdodF9zdHlsZV9fXCI7XG5jb25zdCBISUdITElHSFRfT1ZFUkxBWV9JRCA9IFwiX190YWJfbWFuYWdlcl9oaWdobGlnaHRfb3ZlcmxheV9fXCI7XG5jb25zdCBSRVVTRV9QUk9NUFRfU1RZTEVfSUQgPSBcIl9fdGFiX21hbmFnZXJfcmV1c2VfcHJvbXB0X3N0eWxlX19cIjtcbmNvbnN0IFJFVVNFX1BST01QVF9JRCA9IFwiX190YWJfbWFuYWdlcl9yZXVzZV9wcm9tcHRfX1wiO1xubGV0IGhpZ2hsaWdodFRpbWVySWQgPSBudWxsO1xuXG5mdW5jdGlvbiB0cnVuY2F0ZVRleHQodGV4dCwgbWF4TGVuZ3RoID0gVEVYVF9MSU1JVCkge1xuICBjb25zdCBub3JtYWxpemVkID0gU3RyaW5nKHRleHQgfHwgXCJcIikucmVwbGFjZSgvXFxzKy9nLCBcIiBcIikudHJpbSgpO1xuICByZXR1cm4gbm9ybWFsaXplZC5sZW5ndGggPiBtYXhMZW5ndGggPyBub3JtYWxpemVkLnNsaWNlKDAsIG1heExlbmd0aCkgKyBcIi4uLlwiIDogbm9ybWFsaXplZDtcbn1cblxuZnVuY3Rpb24gZ2V0U2Nyb2xsU3RhdGUoKSB7XG4gIGNvbnN0IHNjcm9sbGVyID0gZG9jdW1lbnQuc2Nyb2xsaW5nRWxlbWVudCB8fCBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQgfHwgZG9jdW1lbnQuYm9keTtcbiAgY29uc3Qgdmlld3BvcnRIZWlnaHQgPSB3aW5kb3cuaW5uZXJIZWlnaHQgfHwgZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LmNsaWVudEhlaWdodCB8fCAwO1xuICBjb25zdCB2aWV3cG9ydFdpZHRoID0gd2luZG93LmlubmVyV2lkdGggfHwgZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LmNsaWVudFdpZHRoIHx8IDA7XG4gIGNvbnN0IGRvY3VtZW50SGVpZ2h0ID0gTWF0aC5tYXgoXG4gICAgc2Nyb2xsZXI/LnNjcm9sbEhlaWdodCB8fCAwLFxuICAgIGRvY3VtZW50LmRvY3VtZW50RWxlbWVudD8uc2Nyb2xsSGVpZ2h0IHx8IDAsXG4gICAgZG9jdW1lbnQuYm9keT8uc2Nyb2xsSGVpZ2h0IHx8IDBcbiAgKTtcbiAgY29uc3QgZG9jdW1lbnRXaWR0aCA9IE1hdGgubWF4KFxuICAgIHNjcm9sbGVyPy5zY3JvbGxXaWR0aCB8fCAwLFxuICAgIGRvY3VtZW50LmRvY3VtZW50RWxlbWVudD8uc2Nyb2xsV2lkdGggfHwgMCxcbiAgICBkb2N1bWVudC5ib2R5Py5zY3JvbGxXaWR0aCB8fCAwXG4gICk7XG4gIGNvbnN0IHNjcm9sbFkgPSB3aW5kb3cuc2Nyb2xsWSB8fCBzY3JvbGxlcj8uc2Nyb2xsVG9wIHx8IDA7XG4gIGNvbnN0IHNjcm9sbFggPSB3aW5kb3cuc2Nyb2xsWCB8fCBzY3JvbGxlcj8uc2Nyb2xsTGVmdCB8fCAwO1xuICBjb25zdCBtYXhTY3JvbGxZID0gTWF0aC5tYXgoMCwgZG9jdW1lbnRIZWlnaHQgLSB2aWV3cG9ydEhlaWdodCk7XG4gIGNvbnN0IG1heFNjcm9sbFggPSBNYXRoLm1heCgwLCBkb2N1bWVudFdpZHRoIC0gdmlld3BvcnRXaWR0aCk7XG5cbiAgcmV0dXJuIHtcbiAgICB1cmw6IGRvY3VtZW50LlVSTCxcbiAgICB0aXRsZTogZG9jdW1lbnQudGl0bGUsXG4gICAgc2Nyb2xsWCxcbiAgICBzY3JvbGxZLFxuICAgIG1heFNjcm9sbFgsXG4gICAgbWF4U2Nyb2xsWSxcbiAgICB2aWV3cG9ydFdpZHRoLFxuICAgIHZpZXdwb3J0SGVpZ2h0LFxuICAgIGRvY3VtZW50V2lkdGgsXG4gICAgZG9jdW1lbnRIZWlnaHQsXG4gICAgYXRUb3A6IHNjcm9sbFkgPD0gMCxcbiAgICBhdEJvdHRvbTogc2Nyb2xsWSA+PSBtYXhTY3JvbGxZLFxuICAgIGF0TGVmdDogc2Nyb2xsWCA8PSAwLFxuICAgIGF0UmlnaHQ6IHNjcm9sbFggPj0gbWF4U2Nyb2xsWFxuICB9O1xufVxuXG5mdW5jdGlvbiBnZXRTZWFyY2hhYmxlVGV4dChlbGVtZW50KSB7XG4gIHJldHVybiB0cnVuY2F0ZVRleHQoW1xuICAgIGVsZW1lbnQuaW5uZXJUZXh0LFxuICAgIGVsZW1lbnQudGV4dENvbnRlbnQsXG4gICAgZWxlbWVudC5nZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIpLFxuICAgIGVsZW1lbnQuZ2V0QXR0cmlidXRlKFwidGl0bGVcIiksXG4gICAgZWxlbWVudC5nZXRBdHRyaWJ1dGUoXCJwbGFjZWhvbGRlclwiKSxcbiAgICBlbGVtZW50LmdldEF0dHJpYnV0ZShcImFsdFwiKSxcbiAgICBlbGVtZW50LmdldEF0dHJpYnV0ZShcInZhbHVlXCIpXG4gIF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oXCIgXCIpLCAyMDAwKS50b0xvd2VyQ2FzZSgpO1xufVxuXG5mdW5jdGlvbiBpc0VsZW1lbnRWaXNpYmxlKGVsZW1lbnQpIHtcbiAgY29uc3QgcmVjdCA9IGVsZW1lbnQuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG4gIGNvbnN0IHN0eWxlID0gd2luZG93LmdldENvbXB1dGVkU3R5bGUoZWxlbWVudCk7XG4gIGlmIChzdHlsZS5kaXNwbGF5ID09PSBcIm5vbmVcIiB8fCBzdHlsZS52aXNpYmlsaXR5ID09PSBcImhpZGRlblwiIHx8IE51bWJlcihzdHlsZS5vcGFjaXR5KSA9PT0gMCkge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICByZXR1cm4gcmVjdC53aWR0aCA+IDAgJiYgcmVjdC5oZWlnaHQgPiAwO1xufVxuXG5mdW5jdGlvbiBpc0VsZW1lbnRDbGlja2FibGUoZWxlbWVudCkge1xuICByZXR1cm4gQm9vbGVhbihcbiAgICBlbGVtZW50Lm1hdGNoZXMoXCJhLCBidXR0b24sIGlucHV0LCBzZWxlY3QsIHRleHRhcmVhLCBzdW1tYXJ5LCBvcHRpb24sIGxhYmVsXCIpIHx8XG4gICAgZWxlbWVudC5nZXRBdHRyaWJ1dGUoXCJyb2xlXCIpID09PSBcImJ1dHRvblwiIHx8XG4gICAgdHlwZW9mIGVsZW1lbnQub25jbGljayA9PT0gXCJmdW5jdGlvblwiXG4gICk7XG59XG5cbmZ1bmN0aW9uIHNlcmlhbGl6ZUF0dHJpYnV0ZXMoZWxlbWVudCkge1xuICBjb25zdCBpbXBvcnRhbnROYW1lcyA9IFtcbiAgICBcImlkXCIsXG4gICAgXCJjbGFzc1wiLFxuICAgIFwibmFtZVwiLFxuICAgIFwidHlwZVwiLFxuICAgIFwicm9sZVwiLFxuICAgIFwiaHJlZlwiLFxuICAgIFwic3JjXCIsXG4gICAgXCJwbGFjZWhvbGRlclwiLFxuICAgIFwiYXJpYS1sYWJlbFwiLFxuICAgIFwiZm9yXCIsXG4gICAgXCJ2YWx1ZVwiXG4gIF07XG4gIGNvbnN0IGF0dHJpYnV0ZXMgPSB7fTtcblxuICBmb3IgKGNvbnN0IG5hbWUgb2YgaW1wb3J0YW50TmFtZXMpIHtcbiAgICBjb25zdCB2YWx1ZSA9IGVsZW1lbnQuZ2V0QXR0cmlidXRlKG5hbWUpO1xuICAgIGlmICh2YWx1ZSAhPSBudWxsICYmIHZhbHVlICE9PSBcIlwiKSB7XG4gICAgICBhdHRyaWJ1dGVzW25hbWVdID0gdHJ1bmNhdGVUZXh0KHZhbHVlLCAzMDApO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiBhdHRyaWJ1dGVzO1xufVxuXG5mdW5jdGlvbiBzZXJpYWxpemVSZWN0KGVsZW1lbnQpIHtcbiAgY29uc3QgcmVjdCA9IGVsZW1lbnQuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG4gIHJldHVybiB7XG4gICAgeDogTWF0aC5yb3VuZChyZWN0LngpLFxuICAgIHk6IE1hdGgucm91bmQocmVjdC55KSxcbiAgICB3aWR0aDogTWF0aC5yb3VuZChyZWN0LndpZHRoKSxcbiAgICBoZWlnaHQ6IE1hdGgucm91bmQocmVjdC5oZWlnaHQpLFxuICAgIHRvcDogTWF0aC5yb3VuZChyZWN0LnRvcCksXG4gICAgbGVmdDogTWF0aC5yb3VuZChyZWN0LmxlZnQpLFxuICAgIHJpZ2h0OiBNYXRoLnJvdW5kKHJlY3QucmlnaHQpLFxuICAgIGJvdHRvbTogTWF0aC5yb3VuZChyZWN0LmJvdHRvbSksXG4gICAgcGFnZVg6IE1hdGgucm91bmQocmVjdC5sZWZ0ICsgd2luZG93LnNjcm9sbFgpLFxuICAgIHBhZ2VZOiBNYXRoLnJvdW5kKHJlY3QudG9wICsgd2luZG93LnNjcm9sbFkpXG4gIH07XG59XG5cbmZ1bmN0aW9uIHNlcmlhbGl6ZUVsZW1lbnQoZWxlbWVudCwgaW5kZXgpIHtcbiAgcmV0dXJuIHtcbiAgICBpbmRleCxcbiAgICB0YWdOYW1lOiBlbGVtZW50LnRhZ05hbWUudG9Mb3dlckNhc2UoKSxcbiAgICB0ZXh0OiB0cnVuY2F0ZVRleHQoZWxlbWVudC5pbm5lclRleHQgfHwgZWxlbWVudC50ZXh0Q29udGVudCB8fCBcIlwiKSxcbiAgICB2YWx1ZTogdHJ1bmNhdGVUZXh0KGVsZW1lbnQudmFsdWUgfHwgXCJcIiwgMzAwKSxcbiAgICB2aXNpYmxlOiBpc0VsZW1lbnRWaXNpYmxlKGVsZW1lbnQpLFxuICAgIGNsaWNrYWJsZTogaXNFbGVtZW50Q2xpY2thYmxlKGVsZW1lbnQpLFxuICAgIGF0dHJpYnV0ZXM6IHNlcmlhbGl6ZUF0dHJpYnV0ZXMoZWxlbWVudCksXG4gICAgcmVjdDogc2VyaWFsaXplUmVjdChlbGVtZW50KVxuICB9O1xufVxuXG5mdW5jdGlvbiBmaW5kTWF0Y2hpbmdFbGVtZW50cyh7IHNlbGVjdG9yLCB0ZXh0LCBtYXRjaEV4YWN0IH0pIHtcbiAgaWYgKCFzZWxlY3RvciAmJiAhdGV4dCkge1xuICAgIHJldHVybiB7IGVycm9yOiBcIlBsZWFzZSBwcm92aWRlIGF0IGxlYXN0IG9uZSBsb2NhdG9yOiBzZWxlY3RvciBvciB0ZXh0XCIgfTtcbiAgfVxuXG4gIGxldCBlbGVtZW50cztcbiAgdHJ5IHtcbiAgICBlbGVtZW50cyA9IHNlbGVjdG9yXG4gICAgICA/IEFycmF5LmZyb20oZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbChzZWxlY3RvcikpXG4gICAgICA6IEFycmF5LmZyb20oZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbChcImJvZHkgKlwiKSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICByZXR1cm4geyBlcnJvcjogYEludmFsaWQgc2VsZWN0b3I6ICR7ZS5tZXNzYWdlfWAgfTtcbiAgfVxuXG4gIGlmICghdGV4dCkge1xuICAgIHJldHVybiB7IGVsZW1lbnRzIH07XG4gIH1cblxuICBjb25zdCBzZWFyY2ggPSBTdHJpbmcodGV4dCkudHJpbSgpLnRvTG93ZXJDYXNlKCk7XG4gIGNvbnN0IGZpbHRlcmVkID0gZWxlbWVudHMuZmlsdGVyKGVsZW1lbnQgPT4ge1xuICAgIGNvbnN0IGNhbmRpZGF0ZSA9IGdldFNlYXJjaGFibGVUZXh0KGVsZW1lbnQpO1xuICAgIHJldHVybiBtYXRjaEV4YWN0ID8gY2FuZGlkYXRlID09PSBzZWFyY2ggOiBjYW5kaWRhdGUuaW5jbHVkZXMoc2VhcmNoKTtcbiAgfSk7XG5cbiAgcmV0dXJuIHsgZWxlbWVudHM6IGZpbHRlcmVkIH07XG59XG5cbmZ1bmN0aW9uIHJlc29sdmVFbGVtZW50KGxvY2F0b3IpIHtcbiAgY29uc3QgeyBlbGVtZW50cywgZXJyb3IgfSA9IGZpbmRNYXRjaGluZ0VsZW1lbnRzKGxvY2F0b3IpO1xuICBpZiAoZXJyb3IpIHJldHVybiB7IGVycm9yIH07XG5cbiAgY29uc3QgaW5kZXggPSBOdW1iZXIuaXNJbnRlZ2VyKGxvY2F0b3IuaW5kZXgpID8gbG9jYXRvci5pbmRleCA6IDA7XG4gIGlmIChpbmRleCA8IDAgfHwgaW5kZXggPj0gZWxlbWVudHMubGVuZ3RoKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGVycm9yOiBlbGVtZW50cy5sZW5ndGggPT09IDBcbiAgICAgICAgPyBcIk5vIG1hdGNoaW5nIGVsZW1lbnQgZm91bmRcIlxuICAgICAgICA6IGBFbGVtZW50IGluZGV4IG91dCBvZiByYW5nZTogJHtpbmRleH0uIEF2YWlsYWJsZSBtYXRjaGVzOiAke2VsZW1lbnRzLmxlbmd0aH1gXG4gICAgfTtcbiAgfVxuXG4gIHJldHVybiB7IGVsZW1lbnQ6IGVsZW1lbnRzW2luZGV4XSwgaW5kZXgsIHRvdGFsTWF0Y2hlczogZWxlbWVudHMubGVuZ3RoIH07XG59XG5cbmZ1bmN0aW9uIGVuc3VyZUhpZ2hsaWdodFN0eWxlcygpIHtcbiAgaWYgKGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKEhJR0hMSUdIVF9TVFlMRV9JRCkpIHJldHVybjtcbiAgY29uc3Qgc3R5bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3R5bGVcIik7XG4gIHN0eWxlLmlkID0gSElHSExJR0hUX1NUWUxFX0lEO1xuICBzdHlsZS50ZXh0Q29udGVudCA9IGBcbiAgICBAa2V5ZnJhbWVzIHRhYi1tYW5hZ2VyLWhpZ2hsaWdodC1wdWxzZSB7XG4gICAgICAwJSwgMTAwJSB7IG9wYWNpdHk6IDAuMjsgdHJhbnNmb3JtOiBzY2FsZSgwLjk4KTsgfVxuICAgICAgNTAlIHsgb3BhY2l0eTogMTsgdHJhbnNmb3JtOiBzY2FsZSgxKTsgfVxuICAgIH1cbiAgICAjJHtISUdITElHSFRfT1ZFUkxBWV9JRH0ge1xuICAgICAgcG9zaXRpb246IGZpeGVkO1xuICAgICAgcG9pbnRlci1ldmVudHM6IG5vbmU7XG4gICAgICB6LWluZGV4OiAyMTQ3NDgzNjQ3O1xuICAgICAgYm9yZGVyOiAzcHggc29saWQgI2ZmNWYyZTtcbiAgICAgIGJhY2tncm91bmQ6IHJnYmEoMjU1LCA5NSwgNDYsIDAuMTIpO1xuICAgICAgYm94LXNoYWRvdzogMCAwIDAgOTk5OXB4IHJnYmEoMCwgMCwgMCwgMC4wOCk7XG4gICAgICBib3JkZXItcmFkaXVzOiAxMHB4O1xuICAgICAgYW5pbWF0aW9uOiB0YWItbWFuYWdlci1oaWdobGlnaHQtcHVsc2UgMC4zcyBlYXNlLWluLW91dCAzO1xuICAgIH1cbiAgYDtcbiAgZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LmFwcGVuZENoaWxkKHN0eWxlKTtcbn1cblxuZnVuY3Rpb24gY2xlYXJIaWdobGlnaHRPdmVybGF5KCkge1xuICBpZiAoaGlnaGxpZ2h0VGltZXJJZCkge1xuICAgIGNsZWFyVGltZW91dChoaWdobGlnaHRUaW1lcklkKTtcbiAgICBoaWdobGlnaHRUaW1lcklkID0gbnVsbDtcbiAgfVxuICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChISUdITElHSFRfT1ZFUkxBWV9JRCk/LnJlbW92ZSgpO1xufVxuXG5mdW5jdGlvbiBlbnN1cmVSZXVzZVByb21wdFN0eWxlcygpIHtcbiAgaWYgKGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFJFVVNFX1BST01QVF9TVFlMRV9JRCkpIHJldHVybjtcblxuICBjb25zdCBzdHlsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzdHlsZVwiKTtcbiAgc3R5bGUuaWQgPSBSRVVTRV9QUk9NUFRfU1RZTEVfSUQ7XG4gIHN0eWxlLnRleHRDb250ZW50ID0gYFxuICAgICMke1JFVVNFX1BST01QVF9JRH0ge1xuICAgICAgcG9zaXRpb246IGZpeGVkO1xuICAgICAgdG9wOiAyMHB4O1xuICAgICAgcmlnaHQ6IDIwcHg7XG4gICAgICB3aWR0aDogbWluKDM4MHB4LCBjYWxjKDEwMHZ3IC0gMjRweCkpO1xuICAgICAgei1pbmRleDogMjE0NzQ4MzY0NztcbiAgICAgIGJhY2tncm91bmQ6ICNmZmZkZjU7XG4gICAgICBib3JkZXI6IDJweCBzb2xpZCAjMTExODI3O1xuICAgICAgYm9yZGVyLXJhZGl1czogMTRweDtcbiAgICAgIGJveC1zaGFkb3c6IDhweCA4cHggMCByZ2JhKDE3LCAyNCwgMzksIDAuMTYpO1xuICAgICAgY29sb3I6ICMxMTE4Mjc7XG4gICAgICBmb250LWZhbWlseTogdWktc2Fucy1zZXJpZiwgc3lzdGVtLXVpLCBzYW5zLXNlcmlmO1xuICAgICAgb3ZlcmZsb3c6IGhpZGRlbjtcbiAgICB9XG4gICAgIyR7UkVVU0VfUFJPTVBUX0lEfSAqIHtcbiAgICAgIGJveC1zaXppbmc6IGJvcmRlci1ib3g7XG4gICAgfVxuICAgICMke1JFVVNFX1BST01QVF9JRH0gLnRtLXJldXNlLWhlYWRlciB7XG4gICAgICBwYWRkaW5nOiAxNHB4IDE2cHggMTBweDtcbiAgICAgIGJhY2tncm91bmQ6IGxpbmVhci1ncmFkaWVudCgxMzVkZWcsICNmZGU2OGEgMCUsICNmZWYzYzcgMTAwJSk7XG4gICAgICBib3JkZXItYm90dG9tOiAxcHggc29saWQgI2Y1OWUwYjtcbiAgICAgIGZvbnQtd2VpZ2h0OiA3MDA7XG4gICAgICBmb250LXNpemU6IDE0cHg7XG4gICAgfVxuICAgICMke1JFVVNFX1BST01QVF9JRH0gLnRtLXJldXNlLWJvZHkge1xuICAgICAgcGFkZGluZzogMTRweCAxNnB4O1xuICAgICAgZGlzcGxheTogZmxleDtcbiAgICAgIGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47XG4gICAgICBnYXA6IDEwcHg7XG4gICAgICBmb250LXNpemU6IDEzcHg7XG4gICAgICBsaW5lLWhlaWdodDogMS41O1xuICAgIH1cbiAgICAjJHtSRVVTRV9QUk9NUFRfSUR9IC50bS1yZXVzZS1jYXJkIHtcbiAgICAgIHBhZGRpbmc6IDEwcHggMTJweDtcbiAgICAgIGJvcmRlci1yYWRpdXM6IDEwcHg7XG4gICAgICBib3JkZXI6IDFweCBzb2xpZCAjZTVlN2ViO1xuICAgICAgYmFja2dyb3VuZDogI2ZmZmZmZjtcbiAgICB9XG4gICAgIyR7UkVVU0VfUFJPTVBUX0lEfSAudG0tcmV1c2UtbGFiZWwge1xuICAgICAgZm9udC1zaXplOiAxMXB4O1xuICAgICAgZm9udC13ZWlnaHQ6IDcwMDtcbiAgICAgIGxldHRlci1zcGFjaW5nOiAwLjA0ZW07XG4gICAgICBjb2xvcjogIzkyNDAwZTtcbiAgICAgIHRleHQtdHJhbnNmb3JtOiB1cHBlcmNhc2U7XG4gICAgICBtYXJnaW4tYm90dG9tOiA0cHg7XG4gICAgfVxuICAgICMke1JFVVNFX1BST01QVF9JRH0gLnRtLXJldXNlLXRpdGxlIHtcbiAgICAgIGZvbnQtd2VpZ2h0OiA2MDA7XG4gICAgICB3b3JkLWJyZWFrOiBicmVhay13b3JkO1xuICAgIH1cbiAgICAjJHtSRVVTRV9QUk9NUFRfSUR9IC50bS1yZXVzZS11cmwge1xuICAgICAgbWFyZ2luLXRvcDogNHB4O1xuICAgICAgY29sb3I6ICM2YjcyODA7XG4gICAgICB3b3JkLWJyZWFrOiBicmVhay1hbGw7XG4gICAgICBmb250LXNpemU6IDEycHg7XG4gICAgfVxuICAgICMke1JFVVNFX1BST01QVF9JRH0gLnRtLXJldXNlLWRvbWFpbiB7XG4gICAgICBkaXNwbGF5OiBpbmxpbmUtZmxleDtcbiAgICAgIGFsaWduLWl0ZW1zOiBjZW50ZXI7XG4gICAgICB3aWR0aDogZml0LWNvbnRlbnQ7XG4gICAgICBwYWRkaW5nOiA0cHggOHB4O1xuICAgICAgYm9yZGVyLXJhZGl1czogOTk5cHg7XG4gICAgICBiYWNrZ3JvdW5kOiAjZmZmYmViO1xuICAgICAgYm9yZGVyOiAxcHggc29saWQgI2ZjZDM0ZDtcbiAgICAgIGZvbnQtc2l6ZTogMTJweDtcbiAgICAgIGNvbG9yOiAjOTI0MDBlO1xuICAgICAgZm9udC13ZWlnaHQ6IDYwMDtcbiAgICB9XG4gICAgIyR7UkVVU0VfUFJPTVBUX0lEfSAudG0tcmV1c2UtcmVtZW1iZXIge1xuICAgICAgZGlzcGxheTogZmxleDtcbiAgICAgIGFsaWduLWl0ZW1zOiBjZW50ZXI7XG4gICAgICBnYXA6IDhweDtcbiAgICAgIGZvbnQtc2l6ZTogMTJweDtcbiAgICAgIGNvbG9yOiAjMzc0MTUxO1xuICAgICAgbWFyZ2luLXRvcDogMnB4O1xuICAgIH1cbiAgICAjJHtSRVVTRV9QUk9NUFRfSUR9IC50bS1yZXVzZS1hY3Rpb25zIHtcbiAgICAgIGRpc3BsYXk6IGZsZXg7XG4gICAgICBnYXA6IDEwcHg7XG4gICAgICBtYXJnaW4tdG9wOiA0cHg7XG4gICAgfVxuICAgICMke1JFVVNFX1BST01QVF9JRH0gYnV0dG9uIHtcbiAgICAgIGFwcGVhcmFuY2U6IG5vbmU7XG4gICAgICBib3JkZXI6IDFweCBzb2xpZCAjMTExODI3O1xuICAgICAgYm9yZGVyLXJhZGl1czogMTBweDtcbiAgICAgIHBhZGRpbmc6IDEwcHggMTJweDtcbiAgICAgIG1pbi1oZWlnaHQ6IDQwcHg7XG4gICAgICBmb250LXNpemU6IDEzcHg7XG4gICAgICBmb250LXdlaWdodDogNzAwO1xuICAgICAgY3Vyc29yOiBwb2ludGVyO1xuICAgICAgdHJhbnNpdGlvbjogdHJhbnNmb3JtIDAuMTJzIGVhc2UsIGJveC1zaGFkb3cgMC4xMnMgZWFzZSwgYmFja2dyb3VuZCAwLjEycyBlYXNlO1xuICAgIH1cbiAgICAjJHtSRVVTRV9QUk9NUFRfSUR9IGJ1dHRvbjpob3ZlciB7XG4gICAgICB0cmFuc2Zvcm06IHRyYW5zbGF0ZVkoLTFweCk7XG4gICAgICBib3gtc2hhZG93OiAwIDRweCAwIHJnYmEoMTcsIDI0LCAzOSwgMC4xMik7XG4gICAgfVxuICAgICMke1JFVVNFX1BST01QVF9JRH0gLnRtLXJldXNlLWJ0bi1wcmltYXJ5IHtcbiAgICAgIGZsZXg6IDE7XG4gICAgICBiYWNrZ3JvdW5kOiAjZjU5ZTBiO1xuICAgICAgY29sb3I6ICMxMTE4Mjc7XG4gICAgfVxuICAgICMke1JFVVNFX1BST01QVF9JRH0gLnRtLXJldXNlLWJ0bi1zZWNvbmRhcnkge1xuICAgICAgZmxleDogMTtcbiAgICAgIGJhY2tncm91bmQ6ICNmZmZmZmY7XG4gICAgICBjb2xvcjogIzExMTgyNztcbiAgICB9XG4gIGA7XG4gIGRvY3VtZW50LmRvY3VtZW50RWxlbWVudC5hcHBlbmRDaGlsZChzdHlsZSk7XG59XG5cbmZ1bmN0aW9uIHJlbW92ZVJldXNlUHJvbXB0KCkge1xuICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChSRVVTRV9QUk9NUFRfSUQpPy5yZW1vdmUoKTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlUmV1c2VQcm9tcHRSb3cobGFiZWwsIHRpdGxlLCB1cmwpIHtcbiAgY29uc3QgY2FyZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGNhcmQuY2xhc3NOYW1lID0gXCJ0bS1yZXVzZS1jYXJkXCI7XG5cbiAgY29uc3QgbGFiZWxFbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGxhYmVsRWwuY2xhc3NOYW1lID0gXCJ0bS1yZXVzZS1sYWJlbFwiO1xuICBsYWJlbEVsLnRleHRDb250ZW50ID0gbGFiZWw7XG5cbiAgY29uc3QgdGl0bGVFbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlRWwuY2xhc3NOYW1lID0gXCJ0bS1yZXVzZS10aXRsZVwiO1xuICB0aXRsZUVsLnRleHRDb250ZW50ID0gdHJ1bmNhdGVUZXh0KHRpdGxlIHx8IHVybCB8fCBcIlwiLCAyMDApO1xuXG4gIGNvbnN0IHVybEVsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdXJsRWwuY2xhc3NOYW1lID0gXCJ0bS1yZXVzZS11cmxcIjtcbiAgdXJsRWwudGV4dENvbnRlbnQgPSB0cnVuY2F0ZVRleHQodXJsIHx8IFwiXCIsIDUwMCk7XG5cbiAgY2FyZC5hcHBlbmQobGFiZWxFbCwgdGl0bGVFbCwgdXJsRWwpO1xuICByZXR1cm4gY2FyZDtcbn1cblxuZnVuY3Rpb24gaGFuZGxlU2hvd1RhYlJldXNlUHJvbXB0KG1zZywgc2VuZFJlc3BvbnNlKSB7XG4gIGVuc3VyZVJldXNlUHJvbXB0U3R5bGVzKCk7XG4gIHJlbW92ZVJldXNlUHJvbXB0KCk7XG5cbiAgY29uc3Qgb3ZlcmxheSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIG92ZXJsYXkuaWQgPSBSRVVTRV9QUk9NUFRfSUQ7XG5cbiAgY29uc3QgaGVhZGVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgaGVhZGVyLmNsYXNzTmFtZSA9IFwidG0tcmV1c2UtaGVhZGVyXCI7XG4gIGhlYWRlci50ZXh0Q29udGVudCA9IFwi5qOA5rWL5Yiw5bey5omT5byA55qE55u45ZCM6aG16Z2iXCI7XG5cbiAgY29uc3QgYm9keSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGJvZHkuY2xhc3NOYW1lID0gXCJ0bS1yZXVzZS1ib2R5XCI7XG5cbiAgY29uc3QgZGVzY3JpcHRpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBkZXNjcmlwdGlvbi50ZXh0Q29udGVudCA9IFwi6KaB5aSN55So6L+Z5Liq5Y6G5Y+yIFRhYiDlkJfvvJ/lpoLmnpzkuI3lpI3nlKjvvIzmiJHku6zkvJrliIflm57liJrmiZPlvIDnmoTmlrDpobXpnaLjgIJcIjtcblxuICBjb25zdCBkb21haW4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBkb21haW4uY2xhc3NOYW1lID0gXCJ0bS1yZXVzZS1kb21haW5cIjtcbiAgZG9tYWluLnRleHRDb250ZW50ID0gYOWfn+WQje+8miR7bXNnLmRvbWFpbktleSB8fCBcIuacquefpVwifWA7XG5cbiAgY29uc3QgZXhpc3RpbmdSb3cgPSBjcmVhdGVSZXVzZVByb21wdFJvdyhcIuW3suWtmOWcqOeahOmhtemdolwiLCBtc2cuZXhpc3RpbmdUaXRsZSwgbXNnLmV4aXN0aW5nVXJsKTtcbiAgY29uc3QgbmV3Um93ID0gY3JlYXRlUmV1c2VQcm9tcHRSb3coXCLliJrmiZPlvIDnmoTmlrDpobXpnaJcIiwgbXNnLm5ld1RpdGxlLCBtc2cubmV3VXJsKTtcblxuICBjb25zdCByZW1lbWJlckxhYmVsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImxhYmVsXCIpO1xuICByZW1lbWJlckxhYmVsLmNsYXNzTmFtZSA9IFwidG0tcmV1c2UtcmVtZW1iZXJcIjtcblxuICBjb25zdCByZW1lbWJlckNoZWNrYm94ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImlucHV0XCIpO1xuICByZW1lbWJlckNoZWNrYm94LnR5cGUgPSBcImNoZWNrYm94XCI7XG5cbiAgY29uc3QgcmVtZW1iZXJUZXh0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIHJlbWVtYmVyVGV4dC50ZXh0Q29udGVudCA9IFwi6K6w5L2P5b2T5YmN5Z+f5ZCN55qE6YCJ5oupXCI7XG4gIHJlbWVtYmVyTGFiZWwuYXBwZW5kKHJlbWVtYmVyQ2hlY2tib3gsIHJlbWVtYmVyVGV4dCk7XG5cbiAgY29uc3QgYWN0aW9ucyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGFjdGlvbnMuY2xhc3NOYW1lID0gXCJ0bS1yZXVzZS1hY3Rpb25zXCI7XG5cbiAgY29uc3QgcmV1c2VCdXR0b24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICByZXVzZUJ1dHRvbi50eXBlID0gXCJidXR0b25cIjtcbiAgcmV1c2VCdXR0b24uY2xhc3NOYW1lID0gXCJ0bS1yZXVzZS1idG4tcHJpbWFyeVwiO1xuICByZXVzZUJ1dHRvbi50ZXh0Q29udGVudCA9IFwi5aSN55So5Y6G5Y+yIFRhYlwiO1xuXG4gIGNvbnN0IGtlZXBCdXR0b24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBrZWVwQnV0dG9uLnR5cGUgPSBcImJ1dHRvblwiO1xuICBrZWVwQnV0dG9uLmNsYXNzTmFtZSA9IFwidG0tcmV1c2UtYnRuLXNlY29uZGFyeVwiO1xuICBrZWVwQnV0dG9uLnRleHRDb250ZW50ID0gXCLkuI3lpI3nlKhcIjtcblxuICBjb25zdCBzdWJtaXREZWNpc2lvbiA9IChkZWNpc2lvbikgPT4ge1xuICAgIGNocm9tZS5ydW50aW1lLnNlbmRNZXNzYWdlKHtcbiAgICAgIHR5cGU6IFwidGFiX3JldXNlX3Byb21wdF9kZWNpc2lvblwiLFxuICAgICAgZGVjaXNpb24sXG4gICAgICByZW1lbWJlckNob2ljZTogcmVtZW1iZXJDaGVja2JveC5jaGVja2VkLFxuICAgICAgbmV3VGFiSWQ6IG1zZy5uZXdUYWJJZCxcbiAgICAgIGV4aXN0aW5nVGFiSWQ6IG1zZy5leGlzdGluZ1RhYklkLFxuICAgICAgZG9tYWluS2V5OiBtc2cuZG9tYWluS2V5IHx8IFwiXCJcbiAgICB9LCAoKSA9PiB7XG4gICAgICByZW1vdmVSZXVzZVByb21wdCgpO1xuICAgIH0pO1xuICB9O1xuXG4gIHJldXNlQnV0dG9uLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiBzdWJtaXREZWNpc2lvbihcInJldXNlXCIpKTtcbiAga2VlcEJ1dHRvbi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4gc3VibWl0RGVjaXNpb24oXCJrZWVwXCIpKTtcblxuICBhY3Rpb25zLmFwcGVuZChyZXVzZUJ1dHRvbiwga2VlcEJ1dHRvbik7XG4gIGJvZHkuYXBwZW5kKGRlc2NyaXB0aW9uLCBkb21haW4sIGV4aXN0aW5nUm93LCBuZXdSb3csIHJlbWVtYmVyTGFiZWwsIGFjdGlvbnMpO1xuICBvdmVybGF5LmFwcGVuZChoZWFkZXIsIGJvZHkpO1xuICBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuYXBwZW5kQ2hpbGQob3ZlcmxheSk7XG5cbiAgc2VuZFJlc3BvbnNlKHsgc3VjY2VzczogdHJ1ZSB9KTtcbn1cblxuZnVuY3Rpb24gc2hvd0hpZ2hsaWdodE92ZXJsYXkoZWxlbWVudCwgZHVyYXRpb25Ncykge1xuICBjbGVhckhpZ2hsaWdodE92ZXJsYXkoKTtcbiAgZW5zdXJlSGlnaGxpZ2h0U3R5bGVzKCk7XG5cbiAgY29uc3QgcmVjdCA9IGVsZW1lbnQuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG4gIGNvbnN0IG92ZXJsYXkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBvdmVybGF5LmlkID0gSElHSExJR0hUX09WRVJMQVlfSUQ7XG4gIG92ZXJsYXkuc3R5bGUudG9wID0gYCR7TWF0aC5tYXgoMCwgcmVjdC50b3AgLSA2KX1weGA7XG4gIG92ZXJsYXkuc3R5bGUubGVmdCA9IGAke01hdGgubWF4KDAsIHJlY3QubGVmdCAtIDYpfXB4YDtcbiAgb3ZlcmxheS5zdHlsZS53aWR0aCA9IGAke01hdGgubWF4KDgsIHJlY3Qud2lkdGggKyAxMil9cHhgO1xuICBvdmVybGF5LnN0eWxlLmhlaWdodCA9IGAke01hdGgubWF4KDgsIHJlY3QuaGVpZ2h0ICsgMTIpfXB4YDtcbiAgZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LmFwcGVuZENoaWxkKG92ZXJsYXkpO1xuXG4gIGhpZ2hsaWdodFRpbWVySWQgPSB3aW5kb3cuc2V0VGltZW91dCgoKSA9PiB7XG4gICAgb3ZlcmxheS5yZW1vdmUoKTtcbiAgICBoaWdobGlnaHRUaW1lcklkID0gbnVsbDtcbiAgfSwgZHVyYXRpb25Ncyk7XG59XG5cbmZ1bmN0aW9uIHNldEZvcm1FbGVtZW50VmFsdWUoZWxlbWVudCwgdmFsdWUpIHtcbiAgY29uc3QgdGFnTmFtZSA9IGVsZW1lbnQudGFnTmFtZS50b0xvd2VyQ2FzZSgpO1xuICBjb25zdCBzdHJpbmdWYWx1ZSA9IFN0cmluZyh2YWx1ZSA/PyBcIlwiKTtcbiAgbGV0IHNldHRlciA9IG51bGw7XG5cbiAgaWYgKHRhZ05hbWUgPT09IFwiaW5wdXRcIikge1xuICAgIHNldHRlciA9IE9iamVjdC5nZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3Iod2luZG93LkhUTUxJbnB1dEVsZW1lbnQucHJvdG90eXBlLCBcInZhbHVlXCIpPy5zZXQ7XG4gIH0gZWxzZSBpZiAodGFnTmFtZSA9PT0gXCJ0ZXh0YXJlYVwiKSB7XG4gICAgc2V0dGVyID0gT2JqZWN0LmdldE93blByb3BlcnR5RGVzY3JpcHRvcih3aW5kb3cuSFRNTFRleHRBcmVhRWxlbWVudC5wcm90b3R5cGUsIFwidmFsdWVcIik/LnNldDtcbiAgfSBlbHNlIGlmICh0YWdOYW1lID09PSBcInNlbGVjdFwiKSB7XG4gICAgc2V0dGVyID0gT2JqZWN0LmdldE93blByb3BlcnR5RGVzY3JpcHRvcih3aW5kb3cuSFRNTFNlbGVjdEVsZW1lbnQucHJvdG90eXBlLCBcInZhbHVlXCIpPy5zZXQ7XG4gIH1cblxuICBpZiAoc2V0dGVyKSB7XG4gICAgc2V0dGVyLmNhbGwoZWxlbWVudCwgc3RyaW5nVmFsdWUpO1xuICB9IGVsc2Uge1xuICAgIGVsZW1lbnQudmFsdWUgPSBzdHJpbmdWYWx1ZTtcbiAgfVxuXG4gIGVsZW1lbnQuZGlzcGF0Y2hFdmVudChuZXcgRXZlbnQoXCJpbnB1dFwiLCB7IGJ1YmJsZXM6IHRydWUgfSkpO1xuICBlbGVtZW50LmRpc3BhdGNoRXZlbnQobmV3IEV2ZW50KFwiY2hhbmdlXCIsIHsgYnViYmxlczogdHJ1ZSB9KSk7XG59XG5cbmZ1bmN0aW9uIGhhbmRsZURvbVF1ZXJ5KG1zZykge1xuICBjb25zdCBtYXhSZXN1bHRzID0gTWF0aC5taW4oMjAsIE1hdGgubWF4KDEsIE51bWJlci5pc0ludGVnZXIobXNnLm1heFJlc3VsdHMpID8gbXNnLm1heFJlc3VsdHMgOiA1KSk7XG4gIGNvbnN0IHsgZWxlbWVudHMsIGVycm9yIH0gPSBmaW5kTWF0Y2hpbmdFbGVtZW50cyhtc2cpO1xuICBpZiAoZXJyb3IpIHJldHVybiB7IGVycm9yIH07XG5cbiAgcmV0dXJuIHtcbiAgICBzdWNjZXNzOiB0cnVlLFxuICAgIHNlbGVjdG9yOiBtc2cuc2VsZWN0b3IgfHwgbnVsbCxcbiAgICB0ZXh0OiBtc2cudGV4dCB8fCBudWxsLFxuICAgIGNvdW50OiBlbGVtZW50cy5sZW5ndGgsXG4gICAgdHJ1bmNhdGVkOiBlbGVtZW50cy5sZW5ndGggPiBtYXhSZXN1bHRzLFxuICAgIG1hdGNoZXM6IGVsZW1lbnRzLnNsaWNlKDAsIG1heFJlc3VsdHMpLm1hcCgoZWxlbWVudCwgaW5kZXgpID0+IHNlcmlhbGl6ZUVsZW1lbnQoZWxlbWVudCwgaW5kZXgpKVxuICB9O1xufVxuXG5mdW5jdGlvbiBoYW5kbGVEb21DbGljayhtc2cpIHtcbiAgY29uc3QgcmVzb2x2ZWQgPSByZXNvbHZlRWxlbWVudChtc2cpO1xuICBpZiAocmVzb2x2ZWQuZXJyb3IpIHJldHVybiB7IGVycm9yOiByZXNvbHZlZC5lcnJvciB9O1xuXG4gIGNvbnN0IGVsZW1lbnQgPSByZXNvbHZlZC5lbGVtZW50O1xuICBlbGVtZW50LnNjcm9sbEludG9WaWV3KHsgYmxvY2s6IFwiY2VudGVyXCIsIGlubGluZTogXCJuZWFyZXN0XCIsIGJlaGF2aW9yOiBcInNtb290aFwiIH0pO1xuICBpZiAodHlwZW9mIGVsZW1lbnQuZm9jdXMgPT09IFwiZnVuY3Rpb25cIikge1xuICAgIHRyeSB7IGVsZW1lbnQuZm9jdXMoeyBwcmV2ZW50U2Nyb2xsOiB0cnVlIH0pOyB9IGNhdGNoIChlKSB7IGVsZW1lbnQuZm9jdXMoKTsgfVxuICB9XG4gIGVsZW1lbnQuY2xpY2soKTtcblxuICByZXR1cm4ge1xuICAgIHN1Y2Nlc3M6IHRydWUsXG4gICAgYWN0aW9uOiBcImNsaWNrXCIsXG4gICAgdG90YWxNYXRjaGVzOiByZXNvbHZlZC50b3RhbE1hdGNoZXMsXG4gICAgdGFyZ2V0OiBzZXJpYWxpemVFbGVtZW50KGVsZW1lbnQsIHJlc29sdmVkLmluZGV4KVxuICB9O1xufVxuXG5mdW5jdGlvbiBoYW5kbGVEb21TZXRWYWx1ZShtc2cpIHtcbiAgY29uc3QgcmVzb2x2ZWQgPSByZXNvbHZlRWxlbWVudChtc2cpO1xuICBpZiAocmVzb2x2ZWQuZXJyb3IpIHJldHVybiB7IGVycm9yOiByZXNvbHZlZC5lcnJvciB9O1xuXG4gIGNvbnN0IGVsZW1lbnQgPSByZXNvbHZlZC5lbGVtZW50O1xuICBjb25zdCB0YWdOYW1lID0gZWxlbWVudC50YWdOYW1lLnRvTG93ZXJDYXNlKCk7XG4gIGlmICghW1wiaW5wdXRcIiwgXCJ0ZXh0YXJlYVwiLCBcInNlbGVjdFwiXS5pbmNsdWRlcyh0YWdOYW1lKSkge1xuICAgIHJldHVybiB7IGVycm9yOiBgRWxlbWVudCBpcyBub3QgYSBmb3JtIGZpZWxkOiA8JHt0YWdOYW1lfT5gIH07XG4gIH1cblxuICBlbGVtZW50LnNjcm9sbEludG9WaWV3KHsgYmxvY2s6IFwiY2VudGVyXCIsIGlubGluZTogXCJuZWFyZXN0XCIsIGJlaGF2aW9yOiBcInNtb290aFwiIH0pO1xuICBpZiAodHlwZW9mIGVsZW1lbnQuZm9jdXMgPT09IFwiZnVuY3Rpb25cIikge1xuICAgIHRyeSB7IGVsZW1lbnQuZm9jdXMoeyBwcmV2ZW50U2Nyb2xsOiB0cnVlIH0pOyB9IGNhdGNoIChlKSB7IGVsZW1lbnQuZm9jdXMoKTsgfVxuICB9XG5cbiAgc2V0Rm9ybUVsZW1lbnRWYWx1ZShlbGVtZW50LCBtc2cudmFsdWUpO1xuXG4gIHJldHVybiB7XG4gICAgc3VjY2VzczogdHJ1ZSxcbiAgICBhY3Rpb246IFwic2V0X3ZhbHVlXCIsXG4gICAgdG90YWxNYXRjaGVzOiByZXNvbHZlZC50b3RhbE1hdGNoZXMsXG4gICAgdmFsdWU6IHRydW5jYXRlVGV4dChlbGVtZW50LnZhbHVlIHx8IFwiXCIsIDUwMCksXG4gICAgdGFyZ2V0OiBzZXJpYWxpemVFbGVtZW50KGVsZW1lbnQsIHJlc29sdmVkLmluZGV4KVxuICB9O1xufVxuXG5mdW5jdGlvbiBoYW5kbGVEb21TdHlsZShtc2cpIHtcbiAgY29uc3QgcmVzb2x2ZWQgPSByZXNvbHZlRWxlbWVudChtc2cpO1xuICBpZiAocmVzb2x2ZWQuZXJyb3IpIHJldHVybiB7IGVycm9yOiByZXNvbHZlZC5lcnJvciB9O1xuICBpZiAoIW1zZy5zdHlsZXMgfHwgdHlwZW9mIG1zZy5zdHlsZXMgIT09IFwib2JqZWN0XCIgfHwgQXJyYXkuaXNBcnJheShtc2cuc3R5bGVzKSkge1xuICAgIHJldHVybiB7IGVycm9yOiBcIlBsZWFzZSBwcm92aWRlIGEgc3R5bGVzIG9iamVjdFwiIH07XG4gIH1cblxuICBjb25zdCBkdXJhdGlvbk1zID0gTWF0aC5taW4oMTAwMDAsIE1hdGgubWF4KDAsIE51bWJlci5pc0Zpbml0ZShtc2cuZHVyYXRpb25NcykgPyBtc2cuZHVyYXRpb25NcyA6IDIwMDApKTtcbiAgY29uc3QgZWxlbWVudCA9IHJlc29sdmVkLmVsZW1lbnQ7XG4gIGNvbnN0IHByZXZpb3VzID0ge307XG5cbiAgZWxlbWVudC5zY3JvbGxJbnRvVmlldyh7IGJsb2NrOiBcImNlbnRlclwiLCBpbmxpbmU6IFwibmVhcmVzdFwiLCBiZWhhdmlvcjogXCJzbW9vdGhcIiB9KTtcbiAgZm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMobXNnLnN0eWxlcykpIHtcbiAgICBwcmV2aW91c1trZXldID0gZWxlbWVudC5zdHlsZVtrZXldO1xuICAgIGVsZW1lbnQuc3R5bGVba2V5XSA9IFN0cmluZyh2YWx1ZSk7XG4gIH1cblxuICBpZiAoZHVyYXRpb25NcyA+IDApIHtcbiAgICB3aW5kb3cuc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhwcmV2aW91cykpIHtcbiAgICAgICAgZWxlbWVudC5zdHlsZVtrZXldID0gdmFsdWU7XG4gICAgICB9XG4gICAgfSwgZHVyYXRpb25Ncyk7XG4gIH1cblxuICByZXR1cm4ge1xuICAgIHN1Y2Nlc3M6IHRydWUsXG4gICAgYWN0aW9uOiBcInN0eWxlXCIsXG4gICAgZHVyYXRpb25NcyxcbiAgICBzdHlsZXM6IG1zZy5zdHlsZXMsXG4gICAgdGFyZ2V0OiBzZXJpYWxpemVFbGVtZW50KGVsZW1lbnQsIHJlc29sdmVkLmluZGV4KVxuICB9O1xufVxuXG5mdW5jdGlvbiBoYW5kbGVEb21HZXRIdG1sKG1zZykge1xuICBjb25zdCByZXNvbHZlZCA9IHJlc29sdmVFbGVtZW50KG1zZyk7XG4gIGlmIChyZXNvbHZlZC5lcnJvcikgcmV0dXJuIHsgZXJyb3I6IHJlc29sdmVkLmVycm9yIH07XG5cbiAgY29uc3QgbW9kZSA9IG1zZy5tb2RlID09PSBcImlubmVyXCIgPyBcImlubmVyXCIgOiBcIm91dGVyXCI7XG4gIGNvbnN0IG1heExlbmd0aCA9IE1hdGgubWluKDIwMDAwLCBNYXRoLm1heCgyMDAsIE51bWJlci5pc0ludGVnZXIobXNnLm1heExlbmd0aCkgPyBtc2cubWF4TGVuZ3RoIDogSFRNTF9MSU1JVCkpO1xuICBjb25zdCBlbGVtZW50ID0gcmVzb2x2ZWQuZWxlbWVudDtcbiAgY29uc3QgaHRtbCA9IG1vZGUgPT09IFwiaW5uZXJcIiA/IGVsZW1lbnQuaW5uZXJIVE1MIDogZWxlbWVudC5vdXRlckhUTUw7XG5cbiAgcmV0dXJuIHtcbiAgICBzdWNjZXNzOiB0cnVlLFxuICAgIG1vZGUsXG4gICAgdHJ1bmNhdGVkOiBodG1sLmxlbmd0aCA+IG1heExlbmd0aCxcbiAgICBodG1sOiBodG1sLmxlbmd0aCA+IG1heExlbmd0aCA/IGh0bWwuc2xpY2UoMCwgbWF4TGVuZ3RoKSArIFwiLi4uXCIgOiBodG1sLFxuICAgIHRhcmdldDogc2VyaWFsaXplRWxlbWVudChlbGVtZW50LCByZXNvbHZlZC5pbmRleClcbiAgfTtcbn1cblxuZnVuY3Rpb24gaGFuZGxlRG9tSGlnaGxpZ2h0KG1zZywgc2VuZFJlc3BvbnNlKSB7XG4gIGNvbnN0IHJlc29sdmVkID0gcmVzb2x2ZUVsZW1lbnQobXNnKTtcbiAgaWYgKHJlc29sdmVkLmVycm9yKSB7XG4gICAgc2VuZFJlc3BvbnNlKHsgZXJyb3I6IHJlc29sdmVkLmVycm9yIH0pO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IGR1cmF0aW9uTXMgPSBNYXRoLm1pbig1MDAwLCBNYXRoLm1heCgzMDAsIE51bWJlci5pc0Zpbml0ZShtc2cuZHVyYXRpb25NcykgPyBtc2cuZHVyYXRpb25NcyA6IDEwMDApKTtcbiAgY29uc3QgZWxlbWVudCA9IHJlc29sdmVkLmVsZW1lbnQ7XG4gIGVsZW1lbnQuc2Nyb2xsSW50b1ZpZXcoeyBibG9jazogXCJjZW50ZXJcIiwgaW5saW5lOiBcIm5lYXJlc3RcIiwgYmVoYXZpb3I6IFwic21vb3RoXCIgfSk7XG5cbiAgd2luZG93LnNldFRpbWVvdXQoKCkgPT4ge1xuICAgIHNob3dIaWdobGlnaHRPdmVybGF5KGVsZW1lbnQsIGR1cmF0aW9uTXMpO1xuICAgIHNlbmRSZXNwb25zZSh7XG4gICAgICBzdWNjZXNzOiB0cnVlLFxuICAgICAgYWN0aW9uOiBcImhpZ2hsaWdodFwiLFxuICAgICAgZHVyYXRpb25NcyxcbiAgICAgIHRhcmdldDogc2VyaWFsaXplRWxlbWVudChlbGVtZW50LCByZXNvbHZlZC5pbmRleCksXG4gICAgICBzY3JvbGw6IGdldFNjcm9sbFN0YXRlKClcbiAgICB9KTtcbiAgfSwgMzUwKTtcbn1cblxuLyoqXG4gKiBDb250ZW50IHNjcmlwdCBpbmplY3RlZCBpbnRvIGFsbCBodHRwL2h0dHBzIHBhZ2VzLlxuICogUmVzcG9uZHMgdG8gbWVzc2FnZXMgZm9yIHBhZ2UgZXh0cmFjdGlvbiwgc2Nyb2xsaW5nLCBhbmQgc3RydWN0dXJlZCBET00gYWN0aW9ucy5cbiAqL1xuY2hyb21lLnJ1bnRpbWUub25NZXNzYWdlLmFkZExpc3RlbmVyKChtc2csIHNlbmRlciwgc2VuZFJlc3BvbnNlKSA9PiB7XG4gIGlmIChtc2cudHlwZSA9PT0gXCJ0YWJfZXh0cmFjdF9jb250ZW50XCIpIHtcbiAgICBzZW5kUmVzcG9uc2Uoe1xuICAgICAgdXJsOiBkb2N1bWVudC5VUkwsXG4gICAgICB0aXRsZTogZG9jdW1lbnQudGl0bGUsXG4gICAgICBjb250ZW50OiBkb2N1bWVudC5ib2R5LmlubmVyVGV4dC5zdWJzdHJpbmcoMCwgODAwMClcbiAgICB9KTtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICBpZiAobXNnLnR5cGUgPT09IFwidGFiX3Njcm9sbFwiKSB7XG4gICAgY29uc3Qgc3RhdGVCZWZvcmUgPSBnZXRTY3JvbGxTdGF0ZSgpO1xuICAgIGNvbnN0IGJlaGF2aW9yID0gbXNnLmJlaGF2aW9yID09PSBcInNtb290aFwiID8gXCJzbW9vdGhcIiA6IFwiYXV0b1wiO1xuICAgIGNvbnN0IHBvc2l0aW9uID0gdHlwZW9mIG1zZy5wb3NpdGlvbiA9PT0gXCJzdHJpbmdcIiA/IG1zZy5wb3NpdGlvbiA6IG51bGw7XG4gICAgbGV0IHRvcCA9IG51bGw7XG5cbiAgICBpZiAocG9zaXRpb24gPT09IFwidG9wXCIpIHtcbiAgICAgIHRvcCA9IDA7XG4gICAgfSBlbHNlIGlmIChwb3NpdGlvbiA9PT0gXCJib3R0b21cIikge1xuICAgICAgdG9wID0gc3RhdGVCZWZvcmUubWF4U2Nyb2xsWTtcbiAgICB9IGVsc2UgaWYgKHR5cGVvZiBtc2cuZGVsdGFZID09PSBcIm51bWJlclwiICYmIE51bWJlci5pc0Zpbml0ZShtc2cuZGVsdGFZKSkge1xuICAgICAgdG9wID0gc3RhdGVCZWZvcmUuc2Nyb2xsWSArIG1zZy5kZWx0YVk7XG4gICAgfSBlbHNlIGlmICh0eXBlb2YgbXNnLnBhZ2VGcmFjdGlvbiA9PT0gXCJudW1iZXJcIiAmJiBOdW1iZXIuaXNGaW5pdGUobXNnLnBhZ2VGcmFjdGlvbikpIHtcbiAgICAgIHRvcCA9IHN0YXRlQmVmb3JlLnNjcm9sbFkgKyAoc3RhdGVCZWZvcmUudmlld3BvcnRIZWlnaHQgKiBtc2cucGFnZUZyYWN0aW9uKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdG9wID0gc3RhdGVCZWZvcmUuc2Nyb2xsWSArIHN0YXRlQmVmb3JlLnZpZXdwb3J0SGVpZ2h0ICogMC44O1xuICAgIH1cblxuICAgIHRvcCA9IE1hdGgubWF4KDAsIE1hdGgubWluKHN0YXRlQmVmb3JlLm1heFNjcm9sbFksIHRvcCkpO1xuICAgIHdpbmRvdy5zY3JvbGxUbyh7IHRvcCwgYmVoYXZpb3IgfSk7XG5cbiAgICBjb25zdCBkZWxheSA9IGJlaGF2aW9yID09PSBcInNtb290aFwiID8gNDAwIDogNjA7XG4gICAgd2luZG93LnNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgY29uc3Qgc3RhdGVBZnRlciA9IGdldFNjcm9sbFN0YXRlKCk7XG4gICAgICBzZW5kUmVzcG9uc2Uoe1xuICAgICAgICBzdWNjZXNzOiB0cnVlLFxuICAgICAgICBhY3Rpb246IHBvc2l0aW9uIHx8IFwiZGVsdGFcIixcbiAgICAgICAgcmVxdWVzdGVkVG9wOiB0b3AsXG4gICAgICAgIG1vdmVkOiBNYXRoLmFicyhzdGF0ZUFmdGVyLnNjcm9sbFkgLSBzdGF0ZUJlZm9yZS5zY3JvbGxZKSA+IDEsXG4gICAgICAgIGJlZm9yZTogc3RhdGVCZWZvcmUsXG4gICAgICAgIGFmdGVyOiBzdGF0ZUFmdGVyXG4gICAgICB9KTtcbiAgICB9LCBkZWxheSk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICBpZiAobXNnLnR5cGUgPT09IFwiZG9tX3F1ZXJ5XCIpIHtcbiAgICBzZW5kUmVzcG9uc2UoaGFuZGxlRG9tUXVlcnkobXNnKSk7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgaWYgKG1zZy50eXBlID09PSBcImRvbV9jbGlja1wiKSB7XG4gICAgc2VuZFJlc3BvbnNlKGhhbmRsZURvbUNsaWNrKG1zZykpO1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIGlmIChtc2cudHlwZSA9PT0gXCJkb21fc2V0X3ZhbHVlXCIpIHtcbiAgICBzZW5kUmVzcG9uc2UoaGFuZGxlRG9tU2V0VmFsdWUobXNnKSk7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgaWYgKG1zZy50eXBlID09PSBcImRvbV9zdHlsZVwiKSB7XG4gICAgc2VuZFJlc3BvbnNlKGhhbmRsZURvbVN0eWxlKG1zZykpO1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIGlmIChtc2cudHlwZSA9PT0gXCJkb21fZ2V0X2h0bWxcIikge1xuICAgIHNlbmRSZXNwb25zZShoYW5kbGVEb21HZXRIdG1sKG1zZykpO1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIGlmIChtc2cudHlwZSA9PT0gXCJkb21faGlnaGxpZ2h0XCIpIHtcbiAgICBoYW5kbGVEb21IaWdobGlnaHQobXNnLCBzZW5kUmVzcG9uc2UpO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgaWYgKG1zZy50eXBlID09PSBcInNob3dfdGFiX3JldXNlX3Byb21wdFwiKSB7XG4gICAgaGFuZGxlU2hvd1RhYlJldXNlUHJvbXB0KG1zZywgc2VuZFJlc3BvbnNlKTtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICByZXR1cm4gZmFsc2U7XG59KTtcblxuZXhwb3J0IHt9XG4iLCJpbXBvcnQgeyBkZWZpbmVDb250ZW50U2NyaXB0IH0gZnJvbSAnd3h0L3V0aWxzL2RlZmluZS1jb250ZW50LXNjcmlwdCdcblxuZXhwb3J0IGRlZmF1bHQgZGVmaW5lQ29udGVudFNjcmlwdCh7XG4gIG1hdGNoZXM6IFsnaHR0cDovLyovKicsICdodHRwczovLyovKiddLFxuICBydW5BdDogJ2RvY3VtZW50X2lkbGUnLFxuICBhc3luYyBtYWluKCkge1xuICAgIGF3YWl0IGltcG9ydCgnLi9jb250ZW50LWltcGwnKVxuICB9LFxufSlcbiIsIi8vI3JlZ2lvbiBzcmMvdXRpbHMvaW50ZXJuYWwvbG9nZ2VyLnRzXG5mdW5jdGlvbiBwcmludChtZXRob2QsIC4uLmFyZ3MpIHtcblx0aWYgKGltcG9ydC5tZXRhLmVudi5NT0RFID09PSBcInByb2R1Y3Rpb25cIikgcmV0dXJuO1xuXHRpZiAodHlwZW9mIGFyZ3NbMF0gPT09IFwic3RyaW5nXCIpIG1ldGhvZChgW3d4dF0gJHthcmdzLnNoaWZ0KCl9YCwgLi4uYXJncyk7XG5cdGVsc2UgbWV0aG9kKFwiW3d4dF1cIiwgLi4uYXJncyk7XG59XG4vKiogV3JhcHBlciBhcm91bmQgYGNvbnNvbGVgIHdpdGggYSBcIlt3eHRdXCIgcHJlZml4ICovXG5jb25zdCBsb2dnZXIgPSB7XG5cdGRlYnVnOiAoLi4uYXJncykgPT4gcHJpbnQoY29uc29sZS5kZWJ1ZywgLi4uYXJncyksXG5cdGxvZzogKC4uLmFyZ3MpID0+IHByaW50KGNvbnNvbGUubG9nLCAuLi5hcmdzKSxcblx0d2FybjogKC4uLmFyZ3MpID0+IHByaW50KGNvbnNvbGUud2FybiwgLi4uYXJncyksXG5cdGVycm9yOiAoLi4uYXJncykgPT4gcHJpbnQoY29uc29sZS5lcnJvciwgLi4uYXJncylcbn07XG4vLyNlbmRyZWdpb25cbmV4cG9ydCB7IGxvZ2dlciB9O1xuIiwiLy8gI3JlZ2lvbiBzbmlwcGV0XG5leHBvcnQgY29uc3QgYnJvd3NlciA9IGdsb2JhbFRoaXMuYnJvd3Nlcj8ucnVudGltZT8uaWRcbiAgPyBnbG9iYWxUaGlzLmJyb3dzZXJcbiAgOiBnbG9iYWxUaGlzLmNocm9tZTtcbi8vICNlbmRyZWdpb24gc25pcHBldFxuIiwiaW1wb3J0IHsgYnJvd3NlciBhcyBicm93c2VyJDEgfSBmcm9tIFwiQHd4dC1kZXYvYnJvd3NlclwiO1xuLy8jcmVnaW9uIHNyYy9icm93c2VyLnRzXG4vKipcbiogQ29udGFpbnMgdGhlIGBicm93c2VyYCBleHBvcnQgd2hpY2ggeW91IHNob3VsZCB1c2UgdG8gYWNjZXNzIHRoZSBleHRlbnNpb25cbiogQVBJcyBpbiB5b3VyIHByb2plY3Q6XG4qXG4qIGBgYHRzXG4qIGltcG9ydCB7IGJyb3dzZXIgfSBmcm9tICd3eHQvYnJvd3Nlcic7XG4qXG4qIGJyb3dzZXIucnVudGltZS5vbkluc3RhbGxlZC5hZGRMaXN0ZW5lcigoKSA9PiB7XG4qICAgLy8gLi4uXG4qIH0pO1xuKiBgYGBcbipcbiogQG1vZHVsZSB3eHQvYnJvd3NlclxuKi9cbmNvbnN0IGJyb3dzZXIgPSBicm93c2VyJDE7XG4vLyNlbmRyZWdpb25cbmV4cG9ydCB7IGJyb3dzZXIgfTtcbiIsImltcG9ydCB7IGJyb3dzZXIgfSBmcm9tIFwid3h0L2Jyb3dzZXJcIjtcbi8vI3JlZ2lvbiBzcmMvdXRpbHMvaW50ZXJuYWwvY3VzdG9tLWV2ZW50cy50c1xudmFyIFd4dExvY2F0aW9uQ2hhbmdlRXZlbnQgPSBjbGFzcyBXeHRMb2NhdGlvbkNoYW5nZUV2ZW50IGV4dGVuZHMgRXZlbnQge1xuXHRzdGF0aWMgRVZFTlRfTkFNRSA9IGdldFVuaXF1ZUV2ZW50TmFtZShcInd4dDpsb2NhdGlvbmNoYW5nZVwiKTtcblx0Y29uc3RydWN0b3IobmV3VXJsLCBvbGRVcmwpIHtcblx0XHRzdXBlcihXeHRMb2NhdGlvbkNoYW5nZUV2ZW50LkVWRU5UX05BTUUsIHt9KTtcblx0XHR0aGlzLm5ld1VybCA9IG5ld1VybDtcblx0XHR0aGlzLm9sZFVybCA9IG9sZFVybDtcblx0fVxufTtcbi8qKlxuKiBSZXR1cm5zIGFuIGV2ZW50IG5hbWUgdW5pcXVlIHRvIHRoZSBleHRlbnNpb24gYW5kIGNvbnRlbnQgc2NyaXB0IHRoYXQnc1xuKiBydW5uaW5nLlxuKi9cbmZ1bmN0aW9uIGdldFVuaXF1ZUV2ZW50TmFtZShldmVudE5hbWUpIHtcblx0cmV0dXJuIGAke2Jyb3dzZXI/LnJ1bnRpbWU/LmlkfToke2ltcG9ydC5tZXRhLmVudi5FTlRSWVBPSU5UfToke2V2ZW50TmFtZX1gO1xufVxuLy8jZW5kcmVnaW9uXG5leHBvcnQgeyBXeHRMb2NhdGlvbkNoYW5nZUV2ZW50LCBnZXRVbmlxdWVFdmVudE5hbWUgfTtcbiIsImltcG9ydCB7IFd4dExvY2F0aW9uQ2hhbmdlRXZlbnQgfSBmcm9tIFwiLi9jdXN0b20tZXZlbnRzLm1qc1wiO1xuLy8jcmVnaW9uIHNyYy91dGlscy9pbnRlcm5hbC9sb2NhdGlvbi13YXRjaGVyLnRzXG5jb25zdCBzdXBwb3J0c05hdmlnYXRpb25BcGkgPSB0eXBlb2YgZ2xvYmFsVGhpcy5uYXZpZ2F0aW9uPy5hZGRFdmVudExpc3RlbmVyID09PSBcImZ1bmN0aW9uXCI7XG4vKipcbiogQ3JlYXRlIGEgdXRpbCB0aGF0IHdhdGNoZXMgZm9yIFVSTCBjaGFuZ2VzLCBkaXNwYXRjaGluZyB0aGUgY3VzdG9tIGV2ZW50IHdoZW5cbiogZGV0ZWN0ZWQuIFN0b3BzIHdhdGNoaW5nIHdoZW4gY29udGVudCBzY3JpcHQgaXMgaW52YWxpZGF0ZWQuIFVzZXMgTmF2aWdhdGlvblxuKiBBUEkgd2hlbiBhdmFpbGFibGUsIG90aGVyd2lzZSBmYWxscyBiYWNrIHRvIHBvbGxpbmcuXG4qL1xuZnVuY3Rpb24gY3JlYXRlTG9jYXRpb25XYXRjaGVyKGN0eCkge1xuXHRsZXQgbGFzdFVybDtcblx0bGV0IHdhdGNoaW5nID0gZmFsc2U7XG5cdHJldHVybiB7IHJ1bigpIHtcblx0XHRpZiAod2F0Y2hpbmcpIHJldHVybjtcblx0XHR3YXRjaGluZyA9IHRydWU7XG5cdFx0bGFzdFVybCA9IG5ldyBVUkwobG9jYXRpb24uaHJlZik7XG5cdFx0aWYgKHN1cHBvcnRzTmF2aWdhdGlvbkFwaSkgZ2xvYmFsVGhpcy5uYXZpZ2F0aW9uLmFkZEV2ZW50TGlzdGVuZXIoXCJuYXZpZ2F0ZVwiLCAoZXZlbnQpID0+IHtcblx0XHRcdGNvbnN0IG5ld1VybCA9IG5ldyBVUkwoZXZlbnQuZGVzdGluYXRpb24udXJsKTtcblx0XHRcdGlmIChuZXdVcmwuaHJlZiA9PT0gbGFzdFVybC5ocmVmKSByZXR1cm47XG5cdFx0XHR3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgV3h0TG9jYXRpb25DaGFuZ2VFdmVudChuZXdVcmwsIGxhc3RVcmwpKTtcblx0XHRcdGxhc3RVcmwgPSBuZXdVcmw7XG5cdFx0fSwgeyBzaWduYWw6IGN0eC5zaWduYWwgfSk7XG5cdFx0ZWxzZSBjdHguc2V0SW50ZXJ2YWwoKCkgPT4ge1xuXHRcdFx0Y29uc3QgbmV3VXJsID0gbmV3IFVSTChsb2NhdGlvbi5ocmVmKTtcblx0XHRcdGlmIChuZXdVcmwuaHJlZiAhPT0gbGFzdFVybC5ocmVmKSB7XG5cdFx0XHRcdHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBXeHRMb2NhdGlvbkNoYW5nZUV2ZW50KG5ld1VybCwgbGFzdFVybCkpO1xuXHRcdFx0XHRsYXN0VXJsID0gbmV3VXJsO1xuXHRcdFx0fVxuXHRcdH0sIDFlMyk7XG5cdH0gfTtcbn1cbi8vI2VuZHJlZ2lvblxuZXhwb3J0IHsgY3JlYXRlTG9jYXRpb25XYXRjaGVyIH07XG4iLCJpbXBvcnQgeyBsb2dnZXIgfSBmcm9tIFwiLi9pbnRlcm5hbC9sb2dnZXIubWpzXCI7XG5pbXBvcnQgeyBnZXRVbmlxdWVFdmVudE5hbWUgfSBmcm9tIFwiLi9pbnRlcm5hbC9jdXN0b20tZXZlbnRzLm1qc1wiO1xuaW1wb3J0IHsgY3JlYXRlTG9jYXRpb25XYXRjaGVyIH0gZnJvbSBcIi4vaW50ZXJuYWwvbG9jYXRpb24td2F0Y2hlci5tanNcIjtcbmltcG9ydCB7IGJyb3dzZXIgfSBmcm9tIFwid3h0L2Jyb3dzZXJcIjtcbi8vI3JlZ2lvbiBzcmMvdXRpbHMvY29udGVudC1zY3JpcHQtY29udGV4dC50c1xuLyoqXG4qIEltcGxlbWVudHNcbiogW2BBYm9ydENvbnRyb2xsZXJgXShodHRwczovL2RldmVsb3Blci5tb3ppbGxhLm9yZy9lbi1VUy9kb2NzL1dlYi9BUEkvQWJvcnRDb250cm9sbGVyKS5cbiogVXNlZCB0byBkZXRlY3QgYW5kIHN0b3AgY29udGVudCBzY3JpcHQgY29kZSB3aGVuIHRoZSBzY3JpcHQgaXMgaW52YWxpZGF0ZWQuXG4qXG4qIEl0IGFsc28gcHJvdmlkZXMgc2V2ZXJhbCB1dGlsaXRpZXMgbGlrZSBgY3R4LnNldFRpbWVvdXRgIGFuZFxuKiBgY3R4LnNldEludGVydmFsYCB0aGF0IHNob3VsZCBiZSB1c2VkIGluIGNvbnRlbnQgc2NyaXB0cyBpbnN0ZWFkIG9mXG4qIGB3aW5kb3cuc2V0VGltZW91dGAgb3IgYHdpbmRvdy5zZXRJbnRlcnZhbGAuXG4qXG4qIFRvIGNyZWF0ZSBjb250ZXh0IGZvciB0ZXN0aW5nLCB5b3UgY2FuIHVzZSB0aGUgY2xhc3MncyBjb25zdHJ1Y3RvcjpcbipcbiogYGBgdHNcbiogaW1wb3J0IHsgQ29udGVudFNjcmlwdENvbnRleHQgfSBmcm9tICd3eHQvdXRpbHMvY29udGVudC1zY3JpcHRzLWNvbnRleHQnO1xuKlxuKiB0ZXN0KCdzdG9yYWdlIGxpc3RlbmVyIHNob3VsZCBiZSByZW1vdmVkIHdoZW4gY29udGV4dCBpcyBpbnZhbGlkYXRlZCcsICgpID0+IHtcbiogICBjb25zdCBjdHggPSBuZXcgQ29udGVudFNjcmlwdENvbnRleHQoJ3Rlc3QnKTtcbiogICBjb25zdCBpdGVtID0gc3RvcmFnZS5kZWZpbmVJdGVtKCdsb2NhbDpjb3VudCcsIHsgZGVmYXVsdFZhbHVlOiAwIH0pO1xuKiAgIGNvbnN0IHdhdGNoZXIgPSB2aS5mbigpO1xuKlxuKiAgIGNvbnN0IHVud2F0Y2ggPSBpdGVtLndhdGNoKHdhdGNoZXIpO1xuKiAgIGN0eC5vbkludmFsaWRhdGVkKHVud2F0Y2gpOyAvLyBMaXN0ZW4gZm9yIGludmFsaWRhdGUgaGVyZVxuKlxuKiAgIGF3YWl0IGl0ZW0uc2V0VmFsdWUoMSk7XG4qICAgZXhwZWN0KHdhdGNoZXIpLnRvQmVDYWxsZWRUaW1lcygxKTtcbiogICBleHBlY3Qod2F0Y2hlcikudG9CZUNhbGxlZFdpdGgoMSwgMCk7XG4qXG4qICAgY3R4Lm5vdGlmeUludmFsaWRhdGVkKCk7IC8vIFVzZSB0aGlzIGZ1bmN0aW9uIHRvIGludmFsaWRhdGUgdGhlIGNvbnRleHRcbiogICBhd2FpdCBpdGVtLnNldFZhbHVlKDIpO1xuKiAgIGV4cGVjdCh3YXRjaGVyKS50b0JlQ2FsbGVkVGltZXMoMSk7XG4qIH0pO1xuKiBgYGBcbiovXG52YXIgQ29udGVudFNjcmlwdENvbnRleHQgPSBjbGFzcyBDb250ZW50U2NyaXB0Q29udGV4dCB7XG5cdHN0YXRpYyBTQ1JJUFRfU1RBUlRFRF9NRVNTQUdFX1RZUEUgPSBnZXRVbmlxdWVFdmVudE5hbWUoXCJ3eHQ6Y29udGVudC1zY3JpcHQtc3RhcnRlZFwiKTtcblx0aWQ7XG5cdGFib3J0Q29udHJvbGxlcjtcblx0bG9jYXRpb25XYXRjaGVyID0gY3JlYXRlTG9jYXRpb25XYXRjaGVyKHRoaXMpO1xuXHRjb25zdHJ1Y3Rvcihjb250ZW50U2NyaXB0TmFtZSwgb3B0aW9ucykge1xuXHRcdHRoaXMuY29udGVudFNjcmlwdE5hbWUgPSBjb250ZW50U2NyaXB0TmFtZTtcblx0XHR0aGlzLm9wdGlvbnMgPSBvcHRpb25zO1xuXHRcdHRoaXMuaWQgPSBNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyKTtcblx0XHR0aGlzLmFib3J0Q29udHJvbGxlciA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcblx0XHR0aGlzLnN0b3BPbGRTY3JpcHRzKCk7XG5cdFx0dGhpcy5saXN0ZW5Gb3JOZXdlclNjcmlwdHMoKTtcblx0fVxuXHRnZXQgc2lnbmFsKCkge1xuXHRcdHJldHVybiB0aGlzLmFib3J0Q29udHJvbGxlci5zaWduYWw7XG5cdH1cblx0YWJvcnQocmVhc29uKSB7XG5cdFx0cmV0dXJuIHRoaXMuYWJvcnRDb250cm9sbGVyLmFib3J0KHJlYXNvbik7XG5cdH1cblx0Z2V0IGlzSW52YWxpZCgpIHtcblx0XHRpZiAoYnJvd3Nlci5ydW50aW1lPy5pZCA9PSBudWxsKSB0aGlzLm5vdGlmeUludmFsaWRhdGVkKCk7XG5cdFx0cmV0dXJuIHRoaXMuc2lnbmFsLmFib3J0ZWQ7XG5cdH1cblx0Z2V0IGlzVmFsaWQoKSB7XG5cdFx0cmV0dXJuICF0aGlzLmlzSW52YWxpZDtcblx0fVxuXHQvKipcblx0KiBBZGQgYSBsaXN0ZW5lciB0aGF0IGlzIGNhbGxlZCB3aGVuIHRoZSBjb250ZW50IHNjcmlwdCdzIGNvbnRleHQgaXNcblx0KiBpbnZhbGlkYXRlZC5cblx0KlxuXHQqIEBleGFtcGxlXG5cdCogICBicm93c2VyLnJ1bnRpbWUub25NZXNzYWdlLmFkZExpc3RlbmVyKGNiKTtcblx0KiAgIGNvbnN0IHJlbW92ZUludmFsaWRhdGVkTGlzdGVuZXIgPSBjdHgub25JbnZhbGlkYXRlZCgoKSA9PiB7XG5cdCogICAgIGJyb3dzZXIucnVudGltZS5vbk1lc3NhZ2UucmVtb3ZlTGlzdGVuZXIoY2IpO1xuXHQqICAgfSk7XG5cdCogICAvLyAuLi5cblx0KiAgIHJlbW92ZUludmFsaWRhdGVkTGlzdGVuZXIoKTtcblx0KlxuXHQqIEByZXR1cm5zIEEgZnVuY3Rpb24gdG8gcmVtb3ZlIHRoZSBsaXN0ZW5lci5cblx0Ki9cblx0b25JbnZhbGlkYXRlZChjYikge1xuXHRcdHRoaXMuc2lnbmFsLmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBjYik7XG5cdFx0cmV0dXJuICgpID0+IHRoaXMuc2lnbmFsLnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBjYik7XG5cdH1cblx0LyoqXG5cdCogUmV0dXJuIGEgcHJvbWlzZSB0aGF0IG5ldmVyIHJlc29sdmVzLiBVc2VmdWwgaWYgeW91IGhhdmUgYW4gYXN5bmMgZnVuY3Rpb25cblx0KiB0aGF0IHNob3VsZG4ndCBydW4gYWZ0ZXIgdGhlIGNvbnRleHQgaXMgZXhwaXJlZC5cblx0KlxuXHQqIEBleGFtcGxlXG5cdCogICBjb25zdCBnZXRWYWx1ZUZyb21TdG9yYWdlID0gYXN5bmMgKCkgPT4ge1xuXHQqICAgICBpZiAoY3R4LmlzSW52YWxpZCkgcmV0dXJuIGN0eC5ibG9jaygpO1xuXHQqXG5cdCogICAgIC8vIC4uLlxuXHQqICAgfTtcblx0Ki9cblx0YmxvY2soKSB7XG5cdFx0cmV0dXJuIG5ldyBQcm9taXNlKCgpID0+IHt9KTtcblx0fVxuXHQvKipcblx0KiBXcmFwcGVyIGFyb3VuZCBgd2luZG93LnNldEludGVydmFsYCB0aGF0IGF1dG9tYXRpY2FsbHkgY2xlYXJzIHRoZSBpbnRlcnZhbFxuXHQqIHdoZW4gaW52YWxpZGF0ZWQuXG5cdCpcblx0KiBJbnRlcnZhbHMgY2FuIGJlIGNsZWFyZWQgYnkgY2FsbGluZyB0aGUgbm9ybWFsIGBjbGVhckludGVydmFsYCBmdW5jdGlvbi5cblx0Ki9cblx0c2V0SW50ZXJ2YWwoaGFuZGxlciwgdGltZW91dCkge1xuXHRcdGNvbnN0IGlkID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuXHRcdFx0aWYgKHRoaXMuaXNWYWxpZCkgaGFuZGxlcigpO1xuXHRcdH0sIHRpbWVvdXQpO1xuXHRcdHRoaXMub25JbnZhbGlkYXRlZCgoKSA9PiBjbGVhckludGVydmFsKGlkKSk7XG5cdFx0cmV0dXJuIGlkO1xuXHR9XG5cdC8qKlxuXHQqIFdyYXBwZXIgYXJvdW5kIGB3aW5kb3cuc2V0VGltZW91dGAgdGhhdCBhdXRvbWF0aWNhbGx5IGNsZWFycyB0aGUgaW50ZXJ2YWxcblx0KiB3aGVuIGludmFsaWRhdGVkLlxuXHQqXG5cdCogVGltZW91dHMgY2FuIGJlIGNsZWFyZWQgYnkgY2FsbGluZyB0aGUgbm9ybWFsIGBzZXRUaW1lb3V0YCBmdW5jdGlvbi5cblx0Ki9cblx0c2V0VGltZW91dChoYW5kbGVyLCB0aW1lb3V0KSB7XG5cdFx0Y29uc3QgaWQgPSBzZXRUaW1lb3V0KCgpID0+IHtcblx0XHRcdGlmICh0aGlzLmlzVmFsaWQpIGhhbmRsZXIoKTtcblx0XHR9LCB0aW1lb3V0KTtcblx0XHR0aGlzLm9uSW52YWxpZGF0ZWQoKCkgPT4gY2xlYXJUaW1lb3V0KGlkKSk7XG5cdFx0cmV0dXJuIGlkO1xuXHR9XG5cdC8qKlxuXHQqIFdyYXBwZXIgYXJvdW5kIGB3aW5kb3cucmVxdWVzdEFuaW1hdGlvbkZyYW1lYCB0aGF0IGF1dG9tYXRpY2FsbHkgY2FuY2Vsc1xuXHQqIHRoZSByZXF1ZXN0IHdoZW4gaW52YWxpZGF0ZWQuXG5cdCpcblx0KiBDYWxsYmFja3MgY2FuIGJlIGNhbmNlbGVkIGJ5IGNhbGxpbmcgdGhlIG5vcm1hbCBgY2FuY2VsQW5pbWF0aW9uRnJhbWVgXG5cdCogZnVuY3Rpb24uXG5cdCovXG5cdHJlcXVlc3RBbmltYXRpb25GcmFtZShjYWxsYmFjaykge1xuXHRcdGNvbnN0IGlkID0gcmVxdWVzdEFuaW1hdGlvbkZyYW1lKCguLi5hcmdzKSA9PiB7XG5cdFx0XHRpZiAodGhpcy5pc1ZhbGlkKSBjYWxsYmFjayguLi5hcmdzKTtcblx0XHR9KTtcblx0XHR0aGlzLm9uSW52YWxpZGF0ZWQoKCkgPT4gY2FuY2VsQW5pbWF0aW9uRnJhbWUoaWQpKTtcblx0XHRyZXR1cm4gaWQ7XG5cdH1cblx0LyoqXG5cdCogV3JhcHBlciBhcm91bmQgYHdpbmRvdy5yZXF1ZXN0SWRsZUNhbGxiYWNrYCB0aGF0IGF1dG9tYXRpY2FsbHkgY2FuY2VscyB0aGVcblx0KiByZXF1ZXN0IHdoZW4gaW52YWxpZGF0ZWQuXG5cdCpcblx0KiBDYWxsYmFja3MgY2FuIGJlIGNhbmNlbGVkIGJ5IGNhbGxpbmcgdGhlIG5vcm1hbCBgY2FuY2VsSWRsZUNhbGxiYWNrYFxuXHQqIGZ1bmN0aW9uLlxuXHQqL1xuXHRyZXF1ZXN0SWRsZUNhbGxiYWNrKGNhbGxiYWNrLCBvcHRpb25zKSB7XG5cdFx0Y29uc3QgaWQgPSByZXF1ZXN0SWRsZUNhbGxiYWNrKCguLi5hcmdzKSA9PiB7XG5cdFx0XHRpZiAoIXRoaXMuc2lnbmFsLmFib3J0ZWQpIGNhbGxiYWNrKC4uLmFyZ3MpO1xuXHRcdH0sIG9wdGlvbnMpO1xuXHRcdHRoaXMub25JbnZhbGlkYXRlZCgoKSA9PiBjYW5jZWxJZGxlQ2FsbGJhY2soaWQpKTtcblx0XHRyZXR1cm4gaWQ7XG5cdH1cblx0YWRkRXZlbnRMaXN0ZW5lcih0YXJnZXQsIHR5cGUsIGhhbmRsZXIsIG9wdGlvbnMpIHtcblx0XHRpZiAodHlwZSA9PT0gXCJ3eHQ6bG9jYXRpb25jaGFuZ2VcIikge1xuXHRcdFx0aWYgKHRoaXMuaXNWYWxpZCkgdGhpcy5sb2NhdGlvbldhdGNoZXIucnVuKCk7XG5cdFx0fVxuXHRcdHRhcmdldC5hZGRFdmVudExpc3RlbmVyPy4odHlwZS5zdGFydHNXaXRoKFwid3h0OlwiKSA/IGdldFVuaXF1ZUV2ZW50TmFtZSh0eXBlKSA6IHR5cGUsIGhhbmRsZXIsIHtcblx0XHRcdC4uLm9wdGlvbnMsXG5cdFx0XHRzaWduYWw6IHRoaXMuc2lnbmFsXG5cdFx0fSk7XG5cdH1cblx0LyoqXG5cdCogQGludGVybmFsXG5cdCogQWJvcnQgdGhlIGFib3J0IGNvbnRyb2xsZXIgYW5kIGV4ZWN1dGUgYWxsIGBvbkludmFsaWRhdGVkYCBsaXN0ZW5lcnMuXG5cdCovXG5cdG5vdGlmeUludmFsaWRhdGVkKCkge1xuXHRcdHRoaXMuYWJvcnQoXCJDb250ZW50IHNjcmlwdCBjb250ZXh0IGludmFsaWRhdGVkXCIpO1xuXHRcdGxvZ2dlci5kZWJ1ZyhgQ29udGVudCBzY3JpcHQgXCIke3RoaXMuY29udGVudFNjcmlwdE5hbWV9XCIgY29udGV4dCBpbnZhbGlkYXRlZGApO1xuXHR9XG5cdHN0b3BPbGRTY3JpcHRzKCkge1xuXHRcdGRvY3VtZW50LmRpc3BhdGNoRXZlbnQobmV3IEN1c3RvbUV2ZW50KENvbnRlbnRTY3JpcHRDb250ZXh0LlNDUklQVF9TVEFSVEVEX01FU1NBR0VfVFlQRSwgeyBkZXRhaWw6IHtcblx0XHRcdGNvbnRlbnRTY3JpcHROYW1lOiB0aGlzLmNvbnRlbnRTY3JpcHROYW1lLFxuXHRcdFx0bWVzc2FnZUlkOiB0aGlzLmlkXG5cdFx0fSB9KSk7XG5cdFx0d2luZG93LnBvc3RNZXNzYWdlKHtcblx0XHRcdHR5cGU6IENvbnRlbnRTY3JpcHRDb250ZXh0LlNDUklQVF9TVEFSVEVEX01FU1NBR0VfVFlQRSxcblx0XHRcdGNvbnRlbnRTY3JpcHROYW1lOiB0aGlzLmNvbnRlbnRTY3JpcHROYW1lLFxuXHRcdFx0bWVzc2FnZUlkOiB0aGlzLmlkXG5cdFx0fSwgXCIqXCIpO1xuXHR9XG5cdHZlcmlmeVNjcmlwdFN0YXJ0ZWRFdmVudChldmVudCkge1xuXHRcdGNvbnN0IGlzU2FtZUNvbnRlbnRTY3JpcHQgPSBldmVudC5kZXRhaWw/LmNvbnRlbnRTY3JpcHROYW1lID09PSB0aGlzLmNvbnRlbnRTY3JpcHROYW1lO1xuXHRcdGNvbnN0IGlzRnJvbVNlbGYgPSBldmVudC5kZXRhaWw/Lm1lc3NhZ2VJZCA9PT0gdGhpcy5pZDtcblx0XHRyZXR1cm4gaXNTYW1lQ29udGVudFNjcmlwdCAmJiAhaXNGcm9tU2VsZjtcblx0fVxuXHRsaXN0ZW5Gb3JOZXdlclNjcmlwdHMoKSB7XG5cdFx0Y29uc3QgY2IgPSAoZXZlbnQpID0+IHtcblx0XHRcdGlmICghKGV2ZW50IGluc3RhbmNlb2YgQ3VzdG9tRXZlbnQpIHx8ICF0aGlzLnZlcmlmeVNjcmlwdFN0YXJ0ZWRFdmVudChldmVudCkpIHJldHVybjtcblx0XHRcdHRoaXMubm90aWZ5SW52YWxpZGF0ZWQoKTtcblx0XHR9O1xuXHRcdGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoQ29udGVudFNjcmlwdENvbnRleHQuU0NSSVBUX1NUQVJURURfTUVTU0FHRV9UWVBFLCBjYik7XG5cdFx0dGhpcy5vbkludmFsaWRhdGVkKCgpID0+IGRvY3VtZW50LnJlbW92ZUV2ZW50TGlzdGVuZXIoQ29udGVudFNjcmlwdENvbnRleHQuU0NSSVBUX1NUQVJURURfTUVTU0FHRV9UWVBFLCBjYikpO1xuXHR9XG59O1xuLy8jZW5kcmVnaW9uXG5leHBvcnQgeyBDb250ZW50U2NyaXB0Q29udGV4dCB9O1xuIl0sInhfZ29vZ2xlX2lnbm9yZUxpc3QiOlswLDMsNCw1LDYsNyw4XSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7OztDQUNBLFNBQVMsb0JBQW9CLFlBQVk7QUFDeEMsU0FBTzs7Ozs7Q0NRUixTQUFTLGFBQWEsTUFBTSxZQUFZLFlBQVk7RUFDbEQsTUFBTSxhQUFhLE9BQU8sUUFBUSxHQUFHLENBQUMsUUFBUSxRQUFRLElBQUksQ0FBQyxNQUFNO0FBQ2pFLFNBQU8sV0FBVyxTQUFTLFlBQVksV0FBVyxNQUFNLEdBQUcsVUFBVSxHQUFHLFFBQVE7O0NBR2xGLFNBQVMs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