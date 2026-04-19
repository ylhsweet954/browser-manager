# Tab Manager

Tab Manager 是一个面向重度标签页用户的 Chrome 扩展，目标是把“找标签、整理标签、保存工作现场、用 AI 操作浏览器”放到同一个侧边栏里完成。

## 当前功能

- 标签搜索：按标题和 URL 关键词搜索当前已打开的标签页，并同时补充最近浏览记录，方便快速切回页面或重新打开历史页面。
- 标签分组：支持按自定义正则规则分组，也支持一键按域名分组，还可以快速折叠全部分组或取消全部分组。
- 工作区保存与恢复：可以把当前打开的一组页面保存为工作区，之后一键恢复，恢复时会自动跳过已经打开的页面，减少重复标签。
- AI Agent：内置浏览器助手，可结合当前标签页、标签组、窗口、DOM 操作、历史记录等能力完成浏览器内的查询和操作。
- MCP / Skills 扩展：支持接入 MCP 工具和 skill-bridge，为 agent 增加额外工具能力。
- 截图工具控制：可以在设置中配置当前模型是否支持图片输入，决定是否向模型暴露截图能力。
- 会话与调度：agent 对话支持历史会话、导出，以及定时执行工具任务。

## 安装方式

Chrome 商店安装地址：

[https://chromewebstore.google.com/detail/tab-manager/kklpijbnmbkpgcmnldimiagiehbakaec](https://chromewebstore.google.com/detail/tab-manager/kklpijbnmbkpgcmnldimiagiehbakaec)

如果你不是使用 Chrome，或者希望自行修改源码，可以从 GitHub Releases 下载打包产物，然后通过浏览器开发者模式加载扩展。

## 开发说明

本项目基于 Vite + React。

常用命令：

```bash
npm install
npm run build
```

构建完成后，产物位于 `dist/` 目录。

## 视频

[https://www.bilibili.com/video/BV1TsdZBmEo5](https://www.bilibili.com/video/BV1TsdZBmEo5)

[https://www.bilibili.com/video/BV1XKH7eEEM9/](https://www.bilibili.com/video/BV1XKH7eEEM9)

