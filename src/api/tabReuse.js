/* global chrome */

export async function isTabReuseEnabled() {
  const { reuse } = await chrome.storage.local.get({ reuse: false });
  return !!reuse;
}

export function normalizeReusableUrl(url) {
  const raw = String(url || "").trim();
  if (!/^https?:\/\//i.test(raw)) return "";

  try {
    const parsed = new URL(raw);
    parsed.hash = "";
    return parsed.toString();
  } catch (_error) {
    return raw.split("#")[0];
  }
}

export async function findReusableTab(url, { excludeTabId } = {}) {
  const normalizedUrl = normalizeReusableUrl(url);
  if (!normalizedUrl) return null;

  const tabs = await chrome.tabs.query({});
  return tabs.find(tab => {
    if (!tab?.id || tab.id === excludeTabId) return false;
    const candidateUrl = normalizeReusableUrl(tab.pendingUrl || tab.url);
    return candidateUrl === normalizedUrl;
  }) || null;
}

export async function focusReusableTab(tab, { targetWindowId } = {}) {
  if (!tab?.id) return null;

  let nextTab = tab;
  if (targetWindowId && nextTab.windowId && nextTab.windowId !== targetWindowId) {
    nextTab = await chrome.tabs.move(nextTab.id, { windowId: targetWindowId, index: -1 });
  }

  nextTab = await chrome.tabs.update(nextTab.id, { active: true });
  await chrome.windows.update(nextTab.windowId, { focused: true });
  return nextTab;
}
