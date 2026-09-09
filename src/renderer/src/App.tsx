import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import type {
  BubbleContext,
  LibraryEntry,
  LibrarySnapshot,
  PopupContext,
  PublicSettings,
  SettingsInput,
  WordDetails
} from '../../shared/contracts'
import { selectionHotkeyOptions } from '../../shared/contracts'
import piggyIconUrl from './assets/piggy.png'

type Page = 'translate' | 'wordbook' | 'history' | 'settings'
type Notice = { kind: 'success' | 'error'; text: string } | null
type Surface = 'main' | 'bubble' | 'popup'

const defaultSettings: PublicSettings = {
  apiBaseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  hasApiKey: false,
  selectionHotkeyEnabled: true,
  selectionHotkey: 'CommandOrControl+1',
  selectionAutoTranslate: false,
  bubbleDurationMs: 6000,
  launchAtLogin: false
}

const deepSeekModels = [
  {
    value: 'deepseek-chat',
    label: '普通翻译（推荐）',
    description: '响应更快，适合日常单词、句子和段落翻译。'
  },
  {
    value: 'deepseek-reasoner',
    label: '深度翻译',
    description: '思考更充分但响应较慢，适合复杂句和专业内容。'
  }
] as const

const emptyLibrary: LibrarySnapshot = { favorites: [], history: [] }
const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit'
})

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '发生未知错误，请重试。'
  return message.replace(/^Error invoking remote method '[^']+': Error:\s*/, '')
}

function currentSurface(): Surface {
  const value = new URLSearchParams(window.location.search).get('surface')
  return value === 'bubble' || value === 'popup' ? value : 'main'
}

function sourceKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

function hotkeyLabel(value: string): string {
  return selectionHotkeyOptions.find((option) => option.value === value)?.label.replace('（推荐）', '') || value
}

function isFavorite(library: LibrarySnapshot, source: string): boolean {
  const key = sourceKey(source)
  return Boolean(key && library.favorites.some((entry) => sourceKey(entry.source) === key))
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : dateFormatter.format(date)
}

function App(): React.JSX.Element {
  const surface = currentSurface()
  document.documentElement.dataset.surface = surface

  if (surface === 'bubble') return <BubbleSurface />
  if (surface === 'popup') return <PopupSurface />
  return <MainApplication />
}

