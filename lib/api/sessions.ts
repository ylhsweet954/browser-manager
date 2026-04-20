export interface SessionIndexEntry {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChatMessage {
  role?: string;
  content?: unknown;
  [key: string]: unknown;
}

/**
 * Generate a unique session ID: s_{timestamp}_{random4chars}
 */
export function generateSessionId(): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).substring(2, 6);
  return `s_${ts}_${rand}`;
}

/**
 * Get the sessions index list, sorted by updatedAt descending (most recent first).
 */
export async function listSessions(): Promise<SessionIndexEntry[]> {
  const { sessions_index } = await chrome.storage.local.get({ sessions_index: [] as SessionIndexEntry[] });
  const list = Array.isArray(sessions_index) ? sessions_index : [];
  return list.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Create a new session entry in the index. Does NOT save messages yet.
 */
export async function createSession(id: string, title: string): Promise<void> {
  const { sessions_index } = await chrome.storage.local.get({ sessions_index: [] as SessionIndexEntry[] });
  const list = Array.isArray(sessions_index) ? sessions_index : [];
  const now = Date.now();
  list.unshift({ id, title: title || "新会话", createdAt: now, updatedAt: now });
  await chrome.storage.local.set({ sessions_index: list });
}

/**
 * Load messages for a specific session.
 */
export async function loadSession(id: string): Promise<ChatMessage[]> {
  const key = `session_${id}`;
  const result = await chrome.storage.local.get({ [key]: { messages: [] as ChatMessage[] } });
  const bucket = result[key] as { messages?: ChatMessage[] };
  return Array.isArray(bucket?.messages) ? bucket.messages : [];
}

/**
 * Save messages for a session and update the index entry (title + updatedAt).
 */
export async function saveSession(id: string, messages: ChatMessage[], title?: string): Promise<void> {
  const key = `session_${id}`;
  await chrome.storage.local.set({ [key]: { messages } });

  const { sessions_index } = await chrome.storage.local.get({ sessions_index: [] as SessionIndexEntry[] });
  const list = Array.isArray(sessions_index) ? sessions_index : [];
  const entry = list.find((s) => s.id === id);
  if (entry) {
    if (title) entry.title = title;
    entry.updatedAt = Date.now();
  }
  await chrome.storage.local.set({ sessions_index: list });
}

/**
 * Delete a session: remove from index and delete stored messages.
 */
export async function deleteSession(id: string): Promise<void> {
  const key = `session_${id}`;
  await chrome.storage.local.remove(key);

  const { sessions_index } = await chrome.storage.local.get({ sessions_index: [] as SessionIndexEntry[] });
  const list = Array.isArray(sessions_index) ? sessions_index : [];
  const updated = list.filter((s) => s.id !== id);
  await chrome.storage.local.set({ sessions_index: updated });
}

/**
 * Extract a title from messages: first user message content, truncated to 20 chars.
 */
export function extractTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user" && typeof m.content === "string");
  if (!firstUser || typeof firstUser.content !== "string") return "新会话";
  const text = firstUser.content.trim();
  return text.length > 20 ? text.substring(0, 20) + "..." : text;
}
