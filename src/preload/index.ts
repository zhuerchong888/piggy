import { contextBridge, ipcRenderer } from 'electron'
import type {
  BubbleContext,
  BubblePointer,
  LibraryEntryInput,
  PiggyApi,
  PopupContext,
  SettingsInput,
  TranslateInput
} from '../shared/contracts'

const api: PiggyApi = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (input: SettingsInput) => ipcRenderer.invoke('settings:save', input),
  testConnection: (input: SettingsInput) => ipcRenderer.invoke('settings:test', input),
  translate: (input: TranslateInput) => ipcRenderer.invoke('translate', input),
  getBubbleContext: () => ipcRenderer.invoke('bubble:get-context'),
  onBubbleContext: (listener: (context: BubbleContext) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, context: BubbleContext): void => listener(context)
    ipcRenderer.on('bubble:context', handler)
    return () => ipcRenderer.removeListener('bubble:context', handler)
  },
  activateBubble: () => ipcRenderer.send('bubble:activate'),
  showBubbleMenu: () => ipcRenderer.send('bubble:context-menu'),
  startBubbleDrag: (pointer: BubblePointer) => ipcRenderer.send('bubble:drag-start', pointer),
  moveBubble: (pointer: BubblePointer) => ipcRenderer.send('bubble:drag-move', pointer),
  endBubbleDrag: () => ipcRenderer.send('bubble:drag-end'),
  getPopupContext: () => ipcRenderer.invoke('popup:get-context'),
  onPopupContext: (listener: (context: PopupContext) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, context: PopupContext): void => listener(context)
    ipcRenderer.on('popup:context', handler)
    return () => ipcRenderer.removeListener('popup:context', handler)
  },
  closePopup: () => ipcRenderer.send('popup:close'),
  openMainWindow: () => ipcRenderer.send('main:open'),
  copyText: (text: string) => ipcRenderer.invoke('clipboard:write', text),
  getLibrary: () => ipcRenderer.invoke('library:get'),
  addFavorite: (input: LibraryEntryInput) => ipcRenderer.invoke('library:favorite-add', input),
  removeFavorite: (id: string) => ipcRenderer.invoke('library:favorite-remove', id),
  updateFavoriteNote: (id: string, note: string) => ipcRenderer.invoke('library:favorite-note', id, note),
  updateFavoriteTags: (id: string, tags: string[]) => ipcRenderer.invoke('library:favorite-tags', id, tags),
  removeHistory: (id: string) => ipcRenderer.invoke('library:history-remove', id),
  clearHistory: () => ipcRenderer.invoke('library:history-clear'),
  exportLibrary: () => ipcRenderer.invoke('library:export'),
  importLibrary: () => ipcRenderer.invoke('library:import')
}

contextBridge.exposeInMainWorld('piggy', api)
