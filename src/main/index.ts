import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  screen,
  shell,
  Tray,
  type Rectangle
} from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { electronApp, is } from '@electron-toolkit/utils'
import { getPublicSettings, saveSettings } from './settings'
import { testDeepSeekConnection, translateWithDeepSeek } from './deepseek'
import {
  addFavorite,
  clearHistory,
  createLibraryBackup,
  getLibrary,
  importLibraryBackup,
  recordHistory,
  removeFavorite,
  removeHistory,
  updateFavoriteNote,
  updateFavoriteTags
} from './library'
import { readWindowsSelection } from './selection'
import type {
  BubbleContext,
  BubblePointer,
  LibraryEntryInput,
  PopupContext,
  PublicSettings,
  SettingsInput,
  TranslateInput,
  TranslateResult
} from '../shared/contracts'
import { selectionHotkeyOptions } from '../shared/contracts'

const isSmokeTest = process.argv.includes('--smoke-test')
const captureUi = process.argv.includes('--capture-ui')
const startHidden = process.argv.includes('--hidden')
const DEFAULT_SELECTION_HOTKEY = selectionHotkeyOptions[0].value
const BUBBLE_SIZE = 64
const POPUP_WIDTH = 480
const POPUP_HEIGHT = 560

let mainWindow: BrowserWindow | null = null
let bubbleWindow: BrowserWindow | null = null
let popupWindow: BrowserWindow | null = null
let tray: Tray | null = null
let bubbleTimer: NodeJS.Timeout | null = null
let bubbleReady = false
let popupReady = false
let popupShouldShow = false
let bubbleDragOffset: { x: number; y: number } | null = null
let pendingText = ''
let pendingSourceContext = ''
let popupRequestId = 0
let bubbleContext: BubbleContext = { phase: 'idle', message: '' }
let selectionHotkeyEnabled = true
let selectionHotkey: string = DEFAULT_SELECTION_HOTKEY
let selectionAutoTranslate = false
let registeredSelectionHotkey: string | null = null
let selectionReadInProgress = false
let bubbleDurationMs = 6000
let runtimePaused = false
let isQuitting = false

if (isSmokeTest) {
  app.disableHardwareAcceleration()
  app.setPath('userData', join(app.getPath('temp'), `piggy-smoke-${process.pid}`))
}

function loadSurface(window: BrowserWindow, surface?: 'bubble' | 'popup'): void {
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL)
    if (surface) url.searchParams.set('surface', surface)
    void window.loadURL(url.toString())
    return
  }

  const options = surface ? { query: { surface } } : undefined
  void window.loadFile(join(__dirname, '../renderer/index.html'), options)
}

function createMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow

  mainWindow = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 880,
    minHeight: 620,
    show: false,
    backgroundColor: '#f7f4f5',
    title: 'Piggy',
    icon: createTrayImage(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    if (!isSmokeTest && !startHidden) mainWindow?.show()
  })

  mainWindow.on('close', (event) => {
    if (!isQuitting && !isSmokeTest) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isSmokeTest) attachSmokeTest(mainWindow)
  loadSurface(mainWindow)
  return mainWindow
}

