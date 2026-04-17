/* global chrome */
import {
    focusReusableTab,
    isTabReuseEnabled,
    findReusableTab,
    normalizeReusableUrl,
    getReuseDomainKey,
    getReuseDomainPolicy,
    setReuseDomainPolicy
} from "./api/tabReuse";

const REUSE_PROMPT_TIMEOUT_MS = 30000;
const pendingReusePrompts = new Map();

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
    } catch (_error) {
        // Ignore missing/already closed tabs.
    }
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
                resolve({ success: false, error: chrome.runtime.lastError.message });
                return;
            }
            if (!response?.success) {
                resolve({ success: false, error: response?.error || "Prompt not acknowledged" });
                return;
            }
            resolve({ success: true });
        });
    });
}

async function applyReuseDecision(pending, decision, rememberChoice) {
    const normalizedDecision = decision === "keep" ? "keep" : "reuse";

    if (rememberChoice && pending.domainKey) {
        await setReuseDomainPolicy(pending.domainKey, normalizedDecision);
    }

    if (normalizedDecision === "reuse") {
        await focusTabIfExists(pending.existingTabId);
        await closeTabIfExists(pending.newTabId);
        return;
    }

    await focusTabIfExists(pending.newTabId);
}

// ========== Message handler (must be registered first for reliable wake-up) ==========

/**
 * Handle messages from the side panel.
 * "tab_extract" sends a message to the target tab's content script
 * to extract page text content. Uses chrome.tabs.sendMessage which
 * communicates with the auto-injected content script (no host_permissions needed).
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    function forwardToTab(tabId, payload) {
        let responded = false;
        const timerId = setTimeout(() => {
            if (responded) return;
            responded = true;
            sendResponse({ success: false, error: "Timed out waiting for content script response" });
        }, 10000);

        chrome.tabs.sendMessage(tabId, payload, (response) => {
            if (responded) return;
            responded = true;
            clearTimeout(timerId);
            if (chrome.runtime.lastError) {
                sendResponse({ success: false, error: chrome.runtime.lastError.message });
            } else if (response) {
                sendResponse({ success: true, data: response });
            } else {
                sendResponse({ success: false, error: "Content script did not respond" });
            }
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
            sendResponse({ success: false, error: "Reuse prompt is no longer pending" });
            return false;
        }

        applyReuseDecision(pending, msg.decision, !!msg.rememberChoice)
            .then(() => sendResponse({ success: true }))
            .catch((error) => sendResponse({ success: false, error: error?.message || String(error) }));
        return true;
    }
    return false;
});

// ========== Side panel setup ==========

// Open side panel when extension icon is clicked
chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
    // Ignore unsupported/temporary side panel initialization failures.
});

// ========== Tab reuse ==========

// When navigating to a URL already open, switch to that tab instead
chrome.webNavigation.onDOMContentLoaded.addListener(async e => {
    try {
        if (!e?.tabId || e.frameId !== 0) return;
        if (!normalizeReusableUrl(e.url)) return;
        if (pendingReusePrompts.has(e.tabId)) return;

        const reuse = await isTabReuseEnabled();
        if (!reuse) return;

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
        const promptResult = await tryShowReusePrompt(focusedReusableTab.id, {
            type: "show_tab_reuse_prompt",
            newTabId: e.tabId,
            existingTabId: focusedReusableTab.id,
            domainKey,
            newUrl: e.url,
            newTitle: newTab?.title || e.url,
            existingUrl: focusedReusableTab.url || e.url,
            existingTitle: focusedReusableTab.title || focusedReusableTab.url || e.url
        });

        if (!promptResult.success) {
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

// ========== Tab event notifications to side panel ==========

chrome.webNavigation.onCompleted.addListener(async e => {
    if (e.tabId && e.url && e.url.startsWith("http") && e.frameId === 0) {
        try { await chrome.runtime.sendMessage({ type: 'open', tabId: e.tabId }); } catch (e) {/* ignore */}
    }
});

chrome.tabs.onRemoved.addListener(async function (tabId) {
    clearPendingReusePrompt(tabId);
    for (const [pendingTabId, pending] of pendingReusePrompts.entries()) {
        if (pending.existingTabId === tabId) {
            clearPendingReusePrompt(pendingTabId);
        }
    }
    try { await chrome.runtime.sendMessage({ type: 'close', tabId }); } catch (e) {/* ignore */}
});

chrome.tabs.onActivated.addListener(async function (activeInfo) {
    try { await chrome.runtime.sendMessage({ type: 'active', tabId: activeInfo.tabId }); } catch (e) {/* ignore */}
    let { tabActivity } = await chrome.storage.local.get({ tabActivity: {} });
    tabActivity[activeInfo.tabId] = Date.now();
    await chrome.storage.local.set({ tabActivity });
});

// ========== Auto memory release ==========

chrome.runtime.onInstalled.addListener(() => {
    chrome.alarms?.create("check-idle-tabs", { periodInMinutes: 1 });
});

if (chrome.alarms) {
    chrome.alarms.get("check-idle-tabs", (alarm) => {
        if (!alarm) chrome.alarms.create("check-idle-tabs", { periodInMinutes: 1 });
    });

    chrome.alarms.onAlarm.addListener(async (alarm) => {
        if (alarm.name !== "check-idle-tabs") return;

        let { suspendTimeout, tabActivity } = await chrome.storage.local.get({
            suspendTimeout: 0,
            tabActivity: {}
        });
        if (!suspendTimeout || suspendTimeout <= 0) return;

        const now = Date.now();
        const timeoutMs = suspendTimeout * 60 * 1000;
        const tabs = await chrome.tabs.query({});

        for (const tab of tabs) {
            if (tab.active || tab.pinned || tab.discarded || !tab.url || !tab.url.startsWith("http")) continue;
            const lastActive = tabActivity[tab.id] || 0;
            if (lastActive > 0 && (now - lastActive) > timeoutMs) {
                try { await chrome.tabs.discard(tab.id); } catch (e) {/* ignore */}
            }
        }
    });
}
