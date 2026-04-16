/* global chrome */

const STORAGE_KEY = "agentSkills";

export const EMPTY_AGENT_SKILLS = {
  rootPath: "",
  loadedAt: 0,
  selectedToolNames: [],
  skills: []
};

export async function loadAgentSkills() {
  const result = await chrome.storage.local.get({ [STORAGE_KEY]: EMPTY_AGENT_SKILLS });
  return normalizeAgentSkills(result[STORAGE_KEY]);
}

export async function saveAgentSkills(agentSkills) {
  const normalized = normalizeAgentSkills(agentSkills);
  await chrome.storage.local.set({ [STORAGE_KEY]: normalized });
  return normalized;
}

export function buildSkillsSystemPrompt(agentSkills) {
  const normalized = normalizeAgentSkills(agentSkills);
  if (!normalized.rootPath) {
    return "";
  }

  if (normalized.skills.length === 0) {
    return (
      `\n\nLocal skills root:\n` +
      `- The user configured the local skills root path ${JSON.stringify(normalized.rootPath)}.\n` +
      `- Skills headers have not been loaded yet.\n` +
      `- When a task requires local skills, use the configured MCP file or shell tools to inspect this path, locate SKILL.md files, read the relevant skill instructions, and then follow any referenced scripts or sibling files under the same root.`
    );
  }

  const lines = normalized.skills.map(skill => {
    const parts = [`path=${JSON.stringify(skill.path)}`];
    if (skill.name) parts.push(`name=${JSON.stringify(skill.name)}`);
    if (skill.description) parts.push(`description=${JSON.stringify(skill.description)}`);
    for (const [key, value] of Object.entries(skill.header || {})) {
      if (!value || key === "name" || key === "description") continue;
      parts.push(`${key}=${JSON.stringify(value)}`);
    }
    return `- ${parts.join("; ")}`;
  });

  return (
    `\n\nLocal skills root:\n` +
    `- The user configured the local skills root path ${JSON.stringify(normalized.rootPath)}.\n` +
    `- The following entries are indexed summaries extracted from descendant SKILL.md files under that root:\n` +
    `${lines.join("\n")}\n` +
    `- When a task matches one of these skills, use the configured MCP file or shell tools to read the full SKILL.md at the corresponding path under ${JSON.stringify(normalized.rootPath)}.\n` +
    `- After reading the full skill, also inspect and use any referenced scripts, references, assets, or sibling files under the same skills root as needed.\n` +
    `- Do not rely on the summary alone when the task depends on the actual skill workflow.`
  );
}

export function normalizeAgentSkills(agentSkills) {
  const rootPath = normalizeRootPath(agentSkills?.rootPath || agentSkills?.rootName || "");
  const loadedAt = Number(agentSkills?.loadedAt || agentSkills?.scannedAt) || 0;
  const selectedToolNames = normalizeSelectedToolNames(agentSkills?.selectedToolNames);
  const rawSkills = Array.isArray(agentSkills?.skills) ? agentSkills.skills : [];

  const skills = rawSkills
    .map(skill => ({
      path: normalizeRelativePath(skill?.path || ""),
      name: String(skill?.name || ""),
      description: String(skill?.description || ""),
      header: normalizeHeader(skill?.header)
    }))
    .filter(skill => skill.path)
    .sort((left, right) => left.path.localeCompare(right.path));

  return {
    rootPath,
    loadedAt,
    selectedToolNames,
    skills
  };
}

export function mergeAgentSkillsRootPath(agentSkills, rootPath) {
  const normalizedCurrent = normalizeAgentSkills(agentSkills);
  const normalizedRootPath = normalizeRootPath(rootPath);
  return normalizeAgentSkills({
    rootPath: normalizedRootPath,
    loadedAt: normalizedCurrent.rootPath === normalizedRootPath ? normalizedCurrent.loadedAt : 0,
    selectedToolNames: normalizedCurrent.selectedToolNames,
    skills: normalizedCurrent.rootPath === normalizedRootPath ? normalizedCurrent.skills : []
  });
}

export function mergeSelectedSkillTools(agentSkills, selectedToolNames) {
  const normalizedCurrent = normalizeAgentSkills(agentSkills);
  return normalizeAgentSkills({
    ...normalizedCurrent,
    selectedToolNames
  });
}

export function mergeLoadedSkills(_agentSkills, rootPath, skills) {
  return normalizeAgentSkills({
    rootPath,
    loadedAt: Date.now(),
    selectedToolNames: normalizeAgentSkills(_agentSkills).selectedToolNames,
    skills
  });
}

export function isLikelyShellMcpTool(tool) {
  const haystack = [tool?.name, tool?.description, tool?._serverName, tool?._toolCallName]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return /\b(shell|bash|sh|zsh|terminal|command|commands|exec|execute|pty|process|spawn|run)\b/.test(haystack);
}

function normalizeHeader(header) {
  if (!header || typeof header !== "object") return {};
  const normalized = {};
  for (const [key, value] of Object.entries(header)) {
    if (!key || value == null || value === "") continue;
    normalized[String(key)] = String(value);
  }
  return normalized;
}

function normalizeRootPath(rootPath) {
  return String(rootPath || "").trim().replace(/[\\/]+$/, "");
}

function normalizeRelativePath(path) {
  return String(path || "").trim().replace(/\\/g, "/").replace(/^\.?\//, "");
}

function normalizeSelectedToolNames(selectedToolNames) {
  if (!Array.isArray(selectedToolNames)) return [];
  return [...new Set(
    selectedToolNames
      .map(name => String(name || "").trim())
      .filter(Boolean)
  )].sort((left, right) => left.localeCompare(right));
}
