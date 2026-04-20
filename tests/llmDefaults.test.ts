import { describe, expect, it } from 'vitest'
import {
  CODE_DEFAULT_LLM_MODEL_ANTHROPIC,
  CODE_DEFAULT_LLM_MODEL_OPENAI,
  defaultLlmModelForApiType,
  resolveStoredLlmModel,
} from '@/lib/config/llmDefaults'

describe('llmDefaults', () => {
  it('defaultLlmModelForApiType 返回各类型内置默认', () => {
    expect(defaultLlmModelForApiType('openai')).toBe(CODE_DEFAULT_LLM_MODEL_OPENAI)
    expect(defaultLlmModelForApiType('anthropic')).toBe(CODE_DEFAULT_LLM_MODEL_ANTHROPIC)
  })

  it('resolveStoredLlmModel 在非空时保留用户配置', () => {
    expect(resolveStoredLlmModel('openai', 'gpt-4.1')).toBe('gpt-4.1')
    expect(resolveStoredLlmModel('anthropic', ' claude-3 ')).toBe('claude-3')
  })

  it('resolveStoredLlmModel 在空或仅空白时使用默认', () => {
    expect(resolveStoredLlmModel('openai', '')).toBe(CODE_DEFAULT_LLM_MODEL_OPENAI)
    expect(resolveStoredLlmModel('anthropic', undefined)).toBe(CODE_DEFAULT_LLM_MODEL_ANTHROPIC)
    expect(resolveStoredLlmModel('openai', '   ')).toBe(CODE_DEFAULT_LLM_MODEL_OPENAI)
  })
})
