/* global chrome */
import { Button, Dialog } from "@sunwu51/camel-ui";
import { useState, useCallback, useEffect } from "react";
import {
  getProfileSummary,
  analyzeRecentHistory,
  isProfileEnabled,
  setProfileEnabled,
} from "../../api/userProfile";
import toast from "react-hot-toast";

export default function UserProfilePanel() {
  const [summary, setSummary] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);

  const loadData = useCallback(async () => {
    const [s, en] = await Promise.all([getProfileSummary(), isProfileEnabled()]);
    setSummary(s);
    setEnabled(en);
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function handleAnalyze() {
    setAnalyzing(true);
    try {
      const updated = await analyzeRecentHistory();
      if (!updated) toast("无浏览记录或未配置 LLM", { duration: 2500 });
    } catch (e) {
      console.error("[UserProfile] analyze error:", e);
      toast.error("分析失败：" + (e?.message || String(e)));
    }
    await loadData();
    setAnalyzing(false);
  }

  async function handleToggle() {
    const next = !enabled;
    await setProfileEnabled(next);
    setEnabled(next);
    toast(next ? "画像注入已开启" : "画像注入已关闭", { duration: 2000 });
  }

  return (
    <Dialog
      trigger={
        <Button
          className="!text-xs !whitespace-nowrap !bg-gray-100 !text-gray-700 !border !border-gray-300 hover:!bg-gray-200"
          onPress={loadData}
        >
          画像
        </Button>
      }
    >
      <div
        style={{
          width: "min(720px, calc(100vw - 32px))",
          maxWidth: "100%",
          maxHeight: "70vh",
          overflowY: "auto",
          overflowX: "hidden",
          paddingRight: "4px",
          boxSizing: "border-box",
        }}
      >
        {/* Header + analyze button + toggle */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <div className="text-sm font-bold text-gray-500">浏览偏好画像</div>
            <button
              onClick={handleAnalyze}
              disabled={analyzing}
              style={{
                fontSize: "11px",
                color: "#6b7280",
                background: "none",
                border: "none",
                cursor: analyzing ? "default" : "pointer",
                padding: "0 4px",
                opacity: analyzing ? 0.5 : 1,
              }}
              title="分析近 48h 浏览记录并更新画像"
            >
              {analyzing ? "分析中…" : "↻ 立即分析"}
            </button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span className="text-xs text-gray-500">{enabled ? "已开启" : "已关闭"}</span>
            <button
              onClick={handleToggle}
              style={{
                width: "36px",
                height: "20px",
                borderRadius: "10px",
                border: "none",
                cursor: "pointer",
                background: enabled ? "#4ade80" : "#d1d5db",
                position: "relative",
                transition: "background 0.2s",
                flexShrink: 0,
              }}
              title={enabled ? "点击关闭画像注入" : "点击开启画像注入"}
            >
              <span
                style={{
                  position: "absolute",
                  top: "2px",
                  left: enabled ? "18px" : "2px",
                  width: "16px",
                  height: "16px",
                  borderRadius: "50%",
                  background: "white",
                  transition: "left 0.2s",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
                }}
              />
            </button>
          </div>
        </div>

        {!enabled && (
          <div className="text-xs text-gray-400 mb-4">画像注入已关闭，对话不会包含画像信息。已有画像数据仍保留。</div>
        )}

        {/* Profile summary */}
        <div className="text-xs font-semibold text-gray-500 mb-1">当前画像</div>
        <div
          style={{
            padding: "10px 12px",
            border: "1px solid #e5e7eb",
            borderRadius: "6px",
            background: "#f9fafb",
            fontSize: "12px",
            lineHeight: "1.6",
            color: summary ? "#374151" : "#9ca3af",
            overflowY: "auto",
            maxHeight: "200px",
          }}
        >
          {summary || "暂无画像。点击「↻ 立即分析」分析近 48h 浏览记录生成（需要配置 LLM）。"}
        </div>
      </div>
    </Dialog>
  );
}