function attachSmokeTest(window: BrowserWindow): void {
  const smokeTimeout = setTimeout(() => {
    console.error('PIGGY_SMOKE_FAILED: renderer load timed out')
    app.exit(1)
  }, 30_000)

  window.webContents.once('did-finish-load', async () => {
    try {
      await new Promise((resolve) => setTimeout(resolve, 100))
      const mainResult = (await window.webContents.executeJavaScript(`({
        title: document.title,
        hasRoot: Boolean(document.querySelector('#root')),
        hasBridge: typeof window.piggy?.getSettings === 'function' && typeof window.piggy?.getLibrary === 'function',
        hasPiggyImage: Boolean(document.querySelector('.brand-mark img')?.complete && document.querySelector('.brand-mark img')?.naturalWidth),
        modelOptions: Array.from(document.querySelectorAll('#model option')).map((option) => option.value),
        hotkeyOptions: Array.from(document.querySelectorAll('#selectionHotkey option')).map((option) => option.value),
        hasDirectMode: Boolean(document.querySelector('#selectionAutoTranslate')),
        hasLaunchAtLogin: Boolean(document.querySelector('#launchAtLogin')),
        hasDataTools: Boolean(document.querySelector('.data-card'))
      })`)) as {
        title: string
        hasRoot: boolean
        hasBridge: boolean
        hasPiggyImage: boolean
        modelOptions: string[]
        hotkeyOptions: string[]
        hasDirectMode: boolean
        hasLaunchAtLogin: boolean
        hasDataTools: boolean
      }

      if (
        mainResult.title !== 'Piggy' ||
        !mainResult.hasRoot ||
        !mainResult.hasBridge ||
        !mainResult.hasPiggyImage ||
        !mainResult.modelOptions.includes('deepseek-chat') ||
        !mainResult.modelOptions.includes('deepseek-reasoner') ||
        mainResult.hotkeyOptions.length !== selectionHotkeyOptions.length ||
        !mainResult.hasDirectMode ||
        !mainResult.hasLaunchAtLogin ||
        !mainResult.hasDataTools
      ) {
        throw new Error(`unexpected main renderer state: ${JSON.stringify(mainResult)}`)
      }

      if (captureUi) {
        await window.webContents.executeJavaScript(`document.querySelector('.nav-list button')?.click()`)
        window.showInactive()
        await new Promise((resolve) => setTimeout(resolve, 250))
        const image = await window.capturePage()
        await writeFile(join(app.getPath('temp'), 'piggy-main-preview.png'), image.toPNG())
        window.hide()
      }

      pendingText = 'piggy'
      const bubble = createBubbleWindow()
      await waitForRendererLoad(bubble)
      const bubbleResult = (await bubble.webContents.executeJavaScript(`({
        hasButton: Boolean(document.querySelector('.bubble-button')),
        hasImage: Boolean(document.querySelector('.bubble-button img')?.complete && document.querySelector('.bubble-button img')?.naturalWidth),
        hasDragLabel: document.querySelector('.bubble-button')?.getAttribute('title')?.includes('拖动') || false
      })`)) as { hasButton: boolean; hasImage: boolean; hasDragLabel: boolean }
      if (!bubbleResult.hasButton || !bubbleResult.hasImage || !bubbleResult.hasDragLabel) {
        throw new Error(`unexpected bubble renderer state: ${JSON.stringify(bubbleResult)}`)
      }

      const dragWorkArea = screen.getPrimaryDisplay().workArea
      const dragStart = {
        x: dragWorkArea.x + Math.min(100, Math.max(0, dragWorkArea.width - BUBBLE_SIZE - 20)),
        y: dragWorkArea.y + Math.min(100, Math.max(0, dragWorkArea.height - BUBBLE_SIZE - 20))
      }
      bubble.setPosition(dragStart.x, dragStart.y, false)
      await bubble.webContents.executeJavaScript(`
        window.piggy.startBubbleDrag({ screenX: ${dragStart.x + 24}, screenY: ${dragStart.y + 24} })
        window.piggy.moveBubble({ screenX: ${dragStart.x + 34}, screenY: ${dragStart.y + 34} })
        window.piggy.endBubbleDrag()
      `)
      await new Promise((resolve) => setTimeout(resolve, 50))
      const draggedBounds = bubble.getBounds()
      const bubbleMoved = draggedBounds.x === dragStart.x + 10 && draggedBounds.y === dragStart.y + 10
      if (!bubbleMoved) throw new Error(`bubble drag did not move the window: ${JSON.stringify(draggedBounds)}`)

      const hasTrayImage = !createTrayImage().isEmpty()
      if (!hasTrayImage) throw new Error('tray image could not be created')

      const hasCtrl1Hotkey = globalShortcut.register(DEFAULT_SELECTION_HOTKEY, () => undefined)
      if (hasCtrl1Hotkey) globalShortcut.unregister(DEFAULT_SELECTION_HOTKEY)

      const popup = createPopupWindow(pendingText)
      pendingSourceContext = 'The piggy is pink.'
      await waitForRendererLoad(popup)
      await new Promise((resolve) => setTimeout(resolve, 100))
      const popupResult = (await popup.webContents.executeJavaScript(`({
        hasCard: Boolean(document.querySelector('.popup-card')),
        hasImage: Boolean(document.querySelector('.popup-pig img')?.complete && document.querySelector('.popup-pig img')?.naturalWidth),
        hasFavoriteButton: Boolean(document.querySelector('[data-testid="popup-favorite"]')),
        hasWordDetails: Boolean(document.querySelector('.word-details')),
        translation: document.querySelector('.popup-translation')?.textContent || '',
        model: document.querySelector('.model-note')?.textContent || ''
      })`)) as { hasCard: boolean; hasImage: boolean; hasFavoriteButton: boolean; hasWordDetails: boolean; translation: string; model: string }

      if (
        !popupResult.hasCard ||
        !popupResult.hasImage ||
        !popupResult.hasFavoriteButton ||
        !popupResult.hasWordDetails ||
        popupResult.translation !== '小猪' ||
        popupResult.model !== '模型：deepseek-chat'
      ) {
        throw new Error(`unexpected popup renderer state: ${JSON.stringify(popupResult)}`)
      }


      if (captureUi) {
        popup.showInactive()
        await new Promise((resolve) => setTimeout(resolve, 200))
        const image = await popup.capturePage()
        await writeFile(join(app.getPath('temp'), 'piggy-popup-preview.png'), image.toPNG())
        popup.hide()
      }

      await popup.webContents.executeJavaScript(`document.querySelector('[data-testid="popup-favorite"]')?.click()`)
      await new Promise((resolve) => setTimeout(resolve, 150))
      const favoriteButtonText = (await popup.webContents.executeJavaScript(
        `document.querySelector('[data-testid="popup-favorite"]')?.textContent || ''`
      )) as string
      if (favoriteButtonText.trim() !== '已收藏') {
        throw new Error(`popup favorite was not saved: ${favoriteButtonText}`)
      }

      const savedFavorite = (await getLibrary()).favorites[0]
      await updateFavoriteTags(savedFavorite.id, ['阅读', '测试'])

      const libraryResult = (await window.webContents.executeJavaScript(`(async () => {
        document.querySelector('[data-testid="nav-wordbook"]')?.click()
        await new Promise((resolve) => setTimeout(resolve, 150))
        const favorite = document.querySelector('.library-row > strong')?.textContent || ''
        const hasNoteEditor = Boolean(document.querySelector('.note-editor'))
        const hasTagEditor = Boolean(document.querySelector('.tag-editor'))
        const context = document.querySelector('.saved-context p')?.textContent || ''
        const tags = Array.from(document.querySelectorAll('.tag-list span')).map((item) => item.textContent || '')
        const hasSavedWordDetails = Boolean(document.querySelector('.library-card .word-details'))
        document.querySelector('[data-testid="nav-history"]')?.click()
        await new Promise((resolve) => setTimeout(resolve, 150))
        const history = document.querySelector('.library-row > strong')?.textContent || ''
        return { favorite, history, context, tags, hasNoteEditor, hasTagEditor, hasSavedWordDetails }
      })()`)) as {
        favorite: string
        history: string
        context: string
        tags: string[]
        hasNoteEditor: boolean
        hasTagEditor: boolean
        hasSavedWordDetails: boolean
      }
      if (
        libraryResult.favorite !== pendingText ||
        libraryResult.history !== pendingText ||
        libraryResult.context !== pendingSourceContext ||
        !libraryResult.tags.includes('#阅读') ||
        !libraryResult.hasNoteEditor ||
        !libraryResult.hasTagEditor ||
        !libraryResult.hasSavedWordDetails
      ) {
        throw new Error(`unexpected library state: ${JSON.stringify(libraryResult)}`)
      }

      if (captureUi) {
        await window.webContents.executeJavaScript(`document.querySelector('[data-testid="nav-wordbook"]')?.click()`)
        window.showInactive()
        await new Promise((resolve) => setTimeout(resolve, 200))
        const image = await window.capturePage()
        await writeFile(join(app.getPath('temp'), 'piggy-wordbook-preview.png'), image.toPNG())
        window.hide()
      }

      const smokeLibrary = await getLibrary()
      await updateFavoriteNote(smokeLibrary.favorites[0].id, 'Piggy 冒烟测试备注')
      const backup = await createLibraryBackup()
      const restored = await importLibraryBackup(backup)
      const backupResult = {
        format: backup.format,
        note: restored.favorites[0]?.note,
        favorites: restored.favorites.length,
        history: restored.history.length
      }
      if (backupResult.format !== 'piggy-library' || backupResult.note !== 'Piggy 冒烟测试备注') {
        throw new Error(`unexpected backup state: ${JSON.stringify(backupResult)}`)
      }

      console.log(
        `PIGGY_SMOKE_OK: ${JSON.stringify({ main: mainResult, bubble: { ...bubbleResult, moved: bubbleMoved }, popup: popupResult, library: libraryResult, backup: backupResult, trayImage: hasTrayImage, ctrl1Hotkey: hasCtrl1Hotkey })}`
      )
      clearTimeout(smokeTimeout)
      app.exit(0)
    } catch (error) {
      console.error(`PIGGY_SMOKE_FAILED: ${(error as Error).message}`)
      clearTimeout(smokeTimeout)
      app.exit(1)
    }
  })

  window.webContents.once('did-fail-load', (_event, code, description) => {
    console.error(`PIGGY_SMOKE_FAILED: ${code} ${description}`)
    clearTimeout(smokeTimeout)
    app.exit(1)
  })
}

