# Tab Manager 架构说明

## 运行时入口

| 入口 | 文件 | 职责 |
|------|------|------|
| Background | `entrypoints/background/index.ts` | Tab 复用、定时任务、向内容脚本转发 `tab_extract` / `dom_*`、空闲标签 discard、`chrome.runtime.onMessage` 中 `schedule_manager` |
| Content | `entrypoints/content/index.ts` → `content-impl.ts` | 页面文本抽取、滚动、DOM 查询/点击/赋值/样式/HTML/高亮、Tab 复用弹层 |
| Side panel | `entrypoints/sidepanel/main.ts` | 标签管理 UI + 小助手 UI，消费 `lib/api` 与 `lib/agent` |

清单与权限在 [`wxt.config.ts`](../wxt.config.ts) 的 `manifest` 中与 WXT 默认行为合并生成。

## 消息与存储（摘要）

- **Side panel ↔ Background**：沿用 `chrome.runtime.sendMessage`；小助手工具内通过 `lib/api/llm.ts` 等调用浏览器 API。
- **Background ↔ Content**：`chrome.tabs.sendMessage`，消息类型如 `tab_extract_content`、`dom_query`、`show_tab_reuse_prompt` 等。
- **广播给侧边栏**：`chrome.runtime.sendMessage({ type: 'open'|'close'|'active', tabId })` 用于刷新搜索列表（侧栏内 `console.log` 可观察）。

存储键与原有逻辑一致，例如：`llmConfig`、`mcpServers`、`workspaces`、`scheduledJobs`、`reuse` 等，详见 `lib/api` 与 background 内常量。

## 小助手（Agent）

- **控制器**：`lib/agent/AgentPanelController.ts` — 会话生命周期、`streamChat` / `executeTool` 循环、危险工具确认、MCP/Skills 与画像入口。
- **纯函数**：`lib/agent/panel-helpers.ts`（由原 `AgentPanel.jsx` 尾部抽取）、`lib/agent/dangerous-meta.ts`。
- **消息渲染**：`lib/agent/render-messages.ts` + `lib/agent/markdown.ts`（`marked` + `dompurify`）。

## 测试策略

- **单元测试**：`tests/*.test.ts`，覆盖无浏览器依赖模块（如 `llmEndpoint`、危险工具元数据、Markdown 消毒）。
- **E2E**：`tests/e2e/extension-load.spec.ts`，校验构建产物完整性，并以 `--load-extension` 启动 Chromium 做最小冒烟。

## 与 Voyage 参考项目的对应关系

借鉴 Voyage 等项目的 **WXT 入口目录化**（`entrypoints/`）与 **清单由配置生成** 的方式；本仓库 **未** 引入 Vue / 组件库。侧边栏采用 **原生 DOM + Tailwind**。
