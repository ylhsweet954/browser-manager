import { describe, expect, it } from 'vitest'
import { getDefaultLlmEndpointPath, resolveLlmRequestUrl } from '@/lib/api/llmEndpoint'

describe('llmEndpoint', () => {
  it('getDefaultLlmEndpointPath', () => {
    expect(getDefaultLlmEndpointPath('openai')).toContain('chat/completions')
    expect(getDefaultLlmEndpointPath('anthropic')).toContain('messages')
  })

  it('resolveLlmRequestUrl 拼接 base 与默认 path', () => {
    expect(resolveLlmRequestUrl('openai', 'https://api.example.com')).toBe(
      'https://api.example.com/v1/chat/completions',
    )
    expect(resolveLlmRequestUrl('openai', 'https://api.example.com/')).toBe(
      'https://api.example.com/v1/chat/completions',
    )
  })
})
