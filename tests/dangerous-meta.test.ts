import { describe, expect, it } from 'vitest'
import { getDirectDangerousToolMeta, resolveScheduledFireTimestamp } from '@/lib/agent/dangerous-meta'

describe('dangerous-meta', () => {
  it('resolveScheduledFireTimestamp 识别 timestamp', () => {
    expect(resolveScheduledFireTimestamp({ timestamp: 1700000000000 })).toBe(1700000000000)
  })

  it('getDirectDangerousToolMeta eval_js', () => {
    const m = getDirectDangerousToolMeta('eval_js', { code: '1' }, [])
    expect(m?.title).toContain('危险')
  })

  it('getDirectDangerousToolMeta 危险 MCP', () => {
    const m = getDirectDangerousToolMeta(
      'mcp_srv_tool',
      {},
      [{ _toolCallName: 'mcp_srv_tool', name: 'x', _serverName: 'srv', _dangerous: true }],
    )
    expect(m?.title).toContain('MCP')
  })
})
