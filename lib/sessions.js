/**
 * Session-log surgery for the portable-workspace Host half.
 *
 * The JSONL session backend stamps every session's `cwd` into the first line of
 * the log and also derives the log's directory from that same `cwd`
 * (`<root>/<projectKey(cwd)>/<session id>/session.v<format>.jsonl.zstd`). A
 * workspace that moves to another drive therefore carries logs whose header
 * still names the old absolute path, and the backend refuses such a log as
 * corrupt because the directory no longer matches the header.
 *
 * This module reads the first Zstandard frame (exactly one header line by
 * contract), rewrites `cwd`, recompresses that frame with a checksum — the
 * backend validates frame checksums — and relocates the session directory so
 * the pair agrees again. Later frames are copied byte for byte.
 *
 * No DSH package is imported: the container format is small and documented
 * here, which keeps the bundle dependency-free.
 *
 * @module dsh-portable-workspace/lib/sessions
 */

import { constants } from 'node:zlib'
import { promises as fsp, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

import { copyTree, ensureDir, isDirectory, listDir, readJson, removeTree } from './fsx.js'

/** Zstandard frame magic, little endian (`0xFD2FB528`). */
const ZSTD_MAGIC = 0xfd2fb528
/** One checksummed frame per durable batch, matching the backend. */
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

/** Escape one path segment the way the JSONL backend does (`~XXXX`). */
export function encodeSegment(raw) {
  const text = String(raw ?? '')
  if (text === '') throw new Error('cannot encode an empty path segment')
  if (text === '.') return '~002E'
  if (text === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * Human-navigable directory key for a session's `cwd`.
 *
 * Separators (`/`, `\`, `:`) collapse into a single dash and everything outside
 * `[A-Za-z0-9._-]` is escaped; the result is wrapped in double dashes and
 * bounded to the 251 characters the backend uses.
 */
export function projectKey(cwd) {
  const text = String(cwd ?? '')
  if (text === '') throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  const trimmed = readable.replace(/^-+/, '') || 'root'
  return `--${trimmed.slice(0, 251)}--`
}

/** Directory the backend uses for one session's artifacts. */
export function sessionDirOf(root, cwd, id) {
  return join(root, projectKey(cwd), encodeSegment(id))
}

/** Regex-escape a literal string so it can be embedded in `new RegExp`. */
function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Path prefix pairs to re-point when a log moves to another folder or drive.
 *
 * Absolute paths appear inside a log in three spellings: forward slashes (tool
 * arguments), doubled backslashes (JSON string values) and single backslashes.
 * `rebaseText` expands every pair into all three and keeps the spelling it
 * finds, so a rewrite never produces a half-escaped path.
 */
function rebaseRulesBetween(fromPath, toPath) {
  const rules = []
  const push = (from, to) => {
    if (typeof from !== 'string' || typeof to !== 'string') return
    const a = from.replace(/[\\/]+$/, '')
    const b = to.replace(/[\\/]+$/, '')
    if (a === '' || b === '' || a.toLowerCase() === b.toLowerCase()) return
    rules.push({ from: a, to: b })
  }
  const projectDirOf = (path) => {
    if (typeof path !== 'string' || path === '') return undefined
    const text = path.replace(/\\/g, '/')
    const suffix = '/deepseek-harness/default-workspace'
    if (!text.toLowerCase().endsWith(suffix)) return undefined
    return text.slice(0, text.length - suffix.length)
  }
  push(fromPath, toPath)
  push(projectDirOf(fromPath), projectDirOf(toPath))
  return rules
}

/** Per-volume upload cache that holds the files a session references. */
function attachmentDirOf(container) {
  const home = container?.paths?.homeDir ?? container?.homeDir
  return typeof home === 'string' && home !== '' ? join(home, 'attachments') : undefined
}

/** Tool scratch directories that are never worth carrying to another drive. */
function isTransientProjectPath(relative) {
  return String(relative ?? '').split('/')[0] === '.tmp'
}

/** Rewrite every known spelling of every rule; returns the number replaced. */
function rebaseText(text, rules) {
  if (typeof text !== 'string' || text === '' || rules.length === 0) return { text, replacements: 0 }
  let out = text
  let replacements = 0
  for (const rule of rules) {
    const spellings = [
      [rule.from.replace(/\\/g, '/'), rule.to.replace(/\\/g, '/')],
      [rule.from.replace(/\\/g, '\\\\'), rule.to.replace(/\\/g, '\\\\')],
      [rule.from.replace(/\//g, '\\'), rule.to.replace(/\//g, '\\')],
    ]
    const seen = new Set()
    for (const [from, to] of spellings) {
      if (from === '' || seen.has(from)) continue
      seen.add(from)
      const pattern = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(from)}(?![A-Za-z0-9_.-])`, 'gi')
      out = out.replace(pattern, () => { replacements += 1; return to })
    }
  }
  return { text: out, replacements }
}