function BubbleSurface(): React.JSX.Element {
  const [context, setContext] = useState<BubbleContext>({ phase: 'idle', message: '' })
  const drag = useRef<{
    pointerId: number
    startX: number
    startY: number
    moved: boolean
  } | null>(null)

  useEffect(() => {
    const unsubscribe = window.piggy.onBubbleContext(setContext)
    void window.piggy.getBubbleContext().then(setContext).catch(() => undefined)
    return unsubscribe
  }, [])

  function handlePointerDown(event: ReactPointerEvent<HTMLButtonElement>): void {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = {
      pointerId: event.pointerId,
      startX: event.screenX,
      startY: event.screenY,
      moved: false
    }
    window.piggy.startBubbleDrag({ screenX: event.screenX, screenY: event.screenY })
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLButtonElement>): void {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    if (Math.hypot(event.screenX - current.startX, event.screenY - current.startY) > 4) current.moved = true
    window.piggy.moveBubble({ screenX: event.screenX, screenY: event.screenY })
  }

  function finishPointer(event: ReactPointerEvent<HTMLButtonElement>, activate: boolean): void {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    drag.current = null
    window.piggy.endBubbleDrag()
    if (activate && !current.moved) window.piggy.activateBubble()
  }

  return (
    <button
      className={`bubble-button is-${context.phase}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => finishPointer(event, true)}
      onPointerCancel={(event) => finishPointer(event, false)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') window.piggy.activateBubble()
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        window.piggy.showBubbleMenu()
      }}
      aria-label={context.message || '使用 Piggy 翻译；拖动可移动'}
      title={context.message || '点击翻译，拖动可移动'}
    >
      <img src={piggyIconUrl} alt="" aria-hidden="true" draggable="false" />
      {context.phase !== 'idle' && <span className="bubble-status" aria-hidden="true" />}
    </button>
  )
}

function PopupSurface(): React.JSX.Element {
  const [source, setSource] = useState('')
  const [sourceContext, setSourceContext] = useState('')
  const [translation, setTranslation] = useState('')
  const [translationModel, setTranslationModel] = useState('')
  const [wordDetails, setWordDetails] = useState<WordDetails | undefined>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [favoriteSaved, setFavoriteSaved] = useState(false)
  const [savingFavorite, setSavingFavorite] = useState(false)
  const [actionNotice, setActionNotice] = useState('')
  const handledRequestId = useRef<number | null>(null)

  async function refreshFavoriteState(text: string): Promise<void> {
    try {
      setFavoriteSaved(isFavorite(await window.piggy.getLibrary(), text))
    } catch {
      setFavoriteSaved(false)
    }
  }

  async function translate(text: string, context = sourceContext): Promise<void> {
    if (!text.trim()) {
      setError('没有找到需要翻译的内容。')
      setLoading(false)
      return
    }

    setLoading(true)
    setError('')
    setActionNotice('')
    setTranslation('')
    setTranslationModel('')
    setWordDetails(undefined)
    setFavoriteSaved(false)
    try {
      const result = await window.piggy.translate({ text, sourceContext: context || undefined })
      setTranslation(result.translation)
      setTranslationModel(result.model)
      setWordDetails(result.wordDetails)
      void refreshFavoriteState(text)
    } catch (requestError) {
      setError(errorMessage(requestError))
    } finally {
      setLoading(false)
    }
  }

  function loadPopupContext(context: PopupContext): void {
    if (handledRequestId.current === context.requestId) return
    handledRequestId.current = context.requestId
    setSource(context.text)
    setSourceContext(context.sourceContext || '')
    if (context.text.trim()) {
      void translate(context.text, context.sourceContext || '')
    } else {
      setLoading(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    const unsubscribe = window.piggy.onPopupContext((context) => {
      if (!cancelled) loadPopupContext(context)
    })
    window.piggy
      .getPopupContext()
      .then((context) => {
        if (!cancelled) loadPopupContext(context)
      })
      .catch((contextError) => {
        if (!cancelled) {
          setError(errorMessage(contextError))
          setLoading(false)
        }
      })

    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') window.piggy.closePopup()
    }
    window.addEventListener('keydown', closeOnEscape)

    return () => {
      cancelled = true
      unsubscribe()
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [])

  async function copyTranslation(): Promise<void> {
    if (!translation) return
    await window.piggy.copyText(translation)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  async function saveFavorite(): Promise<void> {
    if (!source || !translation || favoriteSaved) return
    setSavingFavorite(true)
    setActionNotice('')
    try {
      const library = await window.piggy.addFavorite({
        source,
        translation,
        model: translationModel,
        sourceContext: sourceContext || undefined,
        wordDetails
      })
      setFavoriteSaved(isFavorite(library, source))
      setActionNotice('已加入生词本。')
    } catch (saveError) {
      setActionNotice(errorMessage(saveError))
    } finally {
      setSavingFavorite(false)
    }
  }

  return (
    <article className="popup-card">
      <header className="popup-header">
        <div className="popup-brand">
          <span className="popup-pig" aria-hidden="true">
            <img src={piggyIconUrl} alt="" />
          </span>
          <strong>Piggy 翻译</strong>
        </div>
        <button className="popup-close" onClick={() => window.piggy.closePopup()} aria-label="关闭">
          ×
        </button>
      </header>

      <div className="popup-content">
        <section className="popup-section source-section">
          <span>英文原文</span>
          <p>{source || '正在读取选中内容……'}</p>
          {sourceContext && <blockquote>{sourceContext}</blockquote>}
        </section>

        <section className="popup-section translation-section" aria-live="polite">
          <span>中文译文</span>
          {loading ? (
            <div className="popup-loading">
              <i />
              正在连接 DeepSeek…
            </div>
          ) : error ? (
            <div className="popup-error">
              <strong>翻译没有完成</strong>
              <p>{error}</p>
            </div>
          ) : (
            <p className="popup-translation">{translation}</p>
          )}
          {translationModel && !loading && !error && <small className="model-note">模型：{translationModel}</small>}
          {wordDetails && !loading && !error && <WordDetailsCard details={wordDetails} compact />}
          {actionNotice && <small className="popup-action-notice">{actionNotice}</small>}
        </section>
      </div>

      <footer className="popup-actions">
        <button className="popup-text-action" onClick={() => window.piggy.openMainWindow()}>
          打开 Piggy
        </button>
        <div>
          {!loading && (
            <button className="popup-secondary" onClick={() => translate(source, sourceContext)}>
              重新翻译
            </button>
          )}
          <button
            className="popup-secondary"
            data-testid="popup-favorite"
            disabled={!translation || loading || favoriteSaved || savingFavorite}
            onClick={saveFavorite}
          >
            {favoriteSaved ? '已收藏' : savingFavorite ? '收藏中…' : '收藏'}
          </button>
          <button className="popup-primary" disabled={!translation || loading} onClick={copyTranslation}>
            {copied ? '已复制' : '复制译文'}
          </button>
        </div>
      </footer>
    </article>
  )
}

function MainApplication(): React.JSX.Element {
  const [page, setPage] = useState<Page>('translate')
  const [settings, setSettings] = useState<PublicSettings>(defaultSettings)
  const [loadingSettings, setLoadingSettings] = useState(true)
  const activeHotkeyLabel = hotkeyLabel(settings.selectionHotkey)

  useEffect(() => {
    window.piggy
      .getSettings()
      .then((value) => {
        setSettings(value)
        if (!value.hasApiKey) setPage('settings')
      })
      .catch(() => setPage('settings'))
      .finally(() => setLoadingSettings(false))
  }, [])

  if (loadingSettings) {
    return (
      <main className="loading-screen">
        <div className="brand-mark large"><img src={piggyIconUrl} alt="" /></div>
        <p>Piggy 正在醒来……</p>
      </main>
    )
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><img src={piggyIconUrl} alt="" /></div>
          <div>
            <strong>Piggy</strong>
            <span>简洁中英互译</span>
          </div>
        </div>

        <nav className="nav-list" aria-label="主导航">
          <button className={page === 'translate' ? 'active' : ''} onClick={() => setPage('translate')}>
            <span aria-hidden="true">译</span>
            翻译
          </button>
          <button data-testid="nav-wordbook" className={page === 'wordbook' ? 'active' : ''} onClick={() => setPage('wordbook')}>
            <span aria-hidden="true">藏</span>
            生词本
          </button>
          <button data-testid="nav-history" className={page === 'history' ? 'active' : ''} onClick={() => setPage('history')}>
            <span aria-hidden="true">历</span>
            翻译历史
          </button>
          <button className={page === 'settings' ? 'active' : ''} onClick={() => setPage('settings')}>
            <span aria-hidden="true">设</span>
            设置
          </button>
        </nav>

        <div className="sidebar-status">
          <i className={settings.hasApiKey && settings.selectionHotkeyEnabled ? 'online' : ''} />
          {!settings.hasApiKey
            ? '等待配置 DeepSeek'
            : settings.selectionHotkeyEnabled
              ? settings.selectionAutoTranslate
                ? `${activeHotkeyLabel} 直出解释`
                : `${activeHotkeyLabel} 划词已开启`
              : '划词翻译已关闭'}
        </div>
      </aside>

      <main className="content">
        {page === 'translate' && (
          <TranslatePage
            configured={settings.hasApiKey}
            hotkeyLabel={activeHotkeyLabel}
            directTranslateOnHotkey={settings.selectionAutoTranslate}
            onOpenSettings={() => setPage('settings')}
          />
        )}
        {page === 'wordbook' && <WordbookPage />}
        {page === 'history' && <HistoryPage />}
        {page === 'settings' && (
          <SettingsPage settings={settings} onSaved={setSettings} onReady={() => setPage('translate')} />
        )}
      </main>
    </div>
  )
}

function TranslatePage({
  configured,
  hotkeyLabel: shortcutLabel,
  directTranslateOnHotkey,
  onOpenSettings
}: {
  configured: boolean
  hotkeyLabel: string
  directTranslateOnHotkey: boolean
  onOpenSettings: () => void
}): React.JSX.Element {
  const [source, setSource] = useState('')
  const [translatedSource, setTranslatedSource] = useState('')
  const [translation, setTranslation] = useState('')
  const [translationModel, setTranslationModel] = useState('')
  const [wordDetails, setWordDetails] = useState<WordDetails | undefined>()
  const [translating, setTranslating] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)
  const [copied, setCopied] = useState(false)
  const [favoriteSaved, setFavoriteSaved] = useState(false)
  const [savingFavorite, setSavingFavorite] = useState(false)
  const remaining = 3000 - source.length

  function changeSource(value: string): void {
    setSource(value)
    if (value.trim() !== translatedSource) {
      setTranslatedSource('')
      setTranslation('')
      setTranslationModel('')
      setWordDetails(undefined)
      setFavoriteSaved(false)
      setNotice(null)
    }
  }

  async function handleTranslate(): Promise<void> {
    const requestSource = source.trim()
    if (!requestSource) {
      setNotice({ kind: 'error', text: '请先输入需要翻译的中文或英文。' })
      return
    }

    setTranslating(true)
    setNotice(null)
    setTranslation('')
    setTranslationModel('')
    setWordDetails(undefined)
    setFavoriteSaved(false)
    try {
      const result = await window.piggy.translate({ text: requestSource })
      setTranslatedSource(requestSource)
      setTranslation(result.translation)
      setTranslationModel(result.model)
      setWordDetails(result.wordDetails)
      void window.piggy
        .getLibrary()
        .then((library) => setFavoriteSaved(isFavorite(library, requestSource)))
        .catch(() => undefined)
    } catch (requestError) {
      setNotice({ kind: 'error', text: errorMessage(requestError) })
    } finally {
      setTranslating(false)
    }
  }

  async function copyTranslation(): Promise<void> {
    if (!translation) return
    await window.piggy.copyText(translation)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  async function saveFavorite(): Promise<void> {
    if (!translatedSource || !translation || favoriteSaved) return
    setSavingFavorite(true)
    setNotice(null)
    try {
      const library = await window.piggy.addFavorite({
        source: translatedSource,
        translation,
        model: translationModel,
        wordDetails
      })
      setFavoriteSaved(isFavorite(library, translatedSource))
      setNotice({ kind: 'success', text: '已加入生词本。' })
    } catch (saveError) {
      setNotice({ kind: 'error', text: errorMessage(saveError) })
    } finally {
      setSavingFavorite(false)
    }
  }

  return (
    <section className="page translate-page">
      <header className="translate-header">
        <div>
          <p className="eyebrow">PIGGY TRANSLATE</p>
          <h1>中英互译，简单一点。</h1>
          <p>自动识别中文或英文，只保留翻译需要的内容。</p>
        </div>
        <span className="direction-pill">中文 ⇄ English</span>
      </header>

      {!configured && (
        <div className="setup-callout">
          <div>
            <strong>还差一步就能开始</strong>
            <span>先填写你的 DeepSeek API Key。</span>
          </div>
          <button onClick={onOpenSettings}>前往设置</button>
        </div>
      )}

      <div className="translator-workspace">
        <section className="translate-pane source-pane">
          <div className="field-heading">
            <label htmlFor="sourceText">原文</label>
            <span className={remaining < 0 ? 'over-limit' : ''}>自动识别 · {source.length} / 3000</span>
          </div>
          <textarea
            id="sourceText"
            value={source}
            onChange={(event) => changeSource(event.target.value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault()
                void handleTranslate()
              }
            }}
            placeholder="输入中文或英文…"
            spellCheck="false"
            autoFocus
          />
          <div className="pane-footer">
            <span className="shortcut-hint">
              <img src={piggyIconUrl} alt="" />
              选中文字按 {shortcutLabel}，{directTranslateOnHotkey ? '直接显示解释' : '点击小猪查看解释'}
            </span>
            <button className="primary-button" disabled={!configured || translating || remaining < 0} onClick={handleTranslate}>
              {translating ? '翻译中…' : '翻译'}
            </button>
          </div>
        </section>

        <section className={`translate-pane result-pane ${translation ? 'has-result' : ''}`} aria-live="polite">
          <div className="field-heading">
            <span className="result-label">译文</span>
            <div className="result-tools">
              {translationModel && <span className="model-chip">{translationModel}</span>}
              {translation && (
                <button className="text-button" disabled={favoriteSaved || savingFavorite} onClick={saveFavorite}>
                  {favoriteSaved ? '已收藏' : savingFavorite ? '收藏中…' : '加入生词本'}
                </button>
              )}
              {translation && (
                <button className="text-button" onClick={copyTranslation}>
                  {copied ? '已复制' : '复制'}
                </button>
              )}
            </div>
          </div>
          {translating ? (
            <div className="result-placeholder pulse">正在连接 DeepSeek…</div>
          ) : translation ? (
            <div className="result-content">
              <p className="translation-text">{translation}</p>
              {wordDetails && <WordDetailsCard details={wordDetails} />}
            </div>
          ) : (
            <div className="result-placeholder">译文会显示在这里</div>
          )}
        </section>
      </div>

      {notice && <div className={`notice translate-notice ${notice.kind}`}>{notice.text}</div>}

      <p className="privacy-note">Ctrl+Enter 快速翻译 · 文本仅在你主动翻译时发送给 DeepSeek · 数据保存在本机</p>
    </section>
  )
}

function WordbookPage(): React.JSX.Element {
  const [library, setLibrary] = useState<LibrarySnapshot>(emptyLibrary)
  const [query, setQuery] = useState('')
  const [selectedTag, setSelectedTag] = useState('')
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState<Notice>(null)
  const [copiedId, setCopiedId] = useState('')

  useEffect(() => {
    window.piggy
      .getLibrary()
      .then(setLibrary)
      .catch((error) => setNotice({ kind: 'error', text: errorMessage(error) }))
      .finally(() => setLoading(false))
  }, [])

  const filtered = useMemo(() => {
    const key = query.trim().toLocaleLowerCase()
    return library.favorites.filter((entry) =>
      (!selectedTag || entry.tags?.some((tag) => tag.toLocaleLowerCase() === selectedTag.toLocaleLowerCase())) &&
      (!key || `${entry.source}\n${entry.translation}\n${entry.sourceContext || ''}\n${entry.note || ''}\n${(entry.tags || []).join(' ')}`.toLocaleLowerCase().includes(key))
    )
  }, [library.favorites, query, selectedTag])

  const tags = useMemo(() => {
    const counts = new Map<string, { label: string; count: number }>()
    for (const entry of library.favorites) {
      for (const tag of entry.tags || []) {
        const key = tag.toLocaleLowerCase()
        const current = counts.get(key)
        counts.set(key, { label: current?.label || tag, count: (current?.count || 0) + 1 })
      }
    }
    return Array.from(counts.values()).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-CN'))
  }, [library.favorites])

  async function remove(entry: LibraryEntry): Promise<void> {
    try {
      setLibrary(await window.piggy.removeFavorite(entry.id))
      setNotice(null)
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) })
    }
  }

  async function copy(entry: LibraryEntry): Promise<void> {
    await window.piggy.copyText(`${entry.source}\n\n${entry.translation}`)
    setCopiedId(entry.id)
    window.setTimeout(() => setCopiedId(''), 1500)
  }

  return (
    <section className="page library-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">PERSONAL LIBRARY</p>
          <h1>生词本</h1>
          <p>收藏需要反复看的单词、短语或句子。</p>
        </div>
        <span className="version-chip">{library.favorites.length} 条收藏</span>
      </header>

      <div className="library-toolbar">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索单词、译文、语境或标签"
          aria-label="搜索生词本"
        />
        <span>{query || selectedTag ? `找到 ${filtered.length} 条` : '按最近收藏排序'}</span>
      </div>

      {tags.length > 0 && (
        <div className="tag-filter-bar" aria-label="按标签筛选">
          <button className={!selectedTag ? 'active' : ''} onClick={() => setSelectedTag('')}>全部</button>
          {tags.map((tag) => (
            <button
              key={tag.label}
              className={selectedTag.toLocaleLowerCase() === tag.label.toLocaleLowerCase() ? 'active' : ''}
              onClick={() => setSelectedTag(tag.label)}
            >
              {tag.label}<span>{tag.count}</span>
            </button>
          ))}
        </div>
      )}

      {notice && <div className={`notice ${notice.kind}`}>{notice.text}</div>}
      {loading ? (
        <LibraryLoading />
      ) : filtered.length ? (
        <div className="library-list">
          {filtered.map((entry) => (
            <LibraryCard
              key={entry.id}
              entry={entry}
              noteEditor={
                <FavoriteNoteEditor
                  entry={entry}
                  onSaved={setLibrary}
                  onError={(error) => setNotice({ kind: 'error', text: errorMessage(error) })}
                />
              }
            >
              <button onClick={() => copy(entry)}>{copiedId === entry.id ? '已复制' : '复制'}</button>
              <button className="danger-action" onClick={() => remove(entry)}>删除</button>
            </LibraryCard>
          ))}
        </div>
      ) : (
        <LibraryEmpty
          title={query ? '没有匹配的收藏' : '生词本还是空的'}
          description={query ? '换一个关键词试试。' : '翻译完成后点击“加入生词本”，它就会出现在这里。'}
        />
      )}
    </section>
  )
}

function HistoryPage(): React.JSX.Element {
  const [library, setLibrary] = useState<LibrarySnapshot>(emptyLibrary)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState<Notice>(null)

  useEffect(() => {
    window.piggy
      .getLibrary()
      .then(setLibrary)
      .catch((error) => setNotice({ kind: 'error', text: errorMessage(error) }))
      .finally(() => setLoading(false))
  }, [])

  const filtered = useMemo(() => {
    const key = query.trim().toLocaleLowerCase()
    if (!key) return library.history
    return library.history.filter((entry) =>
      `${entry.source}\n${entry.translation}`.toLocaleLowerCase().includes(key)
    )
  }, [library.history, query])

  async function remove(entry: LibraryEntry): Promise<void> {
    try {
      setLibrary(await window.piggy.removeHistory(entry.id))
      setNotice(null)
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) })
    }
  }

  async function save(entry: LibraryEntry): Promise<void> {
    try {
      setLibrary(await window.piggy.addFavorite(entry))
      setNotice({ kind: 'success', text: '已加入生词本。' })
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) })
    }
  }

  async function clearAll(): Promise<void> {
    if (!window.confirm('确定清空全部翻译历史吗？生词本中的收藏不会删除。')) return
    try {
      setLibrary(await window.piggy.clearHistory())
      setNotice(null)
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) })
    }
  }

  return (
    <section className="page library-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">RECENT TRANSLATIONS</p>
          <h1>翻译历史</h1>
          <p>保留最近 100 条成功翻译，相同原文只显示最新一次。</p>
        </div>
        <button className="header-text-button" disabled={!library.history.length} onClick={clearAll}>清空历史</button>
      </header>

      <div className="library-toolbar">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索历史"
          aria-label="搜索翻译历史"
        />
        <span>{library.history.length} / 100 条</span>
      </div>

      {notice && <div className={`notice ${notice.kind}`}>{notice.text}</div>}
      {loading ? (
        <LibraryLoading />
      ) : filtered.length ? (
        <div className="library-list">
          {filtered.map((entry) => {
            const saved = isFavorite(library, entry.source)
            return (
              <LibraryCard key={entry.id} entry={entry}>
                <button disabled={saved} onClick={() => save(entry)}>{saved ? '已收藏' : '加入生词本'}</button>
                <button className="danger-action" onClick={() => remove(entry)}>删除</button>
              </LibraryCard>
            )
          })}
        </div>
      ) : (
        <LibraryEmpty
          title={query ? '没有匹配的历史' : '还没有翻译历史'}
          description={query ? '换一个关键词试试。' : '成功翻译后会自动记录在这里。'}
        />
      )}
    </section>
  )
}

function LibraryCard({
  entry,
  children,
  noteEditor
}: {
  entry: LibraryEntry
  children: React.ReactNode
  noteEditor?: React.ReactNode
}): React.JSX.Element {
  return (
    <details className="library-card">
      <summary className="library-row">
        <strong title={entry.source}>{entry.source}</strong>
        <span className="library-row-translation" title={entry.translation}>{entry.translation}</span>
        {Boolean(entry.tags?.length) && (
          <span className="library-row-tags">{entry.tags?.slice(0, 2).map((tag) => `#${tag}`).join(' ')}</span>
        )}
        <time dateTime={entry.createdAt}>{formatDate(entry.createdAt)}</time>
        <i className="library-chevron" aria-hidden="true" />
      </summary>
      <div className="library-card-body">
        <p className="library-full-translation">{entry.translation}</p>
        {entry.sourceContext && (
          <div className="saved-context">
            <span>原句语境</span>
            <p>{entry.sourceContext}</p>
          </div>
        )}
        {Boolean(entry.tags?.length) && (
          <div className="tag-list">{entry.tags?.map((tag) => <span key={tag}>#{tag}</span>)}</div>
        )}
        {entry.wordDetails && <WordDetailsCard details={entry.wordDetails} compact />}
        {noteEditor}
        <footer>
          <span>{entry.model}</span>
          <div>{children}</div>
        </footer>
      </div>
    </details>
  )
}

function FavoriteNoteEditor({
  entry,
  onSaved,
  onError
}: {
  entry: LibraryEntry
  onSaved: (library: LibrarySnapshot) => void
  onError: (error: unknown) => void
}): React.JSX.Element {
  const [note, setNote] = useState(entry.note || '')
  const [tagInput, setTagInput] = useState((entry.tags || []).join('，'))
  const [saving, setSaving] = useState(false)
  const [savingTags, setSavingTags] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => setNote(entry.note || ''), [entry.id, entry.note])
  useEffect(() => setTagInput((entry.tags || []).join('，')), [entry.id, entry.tags])

  const normalizedTags = tagInput
    .split(/[,，\n]+/)
    .map((tag) => tag.trim().replace(/^#+/, ''))
    .filter(Boolean)
    .slice(0, 8)
  const tagsChanged = normalizedTags.join('\n').toLocaleLowerCase() !== (entry.tags || []).join('\n').toLocaleLowerCase()

  async function saveNote(): Promise<void> {
    setSaving(true)
    setSaved(false)
    try {
      onSaved(await window.piggy.updateFavoriteNote(entry.id, note))
      setSaved(true)
      window.setTimeout(() => setSaved(false), 1600)
    } catch (error) {
      onError(error)
    } finally {
      setSaving(false)
    }
  }

  async function saveTags(): Promise<void> {
    setSavingTags(true)
    setSaved(false)
    try {
      onSaved(await window.piggy.updateFavoriteTags(entry.id, normalizedTags))
      setSaved(true)
      window.setTimeout(() => setSaved(false), 1600)
    } catch (error) {
      onError(error)
    } finally {
      setSavingTags(false)
    }
  }

  return (
    <details className="note-editor">
      <summary>
        <span>备注与标签</span>
        <small>{entry.note ? '已有备注' : entry.tags?.length ? `${entry.tags.length} 个标签` : '可选'}</small>
      </summary>
      <div className="note-editor-content">
        <div className="note-editor-heading">
          <strong>备注</strong>
          <span>{note.length} / 500</span>
        </div>
        <textarea
          value={note}
          maxLength={500}
          rows={2}
          onChange={(event) => {
            setNote(event.target.value)
            setSaved(false)
          }}
          placeholder="写一点真正有用的提示…"
        />
        <button disabled={saving || note === (entry.note || '')} onClick={saveNote}>
          {saving ? '保存中…' : saved ? '已保存' : '保存备注'}
        </button>
        <div className="tag-editor">
          <div>
            <strong>标签</strong>
            <span>可选，最多 8 个</span>
          </div>
          <div>
            <input
              value={tagInput}
              onChange={(event) => {
                setTagInput(event.target.value)
                setSaved(false)
              }}
              placeholder="用逗号分隔"
              maxLength={180}
            />
            <button disabled={savingTags || !tagsChanged} onClick={saveTags}>
              {savingTags ? '保存中…' : '保存标签'}
            </button>
          </div>
        </div>
      </div>
    </details>
  )
}

function WordDetailsCard({ details, compact = false }: { details: WordDetails; compact?: boolean }): React.JSX.Element {
  return (
    <div className={`word-details ${compact ? 'compact' : ''}`}>
      <div className="word-details-heading">
        <strong>单词详情</strong>
        <div>
          {details.phonetic && <span className="phonetic">{details.phonetic}</span>}
          {details.partOfSpeech && <span className="part-of-speech">{details.partOfSpeech}</span>}
        </div>
      </div>
      {details.meanings.length > 0 && (
        <ul>{details.meanings.map((meaning, index) => <li key={`${meaning}-${index}`}>{meaning}</li>)}</ul>
      )}
      {details.example && (
        <div className="word-example">
          <span>{details.example}</span>
          {details.exampleTranslation && <small>{details.exampleTranslation}</small>}
        </div>
      )}
    </div>
  )
}

function LibraryLoading(): React.JSX.Element {
  return <div className="library-state pulse">Piggy 正在整理……</div>
}

function LibraryEmpty({ title, description }: { title: string; description: string }): React.JSX.Element {
  return (
    <div className="library-state empty">
      <img src={piggyIconUrl} alt="" />
      <strong>{title}</strong>
      <span>{description}</span>
    </div>
  )
}

function SettingsPage({
  settings,
  onSaved,
  onReady
}: {
  settings: PublicSettings
  onSaved: (settings: PublicSettings) => void
  onReady: () => void
}): React.JSX.Element {
  const [apiKey, setApiKey] = useState('')
  const [apiBaseUrl, setApiBaseUrl] = useState(settings.apiBaseUrl)
  const [model, setModel] = useState(settings.model || 'deepseek-chat')
  const [selectionHotkeyEnabled, setSelectionHotkeyEnabled] = useState(settings.selectionHotkeyEnabled)
  const [selectionHotkey, setSelectionHotkey] = useState(settings.selectionHotkey)
  const [selectionAutoTranslate, setSelectionAutoTranslate] = useState(settings.selectionAutoTranslate)
  const [bubbleDurationMs, setBubbleDurationMs] = useState(settings.bubbleDurationMs)
  const [launchAtLogin, setLaunchAtLogin] = useState(settings.launchAtLogin)
  const [showKey, setShowKey] = useState(false)
  const [busyAction, setBusyAction] = useState<'test' | 'save' | null>(null)
  const [notice, setNotice] = useState<Notice>(null)
  const [dataAction, setDataAction] = useState<'export' | 'import' | null>(null)
  const [dataNotice, setDataNotice] = useState<Notice>(null)

  const input = useMemo<SettingsInput>(
    () => ({
      apiKey: apiKey || undefined,
      apiBaseUrl,
      model,
      selectionHotkeyEnabled,
      selectionHotkey,
      selectionAutoTranslate,
      bubbleDurationMs,
      launchAtLogin
    }),
    [apiKey, apiBaseUrl, model, selectionHotkeyEnabled, selectionHotkey, selectionAutoTranslate, bubbleDurationMs, launchAtLogin]
  )
  const selectedModel = deepSeekModels.find((option) => option.value === model)

  async function handleTest(): Promise<void> {
    setBusyAction('test')
    setNotice(null)
    try {
      const result = await window.piggy.testConnection(input)
      setNotice({ kind: 'success', text: result.message })
    } catch (testError) {
      setNotice({ kind: 'error', text: errorMessage(testError) })
    } finally {
      setBusyAction(null)
    }
  }

  async function handleSave(event: FormEvent): Promise<void> {
    event.preventDefault()
    setBusyAction('save')
    setNotice(null)
    try {
      const saved = await window.piggy.saveSettings(input)
      onSaved(saved)
      setApiKey('')
      setNotice({ kind: 'success', text: '设置已安全保存在这台电脑上。' })
      if (!settings.hasApiKey) onReady()
    } catch (saveError) {
      setNotice({ kind: 'error', text: errorMessage(saveError) })
    } finally {
      setBusyAction(null)
    }
  }

  async function handleData(action: 'export' | 'import'): Promise<void> {
    setDataAction(action)
    setDataNotice(null)
    try {
      const result = action === 'export'
        ? await window.piggy.exportLibrary()
        : await window.piggy.importLibrary()
      setDataNotice({ kind: 'success', text: result.message })
    } catch (error) {
      setDataNotice({ kind: 'error', text: errorMessage(error) })
    } finally {
      setDataAction(null)
    }
  }

  return (
    <section className="page settings-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">PREFERENCES</p>
          <h1>Piggy 设置</h1>
          <p>管理 DeepSeek 连接、取词快捷键和 Windows 启动行为。</p>
        </div>
      </header>

      <form className="settings-card" onSubmit={handleSave}>
        <div className="settings-section-heading">
          <strong>DeepSeek</strong>
          <span>翻译服务</span>
        </div>

        <div className="form-group">
          <label htmlFor="apiKey">API Key</label>
          <div className="secret-input">
            <input
              id="apiKey"
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={settings.hasApiKey ? '已安全保存；留空表示不修改' : 'sk-...'}
              autoComplete="off"
            />
            <button type="button" onClick={() => setShowKey((value) => !value)} aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}>
              {showKey ? '隐藏' : '显示'}
            </button>
          </div>
          <small>仅用于向 DeepSeek 发起翻译请求，不会出现在界面日志中。</small>
        </div>

        <div className="form-row">
          <div className="form-group wide">
            <label htmlFor="apiBaseUrl">API 地址</label>
            <input id="apiBaseUrl" value={apiBaseUrl} onChange={(event) => setApiBaseUrl(event.target.value)} />
          </div>
          <div className="form-group">
            <label htmlFor="model">DeepSeek 模型</label>
            <select id="model" value={model} onChange={(event) => setModel(event.target.value)}>
              {!selectedModel && model && <option value={model}>当前自定义模型（{model}）</option>}
              {deepSeekModels.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <small>{selectedModel?.description || '这是之前保存的自定义模型；可以切换到上面的官方模型。'}</small>
          </div>
        </div>

        <div className="settings-divider" />

        <div className="settings-section-heading">
          <strong>划词翻译</strong>
          <span>按 {hotkeyLabel(selectionHotkey)} 触发</span>
        </div>

        <label className="switch-row">
          <div>
            <strong>启用划词翻译</strong>
            <span>在其他软件中选中中文或英文后按快捷键，不改变原剪贴板。</span>
          </div>
          <input type="checkbox" checked={selectionHotkeyEnabled} onChange={(event) => setSelectionHotkeyEnabled(event.target.checked)} />
          <i aria-hidden="true" />
        </label>

        <label className="switch-row">
          <div>
            <strong>按快捷键后直接显示解释</strong>
            <span>开启后跳过点击小猪；关闭时仍先显示可拖动的小猪浮标。</span>
          </div>
          <input
            id="selectionAutoTranslate"
            type="checkbox"
            checked={selectionAutoTranslate}
            onChange={(event) => setSelectionAutoTranslate(event.target.checked)}
            disabled={!selectionHotkeyEnabled}
          />
          <i aria-hidden="true" />
        </label>

        <div className="duration-row">
          <div>
            <strong>取词快捷键</strong>
            <span>选择一个顺手且不容易和其他软件冲突的组合。</span>
          </div>
          <select id="selectionHotkey" value={selectionHotkey} onChange={(event) => setSelectionHotkey(event.target.value)} disabled={!selectionHotkeyEnabled}>
            {selectionHotkeyOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>

        <div className="duration-row">
          <div>
            <strong>浮标停留时间</strong>
            <span>{selectionAutoTranslate ? '直接显示解释时无需等待浮标。' : '超时后自动消失，不会自动调用 DeepSeek。'}</span>
          </div>
          <select
            value={bubbleDurationMs}
            onChange={(event) => setBubbleDurationMs(Number(event.target.value))}
            disabled={!selectionHotkeyEnabled || selectionAutoTranslate}
          >
            <option value={3000}>3 秒</option>
            <option value={6000}>6 秒</option>
            <option value={10000}>10 秒</option>
            <option value={15000}>15 秒</option>
          </select>
        </div>

        <div className="settings-divider" />

        <div className="settings-section-heading">
          <strong>Windows</strong>
          <span>启动行为</span>
        </div>

        <label className="switch-row">
          <div>
            <strong>开机自动启动 Piggy</strong>
            <span>安装版登录 Windows 后自动在后台启动，可随时从系统托盘退出。</span>
          </div>
          <input id="launchAtLogin" type="checkbox" checked={launchAtLogin} onChange={(event) => setLaunchAtLogin(event.target.checked)} />
          <i aria-hidden="true" />
        </label>

        {notice && <div className={`notice ${notice.kind}`}>{notice.text}</div>}

        <div className="form-actions">
          <button type="button" className="secondary-button" disabled={busyAction !== null} onClick={handleTest}>
            {busyAction === 'test' ? '正在测试…' : '测试连接'}
          </button>
          <div>
            {settings.hasApiKey && (
              <button type="button" className="text-button continue-button" onClick={onReady}>
                返回翻译
              </button>
            )}
            <button type="submit" className="primary-button" disabled={busyAction !== null}>
              {busyAction === 'save' ? '正在保存…' : settings.hasApiKey ? '保存设置' : '保存并开始'}
            </button>
          </div>
        </div>
      </form>

      <section className="settings-card data-card">
        <div className="settings-section-heading">
          <strong>本地数据</strong>
          <span>不包含 API Key</span>
        </div>
        <p>导出生词本、备注和最近翻译历史；导入时会与当前数据合并，不会直接覆盖已有内容。</p>
        <div className="data-actions">
          <button className="secondary-button" disabled={dataAction !== null} onClick={() => handleData('export')}>
            {dataAction === 'export' ? '正在导出…' : '导出备份'}
          </button>
          <button className="secondary-button" disabled={dataAction !== null} onClick={() => handleData('import')}>
            {dataAction === 'import' ? '正在导入…' : '导入备份'}
          </button>
        </div>
        {dataNotice && <div className={`notice ${dataNotice.kind}`}>{dataNotice.text}</div>}
      </section>

      <div className="safety-card">
        <span aria-hidden="true">安</span>
        <div>
          <strong>只处理你主动选择的内容</strong>
          <p>
            按 {hotkeyLabel(selectionHotkey)} 只读取当前选区；
            {selectionAutoTranslate ? '随后直接打开解释并发送给 DeepSeek。' : '点击浮标后，文本才会发送给 DeepSeek。'}
          </p>
        </div>
      </div>
    </section>
  )
}

export default App
