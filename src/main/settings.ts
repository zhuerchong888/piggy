import { app, safeStorage } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { selectionHotkeyOptions, type PublicSettings, type SettingsInput } from '../shared/contracts'

interface StoredSettings {
  apiBaseUrl: string
  model: string
  selectionHotkeyEnabled: boolean
  selectionHotkey: string
  selectionAutoTranslate: boolean
  bubbleDurationMs: number
  launchAtLogin: boolean
  encryptedApiKey?: string
}

const defaults: StoredSettings = {
  apiBaseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  selectionHotkeyEnabled: true,
  selectionHotkey: 'CommandOrControl+1',
  selectionAutoTranslate: false,
  bubbleDurationMs: 6000,
  launchAtLogin: false
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function cleanBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error('API 地址格式不正确。')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('API 地址必须以 http:// 或 https:// 开头。')
  }
  return trimmed
}

function cleanModel(value: string): string {
  const model = value.trim()
  if (!model) throw new Error('模型名称不能为空。')
  return model
}

function cleanBubbleDuration(value: number): number {
  if (!Number.isFinite(value)) return defaults.bubbleDurationMs
  return Math.min(15_000, Math.max(3_000, Math.round(value)))
}

function cleanSelectionHotkey(value: unknown): string {
  return selectionHotkeyOptions.some((option) => option.value === value)
    ? (value as string)
    : defaults.selectionHotkey
}

export async function readStoredSettings(): Promise<StoredSettings> {
  try {
    const raw = await readFile(settingsPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<StoredSettings> & { clipboardEnabled?: boolean }
    return {
      apiBaseUrl: parsed.apiBaseUrl || defaults.apiBaseUrl,
      model: parsed.model || defaults.model,
      selectionHotkeyEnabled:
        parsed.selectionHotkeyEnabled ?? parsed.clipboardEnabled ?? defaults.selectionHotkeyEnabled,
      selectionHotkey: cleanSelectionHotkey(parsed.selectionHotkey),
      selectionAutoTranslate: parsed.selectionAutoTranslate ?? defaults.selectionAutoTranslate,
      bubbleDurationMs: cleanBubbleDuration(parsed.bubbleDurationMs ?? defaults.bubbleDurationMs),
      launchAtLogin: parsed.launchAtLogin ?? defaults.launchAtLogin,
      encryptedApiKey: parsed.encryptedApiKey
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || error instanceof SyntaxError) return { ...defaults }
    throw error
  }
}

async function writeStoredSettings(settings: StoredSettings): Promise<void> {
  const target = settingsPath()
  const temporary = `${target}.tmp`
  await mkdir(dirname(target), { recursive: true })
  await writeFile(temporary, JSON.stringify(settings, null, 2), 'utf8')
  await rename(temporary, target)
}

export function toPublicSettings(settings: StoredSettings): PublicSettings {
  return {
    apiBaseUrl: settings.apiBaseUrl,
    model: settings.model,
    hasApiKey: Boolean(settings.encryptedApiKey),
    selectionHotkeyEnabled: settings.selectionHotkeyEnabled,
    selectionHotkey: settings.selectionHotkey,
    selectionAutoTranslate: settings.selectionAutoTranslate,
    bubbleDurationMs: settings.bubbleDurationMs,
    launchAtLogin: settings.launchAtLogin
  }
}

export async function getPublicSettings(): Promise<PublicSettings> {
  return toPublicSettings(await readStoredSettings())
}

export async function saveSettings(input: SettingsInput): Promise<PublicSettings> {
  const current = await readStoredSettings()
  const apiKey = input.apiKey?.trim()
  let encryptedApiKey = current.encryptedApiKey

  if (apiKey) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows 安全存储暂不可用，无法安全保存 API Key。')
    }
    encryptedApiKey = safeStorage.encryptString(apiKey).toString('base64')
  }
  if (!encryptedApiKey) throw new Error('请填写 DeepSeek API Key。')

  const next: StoredSettings = {
    apiBaseUrl: cleanBaseUrl(input.apiBaseUrl),
    model: cleanModel(input.model),
    selectionHotkeyEnabled: Boolean(input.selectionHotkeyEnabled),
    selectionHotkey: cleanSelectionHotkey(input.selectionHotkey),
    selectionAutoTranslate: Boolean(input.selectionAutoTranslate),
    bubbleDurationMs: cleanBubbleDuration(input.bubbleDurationMs),
    launchAtLogin: Boolean(input.launchAtLogin),
    encryptedApiKey
  }

  await writeStoredSettings(next)
  return toPublicSettings(next)
}

export function decryptApiKey(settings: StoredSettings): string {
  if (!settings.encryptedApiKey) throw new Error('请先在设置中填写 DeepSeek API Key。')
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Windows 安全存储暂不可用，无法读取 API Key。')
  }
  try {
    return safeStorage.decryptString(Buffer.from(settings.encryptedApiKey, 'base64'))
  } catch {
    throw new Error('API Key 无法解密，请在设置中重新填写。')
  }
}

export function normalizeSettingsInput(
  input: SettingsInput
): Pick<StoredSettings, 'apiBaseUrl' | 'model'> {
  return {
    apiBaseUrl: cleanBaseUrl(input.apiBaseUrl),
    model: cleanModel(input.model)
  }
}
