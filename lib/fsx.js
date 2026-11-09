/**
 * Small filesystem helpers shared by the portable-workspace Host half.
 *
 * Everything here is synchronous or promise-based `node:fs` work with no DSH
 * service dependency, so it can run during plugin apply and inside HTTP
 * handlers without holding a context.
 *
 * @module dsh-portable-workspace/lib/fsx
 */

import { createHash, randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { dirname, join, normalize, resolve, sep } from 'node:path'

/** File name of the portable-root marker written into `<drive>:\Portable-DSH`. */
export const ROOT_MARKER = '.dsh-portable.json'
/** File name of the per-workspace manifest. */
export const WORKSPACE_MARKER = 'workspace.json'
/** Directory name the user asked for at the volume root (kept verbatim). */
export const ROOT_DIR_NAME = 'Portable-DSH'
/** Directory under the portable root that holds portable workspaces. */
export const WORKSPACES_DIR_NAME = 'Portable-Workspaces'
/**
 * Root/workspaces names written by 0.1.0 (misspelled "Protable"). Volumes that
 * were initialized by 0.1.0 still carry these names; we keep accepting them so
 * an existing portable disk never disappears after upgrading the plugin.
 */
export const LEGACY_ROOT_DIR_NAME = 'Protable-DSH'
export const LEGACY_WORKSPACES_DIR_NAME = 'Protable-Workspaces'
/** Directory under the portable root that holds shared support data. */
export const SUPPORT_DIR_NAME = 'support'
/** Directory under the portable root that holds generated deliverables. */
export const PROJECTS_DIR_NAME = 'Projects'

/** True when the error is a missing-path error rather than a real failure. */
export function isMissing(error) {
  return error != null && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

/** `stat` that returns `undefined` instead of throwing for a missing path. */
export async function statOrUndefined(path) {
  try {
    return await fsp.stat(path)
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

/** Whether a path exists at all. */
export async function exists(path) {
  return (await statOrUndefined(path)) !== undefined
}

/** Whether a path exists and is a directory. */
export async function isDirectory(path) {
  return (await statOrUndefined(path))?.isDirectory() === true
}

/** `mkdir -p`. */
export async function ensureDir(path) {
  await fsp.mkdir(path, { recursive: true })
  return path
}

/** Read and parse a JSON file; `undefined` when it does not exist. */
export async function readJson(path) {
  let text
  try {
    text = await fsp.readFile(path, 'utf8')
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
  return JSON.parse(text.replace(/^\uFEFF/, ''))
}

/** Write JSON atomically (temp file + rename) so a pulled drive never leaves half a file. */
export async function writeJson(path, value) {
  await ensureDir(dirname(path))
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  await fsp.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await fsp.rename(temp, path)
  return path
}

/** Write UTF-8 text atomically. */
export async function writeText(path, text) {
  await ensureDir(dirname(path))
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  await fsp.writeFile(temp, text, 'utf8')
  await fsp.rename(temp, path)
  return path
}

/** Read UTF-8 text; `undefined` when missing. */
export async function readText(path) {
  try {
    return await fsp.readFile(path, 'utf8')
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

/**
 * Read UTF-8 text starting at a BYTE offset — not a JS string index.
 *
 * `startPortable()` records `fsp.stat().size`, which is a byte count, but a
 * decoded JS string's `.length`/`.slice()` count UTF-16 code units. launch.log
 * contains Chinese lines such as `starter written for 测试工作区`, so bytes and
 * characters diverge (464 bytes of drift on a real 59 KB log). Slicing the
 * string with the byte offset either lands mid-line or, when the file has not
 * yet grown past the offset, the old code fell back to the WHOLE file and
 * `extractUrl()` returned the PREVIOUS launch's URL — a dead port, because
 * `stopWorkspaceInstances()` had just killed that instance. The panel then
 * opened `ERR_CONNECTION_REFUSED` and every retry killed + relaunched again.
 *
 * Reading the raw Buffer by bytes and decoding only the tail makes offset and
 * content agree. Returns '' when the file has not grown past `byteOffset` yet
 * (wait — do NOT fall back to the whole file), and `undefined` when missing.
 */
export async function readTextFrom(path, byteOffset = 0) {
  try {
    const handle = await fsp.open(path, 'r')
    try {
      const size = (await handle.stat()).size
      const start = Math.max(0, Math.min(Number(byteOffset) || 0, size))
      if (size <= start) return ''
      const length = size - start
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, start)
      return buffer.toString('utf8')
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

/** Append one UTF-8 line to a log file, creating parents; never throws. */
export async function appendLog(path, line) {
  try {
    await ensureDir(dirname(path))
    await fsp.appendFile(path, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    // Logging must never break the operation it describes (a pulled drive is common here).
  }
}

/** Directory entries as `{ name, path, isDirectory }`; empty when missing. */
export async function listDir(path) {
  let entries
  try {
    entries = await fsp.readdir(path, { withFileTypes: true })
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
  return entries.map((entry) => ({
    name: entry.name,
    path: join(path, entry.name),
    isDirectory: entry.isDirectory(),
  }))
}

/** Remove a file or directory tree, ignoring a missing path. */
export async function removeTree(path) {
  try {
    await fsp.rm(path, { recursive: true, force: true, maxRetries: 3 })
  } catch (error) {
    if (!isMissing(error)) throw error
  }
}

/**
 * Copy a directory tree.
 *
 * @param source - Absolute source directory.
 * @param target - Absolute target directory (created as needed).
 * @param options - `skip(relativePath)`: return true to skip an entry;
 *   `onProgress(done, total)` for long copies.
 */
export async function copyTree(source, target, options = {}) {
  const { skip, onProgress } = options
  const total = await countTree(source)
  let done = 0
  const seen = new Set()

  const walk = async (from, to, relative) => {
    const stats = await statOrUndefined(from)
    if (stats === undefined) return
    if (stats.isSymbolicLink()) return
    if (stats.isDirectory()) {
      if (relative !== '' && skip?.(relative, true)) return
      await ensureDir(to)
      const entries = await listDir(from)
      for (const entry of entries) {
        await walk(entry.path, join(to, entry.name), relative === '' ? entry.name : `${relative}/${entry.name}`)
      }
      return
    }
    if (relative !== '' && skip?.(relative, false)) return
    await ensureDir(dirname(to))
    const key = resolve(to).toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    await fsp.copyFile(from, to)
    done += 1
    if (done % 64 === 0) onProgress?.(done, total)
  }

  await walk(resolve(source), resolve(target), '')
  onProgress?.(done, Math.max(done, total))
  return { files: done }
}

/** Count files (not directories) below a path; 0 when missing. */
export async function countTree(path) {
  const stats = await statOrUndefined(path)
  if (stats === undefined) return 0
  if (!stats.isDirectory()) return 1
  let total = 0
  for (const entry of await listDir(path)) {
    total += entry.isDirectory ? await countTree(entry.path) : 1
  }
  return total
}

/** Normalize a user-supplied absolute path to backslash-free canonical form. */
export function normalizePath(input) {
  return normalize(resolve(String(input ?? '').trim()))
}

/** Guard: a path must stay inside a base directory (defeats `..` traversal). */
export function isInside(base, candidate) {
  const root = resolve(base)
  const target = resolve(candidate)
  if (target === root) return true
  return target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

/** Stable short id derived from a workspace name plus randomness. */
export function makeId(prefix = 'ws') {
  return `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

/** A filesystem-safe folder name from arbitrary user text. */
export function safeName(text, fallback = 'workspace') {
  const cleaned = String(text ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^\.+/, '')
    .slice(0, 48)
  return cleaned === '' ? fallback : cleaned
}

/** Short stable hash used to key per-machine state. */
export function shortHash(text, length = 12) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, length)
}