function waitForRendererLoad(window: BrowserWindow): Promise<void> {
  return new Promise((resolve, reject) => {
    window.webContents.once('did-finish-load', () => resolve())
    window.webContents.once('did-fail-load', (_event, code, description) => {
      reject(new Error(`${code} ${description}`))
    })
  })
}

function openMainWindow(): void {
  const window = createMainWindow()
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

function createBubbleWindow(): BrowserWindow {
  if (bubbleWindow && !bubbleWindow.isDestroyed()) return bubbleWindow

  bubbleReady = false
  bubbleWindow = new BrowserWindow({
    width: BUBBLE_SIZE,
    height: BUBBLE_SIZE,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  bubbleWindow.setAlwaysOnTop(true, 'floating')
  bubbleWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false })
  bubbleWindow.webContents.once('did-finish-load', () => {
    bubbleReady = true
    publishBubbleContext()
    if (bubbleContext.phase !== 'idle' && isAssistantActive()) showBubble()
  })
  bubbleWindow.on('closed', () => {
    bubbleWindow = null
    bubbleReady = false
    bubbleDragOffset = null
  })

  loadSurface(bubbleWindow, 'bubble')
  return bubbleWindow
}

function positionNearCursor(width: number, height: number, gap = 14): Rectangle {
  const cursor = screen.getCursorScreenPoint()
  const workArea = screen.getDisplayNearestPoint(cursor).workArea
  let x = cursor.x + gap
  let y = cursor.y + gap

  if (x + width > workArea.x + workArea.width) x = cursor.x - width - gap
  if (y + height > workArea.y + workArea.height) y = cursor.y - height - gap

  return {
    x: Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - width)),
    y: Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - height)),
    width,
    height
  }
}

