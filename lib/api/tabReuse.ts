const REUSE_DOMAIN_POLICIES_KEY = "reuseDomainPolicies";

export type ReuseDomainDecision = "reuse" | "keep";

export async function isTabReuseEnabled(): Promise<boolean> {
  const { reuse } = await chrome.storage.local.get({ reuse: false });
  return !!reuse;
}

export function getReuseDomainKey(url: string | undefined): string {
  const normalizedUrl = normalizeReusableUrl(url);
  if (!normalizedUrl) return "";

  try {
    return new URL(normalizedUrl).hostname || "";
  } catch {
    return "";
  }
}

export function normalizeReusableUrl(url: string | undefined): string {
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

export async function findReusableTab(
  url: string,
  opts: { excludeTabId?: number } = {}
): Promise<chrome.tabs.Tab | null> {
  const normalizedUrl = normalizeReusableUrl(url);
  if (!normalizedUrl) return null;

  const tabs = await chrome.tabs.query({});
  const found =
    tabs.find((tab) => {
      if (!tab?.id || tab.id === opts.excludeTabId) return false;
      const candidateUrl = normalizeReusableUrl(tab.pendingUrl || tab.url);
      return candidateUrl === normalizedUrl;
    }) || null;
  return found;
}

export async function getReuseDomainPolicies(): Promise<Record<string, string>> {
  const { [REUSE_DOMAIN_POLICIES_KEY]: reuseDomainPolicies } = await chrome.storage.local.get({
    [REUSE_DOMAIN_POLICIES_KEY]: {} as Record<string, string>,
  });
  return reuseDomainPolicies && typeof reuseDomainPolicies === "object" ? reuseDomainPolicies : {};
}

export async function getReuseDomainPolicy(domainKey: string): Promise<ReuseDomainDecision | ""> {
  if (!domainKey) return "";
  const policies = await getReuseDomainPolicies();
  const value = policies[domainKey];
  return value === "reuse" || value === "keep" ? value : "";
}

export async function setReuseDomainPolicy(domainKey: string, decision: ReuseDomainDecision | ""): Promise<void> {
  if (!domainKey) return;
  const policies = await getReuseDomainPolicies();

  if (decision === "reuse" || decision === "keep") {
    policies[domainKey] = decision;
  } else {
    delete policies[domainKey];
  }

  await chrome.storage.local.set({ [REUSE_DOMAIN_POLICIES_KEY]: policies });
}

export async function clearReuseDomainPolicies(): Promise<void> {
  await chrome.storage.local.set({ [REUSE_DOMAIN_POLICIES_KEY]: {} });
}

export async function focusReusableTab(tab: chrome.tabs.Tab): Promise<chrome.tabs.Tab | null> {
  if (!tab?.id) return null;

  await chrome.windows.update(tab.windowId, { focused: true });
  const nextTab = await chrome.tabs.update(tab.id, { active: true });
  if (!nextTab?.windowId) return nextTab ?? null;
  await chrome.windows.update(nextTab.windowId, { focused: true });
  return nextTab;
}
