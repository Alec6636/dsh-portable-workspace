/**
 * Volume discovery for portable DSH roots.
 *
 * A portable root is identified by a marker file, never by a drive letter and
 * never by a volume label: the letter changes between machines and the label is
 * user-editable (and often non-UTF-8 on removable media). We enumerate the
 * top-level directories of every drive letter and accept any directory that
 * contains `.dsh-portable.json` with `kind = dsh-portable-root` — including the
 * 0.1.0 legacy spelling (`Portable-DSH` / `Protable-DSH`) and any custom name
 * the user chose (e.g. `移动工作区`). A single volume can hold several roots at
 * once, so discovery must return ALL of them, not just the first match.
 *
 * @module dsh-portable-workspace/lib/volumes
 */

import { promises as fsp } from 'node:fs'
import { join } from 'node:path'

import { ROOT_DIR_NAME, ROOT_MARKER, readJson, statOrUndefined } from './fsx.js'

/** Letters probed on Windows (A: and B: are historically floppy drives). */
const CANDIDATE_LETTERS = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

/** How long a single drive probe may take before it is treated as absent. */
const PROBE_TIMEOUT_MS = 1200

/** How long a full top-level directory scan of one drive may take. */
const SCAN_TIMEOUT_MS = 3000

/** Race a promise against a timeout, resolving `fallback` on timeout. */
function withTimeout(promise, ms, fallback) {
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** Absolute path of the portable root directory on one drive. */
export function rootPathOf(drive, dirName = ROOT_DIR_NAME) {
  const letter = String(drive).replace(/[\\/]+$/, '').replace(/:$/, '')
  return `${letter}:\\${dirName}`
}

/** Absolute path of the marker file on one drive. */
export function markerPathOf(drive, dirName = ROOT_DIR_NAME) {
  return join(rootPathOf(drive, dirName), ROOT_MARKER)
}

/**
 * Read the marker on one drive.
 *
 * @param dirName - Root directory name to probe. Defaults to the current
 *   `Portable-DSH`; pass `LEGACY_ROOT_DIR_NAME` to probe a 0.1.0 volume whose
 *   root was named `Protable-DSH`.
 * @returns the parsed marker, or `undefined` when the drive carries no
 *   portable root (or is not mounted at all).
 */
export async function readMarker(drive, dirName = ROOT_DIR_NAME) {
  const path = join(rootPathOf(drive, dirName), ROOT_MARKER)
  const probe = (async () => {
    const stats = await statOrUndefined(path)
    if (stats === undefined || !stats.isFile()) return undefined
    const marker = await readJson(path)
    if (marker == null || marker.kind !== 'dsh-portable-root') return undefined
    return marker
  })().catch(() => undefined)
  return withTimeout(probe, PROBE_TIMEOUT_MS, undefined)
}

/**
 * Probe one drive for ALL portable roots it carries.
 *
 * A root is identified by its marker file, not by a fixed directory name: the
 * user can rename the root (and 0.1.0 used the misspelled `Protable-DSH`), and
 * a single volume may hold several roots side by side. So list every top-level
 * directory (plus the drive root itself) and keep each one whose marker is a
 * valid portable root. The whole scan is bounded by SCAN_TIMEOUT_MS so an
 * unmounted/slow volume can never hold up shutdown.
 *
 * @returns an array of `{ drive, root, markerPath, marker }` entries.
 */
async function probeDrive(letter) {
  const driveRoot = `${letter}:\\`
  const scan = (async () => {
    let dirents
    try {
      dirents = await fsp.readdir(driveRoot, { withFileTypes: true })
    } catch {
      return []
    }
    const dirs = [driveRoot]
    for (const entry of dirents) {
      const name = entry.name ?? ''
      if (!entry.isDirectory()) continue
      if (name.startsWith('$') || name === 'System Volume Information') continue
      dirs.push(join(driveRoot, name))
    }
    const out = []
    for (const root of dirs) {
      const markerPath = join(root, ROOT_MARKER)
      try {
        const marker = await readJson(markerPath)
        if (marker == null || marker.kind !== 'dsh-portable-root') continue
        out.push({ drive: `${letter}:`, root, markerPath, marker })
      } catch {
        // Unreadable/non-JSON marker: not a portable root, skip it.
      }
    }
    return out
  })().catch(() => [])
  return withTimeout(scan, SCAN_TIMEOUT_MS, [])
}

/** Free/total bytes for a drive, or `undefined` when unavailable. */
export async function volumeSpace(drive) {
  try {
    const stats = await fsp.statfs(`${String(drive).replace(/:$/, '')}:\\`)
    return { free: Number(stats.bavail) * Number(stats.bsize), total: Number(stats.blocks) * Number(stats.bsize) }
  } catch {
    return undefined
  }
}

/**
 * Enumerate every mounted volume that carries a portable root.
 *
 * @param extraPaths - Additional absolute paths to probe (network shares,
 *   POSIX mount points, or a root the user moved somewhere unusual).
 * @returns entries sorted by drive letter.
 */
export async function findPortableRoots(extraPaths = []) {
  const results = []
  if (process.platform === 'win32') {
    const probed = await Promise.all(
      CANDIDATE_LETTERS.map((letter) => probeDrive(letter)),
    )
    for (const entries of probed) for (const entry of entries) results.push(entry)
  }
  for (const raw of extraPaths) {
    const path = String(raw ?? '').trim()
    if (path === '') continue
    const markerPath = join(path, ROOT_MARKER)
    // A remembered root may be an unplugged removable drive. A bare fs read
    // against an absent path can block for many seconds (network/removable
    // timeout), and this function runs inside the Host's graceful-shutdown
    // disposer path. Bound every extra-path probe with the same timeout used
    // for drive letters so shutdown can never be held open by a dead volume.
    const probe = readJson(markerPath).catch(() => undefined)
    const marker = await withTimeout(probe, PROBE_TIMEOUT_MS, undefined)
    if (marker == null || marker.kind !== 'dsh-portable-root') continue
    if (results.some((entry) => entry.root.toLowerCase() === path.toLowerCase())) continue
    results.push({ drive: '', root: path, markerPath, marker, external: true })
  }
  const withSpace = await Promise.all(
    results.map(async (entry) => ({
      ...entry,
      space: entry.drive === '' ? undefined : await volumeSpace(entry.drive),
    })),
  )
  return withSpace
}

/** Whether a portable root directory is currently reachable. */
export async function rootIsReachable(root) {
  const marker = await readJson(join(root, ROOT_MARKER)).catch(() => undefined)
  return marker != null && marker.kind === 'dsh-portable-root'
}
