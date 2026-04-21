import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "wxt";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

// See https://wxt.dev/api/config.html
export default defineConfig({
  // 开发时复用同一用户数据目录，保留登录、扩展、设置等
  // 见 https://wxt.dev/guide/essentials/config/browser-startup.html#persist-data
  webExt: {
    chromiumArgs: ["--user-data-dir=./.wxt/chrome-data"],
  },
  manifest: {
    name: "tab manager",
    description: "tab manager",
    permissions: [
      "activeTab",
      "windows",
      "tabGroups",
      "tabs",
      "webNavigation",
      "alarms",
      "unlimitedStorage",
      "sidePanel",
      "history",
      "storage",
      "scripting",
    ],
    host_permissions: ["<all_urls>"],
    action: {
      default_title: "Click to open panel",
    },
    icons: {
      128: "logo.png",
    },
  },
  vite: () => ({
    resolve: {
      alias: {
        "@": rootDir,
      },
    },
  }),
});
