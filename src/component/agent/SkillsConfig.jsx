/* eslint-disable react/prop-types */
import { Button, Dialog, Input } from "@sunwu51/camel-ui";
import { useEffect, useState } from "react";

export default function SkillsConfig({
  agentSkills,
  loading,
  skillToolConnected,
  onServerUrlChange,
  onLoad
}) {
  const [serverUrl, setServerUrl] = useState(agentSkills.serverUrl || "");

  useEffect(() => {
    setServerUrl(agentSkills.serverUrl || "");
  }, [agentSkills.serverUrl]);

  const count = agentSkills.skills.length;
  const label = `Skills${count > 0 ? ` (${count})` : ""}`;

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
          配置 `skill-station` 的 MCP 地址。点击 Load 后，会直接读取 `skills://index` 资源，把返回的 skills 摘要注入到 system prompt，并让会话可调用 `get_skill_detail`。
        </div>

        <Input
          label="skill-station 地址"
          labelClassName="!text-xs !text-gray-500"
          inputClassName="!min-h-8"
          defaultValue={serverUrl}
          onChange={(value) => {
            setServerUrl(value);
            onServerUrlChange(value);
          }}
          placeholder="http://localhost:5151/mcp"
        />

        <div className="flex items-center justify-between gap-2 mt-2 mb-3 flex-wrap">
          <div className="text-xs text-gray-400">
            {agentSkills.loadedAt
              ? `已加载 ${count} 个 skills`
              : "尚未加载 skills 索引"}
          </div>
          <Button
            className="!text-xs !p-0 !px-3 !min-h-8"
            isDisabled={loading || !serverUrl.trim()}
            onPress={() => onLoad(serverUrl)}
          >
            {loading ? "Loading..." : "Load"}
          </Button>
        </div>

        <div className={`text-xs mb-3 ${skillToolConnected ? "text-gray-500" : "text-amber-700"}`}>
          {skillToolConnected
            ? "当前会话已自动接入 skill-station MCP 工具，可直接调用 get_skill_detail。"
            : "加载成功后，会自动把 skill-station 的 MCP 工具加入当前会话。"}
        </div>

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
