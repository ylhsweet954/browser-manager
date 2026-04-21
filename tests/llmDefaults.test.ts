import { describe, expect, it } from 'vitest'
import {
  defaultLlmModelForApiType,
  resolveStoredLlmModel,
} from '@/lib/config/llmDefaults'

describe('llmDefaults', () => {
  it('defaultLlmModelForApiType 与 resolveStoredLlmModel(空存储) 一致', () => {
    expect(resolveStoredLlmModel('openai', '')).toBe(defaultLlmModelForApiType('openai'))
    expect(resolveStoredLlmModel('anthropic', undefined)).toBe(
      defaultLlmModelForApiType('anthropic'),
    )
    expect(resolveStoredLlmModel('openai', '   ')).toBe(defaultLlmModelForApiType('openai'))
  })

  it('resolveStoredLlmModel 在非空时保留用户配置', () => {
    expect(resolveStoredLlmModel('openai', 'gpt-4.1')).toBe('gpt-4.1')
    expect(resolveStoredLlmModel('anthropic', ' claude-3 ')).toBe('claude-3')
  })

  it('defaultLlmModelForApiType 返回非空字符串', () => {
    expect(defaultLlmModelForApiType('openai').length).toBeGreaterThan(0)
    expect(defaultLlmModelForApiType('anthropic').length).toBeGreaterThan(0)
  })
})
