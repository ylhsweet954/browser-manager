import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, test, expect } from '@playwright/test'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const extensionPath = path.resolve(__dirname, '../../.output/chrome-mv3')

test.describe('扩展产物', () => {
  test('manifest 与 sidepanel 存在', async () => {
    const fs = await import('node:fs')
    expect(fs.existsSync(path.join(extensionPath, 'manifest.json'))).toBe(true)
    expect(fs.existsSync(path.join(extensionPath, 'sidepanel.html'))).toBe(true)
    expect(fs.existsSync(path.join(extensionPath, 'background.js'))).toBe(true)
  })

  test('可启动带扩展的 Chromium 并打开任意页', async () => {
    const fs = await import('node:fs')
    if (!fs.existsSync(extensionPath)) {
      test.skip(true, '请先执行 npm run build 生成 .output/chrome-mv3')
    }
    const context = await chromium.launchPersistentContext('', {
      headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    })
    const page = await context.newPage()
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await expect(page.locator('h1')).toContainText('Example')
    await context.close()
  })
})
