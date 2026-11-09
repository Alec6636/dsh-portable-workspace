/**
 * Minimal, read-only app.asar inspector.
 *
 * The desktop installation ships its packages inside `resources/app.asar`, so
 * answering "does this machine already have <package>?" needs a peek into that
 * archive. The Electron archive format starts with a size-prefixed pickle that
 * holds the whole file table as JSON; the file bodies follow in one blob. We
 * only ever read that JSON header, never the bodies.
 *
 * Header layout (little endian):
 *
 *     u32 @0   4                      — size of the first pickle field
 *     u32 @4   payloadSize            — total bytes after this field
 *     u32 @8   stringLength           — length of the header string
 *     u32 @12  jsonLength             — length of the JSON document itself
 *     json     @16 … @16 + jsonLength
 *
 * @module dsh-portable-workspace/lib/asar
 */

import { readFile } from 'node:fs/promises'

/**
 * Open the real filesystem, not Electron's asar-aware facade.
 *
 * Inside Electron, `node:fs` transparently redirects anything under a `.asar`
 * path into the archive — so `stat('…/app.asar')` reports a directory and
 * `open()` fails with ENOENT. Reading the archive *file* therefore needs the
 * original module; plain Node has no `original-fs`, so it falls back.
 */
let fsModule
async function fsOf() {
  if (fsModule === undefined) {
    fsModule = await import('original-fs')
      .then((module) => module.default ?? module)
      .catch(() => undefined)
    if (fsModule !== undefined && typeof fsModule.promises?.open !== 'function') fsModule = undefined
  }
  return fsModule === undefined ? undefined : fsModule.promises
}

/** `open` from whichever filesystem sees `app.asar` as a regular file. */
async function openArchive(asarPath) {
  const real = await fsOf()
  if (real !== undefined) return real.open(asarPath, 'r')
  const { open } = await import('node:fs/promises')
  return open(asarPath, 'r')
}

/** Bytes of the pickle prefix before the JSON document. */
const PREFIX_BYTES = 16
/** Guard against a corrupt header turning into a huge allocation. */
const MAX_HEADER_BYTES = 64 * 1024 * 1024

/** @type {Map<string, Set<string>>} */
const treeCache = new Map()

/**
 * Read the JSON header of an asar archive.
 *
 * @param asarPath - Absolute path to `app.asar`.
 * @returns the parsed header, or `undefined` when it is unreadable.
 */
export async function readAsarHeader(asarPath) {
  let handle
  try {
    handle = await openArchive(asarPath)
  } catch {
    return undefined
  }
  try {
    const prefix = Buffer.alloc(PREFIX_BYTES)
    const { bytesRead } = await handle.read(prefix, 0, PREFIX_BYTES, 0)
    if (bytesRead < PREFIX_BYTES) return undefined
    const jsonLength = prefix.readUInt32LE(12)
    if (jsonLength <= 0 || jsonLength > MAX_HEADER_BYTES) return undefined
    const body = Buffer.alloc(jsonLength)
    const read = await handle.read(body, 0, jsonLength, PREFIX_BYTES)
    if (read.bytesRead < jsonLength) return undefined
    return JSON.parse(body.toString('utf8'))
  } catch {
    return undefined
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** Collect every file path of the asar tree into a flat set. */
function flatten(node, prefix, into) {
  const files = node != null && typeof node === 'object' ? node.files : undefined
  if (files == null || typeof files !== 'object') return
  for (const [name, entry] of Object.entries(files)) {
    const path = prefix === '' ? name : `${prefix}/${name}`
    if (entry != null && typeof entry === 'object' && entry.files != null) flatten(entry, path, into)
    else into.add(path)
  }
}

/**
 * List every file path inside an asar archive.
 *
 * @param asarPath - Absolute path to `app.asar`.
 * @returns a set of forward-slash relative paths; empty when unreadable.
 */
export async function listAsarFiles(asarPath) {
  const cached = treeCache.get(asarPath)
  if (cached !== undefined) return cached
  const header = await readAsarHeader(asarPath)
  const files = new Set()
  if (header !== undefined) flatten(header, '', files)
  if (files.size > 0) treeCache.set(asarPath, files)
  return files
}

/**
 * Whether an asar archive contains a relative path.
 *
 * @param asarPath - Absolute path to `app.asar`.
 * @param relativePath - Forward-slash path such as `dsh/node_modules/x/package.json`.
 */
export async function asarHas(asarPath, relativePath) {
  const files = await listAsarFiles(asarPath)
  return files.has(relativePath)
}

/**
 * Names under a package scope directory that carry a `package.json`.
 *
 * @param asarPath - Absolute path to `app.asar`.
 * @param scope - Directory such as `dsh/node_modules/@deepseek-ai`.
 * @returns sorted package names (without the scope prefix), or `[]`.
 */
export async function asarPackagesIn(asarPath, scope) {
  const files = await listAsarFiles(asarPath)
  const prefix = `${scope.replace(/\/+$/, '')}/`
  const names = new Set()
  for (const path of files) {
    if (!path.startsWith(prefix)) continue
    const rest = path.slice(prefix.length)
    const segments = rest.split('/')
    if (segments.length !== 2 || segments[1] !== 'package.json') continue
    const name = segments[0]
    if (name === '' || name.startsWith('@') || name.startsWith('.')) continue
    names.add(name)
  }
  return [...names].sort()
}

/** Read a file body out of an asar archive (bodies follow the header blob). */
export async function readAsarFile(asarPath, relativePath) {
  const header = await readAsarHeader(asarPath)
  if (header === undefined) return undefined
  const segments = relativePath.split('/').filter((segment) => segment !== '')
  let node = header
  for (const segment of segments) {
    const files = node != null && typeof node === 'object' ? node.files : undefined
    if (files == null || typeof files !== 'object') return undefined
    node = files[segment]
    if (node === undefined) return undefined
  }
  if (node == null || typeof node !== 'object' || node.offset === undefined) return undefined
  // Some archives store the offset as a decimal string.
  const offset = typeof node.offset === 'string' ? Number(node.offset) : node.offset
  if (typeof offset !== 'number' || !Number.isFinite(offset)) return undefined
  const size = typeof node.size === 'number' ? node.size : Number(node.size ?? 0)
  // The body blob starts after the header block: 8 + payloadSize from the prefix.
  let base
  try {
    const handle = await openArchive(asarPath)
    try {
      const prefix = Buffer.alloc(PREFIX_BYTES)
      await handle.read(prefix, 0, PREFIX_BYTES, 0)
      base = 8 + prefix.readUInt32LE(4)
      const body = Buffer.alloc(size)
      await handle.read(body, 0, size, base + offset)
      return body
    } finally {
      await handle.close().catch(() => undefined)
    }
  } catch {
    return undefined
  }
}

/** Read a JSON file body out of an asar archive. */
export async function readAsarJson(asarPath, relativePath) {
  const buffer = await readAsarFile(asarPath, relativePath)
  if (buffer === undefined) return undefined
  try {
    return JSON.parse(buffer.toString('utf8').replace(/^\uFEFF/, ''))
  } catch {
    return undefined
  }
}

/** Drop cached trees (used when the installation root changes). */
export function clearAsarCache() {
  treeCache.clear()
}

/** Exposed for callers that want the raw header without caching. */
export const _internals = { PREFIX_BYTES, flatten, readFile }
