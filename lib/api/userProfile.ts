import { textComplete, type LlmTextMessage, getLLMConfigForMemory } from "./llmTextComplete";

const KEY_PROFILE_SUMMARY = "user_profile_summary";
const KEY_META = "user_profile_meta";

interface ProfileMeta {
  enabled?: boolean;
}

async function getProfileMeta(): Promise<ProfileMeta> {
  const { [KEY_META]: meta } = await chrome.storage.local.get({ [KEY_META]: {} as ProfileMeta });
  return meta && typeof meta === "object" ? meta : {};
}

async function saveProfileMeta(patch: Partial<ProfileMeta>): Promise<void> {
  const meta = await getProfileMeta();
  await chrome.storage.local.set({ [KEY_META]: { ...meta, ...patch } });
}

export async function isProfileEnabled(): Promise<boolean> {
  const meta = await getProfileMeta();
  return meta.enabled !== false;
}

export async function setProfileEnabled(enabled: boolean): Promise<void> {
  await saveProfileMeta({ enabled });
}

export async function getProfileSummary(): Promise<string> {
  const { [KEY_PROFILE_SUMMARY]: s } = await chrome.storage.local.get({ [KEY_PROFILE_SUMMARY]: "" });
  return typeof s === "string" ? s : "";
}

async function saveProfileSummary(summary: string): Promise<void> {
  await chrome.storage.local.set({ [KEY_PROFILE_SUMMARY]: summary });
}

const MAX_DOMAIN_STR_CHARS = 100_000;

/**
 * Query the last 48h of browser history, deduplicate by hostname,
 * truncate to MAX_DOMAIN_STR_CHARS, then call LLM to update the profile summary.
 * Returns true if the LLM was called, false if skipped.
 */
export async function analyzeRecentHistory(): Promise<boolean> {
  if (!(await isProfileEnabled())) return false;

  const config = await getLLMConfigForMemory();
  if (!config) return false;

  const startTime = Date.now() - 48 * 60 * 60 * 1000;
  const items = await chrome.history.search({ text: "", maxResults: 5000, startTime });

  const hostnames = new Set<string>();
  for (const item of items) {
    try {
      const url = new URL(item.url || "");
      if (url.hostname) hostnames.add(url.hostname);
    } catch {
      /* skip malformed URLs */
    }
  }

  if (hostnames.size === 0) return false;

  let domainList = [...hostnames].sort().join(", ");
  if (domainList.length > MAX_DOMAIN_STR_CHARS) {
    domainList = domainList.slice(0, MAX_DOMAIN_STR_CHARS);
    const lastComma = domainList.lastIndexOf(", ");
    if (lastComma > 0) domainList = domainList.slice(0, lastComma);
  }

  await _updateProfileFromDomains(domainList);
  return true;
}

async function _updateProfileFromDomains(domainList: string): Promise<void> {
  const config = await getLLMConfigForMemory();
  if (!config) return;

  const prevSummary = await getProfileSummary();

  const userContent = prevSummary
    ? `【已有用户画像】${prevSummary}\n\n【新增访问域名】${domainList}`
    : `【访问域名】${domainList}`;

  const messages: LlmTextMessage[] = [
    {
      role: "system",
      content:
        "你是一个用户兴趣分析员。根据用户访问的网站域名，推断其个人兴趣爱好、常用工具、关注领域等。" +
        "聚焦于「这个人平时喜欢什么、关注什么」，例如：游戏、编程、设计、财经、动漫等方向。" +
        "如果提供了已有画像，请融合新信息，更新为一句更完整的描述。" +
        "输出格式：一句简洁的中文，直接输出，不要任何前缀或解释。" +
        "示例：常访问 GitHub、Stack Overflow，关注前端技术，玩 Steam 游戏，偶尔看 B 站视频。",
    },
    { role: "user", content: userContent },
  ];

  const summary = await textComplete(config, messages);

  await saveProfileSummary(summary);
}

export async function formatProfileForSystemPrompt(): Promise<string> {
  if (!(await isProfileEnabled())) return "";

  const summary = await getProfileSummary();
  if (!summary) return "";

  return (
    "\n\n--- User Profile (auto-generated from browsing history, treat as background context) ---\n" +
    summary +
    "\n--- End of User Profile ---"
  );
}