function showBubbleFor(text: string): void {
  pendingText = text
  setBubbleContext('ready', '点击小猪查看翻译')
  createBubbleWindow()
  if (bubbleReady) showBubble()
}

function currentPopupContext(): PopupContext {
  return { text: pendingText, sourceContext: pendingSourceContext || undefined, requestId: popupRequestId }
}

function publishBubbleContext(): void {
  if (bubbleWindow && !bubbleWindow.isDestroyed() && bubbleReady) {
    bubbleWindow.webContents.send('bubble:context', bubbleContext)
  }
}

function setBubbleContext(phase: BubbleContext['phase'], message: string): void {
  bubbleContext = { phase, message }
  publishBubbleContext()
}

function showBubble(): void {
  if (!bubbleWindow || bubbleWindow.isDestroyed() || !bubbleReady || !isAssistantActive()) return

  bubbleWindow.setBounds(positionNearCursor(BUBBLE_SIZE, BUBBLE_SIZE), false)
  bubbleWindow.showInactive()
  resetBubbleTimer()
}

function resetBubbleTimer(): void {
  if (bubbleTimer) clearTimeout(bubbleTimer)
  bubbleTimer = setTimeout(() => hideBubble(), bubbleDurationMs)
}

function stopBubbleTimer(): void {
  if (!bubbleTimer) return
  clearTimeout(bubbleTimer)
  bubbleTimer = null
}

