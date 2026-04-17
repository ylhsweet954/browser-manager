/* global chrome */
import { Button, Checkbox, Dialog, Input, Select } from "@sunwu51/camel-ui";
import { useEffect, useRef, useState } from "react";
import { clearReuseDomainPolicies, getReuseDomainPolicies } from "../api/tabReuse";

/**
 * Settings dialog for LLM API configuration, tab reuse, and auto-suspend.
 * All changes are auto-saved when any value changes; no confirm button needed.
 */
export default function SettingsDialog() {
  let [apiType, setApiType] = useState("openai");
  let [baseUrl, setBaseUrl] = useState("");
  let [apiKey, setApiKey] = useState("");
  let [showApiKey, setShowApiKey] = useState(false);
  let [model, setModel] = useState("");
  let [suspendTimeout, setSuspendTimeout] = useState(0);
  let [mcpToolTimeoutSeconds, setMcpToolTimeoutSeconds] = useState(60);
  let [reuse, setReuse] = useState(false);
  let [reusePolicyCount, setReusePolicyCount] = useState(0);
  const loaded = useRef(false);
  const suspendOptions = [
    { label: "关闭", value: 0 },
    { label: "15 分钟", value: 15 },
    { label: "30 分钟", value: 30 },
    { label: "1 小时", value: 60 },
    { label: "2 小时", value: 120 },
    { label: "1 天", value: 1440 }
  ];

  useEffect(() => {
    chrome.storage.local.get({
      llmConfig: { apiType: "openai", baseUrl: "", apiKey: "", model: "" },
      suspendTimeout: 0,
      mcpToolTimeoutSeconds: 60,
      reuse: false
    }).then(res => {
      setApiType(res.llmConfig.apiType || "openai");
      setBaseUrl(res.llmConfig.baseUrl || "");
      setApiKey(res.llmConfig.apiKey || "");
      setModel(res.llmConfig.model || "");
      setSuspendTimeout(res.suspendTimeout);
      setMcpToolTimeoutSeconds(res.mcpToolTimeoutSeconds || 60);
      setReuse(res.reuse);
      loaded.current = true;
    });

    getReuseDomainPolicies().then((policies) => {
      setReusePolicyCount(Object.keys(policies || {}).length);
    });
  }, [])

  /** Auto-save whenever any setting changes */
  useEffect(() => {
    if (!loaded.current) return;
    chrome.storage.local.set({
      llmConfig: { apiType, baseUrl, apiKey, model },
      suspendTimeout,
      mcpToolTimeoutSeconds,
      reuse
    });
  }, [apiType, baseUrl, apiKey, model, suspendTimeout, mcpToolTimeoutSeconds, reuse])

  async function handleClearReusePolicies() {
    await clearReuseDomainPolicies();
    setReusePolicyCount(0);
  }

  return (
    <>
      <Dialog trigger={<Button className="w-16">设置</Button>}>
        <Select
          label="API 类型"
          items={["OpenAI 兼容", "Anthropic"]}
          defaultIndex={apiType === "anthropic" ? 1 : 0}
          onSelectedItemChange={(changes) => {
            setApiType(changes.selectedItem === "Anthropic" ? "anthropic" : "openai");
          }}
        />
        <Input label="API 地址" labelClassName="!text-sm !font-medium !text-gray-500" inputClassName="!min-h-8"
          defaultValue={baseUrl} onChange={setBaseUrl}
          placeholder={apiType === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com"} />
        <div className="settings-secret-field">
          <label className="!text-sm !font-medium !text-gray-500" htmlFor="settings-api-key">API Key</label>
          <div className="settings-secret-input-wrapper">
            <input
              id="settings-api-key"
              className="settings-secret-input !min-h-8"
              type={showApiKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={apiType === "anthropic" ? "sk-ant-..." : "sk-..."}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              className="settings-secret-toggle"
              onClick={() => setShowApiKey((prev) => !prev)}
              aria-label={showApiKey ? "隐藏 API Key" : "显示 API Key"}
              title={showApiKey ? "隐藏" : "显示"}
            >
              {showApiKey ? (
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M3 3L21 21M10.6 10.7A3 3 0 0 0 13.3 13.4M9.9 5.1A10.9 10.9 0 0 1 12 4.9C17 4.9 21 12 21 12A20.6 20.6 0 0 1 17.4 16.6M14.1 14.3A3 3 0 0 1 9.7 9.9M6.5 7.5A20.3 20.3 0 0 0 3 12S7 19.1 12 19.1C13.3 19.1 14.5 18.8 15.6 18.3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M2.5 12S6.5 5 12 5s9.5 7 9.5 7-4 7-9.5 7S2.5 12 2.5 12Z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <circle
                    cx="12"
                    cy="12"
                    r="3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                  />
                </svg>
              )}
            </button>
          </div>
        </div>
        <Input label="模型" labelClassName="!text-sm !font-medium !text-gray-500" inputClassName="!min-h-8"
          defaultValue={model} onChange={setModel}
          placeholder={apiType === "anthropic" ? "claude-sonnet-4-20250514" : "gpt-4o"} />
        <Select
          label="自动释放内存"
          items={suspendOptions.map((item) => item.label)}
          defaultIndex={Math.max(0, suspendOptions.findIndex((item) => item.value === suspendTimeout))}
          onSelectedItemChange={(changes) => {
            const selected = suspendOptions.find((item) => item.label === changes.selectedItem);
            setSuspendTimeout(selected ? selected.value : 0);
          }}
        />
        <Input
          label="MCP 工具超时（秒）"
          labelClassName="!text-sm !font-medium !text-gray-500"
          inputClassName="!min-h-8"
          defaultValue={String(mcpToolTimeoutSeconds)}
          onChange={(value) => {
            const parsed = Math.max(1, parseInt(value || "60", 10) || 60);
            setMcpToolTimeoutSeconds(parsed);
          }}
          placeholder="60"
        />
        <div className="mt-2">
          <Checkbox isSelected={reuse} onChange={setReuse}>
            <span className="text-sm">复用 Tab（命中已存在页面时优先询问是否复用，并可记住域名选择）</span>
          </Checkbox>
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-xs text-gray-500">已记住 {reusePolicyCount} 个域名的复用决策</span>
          <Button
            className="!min-h-6 !px-2 !text-xs"
            disabled={reusePolicyCount === 0}
            onClick={handleClearReusePolicies}
          >
            清除域名记忆
          </Button>
        </div>
      </Dialog>
    </>
  )
}
