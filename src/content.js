/* global chrome */

const TEXT_LIMIT = 500;
const HTML_LIMIT = 4000;
const HIGHLIGHT_STYLE_ID = "__tab_manager_highlight_style__";
const HIGHLIGHT_OVERLAY_ID = "__tab_manager_highlight_overlay__";
let highlightTimerId = null;

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

function findMatchingElements({ selector, text, matchExact }) {
  if (!selector && !text) {
    return { error: "Please provide at least one locator: selector or text" };
  }

  let elements;
  try {
    elements = selector
      ? Array.from(document.querySelectorAll(selector))
      : Array.from(document.querySelectorAll("body *"));
  } catch (e) {
    return { error: `Invalid selector: ${e.message}` };
  }

  if (!text) {
    return { elements };
  }

  const search = String(text).trim().toLowerCase();
  const filtered = elements.filter(element => {
    const candidate = getSearchableText(element);
    return matchExact ? candidate === search : candidate.includes(search);
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
  if (highlightTimerId) {
    clearTimeout(highlightTimerId);
    highlightTimerId = null;
  }
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

  highlightTimerId = window.setTimeout(() => {
    overlay.remove();
    highlightTimerId = null;
  }, durationMs);
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

  if (setter) {
    setter.call(element, stringValue);
  } else {
    element.value = stringValue;
  }

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
  element.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
  if (typeof element.focus === "function") {
    try { element.focus({ preventScroll: true }); } catch (e) { element.focus(); }
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
  if (!["input", "textarea", "select"].includes(tagName)) {
    return { error: `Element is not a form field: <${tagName}>` };
  }

  element.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
  if (typeof element.focus === "function") {
    try { element.focus({ preventScroll: true }); } catch (e) { element.focus(); }
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
  if (!msg.styles || typeof msg.styles !== "object" || Array.isArray(msg.styles)) {
    return { error: "Please provide a styles object" };
  }

  const durationMs = Math.min(10000, Math.max(0, Number.isFinite(msg.durationMs) ? msg.durationMs : 2000));
  const element = resolved.element;
  const previous = {};

  element.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
  for (const [key, value] of Object.entries(msg.styles)) {
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
    styles: msg.styles,
    target: serializeElement(element, resolved.index)
  };
}

function handleDomGetHtml(msg) {
  const resolved = resolveElement(msg);
  if (resolved.error) return { error: resolved.error };

  const mode = msg.mode === "inner" ? "inner" : "outer";
  const maxLength = Math.min(20000, Math.max(200, Number.isInteger(msg.maxLength) ? msg.maxLength : HTML_LIMIT));
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

  const durationMs = Math.min(5000, Math.max(300, Number.isFinite(msg.durationMs) ? msg.durationMs : 1000));
  const element = resolved.element;
  element.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });

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

/**
 * Content script injected into all http/https pages.
 * Responds to messages for page extraction, scrolling, and structured DOM actions.
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "tab_extract_content") {
    sendResponse({
      url: document.URL,
      title: document.title,
      content: document.body.innerText.substring(0, 8000)
    });
    return false;
  }

  if (msg.type === "tab_scroll") {
    const stateBefore = getScrollState();
    const behavior = msg.behavior === "smooth" ? "smooth" : "auto";
    const position = typeof msg.position === "string" ? msg.position : null;
    let top = null;

    if (position === "top") {
      top = 0;
    } else if (position === "bottom") {
      top = stateBefore.maxScrollY;
    } else if (typeof msg.deltaY === "number" && Number.isFinite(msg.deltaY)) {
      top = stateBefore.scrollY + msg.deltaY;
    } else if (typeof msg.pageFraction === "number" && Number.isFinite(msg.pageFraction)) {
      top = stateBefore.scrollY + (stateBefore.viewportHeight * msg.pageFraction);
    } else {
      top = stateBefore.scrollY + stateBefore.viewportHeight * 0.8;
    }

    top = Math.max(0, Math.min(stateBefore.maxScrollY, top));
    window.scrollTo({ top, behavior });

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

  return false;
});
