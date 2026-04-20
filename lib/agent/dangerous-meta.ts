/** 危险工具确认元数据（从 AgentPanel 逻辑抽取，便于单测与复用） */

export function resolveScheduledFireTimestamp(scheduleArgs: Record<string, unknown> | undefined): number | null {
  if (Number.isFinite(Number(scheduleArgs?.timestamp))) {
    return Number(scheduleArgs!.timestamp)
  }
  if (Number.isFinite(Number(scheduleArgs?.delaySeconds)) && Number(scheduleArgs!.delaySeconds) > 0) {
    return Date.now() + Number(scheduleArgs!.delaySeconds) * 1000
  }
  return null
}

export function formatScheduledFireAt(fireTimestamp: number | null): string | null {
  if (!Number.isFinite(fireTimestamp)) return null
  const fireDate = new Date(fireTimestamp as number)
  if (Number.isNaN(fireDate.getTime())) return null
  return fireDate.toLocaleString()
}

export function getDirectDangerousToolMeta(
  toolName: string | undefined,
  toolArgs: unknown,
  combinedMcpTools: Array<Record<string, unknown>>,
) {
  if (toolName === 'eval_js') {
    return {
      title: '危险工具待确认',
      description: '`eval_js` 将在当前页面执行任意 JavaScript。请确认参数无误后再执行。',
      displayArgs: toolArgs || {},
      confirmLabel: '确认执行',
      executeArgs: toolArgs || {},
      toolLabel: '危险工具 `eval_js`',
    }
  }
  if (toolName?.startsWith('mcp_')) {
    const mcpTool = combinedMcpTools.find((tool) => tool._toolCallName === toolName)
    if (mcpTool?._dangerous) {
      return {
        title: '危险 MCP 工具待确认',
        description: `MCP 工具「${mcpTool._serverName || 'MCP Server'} / ${mcpTool.name}」被标记为危险工具。请确认参数无误后再执行。`,
        displayArgs: toolArgs || {},
        confirmLabel: '确认执行',
        executeArgs: toolArgs || {},
        toolLabel: `危险 MCP 工具「${mcpTool._serverName || 'MCP Server'} / ${mcpTool.name}」`,
      }
    }
  }
  return null
}

export function getDangerousToolMeta(
  toolCall: { name?: string; args?: Record<string, unknown> } | null,
  combinedMcpTools: Array<Record<string, unknown>>,
) {
  if (!toolCall) return null
  if (toolCall.name === 'schedule_tool') {
    const scheduledToolMeta = getDirectDangerousToolMeta(
      toolCall.args?.toolName as string | undefined,
      toolCall.args?.toolArgs,
      combinedMcpTools,
    )
    if (!scheduledToolMeta) return null
    const scheduledTimestamp = resolveScheduledFireTimestamp(toolCall.args)
    const scheduledFireAt = formatScheduledFireAt(scheduledTimestamp)
    const originalArgs = toolCall.args || {}
    const restArgs = { ...originalArgs }
    delete restArgs.delaySeconds
    return {
      title: '危险定时任务待确认',
      description:
        `${scheduledToolMeta.toolLabel} 将于 ${scheduledFireAt || '未来某个时间'} 自动执行。` +
        '请确认参数无误后再创建该定时任务。',
      displayArgs: {
        toolName: toolCall.args?.toolName,
        label: toolCall.args?.label || toolCall.args?.toolName,
        fireAt: scheduledFireAt,
        delaySeconds: toolCall.args?.delaySeconds,
        timestamp: toolCall.args?.timestamp,
        timeoutSeconds: toolCall.args?.timeoutSeconds,
        toolArgs: toolCall.args?.toolArgs || {},
      },
      confirmLabel: '确认创建任务',
      executeArgs:
        scheduledTimestamp != null ? { ...restArgs, timestamp: scheduledTimestamp } : { ...originalArgs },
    }
  }
  return getDirectDangerousToolMeta(toolCall.name, toolCall.args, combinedMcpTools)
}
