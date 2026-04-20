/**
 * 代码内默认模型名（可通过环境变量在构建时覆盖）。
 * 在 .env 中设置 VITE_DEFAULT_OPENAI_MODEL / VITE_DEFAULT_ANTHROPIC_MODEL 即可。
 */
export const CODE_DEFAULT_LLM_MODEL_OPENAI = 'gpt-4o'
export const CODE_DEFAULT_LLM_MODEL_ANTHROPIC = 'claude-sonnet-4-20250514'

function readViteEnv(key: string): string | undefined {
  const meta = import.meta as unknown as { env: Record<string, string | boolean | undefined> }
  const v = meta.env[key]
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

/**
 * 当前 API 类型下的默认模型名（环境变量优先，否则为代码常量）。
 */
export function defaultLlmModelForApiType(apiType: string): string {
  if (apiType === 'anthropic') {
    return (
      readViteEnv('VITE_DEFAULT_ANTHROPIC_MODEL') ?? CODE_DEFAULT_LLM_MODEL_ANTHROPIC
    )
  }
  return readViteEnv('VITE_DEFAULT_OPENAI_MODEL') ?? CODE_DEFAULT_LLM_MODEL_OPENAI
}

/**
 * 若用户未填写模型名，则使用当前 API 类型对应的默认值。
 */
export function resolveStoredLlmModel(
  apiType: string | undefined,
  stored: string | undefined,
): string {
  const t = String(apiType || 'openai').trim() || 'openai'
  const m = typeof stored === 'string' ? stored.trim() : ''
  if (m) return m
  return defaultLlmModelForApiType(t === 'anthropic' ? 'anthropic' : 'openai')
}
