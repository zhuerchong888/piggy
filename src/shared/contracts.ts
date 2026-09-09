export const selectionHotkeyOptions = [
  { value: 'CommandOrControl+1', label: 'Ctrl+1' },
  { value: 'CommandOrControl+Alt+T', label: 'Ctrl+Alt+T（推荐）' },
  { value: 'CommandOrControl+Alt+G', label: 'Ctrl+Alt+G' },
  { value: 'Alt+Shift+T', label: 'Alt+Shift+T' },
  { value: 'F9', label: 'F9' }
] as const

export interface PublicSettings {
  apiBaseUrl: string
  model: string
  hasApiKey: boolean
  selectionHotkeyEnabled: boolean
  selectionHotkey: string
  selectionAutoTranslate: boolean
  bubbleDurationMs: number
  launchAtLogin: boolean
}

export interface SettingsInput {
  apiKey?: string
  apiBaseUrl: string
  model: string
  selectionHotkeyEnabled: boolean
  selectionHotkey: string
  selectionAutoTranslate: boolean
  bubbleDurationMs: number
  launchAtLogin: boolean
}

export interface TranslateInput {
  text: string
  sourceContext?: string
}

export interface TranslateResult {
  translation: string
  model: string
  wordDetails?: WordDetails
}

export interface WordDetails {
  phonetic: string
  partOfSpeech: string
  meanings: string[]
  example: string
  exampleTranslation: string
}

export interface OperationResult {
  ok: true
  message: string
}

export interface PopupContext {
  text: string
  sourceContext?: string
  requestId: number
}

export type BubblePhase = 'idle' | 'reading' | 'ready' | 'error'

export interface BubbleContext {
  phase: BubblePhase
  message: string
}

export interface BubblePointer {
  screenX: number
  screenY: number
}

export interface LibraryEntry {
  id: string
  source: string
  translation: string
  model: string
  createdAt: string
  note?: string
  sourceContext?: string
  tags?: string[]
  wordDetails?: WordDetails
}

export interface LibraryEntryInput {
  source: string
  translation: string
  model: string
  sourceContext?: string
  tags?: string[]
  wordDetails?: WordDetails
}

export interface LibrarySnapshot {
  favorites: LibraryEntry[]
  history: LibraryEntry[]
}

export interface PiggyApi {
  getSettings: () => Promise<PublicSettings>
  saveSettings: (input: SettingsInput) => Promise<PublicSettings>
  testConnection: (input: SettingsInput) => Promise<OperationResult>
  translate: (input: TranslateInput) => Promise<TranslateResult>
  getBubbleContext: () => Promise<BubbleContext>
  onBubbleContext: (listener: (context: BubbleContext) => void) => () => void
  activateBubble: () => void
  showBubbleMenu: () => void
  startBubbleDrag: (pointer: BubblePointer) => void
  moveBubble: (pointer: BubblePointer) => void
  endBubbleDrag: () => void
  getPopupContext: () => Promise<PopupContext>
  onPopupContext: (listener: (context: PopupContext) => void) => () => void
  closePopup: () => void
  openMainWindow: () => void
  copyText: (text: string) => Promise<void>
  getLibrary: () => Promise<LibrarySnapshot>
  addFavorite: (input: LibraryEntryInput) => Promise<LibrarySnapshot>
  removeFavorite: (id: string) => Promise<LibrarySnapshot>
  updateFavoriteNote: (id: string, note: string) => Promise<LibrarySnapshot>
  updateFavoriteTags: (id: string, tags: string[]) => Promise<LibrarySnapshot>
  removeHistory: (id: string) => Promise<LibrarySnapshot>
  clearHistory: () => Promise<LibrarySnapshot>
  exportLibrary: () => Promise<OperationResult>
  importLibrary: () => Promise<OperationResult>
}
