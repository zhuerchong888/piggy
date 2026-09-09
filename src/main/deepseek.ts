import type { SettingsInput, TranslateResult, WordDetails } from '../shared/contracts'
import { decryptApiKey, normalizeSettingsInput, readStoredSettings } from './settings'

interface ChatCompletionResponse {
  model?: string
  choices?: Array<{ message?: { content?: string } }>
  error?: { message?: string; code?: string }
}

interface ChatResult {
  content: string
  model: string
}

const ENGLISH_TO_CHINESE_PROMPT = `你是 Piggy 的专业英译中引擎。请把用户提供的英文准确、自然地翻译成简体中文。
规则：
1. 忠实保留原意，不总结、不扩写，不添加原文没有的信息。
2. 保留代码、数字、URL 和专有名词；必要时采用通行中文译名。
3. 单词或短语给出简洁、常用的中文释义；句子或段落输出自然、连贯的中文。
4. 只输出译文，不输出解释、标题、引号或 Markdown。`

const CHINESE_TO_ENGLISH_PROMPT = `你是 Piggy 的专业中译英引擎。请把用户提供的中文准确、自然地翻译成英文。
规则：
1. 忠实保留原意，不总结、不扩写，不添加原文没有的信息。
2. 使用自然、符合语境的现代英文；保留代码、数字、URL 和专有名词。
3. 短语简洁翻译，句子或段落保持完整、连贯。
4. 只输出英文译文，不输出解释、标题、引号或 Markdown。`

const WORD_DETAILS_SYSTEM_PROMPT = `你是 Piggy 的英汉词典助手。用户会提供一个英文单词或很短的英文短语。
请只输出一个合法 JSON 对象，不要使用 Markdown 代码块，也不要输出思考过程或额外文字。
JSON 必须严格使用以下结构：
{"translation":"简洁准确的中文总释义","phonetic":"IPA 音标，短语无通行音标时为空字符串","partOfSpeech":"常见词性，多个词性用 / 分隔","meanings":["常见释义1","常见释义2"],"example":"自然且简短的英文例句","exampleTranslation":"例句的准确中文翻译"}
要求：只提供可靠、常用的信息；meanings 保留 1 至 5 项；例句必须与主要含义一致。`

