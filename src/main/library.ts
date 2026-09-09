import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { LibraryEntry, LibraryEntryInput, LibrarySnapshot, WordDetails } from '../shared/contracts'

interface StoredLibrary extends LibrarySnapshot {
  version: 2
}

const emptyLibrary = (): StoredLibrary => ({ version: 2, favorites: [], history: [] })
let mutationQueue: Promise<void> = Promise.resolve()

function libraryPath(): string {
  return join(app.getPath('userData'), 'library.json')
}

function cleanText(value: unknown, maximum: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : ''
}

function cleanTags(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const unique = new Map<string, string>()
  for (const rawTag of value) {
    const tag = cleanText(rawTag, 20).replace(/^#+/, '').trim()
    const key = tag.toLocaleLowerCase()
    if (tag && !unique.has(key)) unique.set(key, tag)
    if (unique.size >= 8) break
  }
  return Array.from(unique.values())
}

function cleanWordDetails(value: unknown): WordDetails | undefined {
  if (!value || typeof value !== 'object') return undefined
  const details = value as Partial<WordDetails>
  const meanings = Array.isArray(details.meanings)
    ? details.meanings.map((meaning) => cleanText(meaning, 200)).filter(Boolean).slice(0, 5)
    : []
  const cleaned = {
    phonetic: cleanText(details.phonetic, 100),
    partOfSpeech: cleanText(details.partOfSpeech, 100),
    meanings,
    example: cleanText(details.example, 500),
    exampleTranslation: cleanText(details.exampleTranslation, 500)
  }
  return Object.values(cleaned).some((value) => Array.isArray(value) ? value.length : value) ? cleaned : undefined
}

function cleanEntry(value: unknown): LibraryEntry | null {
  if (!value || typeof value !== 'object') return null
  const entry = value as Partial<LibraryEntry>
  const source = cleanText(entry.source, 3000)
  const translation = cleanText(entry.translation, 10_000)
  if (!source || !translation) return null

  return {
    id: cleanText(entry.id, 100) || randomUUID(),
    source,
    translation,
    model: cleanText(entry.model, 200) || '未知模型',
    createdAt: Number.isNaN(Date.parse(entry.createdAt || '')) ? new Date().toISOString() : entry.createdAt!,
    note: cleanText(entry.note, 500) || undefined,
    sourceContext: cleanText(entry.sourceContext, 1200) || undefined,
    tags: cleanTags(entry.tags),
    wordDetails: cleanWordDetails(entry.wordDetails)
  }
}

function cleanEntries(value: unknown, maximum: number): LibraryEntry[] {
  if (!Array.isArray(value)) return []
  return value.map(cleanEntry).filter((entry): entry is LibraryEntry => Boolean(entry)).slice(0, maximum)
}

async function readLibraryFile(): Promise<StoredLibrary> {
  try {
    const raw = await readFile(libraryPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<StoredLibrary>
    return {
      version: 2,
      favorites: cleanEntries(parsed.favorites, 5000),
      history: cleanEntries(parsed.history, 100)
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || error instanceof SyntaxError) return emptyLibrary()
    throw error
  }
}

async function writeLibraryFile(library: StoredLibrary): Promise<void> {
  const target = libraryPath()
  const temporary = `${target}.tmp`
  await mkdir(dirname(target), { recursive: true })
  await writeFile(temporary, JSON.stringify(library, null, 2), 'utf8')
  await rename(temporary, target)
}

function snapshot(library: StoredLibrary): LibrarySnapshot {
  return {
    favorites: library.favorites.map((entry) => ({ ...entry, tags: cleanTags(entry.tags), wordDetails: cleanWordDetails(entry.wordDetails) })),
    history: library.history.map((entry) => ({ ...entry, tags: cleanTags(entry.tags), wordDetails: cleanWordDetails(entry.wordDetails) }))
  }
}

function sourceKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

function cleanInput(input: LibraryEntryInput): Omit<LibraryEntry, 'id' | 'createdAt'> {
  const source = cleanText(input?.source, 3000)
  const translation = cleanText(input?.translation, 10_000)
  const model = cleanText(input?.model, 200) || '未知模型'
  const sourceContext = cleanText(input?.sourceContext, 1200) || undefined
  const tags = cleanTags(input?.tags)
  const wordDetails = cleanWordDetails(input?.wordDetails)
  if (!source || !translation) throw new Error('收藏内容不完整。')
  return { source, translation, model, sourceContext, tags, wordDetails }
}

async function mutateLibrary(change: (library: StoredLibrary) => void): Promise<LibrarySnapshot> {
  let result: LibrarySnapshot | null = null
  const operation = mutationQueue.then(async () => {
    const library = await readLibraryFile()
    change(library)
    await writeLibraryFile(library)
    result = snapshot(library)
  })
  mutationQueue = operation.then(
    () => undefined,
    () => undefined
  )
  await operation
  return result!
}

export async function getLibrary(): Promise<LibrarySnapshot> {
  await mutationQueue
  return snapshot(await readLibraryFile())
}

export async function recordHistory(input: LibraryEntryInput): Promise<void> {
  const entry = cleanInput(input)
  await mutateLibrary((library) => {
    const key = sourceKey(entry.source)
    library.history = [
      { id: randomUUID(), ...entry, createdAt: new Date().toISOString() },
      ...library.history.filter((item) => sourceKey(item.source) !== key)
    ].slice(0, 100)
  })
}

export function addFavorite(input: LibraryEntryInput): Promise<LibrarySnapshot> {
  const entry = cleanInput(input)
  return mutateLibrary((library) => {
    const key = sourceKey(entry.source)
    const existing = library.favorites.find((item) => sourceKey(item.source) === key)
    library.favorites = [
      {
        id: existing?.id || randomUUID(),
        ...entry,
        createdAt: existing?.createdAt || new Date().toISOString(),
        note: existing?.note,
        sourceContext: entry.sourceContext || existing?.sourceContext,
        tags: cleanTags([...(existing?.tags || []), ...(entry.tags || [])])
      },
      ...library.favorites.filter((item) => sourceKey(item.source) !== key)
    ]
  })
}

export function updateFavoriteNote(id: string, note: string): Promise<LibrarySnapshot> {
  const cleanNote = cleanText(note, 500)
  return mutateLibrary((library) => {
    const entry = library.favorites.find((item) => item.id === id)
    if (!entry) throw new Error('没有找到这条生词。')
    entry.note = cleanNote || undefined
  })
}

export function updateFavoriteTags(id: string, tags: string[]): Promise<LibrarySnapshot> {
  const cleanedTags = cleanTags(tags)
  return mutateLibrary((library) => {
    const entry = library.favorites.find((item) => item.id === id)
    if (!entry) throw new Error('没有找到这条生词。')
    entry.tags = cleanedTags
  })
}

export function removeFavorite(id: string): Promise<LibrarySnapshot> {
  return mutateLibrary((library) => {
    library.favorites = library.favorites.filter((entry) => entry.id !== id)
  })
}

export function removeHistory(id: string): Promise<LibrarySnapshot> {
  return mutateLibrary((library) => {
    library.history = library.history.filter((entry) => entry.id !== id)
  })
}

export function clearHistory(): Promise<LibrarySnapshot> {
  return mutateLibrary((library) => {
    library.history = []
  })
}

function entryTime(entry: LibraryEntry): number {
  const value = Date.parse(entry.createdAt)
  return Number.isNaN(value) ? 0 : value
}

function mergeEntries(imported: LibraryEntry[], local: LibraryEntry[], maximum: number): LibraryEntry[] {
  const merged = new Map<string, LibraryEntry>()
  const ordered = [...imported, ...local].sort((a, b) => entryTime(b) - entryTime(a))
  for (const entry of ordered) {
    const key = sourceKey(entry.source)
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, { ...entry, wordDetails: cleanWordDetails(entry.wordDetails) })
      continue
    }
    if (!existing.note && entry.note) existing.note = entry.note
    if (!existing.sourceContext && entry.sourceContext) existing.sourceContext = entry.sourceContext
    existing.tags = cleanTags([...(existing.tags || []), ...(entry.tags || [])])
    if (!existing.wordDetails && entry.wordDetails) existing.wordDetails = cleanWordDetails(entry.wordDetails)
  }
  return Array.from(merged.values()).slice(0, maximum)
}

export async function createLibraryBackup(): Promise<Record<string, unknown>> {
  const library = await getLibrary()
  return {
    format: 'piggy-library',
    version: 2,
    exportedAt: new Date().toISOString(),
    favorites: library.favorites,
    history: library.history
  }
}

export function importLibraryBackup(value: unknown): Promise<LibrarySnapshot> {
  if (!value || typeof value !== 'object') throw new Error('备份文件格式不正确。')
  const backup = value as { format?: unknown; favorites?: unknown; history?: unknown }
  if (backup.format !== 'piggy-library' || !Array.isArray(backup.favorites) || !Array.isArray(backup.history)) {
    throw new Error('这不是有效的 Piggy 备份文件。')
  }

  const favorites = cleanEntries(backup.favorites, 5000)
  const history = cleanEntries(backup.history, 100)
  return mutateLibrary((library) => {
    library.favorites = mergeEntries(favorites, library.favorites, 5000)
    library.history = mergeEntries(history, library.history, 100)
  })
}
