/* global chrome */
import { resolveLlmRequestUrl } from '@/lib/api/llmEndpoint'
import {
  defaultLlmModelForApiType,
  envDefaultLlmApiKey,
  envDefaultLlmBaseUrl,
  envDefaultLlmModel,
} from '@/lib/config/llmDefaults'
import { clearReuseDomainPolicies, getReuseDomainPolicies } from '@/lib/api/tabReuse'
import { openModal } from '@/entrypoints/sidepanel/ui/modal'
import { toast } from '@/entrypoints/sidepanel/ui/toast'

const DEFAULT_SETTINGS = {
  llmConfig: {
    apiType: 'openai' as 'openai' | 'anthropic',
    baseUrl: envDefaultLlmBaseUrl(),
    apiKey: envDefaultLlmApiKey(),
    model: envDefaultLlmModel(),
    firstPacketTimeoutSeconds: 20,
    supportsImageInput: true,
  },
  suspendTimeout: 0,
  mcpToolTimeoutSeconds: 60,
  reuse: false,
}

export function createSettingsButton(): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'w-16 text-xs py-1 border rounded bg-white hover:bg-gray-50 shadow-sm'
  btn.textContent = '设置'
  btn.addEventListener('click', () => void openSettingsDialog())
  return btn
}

async function openSettingsDialog(): Promise<void> {
  const body = document.createElement('div')
  body.className = 'settings-dialog-body text-xs space-y-3 max-w-lg'

  const res = await chrome.storage.local.get(DEFAULT_SETTINGS)
  const llm = { ...DEFAULT_SETTINGS.llmConfig, ...(res.llmConfig || {}) }

  let apiType: 'openai' | 'anthropic' = llm.apiType === 'anthropic' ? 'anthropic' : 'openai'
  let baseUrl = llm.baseUrl || ''
  let apiKey = llm.apiKey || ''
  let showKey = false
  let model = (llm.model || '').trim() || defaultLlmModelForApiType(llm.apiType === 'anthropic' ? 'anthropic' : 'openai')
  let firstPacketTimeoutSeconds = Math.max(1, Number(llm.firstPacketTimeoutSeconds) || 20)
  let supportsImageInput = llm.supportsImageInput !== false
  let suspendTimeout = Number(res.suspendTimeout) || 0
  let mcpToolTimeoutSeconds = Math.max(1, Number(res.mcpToolTimeoutSeconds) || 60)
  let reuse = !!res.reuse
  let reusePolicyCount = Object.keys((await getReuseDomainPolicies()) || {}).length

  const suspendOptions = [
    { label: '关闭', value: 0 },
    { label: '15 分钟', value: 15 },
    { label: '30 分钟', value: 30 },
    { label: '1 小时', value: 60 },
    { label: '2 小时', value: 120 },
    { label: '1 天', value: 1440 },
  ]

  const render = () => {
    const resolvedUrl = resolveLlmRequestUrl(apiType, baseUrl)
    body.innerHTML = ''

    const apiRow = document.createElement('div')
    apiRow.innerHTML = `<label class="block text-sm font-medium text-gray-500 mb-1">API 类型</label>`
    const apiSel = document.createElement('select')
    apiSel.className = 'w-full border rounded px-2 py-1.5 text-sm'
    apiSel.innerHTML = `<option value="openai">OpenAI 兼容</option><option value="anthropic">Anthropic</option>`
    apiSel.value = apiType
    apiSel.addEventListener('change', () => {
      apiType = apiSel.value as 'openai' | 'anthropic'
      render()
    })
    apiRow.appendChild(apiSel)
    body.appendChild(apiRow)

    body.appendChild(labeledInput('API 地址', baseUrl, (v) => (baseUrl = v), apiType === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com'))

    const hint = document.createElement('div')
    hint.className = 'settings-api-url-hint'
    hint.textContent = `最终 URL 为 ${resolvedUrl || '—'}`
    body.appendChild(hint)

    body.appendChild(secretApiKeyRow())

    body.appendChild(labeledInput('模型', model, (v) => (model = v), defaultLlmModelForApiType(apiType)))

    body.appendChild(
      labeledInput(
        'LLM 首包超时（秒）',
        String(firstPacketTimeoutSeconds),
        (v) => {
          firstPacketTimeoutSeconds = Math.max(1, parseInt(v || '20', 10) || 20)
        },
        '20',
      ),
    )

    const imgRow = document.createElement('label')
    imgRow.className = 'flex items-start gap-2 mt-2'
    const imgCb = document.createElement('input')
    imgCb.type = 'checkbox'
    imgCb.checked = supportsImageInput
    imgCb.addEventListener('change', () => (supportsImageInput = imgCb.checked))
    imgRow.appendChild(imgCb)
    const imgTxt = document.createElement('span')
    imgTxt.className = 'text-sm text-gray-700'
    imgTxt.textContent = '模型支持图片输入（开启后允许截图工具，并把截图作为图片上下文传给模型）'
    imgRow.appendChild(imgTxt)
    body.appendChild(imgRow)

    body.appendChild(
      labeledInput(
        'MCP 工具超时（秒）',
        String(mcpToolTimeoutSeconds),
        (v) => {
          mcpToolTimeoutSeconds = Math.max(1, parseInt(v || '60', 10) || 60)
        },
        '60',
      ),
    )

    const susRow = document.createElement('div')
    susRow.innerHTML = `<label class="block text-sm font-medium text-gray-500 mb-1">自动释放长期不用标签的内存</label>`
    const susSel = document.createElement('select')
    susSel.className = 'w-full border rounded px-2 py-1.5 text-sm'
    suspendOptions.forEach((o) => {
      const opt = document.createElement('option')
      opt.value = String(o.value)
      opt.textContent = o.label
      susSel.appendChild(opt)
    })
    susSel.value = String(suspendTimeout)
    susSel.addEventListener('change', () => {
      suspendTimeout = Number(susSel.value) || 0
    })
    susRow.appendChild(susSel)
    body.appendChild(susRow)

    const reuseRow = document.createElement('label')
    reuseRow.className = 'flex items-start gap-2 mt-2'
    const reuseCb = document.createElement('input')
    reuseCb.type = 'checkbox'
    reuseCb.checked = reuse
    reuseCb.addEventListener('change', () => (reuse = reuseCb.checked))
    reuseRow.appendChild(reuseCb)
    reuseRow.appendChild(
      Object.assign(document.createElement('span'), {
        className: 'text-sm text-gray-700',
        textContent: '复用 Tab（命中已存在页面时优先询问是否复用，并可记住域名选择）',
      }),
    )
    body.appendChild(reuseRow)

    const memRow = document.createElement('div')
    memRow.className = 'settings-reuse-memory-row'
    memRow.innerHTML = `<span class="text-xs text-gray-500">已记住 ${reusePolicyCount} 个域名的复用决策</span>`
    const clearMem = document.createElement('button')
    clearMem.type = 'button'
    clearMem.className = 'text-xs px-2 py-0.5 border rounded disabled:opacity-50'
    clearMem.textContent = '清空域名复用记忆'
    clearMem.disabled = reusePolicyCount === 0
    clearMem.addEventListener('click', async () => {
      await clearReuseDomainPolicies()
      reusePolicyCount = 0
      toast.success('已清空域名复用记忆')
      render()
    })
    memRow.appendChild(clearMem)
    body.appendChild(memRow)

    const actions = document.createElement('div')
    actions.className = 'settings-dialog-actions'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'text-sm min-h-8 px-4 bg-gray-100 text-gray-700 border border-gray-300 rounded hover:bg-gray-200'
    cancel.textContent = '取消'
    const ok = document.createElement('button')
    ok.type = 'button'
    ok.className = 'text-sm min-h-8 px-4 bg-blue-600 text-white border border-blue-600 rounded hover:bg-blue-700'
    ok.textContent = '确认'
    cancel.addEventListener('click', () => close())
    ok.addEventListener('click', async () => {
      await chrome.storage.local.set({
        llmConfig: {
          apiType,
          baseUrl,
          apiKey,
          model,
          firstPacketTimeoutSeconds,
          supportsImageInput,
        },
        suspendTimeout,
        mcpToolTimeoutSeconds,
        reuse,
      })
      toast.success('设置已保存')
      close()
    })
    actions.append(cancel, ok)
    body.appendChild(actions)
  }

  function labeledInput(
    label: string,
    value: string,
    onChange: (v: string) => void,
    placeholder: string,
  ): HTMLElement {
    const wrap = document.createElement('div')
    const lab = document.createElement('label')
    lab.className = 'block text-sm font-medium text-gray-500 mb-1'
    lab.textContent = label
    const inp = document.createElement('input')
    inp.className = 'w-full min-h-8 border border-gray-300 rounded px-2 py-1 text-sm box-border'
    inp.value = value
    inp.placeholder = placeholder
    inp.addEventListener('input', () => onChange(inp.value))
    wrap.append(lab, inp)
    return wrap
  }

  function secretApiKeyRow(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'settings-secret-field'
    const lab = document.createElement('label')
    lab.className = 'block text-sm font-medium text-gray-500 mb-1'
    lab.htmlFor = 'settings-api-key'
    lab.textContent = 'API Key'
    const row = document.createElement('div')
    row.className = 'settings-secret-input-wrapper'
    const inp = document.createElement('input')
    inp.id = 'settings-api-key'
    inp.className = 'settings-secret-input'
    inp.type = showKey ? 'text' : 'password'
    inp.value = apiKey
    inp.autocomplete = 'off'
    inp.placeholder = apiType === 'anthropic' ? 'sk-ant-...' : 'sk-...'
    inp.addEventListener('input', () => (apiKey = inp.value))
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'settings-secret-toggle'
    toggle.title = showKey ? '隐藏' : '显示'
    toggle.innerHTML = showKey
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3L21 21M10.6 10.7A3 3 0 0 0 13.3 13.4M9.9 5.1A10.9 10.9 0 0 1 12 4.9C17 4.9 21 12 21 12A20.6 20.6 0 0 1 17.4 16.6M14.1 14.3A3 3 0 0 1 9.7 9.9M6.5 7.5A20.3 20.3 0 0 0 3 12S7 19.1 12 19.1C13.3 19.1 14.5 18.8 15.6 18.3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12S6.5 5 12 5s9.5 7 9.5 7-4 7-9.5 7S2.5 12 2.5 12Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>'
    toggle.addEventListener('click', () => {
      showKey = !showKey
      inp.type = showKey ? 'text' : 'password'
      render()
    })
    row.append(inp, toggle)
    wrap.append(lab, row)
    return wrap
  }

  const { close } = openModal(body, { title: '设置', widthClass: 'w-full max-w-lg' })
  render()
}
