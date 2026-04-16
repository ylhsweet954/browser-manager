/* eslint-disable react/prop-types */
import { Button, Checkbox, Dialog, Input } from "@sunwu51/camel-ui";
import { useEffect, useState } from "react";
import { isLikelyShellMcpTool } from "../../api/skills";

export default function SkillsConfig({
  agentSkills,
  loading,
  mcpTools,
  onRootPathChange,
  onSelectedToolNamesChange,
  onLoad
}) {
  const [rootPath, setRootPath] = useState(agentSkills.rootPath || "");

  useEffect(() => {
    setRootPath(agentSkills.rootPath || "");
  }, [agentSkills.rootPath]);

  const count = agentSkills.skills.length;
  const label = `Skills${count > 0 ? ` (${count})` : ""}`;
  const selectedToolNames = Array.isArray(agentSkills.selectedToolNames) ? agentSkills.selectedToolNames : [];
  const selectedTools = mcpTools.filter(tool => selectedToolNames.includes(tool._toolCallName));
  const selectedShellCount = selectedTools.filter(isLikelyShellMcpTool).length;

  function toggleTool(toolCallName, checked) {
    const next = checked
      ? [...selectedToolNames, toolCallName]
      : selectedToolNames.filter(name => name !== toolCallName);
    onSelectedToolNamesChange(next);
  }

  return (
    <Dialog trigger={
      <Button className="!text-xs !whitespace-nowrap !bg-gray-100 !text-gray-700 !border !border-gray-300 hover:!bg-gray-200">
        {label}
      </Button>
    }>
      <div
        style={{
          width: "min(720px, calc(100vw - 32px))",
          maxWidth: "100%",
          maxHeight: "70vh",
          overflowY: "auto",
          overflowX: "hidden",
          paddingRight: "4px",
          boxSizing: "border-box"
        }}
      >
        <div className="text-sm font-bold text-gray-500 mb-2">Skills</div>
        <div className="text-xs text-gray-500 mb-3">
          手动填写 skills 根目录绝对路径，并勾选用于 skills 加载的 MCP 工具。点击 Load 后，只会使用这里勾选的工具扫描子目录中的 `SKILL.md` 头部信息，并注入到 system prompt。
        </div>

        <Input
          label="Skills 根目录"
          labelClassName="!text-xs !text-gray-500"
          inputClassName="!min-h-8"
          defaultValue={rootPath}
          onChange={(value) => {
            setRootPath(value);
            onRootPathChange(value);
          }}
          placeholder="/Users/you/.codex/skills"
        />

        <div className="flex items-center justify-between gap-2 mt-2 mb-3 flex-wrap">
          <div className="text-xs text-gray-400">
            {agentSkills.loadedAt
              ? `已加载 ${count} 个 skills`
              : "尚未加载 skills 头部索引"}
          </div>
          <Button
            className="!text-xs !p-0 !px-3 !min-h-8"
            isDisabled={loading || !rootPath.trim()}
            onPress={() => onLoad(rootPath)}
          >
            {loading ? "Loading..." : "Load"}
          </Button>
        </div>

        <div className={`text-xs mb-2 ${selectedTools.length === 0 || selectedShellCount === 0 ? "text-red-600" : "text-gray-500"}`}>
          已选择 {selectedTools.length} 个工具，其中 Shell 工具 {selectedShellCount} 个。请至少勾选 1 个 Shell 工具，否则无法引入 skill。
        </div>
        <div className="text-xs text-amber-700 mb-3">
          Shell 工具也会用于执行 skill 相关脚本。部分 skill 依赖环境变量时，请把环境变量配置到对应 Shell MCP Server 中。
        </div>

        <div className="text-xs font-medium text-gray-500 mb-2">用于 Skills Load 的 MCP 工具</div>
        {mcpTools.length === 0 ? (
          <div className="text-xs text-gray-400 border border-dashed border-gray-200 rounded p-3 mb-3">
            暂无可选 MCP 工具，请先在 MCP 面板连接并启用工具。
          </div>
        ) : (
          <div className="flex flex-col gap-2 mb-3">
            {mcpTools.map(tool => {
              const isShell = isLikelyShellMcpTool(tool);
              return (
                <label key={tool._toolCallName} className="rounded border border-gray-100 p-2 min-w-0 overflow-hidden cursor-pointer">
                  <div className="flex items-start gap-2">
                    <Checkbox
                      isSelected={selectedToolNames.includes(tool._toolCallName)}
                      onChange={(checked) => toggleTool(tool._toolCallName, checked)}
                    />
                    <div className="min-w-0 flex-1">
                      <div
                        className="text-xs font-medium break-all"
                        style={{ overflowWrap: "anywhere", wordBreak: "break-word" }}
                      >
                        {tool.name}
                      </div>
                      <div className="text-xs text-gray-400 mt-1 break-all">
                        {tool._serverName || "MCP Server"}
                        {tool._dangerous ? " · 危险工具" : ""}
                        {isShell ? " · Shell" : ""}
                      </div>
                      <div
                        className="text-xs text-gray-500 mt-1 break-all whitespace-normal"
                        style={{ overflowWrap: "anywhere", wordBreak: "break-word" }}
                      >
                        {tool.description || "无描述"}
                      </div>
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        )}

        {count === 0 ? (
          <div className="text-xs text-gray-400 border border-dashed border-gray-200 rounded p-3">
            暂无已加载的 skill 索引
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {agentSkills.skills.map(skill => (
              <div key={skill.path} className="rounded border border-gray-100 p-2 min-w-0 overflow-hidden">
                <div
                  className="text-xs font-medium break-all"
                  style={{ overflowWrap: "anywhere", wordBreak: "break-word" }}
                >
                  {skill.name || "Unnamed Skill"}
                </div>
                <div className="text-xs text-gray-400 mt-1 break-all">{skill.path}</div>
                <div className="text-xs text-gray-500 mt-1 break-all whitespace-normal">
                  {skill.description || "无描述"}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}
