/**
 * Visual indicator shown in the message stream when the AI
 * is extracting content from a browser tab via tab_extract tool.
 */
export default function ToolCallIndicator({ tabTitle, loading }) {
  return (
    <div className="tool-call-indicator">
      <span className="tool-call-icon">{loading ? "🔧" : "✅"}</span>
      <span className="tool-call-text">
        {loading
          ? <>正在读取「<strong>{tabTitle}</strong>」的内容...</>
          : <>已读取「<strong>{tabTitle}</strong>」</>
        }
      </span>
    </div>
  );
}
