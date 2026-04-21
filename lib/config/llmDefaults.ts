/**
 * 构建时默认值（.env，Vite 约定 VITE_*）：
 * - VITE_DEFAULT_LLM_BASE_URL / VITE_DEFAULT_LLM_API_KEY / VITE_DEFAULT_LLM_MODEL：设置页与 storage 合并用默认
 * - VITE_DEFAULT_LLM_MODEL：未单独指定时，也作为「空模型名」解析时的全局优先默认
 * - VITE_DEFAULT_OPENAI_MODEL / VITE_DEFAULT_ANTHROPIC_MODEL：按 API 类型覆盖（在无 VITE_DEFAULT_LLM_MODEL 时生效）
 */
export const CODE_DEFAULT_LLM_MODEL_OPENAI = 'gpt-4o'
export const CODE_DEFAULT_LLM_MODEL_ANTHROPIC = 'claude-sonnet-4-20250514'

function readViteEnv(key: string): string | undefined {
  const env = (import.meta as unknown as { env?: Record<string, string | boolean | undefined> }).env
  if (!env) return undefined
  const v = env[key]
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

export function envDefaultLlmBaseUrl(): string {
  return readViteEnv('VITE_DEFAULT_LLM_BASE_URL') ?? ''
}

export function envDefaultLlmApiKey(): string {
  return readViteEnv('VITE_DEFAULT_LLM_API_KEY') ?? ''
}

export function envDefaultLlmModel(): string {
  return readViteEnv('VITE_DEFAULT_LLM_MODEL') ?? ''
}

/**
 * 当前 API 类型下的默认模型名（环境变量优先，否则为代码常量）。
 */
export function defaultLlmModelForApiType(apiType: string): string {
  const globalModel = readViteEnv('VITE_DEFAULT_LLM_MODEL')
  if (globalModel) return globalModel
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
