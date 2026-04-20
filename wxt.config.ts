import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "wxt";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

// See https://wxt.dev/api/config.html
export default defineConfig({
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
