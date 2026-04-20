# Tab Manager

Tab Manager 是一个面向重度标签页用户的 Chrome / Edge 扩展（Manifest V3），在侧边栏中完成「找标签、整理标签、保存工作现场、用 AI 操作浏览器」等能力。

## 当前功能

- **标签搜索**：按标题与 URL 关键词搜索已打开标签，并补充最近浏览记录。
- **标签分组**：自定义正则分组、按域名分组、折叠全部分组、取消分组。
- **工作区**：保存当前 HTTP(S) 标签列表，一键恢复（跳过已打开 URL）。
- **小助手（Agent）**：流式对话、浏览器工具调用、MCP / skill-bridge、会话与导出、危险操作确认、定时任务调度等（逻辑继承自原 React 版本）。
- **设置**：LLM API（OpenAI 兼容 / Anthropic）、MCP 超时、标签内存自动释放、Tab 复用策略等。

## 技术栈

- **[WXT](https://wxt.dev/)**：扩展构建与入口管理
- **TypeScript + 原生 DOM**：侧边栏界面
- **Tailwind CSS**：样式工具类
- **Vitest**：单元测试
- **Playwright**：E2E（加载扩展产物 + 基础导航）

业务逻辑主要位于 [`lib/api/`](lib/api/)（由原 `src/api` 迁移），小助手 UI 控制器在 [`lib/agent/AgentPanelController.ts`](lib/agent/AgentPanelController.ts)。

## 环境要求

- Node.js >= 18
- npm（如遇企业内部 registry 404，可使用 `npm install --registry=https://registry.npmjs.org/`）

## 开发与构建

```bash
npm install --registry=https://registry.npmjs.org/
npm run dev          # WXT 开发模式（Chrome）
npm run build        # 产出 .output/chrome-mv3
npm run zip          # 打 zip 包（WXT）
npm run compile      # TypeScript 检查
npm run test         # 单元测试
npm run test:e2e     # E2E（需先 build）
```

加载未打包扩展：

1. 执行 `npm run build`
2. 打开 `chrome://extensions` 或 `edge://extensions`
3. 开启「开发者模式」→「加载已解压的扩展程序」
4. 选择目录 **`.output/chrome-mv3`**

## 项目结构（摘要）

```
entrypoints/
  background/index.ts    # Service worker
  content/               # 内容脚本（DOM/高亮/复用提示等）
  sidepanel/             # 侧边栏 HTML + TS + 样式
lib/
  api/                   # LLM、MCP、会话、Skills 等
  agent/                 # 小助手控制器、Markdown、危险工具元数据等
public/
  logo.png                # 扩展图标
tests/                   # Vitest
tests/e2e/               # Playwright
```

更完整的架构说明见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## Chrome 商店

[Chrome Web Store - Tab Manager](https://chromewebstore.google.com/detail/tab-manager/kklpijbnmbkpgcmnldimiagiehbakaec)

也可从 GitHub Releases 下载 zip 后自行加载。

## 视频

- [Bilibili](https://www.bilibili.com/video/BV1TsdZBmEo5)
- [Bilibili](https://www.bilibili.com/video/BV1XKH7eEEM9/)