/**
 * Rebuild a multi-frame log with a fresh header and rebased payload frames.
 *
 * Frames that hold no matching path are copied byte for byte (no needless
 * recompression); a trailing torn frame is preserved as-is.
 */
function rebuildLogBytes(bytes, header, destCwd, rules) {
  const { frames, tornStart } = scanZstdFrames(bytes)
  if (frames[0] === undefined) return undefined
  const parts = []
  let replacements = 0
  for (let index = 0; index < frames.length; index += 1) {
    const slice = bytes.subarray(frames[index].start, frames[index].end)
    if (index === 0) {
      const next = { ...header, cwd: destCwd }
      const rebased = rebaseText(`${JSON.stringify(next)}\n`, rules)
      replacements += rebased.replacements
      parts.push(zstdCompressSync(Buffer.from(rebased.text, 'utf8'), CHECKSUM_OPTIONS))
      continue
    }
    let text
    try {
      text = zstdDecompressSync(slice).toString('utf8')
    } catch {
      // An unreadable payload is copied verbatim: a stale path beats a lost log.
      parts.push(slice)
      continue
    }
    const rebased = rebaseText(text, rules)
    if (rebased.replacements === 0) {
      parts.push(slice)
      continue
    }
    replacements += rebased.replacements
    parts.push(zstdCompressSync(Buffer.from(rebased.text, 'utf8'), CHECKSUM_OPTIONS))
  }
  if (tornStart !== undefined) parts.push(bytes.subarray(tornStart))
  return { buffer: Buffer.concat(parts), replacements }
}