function shouldShowWordDetails(source: string): boolean {
  if (source.length > 80 || /[.!?;:\n\r]/.test(source) || /[\u3400-\u9fff]/.test(source)) return false
  const words = source.match(/[A-Za-z]+(?:['’][A-Za-z]+)*/g) || []
  if (words.length < 1 || words.length > 4) return false
  const remainder = source.replace(/[A-Za-z]+(?:['’][A-Za-z]+)*/g, '').trim()
  return !remainder
}

function translationPromptFor(source: string): string {
  const chineseCharacters = source.match(/[\u3400-\u9fff]/g)?.length ?? 0
  const englishWords = source.match(/[A-Za-z]+(?:['’][A-Za-z]+)*/g)?.length ?? 0
  return chineseCharacters > 0 && chineseCharacters >= englishWords
    ? CHINESE_TO_ENGLISH_PROMPT
    : ENGLISH_TO_CHINESE_PROMPT
}

function cleanDetailText(value: unknown, maximum: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : ''
}

function parseWordResult(content: string): Pick<TranslateResult, 'translation' | 'wordDetails'> {
  const unfenced = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  const jsonText = unfenced.startsWith('{') && unfenced.endsWith('}')
    ? unfenced
    : unfenced.slice(unfenced.indexOf('{'), unfenced.lastIndexOf('}') + 1)
  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>
    const meanings = Array.isArray(parsed.meanings)
      ? parsed.meanings.map((value) => cleanDetailText(value, 200)).filter(Boolean).slice(0, 5)
      : []
    const translation = cleanDetailText(parsed.translation, 1000) || meanings.join('；')
    if (!translation) throw new Error('missing translation')
    const wordDetails: WordDetails = {
      phonetic: cleanDetailText(parsed.phonetic, 100),
      partOfSpeech: cleanDetailText(parsed.partOfSpeech, 100),
      meanings,
      example: cleanDetailText(parsed.example, 500),
      exampleTranslation: cleanDetailText(parsed.exampleTranslation, 500)
    }
    return { translation, wordDetails }
  } catch {
    return { translation: content }
  }
}

function endpointFor(baseUrl: string): string {
  return baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`
}

function friendlyApiError(status: number, payload: ChatCompletionResponse): Error {
  const rawMessage = payload.error?.message || ''
  if (status === 401 || status === 403) return new Error('API Key 无效，请检查后重试。')
  if (status === 402 || /balance|insufficient|quota/i.test(rawMessage)) {
    return new Error('DeepSeek 账户余额不足，请充值后重试。')
  }
  if (status === 429) return new Error('请求过于频繁，请稍后再试。')
  if (status >= 500) return new Error('DeepSeek 服务暂时不可用，请稍后再试。')
  return new Error(rawMessage ? `DeepSeek 请求失败：${rawMessage}` : `DeepSeek 请求失败（${status}）。`)
}

async function requestChat(options: {
  apiKey: string
  apiBaseUrl: string
  model: string
  messages: Array<{ role: 'system' | 'user'; content: string }>
  maxTokens: number
}): Promise<ChatResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)
  try {
    let response: Response
    try {
      response = await fetch(endpointFor(options.apiBaseUrl), {
        method: 'POST',
        headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: options.model,
          messages: options.messages,
          temperature: 0.1,
          max_tokens: options.maxTokens,
          stream: false
        }),
        signal: controller.signal
      })
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw new Error('DeepSeek 请求超时，请稍后重试。')
      throw new Error('无法连接 DeepSeek，请检查网络和 API 地址。')
    }
    let payload: ChatCompletionResponse = {}
    try {
      payload = (await response.json()) as ChatCompletionResponse
    } catch {
      // A readable status-specific error is returned below.
    }
    if (!response.ok) throw friendlyApiError(response.status, payload)
    const content = payload.choices?.[0]?.message?.content?.trim()
    if (!content) throw new Error('DeepSeek 没有返回译文，请重新尝试。')
    return { content, model: payload.model?.trim() || options.model }
  } finally {
    clearTimeout(timeout)
  }
}

export async function testDeepSeekConnection(input: SettingsInput): Promise<void> {
  const normalized = normalizeSettingsInput(input)
  const stored = await readStoredSettings()
  const apiKey = input.apiKey?.trim() || decryptApiKey(stored)
  await requestChat({
    apiKey,
    ...normalized,
    messages: [
      { role: 'system', content: '你是连接测试助手，只输出 OK。' },
      { role: 'user', content: '请输出 OK' }
    ],
    maxTokens: 8
  })
}

export async function translateWithDeepSeek(text: string): Promise<TranslateResult> {
  const source = text.trim()
  if (!source) throw new Error('请输入需要翻译的内容。')
  if (source.length > 3000) throw new Error('内容超过 3000 个字符，请分段翻译。')
  if (!/[A-Za-z\u3400-\u9fff]/.test(source)) throw new Error('请输入中文或英文内容。')

  const settings = await readStoredSettings()
  const apiKey = decryptApiKey(settings)
  const includeWordDetails = shouldShowWordDetails(source)
  const result = await requestChat({
    apiKey,
    apiBaseUrl: settings.apiBaseUrl,
    model: settings.model,
    messages: [
      { role: 'system', content: includeWordDetails ? WORD_DETAILS_SYSTEM_PROMPT : translationPromptFor(source) },
      { role: 'user', content: source }
    ],
    maxTokens: includeWordDetails ? 1200 : 2000
  })

  return includeWordDetails
    ? { ...parseWordResult(result.content), model: result.model }
    : { translation: result.content, model: result.model }
}