function hideBubble(): void {
  stopBubbleTimer()
  bubbleDragOffset = null
  if (bubbleWindow && !bubbleWindow.isDestroyed()) bubbleWindow.hide()
}

function validBubblePointer(value: BubblePointer): value is BubblePointer {
  return Boolean(value && Number.isFinite(value.screenX) && Number.isFinite(value.screenY))
}

function moveBubbleToPointer(pointer: BubblePointer): void {
  if (!bubbleWindow || bubbleWindow.isDestroyed() || !bubbleDragOffset) return
  const workArea = screen.getDisplayNearestPoint({ x: pointer.screenX, y: pointer.screenY }).workArea
  const x = Math.max(
    workArea.x,
    Math.min(Math.round(pointer.screenX - bubbleDragOffset.x), workArea.x + workArea.width - BUBBLE_SIZE)
  )
  const y = Math.max(
    workArea.y,
    Math.min(Math.round(pointer.screenY - bubbleDragOffset.y), workArea.y + workArea.height - BUBBLE_SIZE)
  )
  bubbleWindow.setPosition(x, y, false)
}

function createPopupWindow(text?: string): BrowserWindow {
  if (typeof text === 'string') pendingText = text
  if (popupWindow && !popupWindow.isDestroyed()) return popupWindow

  const bounds = positionNearCursor(POPUP_WIDTH, POPUP_HEIGHT, 18)
  popupReady = false
  popupWindow = new BrowserWindow({
    ...bounds,
    minWidth: 380,
    minHeight: 420,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  popupWindow.setAlwaysOnTop(true, 'floating')
  popupWindow.webContents.once('did-finish-load', () => {
    popupReady = true
    publishPopupContext()
    if (popupShouldShow) showPopupWindow()
  })
  popupWindow.on('closed', () => {
    popupWindow = null
    popupReady = false
    popupShouldShow = false
  })

  loadSurface(popupWindow, 'popup')
  return popupWindow
}

function publishPopupContext(): void {
  if (popupWindow && !popupWindow.isDestroyed() && popupReady) {
    popupWindow.webContents.send('popup:context', currentPopupContext())
  }
}

function showPopupWindow(): void {
  if (!popupWindow || popupWindow.isDestroyed() || !popupReady || isSmokeTest) return
  popupWindow.show()
  popupWindow.focus()
}

function openPopupFor(text: string, sourceContext = ''): void {
  pendingText = text
  pendingSourceContext = sourceContext
  popupRequestId += 1
  popupShouldShow = true
  const window = createPopupWindow()
  window.setBounds(positionNearCursor(POPUP_WIDTH, POPUP_HEIGHT, 18), false)
  publishPopupContext()
  showPopupWindow()
}

function normalizeSelectionText(value: string): string {
  return value.replace(/\u0000/g, '').trim()
}

function isTranslatableText(value: string): boolean {
  if (!value || value.length > 3000) return false
  if (!/[A-Za-z\u3400-\u9fff]/.test(value)) return false
  if (/^[A-Za-z]:\\/.test(value) || /^file:\/\//i.test(value)) return false
  return true
}

function isAssistantActive(): boolean {
  return selectionHotkeyEnabled && !runtimePaused
}

function selectionHotkeyLabel(): string {
  return selectionHotkeyOptions.find((option) => option.value === selectionHotkey)?.label.replace('（推荐）', '') || selectionHotkey
}

async function handleSelectionHotkey(): Promise<void> {
  if (!isAssistantActive() || selectionReadInProgress) return

  selectionReadInProgress = true
  pendingText = ''
  pendingSourceContext = ''
  setBubbleContext('reading', '正在读取选中文字')
  createBubbleWindow()
  if (bubbleReady) showBubble()
  try {
    const selection = await readWindowsSelection()
    const selectedText = normalizeSelectionText(selection.text)
    if (selectedText.length > 3000) {
      const message = `选中的内容超过 3000 个字符，请缩小选区后再按 ${selectionHotkeyLabel()}。`
      setBubbleContext('error', '选中的内容太长')
      showSelectionNotice(message)
      resetBubbleTimer()
      return
    }
    if (!isTranslatableText(selectedText)) {
      const message = `请先选中一段中文或英文，再按 ${selectionHotkeyLabel()}。`
      setBubbleContext('error', '没有读取到文字')
      showSelectionNotice(message)
      resetBubbleTimer()
      return
    }
    pendingSourceContext = normalizeSelectionText(selection.sourceContext || '')
    if (selectionAutoTranslate) {
      pendingText = selectedText
      setBubbleContext('ready', '正在打开解释')
      hideBubble()
      openPopupFor(selectedText, pendingSourceContext)
    } else {
      showBubbleFor(selectedText)
    }
  } catch (error) {
    setBubbleContext('error', '取词失败，请重试')
    showSelectionNotice((error as Error).message)
    resetBubbleTimer()
  } finally {
    selectionReadInProgress = false
  }
}

function syncSelectionHotkey(): void {
  if (isSmokeTest) return
  if (registeredSelectionHotkey) {
    globalShortcut.unregister(registeredSelectionHotkey)
    registeredSelectionHotkey = null
  }

  if (isAssistantActive()) {
    const registered = globalShortcut.register(selectionHotkey, () => void handleSelectionHotkey())
    if (!registered) {
      showSelectionNotice(`${selectionHotkeyLabel()} 已被其他软件占用，Piggy 暂时无法启用划词快捷键。`)
    } else {
      registeredSelectionHotkey = selectionHotkey
    }
  }
}

function showSelectionNotice(message: string): void {
  if (!Notification.isSupported()) return
  new Notification({ title: 'Piggy', body: message, silent: true }).show()
}

function applyAssistantSettings(settings: PublicSettings): void {
  selectionHotkeyEnabled = settings.selectionHotkeyEnabled
  selectionHotkey = settings.selectionHotkey
  selectionAutoTranslate = settings.selectionAutoTranslate
  bubbleDurationMs = settings.bubbleDurationMs
  if (!isSmokeTest && app.isPackaged) {
    app.setLoginItemSettings({
      openAtLogin: settings.launchAtLogin,
      path: process.execPath,
      args: ['--hidden']
    })
  }
  if (!isAssistantActive()) hideBubble()
  syncSelectionHotkey()
  refreshTrayMenu()
}

function createTrayImage(): Electron.NativeImage {
  const assetPath = app.isPackaged
    ? join(process.resourcesPath, 'piggy.png')
    : join(process.cwd(), 'resources', 'piggy.png')
  return nativeImage.createFromPath(assetPath).resize({ width: 16, height: 16 })
}

function createTray(): void {
  tray = new Tray(createTrayImage())
  tray.setToolTip('Piggy · DeepSeek 划词翻译')
  tray.on('click', openMainWindow)
  refreshTrayMenu()
}

function refreshTrayMenu(): void {
  if (!tray) return
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开 Piggy', click: openMainWindow },
      {
        label: runtimePaused ? '继续划词翻译' : '暂停划词翻译',
        enabled: selectionHotkeyEnabled,
        click: () => {
          runtimePaused = !runtimePaused
          if (runtimePaused) hideBubble()
          syncSelectionHotkey()
          refreshTrayMenu()
        }
      },
      { type: 'separator' },
      {
        label: '退出 Piggy',
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
  )
}

function registerIpcHandlers(): void {
  ipcMain.handle('settings:get', () => getPublicSettings())
  ipcMain.handle('settings:save', async (_event, input: SettingsInput) => {
    const saved = await saveSettings(input)
    applyAssistantSettings(saved)
    return saved
  })
  ipcMain.handle('settings:test', async (_event, input: SettingsInput) => {
    await testDeepSeekConnection(input)
    return { ok: true as const, message: '连接成功，DeepSeek 已准备好。' }
  })
  ipcMain.handle('translate', async (_event, input: TranslateInput): Promise<TranslateResult> => {
    if (!input || typeof input.text !== 'string') throw new Error('翻译内容格式不正确。')
    const result = isSmokeTest
      ? {
          translation: '小猪',
          model: 'deepseek-chat',
          wordDetails: {
            phonetic: '/ˈpɪɡi/',
            partOfSpeech: 'n.',
            meanings: ['小猪'],
            example: 'The piggy is pink.',
            exampleTranslation: '这只小猪是粉色的。'
          }
        }
      : await translateWithDeepSeek(input.text)
    try {
      await recordHistory({
        source: input.text,
        translation: result.translation,
        model: result.model,
        sourceContext: input.sourceContext,
        wordDetails: result.wordDetails
      })
    } catch (error) {
      console.warn(`Piggy could not save translation history: ${(error as Error).message}`)
    }
    return result
  })
  ipcMain.handle('bubble:get-context', () => bubbleContext)
  ipcMain.handle('popup:get-context', () => currentPopupContext())
  ipcMain.handle('clipboard:write', (_event, text: string) => {
    if (typeof text !== 'string') throw new Error('复制内容格式不正确。')
    clipboard.writeText(text)
  })
  ipcMain.handle('library:get', () => getLibrary())
  ipcMain.handle('library:favorite-add', (_event, input: LibraryEntryInput) => addFavorite(input))
  ipcMain.handle('library:favorite-remove', (_event, id: string) => removeFavorite(id))
  ipcMain.handle('library:favorite-note', (_event, id: string, note: string) => updateFavoriteNote(id, note))
  ipcMain.handle('library:favorite-tags', (_event, id: string, tags: string[]) => updateFavoriteTags(id, tags))
  ipcMain.handle('library:history-remove', (_event, id: string) => removeHistory(id))
  ipcMain.handle('library:history-clear', () => clearHistory())
  ipcMain.handle('library:export', async () => {
    const options = {
      title: '导出 Piggy 生词数据',
      defaultPath: join(app.getPath('documents'), `Piggy-备份-${new Date().toISOString().slice(0, 10)}.piggy.json`),
      filters: [{ name: 'Piggy 备份', extensions: ['json'] }]
    }
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showSaveDialog(mainWindow, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { ok: true as const, message: '已取消导出。' }
    const backup = await createLibraryBackup()
    await writeFile(result.filePath, JSON.stringify(backup, null, 2), 'utf8')
    return { ok: true as const, message: `备份已保存到：${result.filePath}` }
  })
  ipcMain.handle('library:import', async () => {
    const options: Electron.OpenDialogOptions = {
      title: '导入 Piggy 生词数据',
      properties: ['openFile'],
      filters: [{ name: 'Piggy 备份', extensions: ['json'] }]
    }
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    const filePath = result.filePaths[0]
    if (result.canceled || !filePath) return { ok: true as const, message: '已取消导入。' }
    const raw = await readFile(filePath, 'utf8')
    if (Buffer.byteLength(raw, 'utf8') > 10 * 1024 * 1024) throw new Error('备份文件超过 10 MB，无法导入。')
    let backup: unknown
    try {
      backup = JSON.parse(raw)
    } catch {
      throw new Error('备份文件不是有效的 JSON。')
    }
    const library = await importLibraryBackup(backup)
    return {
      ok: true as const,
      message: `导入完成：生词本 ${library.favorites.length} 条，翻译历史 ${library.history.length} 条。`
    }
  })
  ipcMain.on('bubble:drag-start', (event, pointer: BubblePointer) => {
    if (event.sender !== bubbleWindow?.webContents || !validBubblePointer(pointer)) return
    const bounds = bubbleWindow.getBounds()
    bubbleDragOffset = { x: pointer.screenX - bounds.x, y: pointer.screenY - bounds.y }
    stopBubbleTimer()
  })
  ipcMain.on('bubble:drag-move', (event, pointer: BubblePointer) => {
    if (event.sender !== bubbleWindow?.webContents || !validBubblePointer(pointer)) return
    moveBubbleToPointer(pointer)
  })
  ipcMain.on('bubble:drag-end', (event) => {
    if (event.sender !== bubbleWindow?.webContents) return
    bubbleDragOffset = null
    if (bubbleWindow.isVisible()) resetBubbleTimer()
  })
  ipcMain.on('bubble:activate', (event) => {
    if (event.sender !== bubbleWindow?.webContents) return
    if (bubbleContext.phase === 'error') {
      hideBubble()
      openMainWindow()
      return
    }
    if (!pendingText || bubbleContext.phase !== 'ready') return
    hideBubble()
    openPopupFor(pendingText, pendingSourceContext)
  })
  ipcMain.on('bubble:context-menu', (event) => {
    if (event.sender !== bubbleWindow?.webContents || !bubbleWindow) return
    Menu.buildFromTemplate([
      { label: '打开 Piggy', click: openMainWindow },
      { label: '隐藏浮标', click: hideBubble },
      { type: 'separator' },
      {
        label: '暂停划词翻译',
        click: () => {
          runtimePaused = true
          hideBubble()
          syncSelectionHotkey()
          refreshTrayMenu()
        }
      },
      {
        label: '退出 Piggy',
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ]).popup({ window: bubbleWindow })
  })
  ipcMain.on('popup:close', () => {
    popupShouldShow = false
    popupWindow?.hide()
  })
  ipcMain.on('main:open', openMainWindow)
}

const hasSingleInstanceLock = isSmokeTest || app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', openMainWindow)

  app.whenReady().then(async () => {
    electronApp.setAppUserModelId('com.piggy.translator.v3')
    registerIpcHandlers()
    const settings = await getPublicSettings()
    applyAssistantSettings(settings)
    createMainWindow()

    if (!isSmokeTest) {
      createBubbleWindow()
      createPopupWindow()
      createTray()
    }

    app.on('activate', openMainWindow)
  })
}

app.on('before-quit', () => {
  isQuitting = true
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (process.platform === 'darwin' && !isQuitting) return
  if (!tray && !isSmokeTest) app.quit()
})