/**
 * Split a concatenated-frame container into complete frames.
 *
 * Mirrors the backend scanner closely enough to know where a frame ends: the
 * descriptor byte carries the content-size/dictionary/checksum flags, then
 * block headers repeat as 3 bytes of size/type/`last` flag each.
 *
 * @returns `{ frames: [{start, end}], tornStart?: number }`.
 */
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`corrupt session log: reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/** Read the header line of one session log (first frame only). */
export async function readSessionHeader(file) {
  const bytes = await fsp.readFile(file)
  const { frames } = scanZstdFrames(bytes)
  const first = frames[0]
  if (first === undefined) return undefined
  let plaintext
  try {
    plaintext = zstdDecompressSync(bytes.subarray(first.start, first.end))
  } catch {
    return undefined
  }
  const line = plaintext.toString('utf8')
  if (!line.endsWith('\n')) return undefined
  try {
    return JSON.parse(line.slice(0, -1))
  } catch {
    return undefined
  }
}

/**
 * Rewrite one session log so its header names `cwd`, then relocate the session
 * directory to the location that `cwd` implies.
 *
 * @returns the new log path, or `undefined` when nothing had to move.
 */
/**
 * Re-point the absolute paths *inside* one existing log, without moving it.
 *
 * Migrations run by builds before 0.1.7 copied the log with a corrected header
 * but left the old drive letter scattered through the body; this repairs such a
 * log in place. It is also the tool behind the "already migrated" fixup.
 *
 * @returns the number of path occurrences rewritten (0 when nothing matched).
 */
export async function rebaseSessionLog(file, fromCwd, toCwd, extraRules = []) {
  if (typeof fromCwd !== 'string' || typeof toCwd !== 'string') return 0
  if (fromCwd.toLowerCase() === toCwd.toLowerCase() && extraRules.length === 0) return 0
  const header = await readSessionHeader(file)
  if (header === undefined) return 0
  const bytes = await fsp.readFile(file)
  const rules = [...rebaseRulesBetween(fromCwd, toCwd), ...extraRules]
  const rebuilt = rebuildLogBytes(bytes, header, header.cwd ?? toCwd, rules)
  if (rebuilt === undefined || rebuilt.replacements === 0) return 0
  await fsp.writeFile(file, rebuilt.buffer)
  return rebuilt.replacements
}

export async function rewriteSessionCwd(file, cwd, root) {
  const header = await readSessionHeader(file)
  if (header === undefined || header.cwd === cwd) return undefined
  const oldDir = join(file, '..')
  const bytes = await fsp.readFile(file)
  // A drive change also invalidates every absolute path in the body, so heal
  // the whole log, not just its header.
  const rules = rebaseRulesBetween(header.cwd, cwd)
  const rebuilt = rebuildLogBytes(bytes, header, cwd, rules)
  if (rebuilt === undefined) return undefined
  const targetDir = sessionDirOf(root, cwd, header.id)
  if (targetDir === oldDir) {
    await fsp.writeFile(file, rebuilt.buffer)
    return file
  }
  await ensureDir(targetDir)
  const target = join(targetDir, basename(file))
  await fsp.writeFile(target, rebuilt.buffer)
  // Remove only this session's own folder; its siblings belong to other ids.
  await removeTree(oldDir).catch(() => undefined)
  return target
}

/**
 * Re-point every session log under `paths.sessionsDir` at `target`.
 *
 * A portable workspace keeps one working directory, so a log that names
 * anything else is stale: a previous drive letter, the older
 * `<workspace>/deepseek-harness` location, or the local Documents folder a
 * pre-fix build recorded.
 *
 * @returns `{ rewritten, target }`.
 */
export async function healSessionCwds(paths, target = join(paths.projectDir, 'deepseek-harness', 'default-workspace')) {
  const root = paths.sessionsDir
  if (!(await isDirectory(root))) return { rewritten: 0, target }
  let rewritten = 0
  for (const project of await listDir(root)) {
    if (!project.isDirectory) continue
    if (project.name === projectKey(target)) continue
    for (const session of await listDir(project.path)) {
      if (!session.isDirectory) continue
      const logs = (await listDir(session.path)).filter((entry) => !entry.isDirectory && entry.name.startsWith('session.'))
      for (const log of logs) {
        const moved = await rewriteSessionCwd(log.path, target, root).catch(() => undefined)
        if (moved !== undefined) rewritten += 1
      }
    }
    // The project folder is either empty (fully migrated) or holds logs we
    // deliberately left alone; remove it only when it is empty.
    const left = await fsp.readdir(project.path).catch(() => ['?'])
    if (left.length === 0) await removeTree(project.path).catch(() => undefined)
  }
  return { rewritten, target }
}

/** Count session logs stored under the workspace, without reading any of them. */
export function countSessionLogs(sessionsDir) {
  let total = 0
  for (const project of safeReaddir(sessionsDir)) {
    if (!project.isDirectory) continue
    for (const session of safeReaddir(project.path)) {
      if (!session.isDirectory) continue
      for (const file of safeReaddir(session.path)) {
        if (!file.isDirectory && file.name.startsWith('session.')) total += 1
      }
    }
  }
  return total
}

function safeReaddir(path) {
  try {
    return readdirSync(path, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      path: join(path, entry.name),
      isDirectory: entry.isDirectory(),
    }))
  } catch {
    return []
  }
}

/* -------------------------------------------------------------------------- */
/* Session migration / projcache healing (0.1.3)                              */
/* -------------------------------------------------------------------------- */

function firstLine(text) {
  const line = String(text).split('\n').map((s) => s.trim()).find((s) => s !== '') ?? ''
  return line.replace(/^#{1,6}\s+/, '').slice(0, 120)
}

/** Read a `session/title` frame from a compressed log, if present. */
async function titleFromLog(file) {
  if (typeof file !== 'string' || file === '') return ''
  let bytes
  try { bytes = await fsp.readFile(file) } catch { return '' }
  const { frames } = scanZstdFrames(bytes)
  for (const frame of frames.slice(0, 24)) {
    let plaintext
    try { plaintext = zstdDecompressSync(bytes.subarray(frame.start, frame.end)).toString('utf8') } catch { continue }
    for (const line of plaintext.split('\n')) {
      if (line === '') continue
      let record
      try { record = JSON.parse(line) } catch { continue }
      if (record?.type === 'session/title' && typeof record.data?.title === 'string') {
        const title = firstLine(record.data.title)
        if (title !== '') return title
      }
    }
  }
  return ''
}

/**
 * Human title of one session, read from the projcache when available.
 *
 * `rows.title.val` is the sidebar title the user actually sees, so it wins.
 * Older / empty sessions fall back to the first user message, then to the
 * first turn prompt, then to a `session/title` log frame, then to '' (the
 * client shows a placeholder + short id in that case).
 */
export async function sessionTitleOf(storagesDir, id, logFile) {
  if (typeof storagesDir === 'string' && storagesDir !== '') {
    const dir = join(storagesDir, 'session_projcache', 'sessions')
    const candidates = [id]
    if (id.startsWith('session-')) candidates.push(id.slice('session-'.length))
    else candidates.push(`session-${id}`)
    for (const name of candidates) {
      const raw = await readJson(join(dir, `${name}.json`)).catch(() => undefined)
      if (raw == null || typeof raw !== 'object') continue
      const rows = raw?.record?.rows
      if (rows == null || typeof rows !== 'object') continue
      const title = rows.title?.val
      if (typeof title === 'string' && title.trim() !== '') return firstLine(title)
      const first = rows.titleInput?.val?.first?.text
      if (typeof first === 'string' && first.trim() !== '') return firstLine(first)
      const prompt = rows.turnOutline?.val?.turns?.[0]?.prompt
      if (typeof prompt === 'string' && prompt.trim() !== '') return firstLine(prompt)
    }
  }
  return await titleFromLog(logFile).catch(() => '')
}

/**
 * List the sessions stored under one container's session root.
 * Returns one entry per session log, keyed by the header id (newest first).
 * With `storagesDir`, `title` is the human session topic instead of the id.
 */
export async function listSessions(sessionsDir, storagesDir = '') {
  const out = []
  if (!(await isDirectory(sessionsDir))) return out
  for (const project of await listDir(sessionsDir)) {
    if (!project.isDirectory) continue
    for (const session of await listDir(project.path)) {
      if (!session.isDirectory) continue
      const logs = (await listDir(session.path)).filter((e) => !e.isDirectory && e.name.startsWith('session.'))
      for (const log of logs) {
        const header = await readSessionHeader(log.path).catch(() => undefined)
        if (header === undefined) continue
        const sid = String(header.id ?? session.name)
        out.push({
          id: sid,
          cwd: String(header.cwd ?? ''),
          createdAt: typeof header.createdAt === 'number' ? header.createdAt : 0,
          title: await sessionTitleOf(storagesDir, sid, log.path).catch(() => ''),
          file: log.path,
          dir: session.path,
        })
      }
    }
  }
  const seen = new Set()
  return out
    .filter((s) => { if (seen.has(s.id)) return false; seen.add(s.id); return true })
    .sort((a, b) => b.createdAt - a.createdAt)
}

/** Re-point `record.identity.cwd` in every projcache file to `target`. */
export async function healProjcacheCwds(storagesDir, target) {
  const dir = join(storagesDir, 'session_projcache', 'sessions')
  if (!(await isDirectory(dir))) return 0
  let healed = 0
  for (const entry of await listDir(dir)) {
    if (entry.isDirectory || !entry.name.endsWith('.json')) continue
    let raw
    try { raw = JSON.parse(await fsp.readFile(entry.path, 'utf8')) } catch { continue }
    const ident = raw?.record?.identity
    if (ident === undefined || ident === null || typeof ident !== 'object') continue
    if (ident.cwd === target) continue
    ident.cwd = target
    await fsp.writeFile(entry.path, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
    healed += 1
  }
  return healed
}

/** Copy one session log to a destination root, re-pointing its header cwd. */
async function copySessionLog(srcFile, destSessionsDir, destCwd, rules = []) {
  const header = await readSessionHeader(srcFile)
  if (header === undefined) return undefined
  const bytes = await fsp.readFile(srcFile)
  const rebuilt = rebuildLogBytes(bytes, header, destCwd, rules)
  if (rebuilt === undefined) return undefined
  const targetDir = sessionDirOf(destSessionsDir, destCwd, String(header.id))
  await ensureDir(targetDir)
  const target = join(targetDir, basename(srcFile))
  await fsp.writeFile(target, rebuilt.buffer)
  return { path: target, replacements: rebuilt.replacements }
}

/** Add/remove session ids in a workspace registry; `add` picks the record matching cwd. */
async function adjustRegistry(storagesDir, ids, mode, cwd) {
  const file = join(storagesDir, 'workspace.json')
  let raw
  try { raw = JSON.parse(await fsp.readFile(file, 'utf8')) } catch { return 0 }
  const table = raw?.tables?.workspaces
  if (table === undefined || table === null || typeof table !== 'object') return 0
  const keys = Object.keys(table)
  if (keys.length === 0) return 0
  let targetKey
  if (mode === 'add') {
    targetKey = keys.find((k) => table[k]?.path === cwd)
    if (targetKey === undefined) {
      const preferred = raw?.global?.defaultWorkspaceId
      targetKey = (typeof preferred === 'string' && table[preferred] !== undefined) ? preferred : keys[0]
    }
  }
  let touched = 0
  for (const key of (mode === 'add' ? [targetKey] : keys)) {
    const rec = table[key]
    if (rec === null || typeof rec !== 'object') continue
    const set = new Set(Array.isArray(rec.sessionIds) ? rec.sessionIds : [])
    let changed = false
    for (const id of ids) {
      if (mode === 'add') { if (!set.has(id)) { set.add(id); changed = true } }
      else if (set.delete(id)) changed = true
    }
    if (changed) { rec.sessionIds = [...set]; rec.updatedAt = new Date().toISOString(); touched += 1 }
  }
  if (mode === 'remove' && raw.global && typeof raw.global === 'object') {
    for (const gk of ['archivedSessionIds', 'pinnedSessionIds']) {
      if (Array.isArray(raw.global[gk])) raw.global[gk] = raw.global[gk].filter((id) => !ids.includes(id))
    }
  }
  await fsp.writeFile(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
  return touched
}

/**
 * Transfer selected sessions between two containers ({sessionsDir, storagesDir,
 * projectDir?, cwd}). Copies session logs (re-pointed at target cwd), projcache
 * entries and registry sessionIds. When both sides expose a projectDir the whole
 * project tree (source files + deliverables) is copied too.
 */
export async function transferSessions(source, target, sessionIds, options = {}) {
  const wanted = new Set(sessionIds.map((x) => String(x)))
  const all = await listSessions(source.sessionsDir)
  const chosen = all.filter((s) => wanted.has(s.id))
  const rules = rebaseRulesBetween(source.cwd, target.cwd)
  const sourceAttachments = attachmentDirOf(source)
  const targetAttachments = attachmentDirOf(target)
  const sameAttachments = sourceAttachments !== undefined && targetAttachments !== undefined
    && sourceAttachments.toLowerCase() === targetAttachments.toLowerCase()
  if (sourceAttachments !== undefined && targetAttachments !== undefined && !sameAttachments) {
    rules.push(...rebaseRulesBetween(sourceAttachments, targetAttachments))
  }
  let moved = 0
  let rebased = 0
  for (const s of chosen) {
    const placed = await copySessionLog(s.file, target.sessionsDir, target.cwd, rules).catch(() => undefined)
    if (placed === undefined) continue
    rebased += placed.replacements
    const srcCache = join(source.storagesDir, 'session_projcache', 'sessions', `${s.id}.json`)
    const dstCacheDir = join(target.storagesDir, 'session_projcache', 'sessions')
    try {
      const txt = await fsp.readFile(srcCache, 'utf8')
      const obj = JSON.parse(txt)
      if (obj?.record?.identity && typeof obj.record.identity === 'object') obj.record.identity.cwd = target.cwd
      await ensureDir(dstCacheDir)
      await fsp.writeFile(join(dstCacheDir, `${s.id}.json`), `${JSON.stringify(obj, null, 2)}\n`, 'utf8')
    } catch { /* projcache is a cache; a missing entry is harmless */ }
    if (options.move === true) {
      await removeTree(s.dir).catch(() => undefined)
      await fsp.rm(srcCache, { force: true }).catch(() => undefined)
    }
    moved += 1
  }
  const ids = chosen.map((s) => s.id)
  await adjustRegistry(target.storagesDir, ids, 'add', target.cwd).catch(() => 0)
  if (options.move === true) await adjustRegistry(source.storagesDir, ids, 'remove', source.cwd).catch(() => 0)
  let projectFiles = 0
  if (options.copyProjects === true && source.projectDir && target.projectDir) {
    // `.tmp` holds tool scratch caches (pip/uv downloads); carrying it would
    // double the migration size for nothing.
    const copied = await copyTree(source.projectDir, target.projectDir, { skip: isTransientProjectPath })
      .catch(() => ({ files: 0 }))
    projectFiles = copied.files
  }
  let attachmentFiles = 0
  if (options.copyProjects === true && sourceAttachments !== undefined && targetAttachments !== undefined && !sameAttachments) {
    const copied = await copyTree(sourceAttachments, targetAttachments).catch(() => ({ files: 0 }))
    attachmentFiles = copied.files
  }
  return { moved, ids, projectFiles, attachmentFiles, rebased }
}
