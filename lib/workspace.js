/**
 * Portable workspace manifests: create, read, update, remove, and migrate.
 *
 * A portable root on a volume looks like this:
 *
 *   <letter>:\Portable-DSH\
 *     .dsh-portable.json          root marker (what identifies the volume)
 *     support\home\               shared portable DSH_HOME on this volume
 *     Portable-Workspaces\<id>\   one directory per workspace (manifest, sessions, logs)
 *     Projects\<id>\              the working directory of that workspace
 *
 * Nothing here talks to DSH services, so it also runs outside a mounted app.
 *
 * @module dsh-portable-workspace/lib/workspace
 */

import { execFile } from 'node:child_process'
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import {
  PROJECTS_DIR_NAME,
  ROOT_DIR_NAME,
  ROOT_MARKER,
  SUPPORT_DIR_NAME,
  WORKSPACES_DIR_NAME,
  WORKSPACE_MARKER,
  LEGACY_WORKSPACES_DIR_NAME,
  copyTree,
  ensureDir,
  exists,
  isDirectory,
  listDir,
  makeId,
  readJson,
  readText,
  removeTree,
  safeName,
  statOrUndefined,
  writeJson,
  writeText,
} from './fsx.js'
import { healSessionCwds } from './sessions.js'

const execFileAsync = promisify(execFile)

/** Manifest format version written by this plugin. */
export const WORKSPACE_FORMAT = 1
/** Root marker format version written by this plugin. */
export const ROOT_FORMAT = 1
/** Marker `kind` that identifies a portable root. */
export const ROOT_KIND = 'dsh-portable-root'
/** Marker `kind` that identifies a workspace manifest. */
export const WORKSPACE_KIND = 'dsh-portable-workspace'

/** scrypt parameters; stored with each hash so old workspaces keep verifying. */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 }

/** Unambiguous alphabet (no 0/O/1/I) for one-time recovery codes. */
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const RECOVERY_GROUPS = 4
const RECOVERY_GROUP_LEN = 4

/** A fresh one-time recovery code, e.g. `K7Q2-M9XP-3RTB-WH5N`. */
export function generateRecoveryCode() {
  const bytes = randomBytes(RECOVERY_GROUPS * RECOVERY_GROUP_LEN)
  const groups = []
  for (let g = 0; g < RECOVERY_GROUPS; g++) {
    let part = ''
    for (let i = 0; i < RECOVERY_GROUP_LEN; i++) {
      part += RECOVERY_ALPHABET[bytes[g * RECOVERY_GROUP_LEN + i] % RECOVERY_ALPHABET.length]
    }
    groups.push(part)
  }
  return groups.join('-')
}

/* -------------------------------------------------------------------------- */
/* Portable root                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Which workspaces sub-directory name a root actually uses.
 *
 * 0.1.0 wrote `Protable-Workspaces`. New roots use `Portable-Workspaces`. An
 * already-initialized volume keeps its existing sub-directory, so picking the
 * name that is really on disk lets the upgraded plugin open old workspaces.
 * The check is synchronous (existsSync) because `layoutOf` is synchronous and
 * is called from many hot paths.
 */
export function workspacesDirNameFor(root) {
  if (existsSync(join(root, WORKSPACES_DIR_NAME))) return WORKSPACES_DIR_NAME
  if (existsSync(join(root, LEGACY_WORKSPACES_DIR_NAME))) return LEGACY_WORKSPACES_DIR_NAME
  return WORKSPACES_DIR_NAME
}

/** Directory layout paths for one portable root. */
export function layoutOf(root) {
  const workspacesDir = join(root, workspacesDirNameFor(root))
  const supportDir = join(root, SUPPORT_DIR_NAME)
  const projectsDir = join(root, PROJECTS_DIR_NAME)
  const homeDir = join(supportDir, 'home')
  return {
    root,
    markerPath: join(root, ROOT_MARKER),
    workspacesDir,
    supportDir,
    projectsDir,
    homeDir,
    profileDir: join(homeDir, 'profiles', 'portable'),
  }
}

/** Build the marker payload for a new portable root. */
export function newRootMarker() {
  return {
    kind: ROOT_KIND,
    format: ROOT_FORMAT,
    rootId: randomUUID(),
    createdAt: Date.now(),
  }
}

/**
 * Create the directory skeleton of a portable root.
 *
 * Idempotent: an existing marker is kept so a volume that already carries
 * workspaces is never re-identified.
 *
 * @param root - Absolute `<letter>:\Portable-DSH` path.
 * @returns `{ marker, created }` where `created` is false when it already existed.
 */
export async function ensurePortableRoot(root) {
  const layout = layoutOf(root)
  await ensureDir(layout.workspacesDir)
  await ensureDir(layout.projectsDir)
  await ensureDir(layout.supportDir)
  await ensureDir(layout.homeDir)
  const existing = await readMarkerFile(root)
  if (existing !== undefined) return { marker: existing, created: false, layout }
  const marker = newRootMarker()
  await writeJson(layout.markerPath, marker)
  return { marker, created: true, layout }
}

/** Read the root marker of a directory, or `undefined` when it is not a root. */
export async function readMarkerFile(root) {
  const marker = await readJson(join(root, ROOT_MARKER)).catch(() => undefined)
  return marker != null && marker.kind === ROOT_KIND ? marker : undefined
}

/* -------------------------------------------------------------------------- */
/* Manifest paths                                                             */
/* -------------------------------------------------------------------------- */

/** Absolute paths belonging to one workspace. */
export function workspacePaths(root, id) {
  const layout = layoutOf(root)
  const dir = join(layout.workspacesDir, id)
  const projectDir = join(layout.projectsDir, id)
  return {
    root,
    id,
    dir,
    homeDir: layout.homeDir,
    profileDir: layout.profileDir,
    manifestPath: join(dir, WORKSPACE_MARKER),
    sessionsDir: join(dir, 'sessions'),
    storagesDir: join(dir, 'storages'),
    logsDir: join(dir, 'logs'),
    launchDir: join(dir, 'launch'),
    patchPath: join(dir, 'launch', 'cordis.patch.yml'),
    runtimePath: join(dir, 'launch', 'runtime.json'),
    projectDir,
  }
}

/* -------------------------------------------------------------------------- */
/* Passwords                                                                  */
/* -------------------------------------------------------------------------- */

/** Turn a plain password into a storable `{ algo, salt, hash, ... }` record. */
export function hashPassword(password) {
  const text = String(password ?? '')
  if (text === '') return null
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(text, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p })
  return {
    algo: 'scrypt',
    salt,
    hash: hash.toString('hex'),
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  }
}

/**
 * Verify a plain password against a stored record.
 *
 * A workspace without a password (`record` null) accepts every input, which is
 * what "密码留空" means: no prompt, no check.
 */
export function verifyPassword(record, password) {
  if (record == null) return true
  if (typeof record !== 'object' || typeof record.hash !== 'string' || typeof record.salt !== 'string') return false
  try {
    const expected = Buffer.from(record.hash, 'hex')
    const actual = scryptSync(String(password ?? ''), record.salt, expected.length, {
      N: record.N ?? SCRYPT.N,
      r: record.r ?? SCRYPT.r,
      p: record.p ?? SCRYPT.p,
    })
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

/* -------------------------------------------------------------------------- */
/* Manifest I/O                                                               */
/* -------------------------------------------------------------------------- */

/** Coerce a stored manifest into the shape the rest of the plugin expects. */
function normalizeManifest(raw) {
  const manifest = raw != null && typeof raw === 'object' ? raw : {}
  return {
    kind: WORKSPACE_KIND,
    format: Number.isFinite(manifest.format) ? manifest.format : WORKSPACE_FORMAT,
    id: typeof manifest.id === 'string' ? manifest.id : '',
    name: typeof manifest.name === 'string' && manifest.name !== '' ? manifest.name : '未命名工作区',
    createdAt: Number.isFinite(manifest.createdAt) ? manifest.createdAt : Date.now(),
    updatedAt: Number.isFinite(manifest.updatedAt) ? manifest.updatedAt : Date.now(),
    lastOpenedAt: Number.isFinite(manifest.lastOpenedAt) ? manifest.lastOpenedAt : undefined,
    rootId: typeof manifest.rootId === 'string' ? manifest.rootId : '',
    password: manifest.password != null && typeof manifest.password === 'object' ? manifest.password : null,
    passwordHint: typeof manifest.passwordHint === 'string' ? manifest.passwordHint : '',
    recovery: manifest.recovery != null && typeof manifest.recovery === 'object' ? manifest.recovery : null,
    plugins: Array.isArray(manifest.plugins) ? manifest.plugins.filter(isPluginEntry).map(cleanPluginEntry) : [],
    profile: typeof manifest.profile === 'string' && manifest.profile !== '' ? manifest.profile : 'portable',
    notes: typeof manifest.notes === 'string' ? manifest.notes : '',
    origin: manifest.origin != null && typeof manifest.origin === 'object' ? manifest.origin : undefined,
  }
}

/** Whether an entry of `plugins` is usable. */
function isPluginEntry(entry) {
  return entry != null && typeof entry === 'object' && typeof entry.name === 'string' && entry.name !== ''
}

/** Keep only the fields a plugin requirement has. */
function cleanPluginEntry(entry) {
  return {
    name: String(entry.name),
    version: typeof entry.version === 'string' ? entry.version : undefined,
    optional: entry.optional === true,
  }
}

/**
 * Append plugin requirements to a manifest's list without duplicates.
 *
 * Used when migrating a workspace: the destination must declare the plugins
 * that were installed in the source volume's shared profile, so opening it on
 * a new drive offers to reinstall them (plugins themselves are never copied).
 *
 * @param base - Existing manifest.plugins array.
 * @param extra - Additional `{ name, version?, optional? }` entries.
 * @returns a new normalized array.
 */
export function mergePluginsIntoManifest(base, extra) {
  const merged = Array.isArray(base) ? base.filter(isPluginEntry).map(cleanPluginEntry) : []
  const names = new Set(merged.map((entry) => entry.name))
  if (Array.isArray(extra)) {
    for (const raw of extra) {
      if (!isPluginEntry(raw)) continue
      const entry = cleanPluginEntry(raw)
      if (names.has(entry.name)) continue
      merged.push(entry)
      names.add(entry.name)
    }
  }
  return merged
}

/** Read one workspace manifest; `undefined` when the directory has none. */
export async function readWorkspace(root, id) {
  const paths = workspacePaths(root, id)
  const raw = await readJson(paths.manifestPath).catch(() => undefined)
  if (raw == null || typeof raw !== 'object') return undefined
  const manifest = normalizeManifest(raw)
  if (manifest.id === '') manifest.id = id
  return { manifest, paths }
}

/** List every workspace under one portable root, newest first. */
export async function listWorkspaces(root) {
  const layout = layoutOf(root)
  const entries = await listDir(layout.workspacesDir)
  const found = []
  for (const entry of entries) {
    if (!entry.isDirectory) continue
    if (entry.name.startsWith('.')) continue
    const workspace = await readWorkspace(root, entry.name)
    if (workspace === undefined) continue
    found.push(workspace)
  }
  found.sort((a, b) => (b.manifest.lastOpenedAt ?? b.manifest.createdAt) - (a.manifest.lastOpenedAt ?? a.manifest.createdAt))
  return found
}

/**
 * Create a workspace on a portable root.
 *
 * @param root - Absolute portable root path.
 * @param options - `{ name, password, hint, plugins, notes }`.
 * @returns the created `{ manifest, paths, passwordProtected, recoveryCode }`.
 * @throws Error with `code: 'duplicate-name'` when the name is already used.
 */
export async function createWorkspace(root, options = {}) {
  const layout = layoutOf(root)
  await ensureDir(layout.workspacesDir)
  const name = String(options.name ?? '').trim() === '' ? '移动工作区' : String(options.name).trim()
  const existing = await listWorkspaces(root)
  if (existing.some((entry) => entry.manifest.name === name)) {
    const error = new Error(`本盘已有同名工作区：${name}`)
    error.code = 'duplicate-name'
    throw error
  }
  const id = makeId('ws')
  const paths = workspacePaths(root, id)
  await ensureDir(paths.dir)
  await ensureDir(paths.sessionsDir)
  await ensureDir(paths.storagesDir)
  await ensureDir(paths.logsDir)
  await ensureDir(paths.launchDir)
  await ensureDir(paths.projectDir)
  // Materialized up front so the first-use Workspace never reports `missing-dir`
  // and a session's very first turn has a real cwd on the stick.
  await ensureDir(defaultWorkspaceDirOf(paths))
  const marker = (await readMarkerFile(root)) ?? {}
  const now = Date.now()
  const password = hashPassword(options.password)
  // A recovery code is minted only when the workspace is actually locked.
  // Only its scrypt hash is stored on the drive; the plain code is returned
  // once to the caller and never written anywhere.
  const recoveryCode = password != null ? generateRecoveryCode() : ''
  const manifest = normalizeManifest({
    format: WORKSPACE_FORMAT,
    id,
    name,
    createdAt: now,
    updatedAt: now,
    rootId: typeof marker.rootId === 'string' ? marker.rootId : '',
    password,
    passwordHint: typeof options.hint === 'string' ? options.hint : '',
    recovery: recoveryCode === '' ? null : hashPassword(recoveryCode),
    plugins: Array.isArray(options.plugins) ? options.plugins : [],
    notes: typeof options.notes === 'string' ? options.notes : '',
  })
  await writeJson(paths.manifestPath, manifest)
  return { manifest, paths, passwordProtected: manifest.password != null, recoveryCode }
}

/** Rewrite a manifest, refreshing `updatedAt`. */
export async function saveWorkspace(paths, manifest) {
  const next = normalizeManifest({ ...manifest, updatedAt: Date.now() })
  await writeJson(paths.manifestPath, next)
  return next
}

/**
 * Change name, password, notes or plugin list of an existing workspace.
 *
 * `password` is tri-state: `undefined` keeps it, `''` removes it, anything else
 * replaces it.
 */
export async function updateWorkspace(root, id, patch = {}) {
  const found = await readWorkspace(root, id)
  if (found === undefined) {
    const error = new Error(`找不到工作区：${id}`)
    error.code = 'not-found'
    throw error
  }
  const manifest = { ...found.manifest }
  if (typeof patch.name === 'string' && patch.name.trim() !== '') {
    const trimmed = patch.name.trim()
    if (trimmed !== manifest.name) {
      const others = await listWorkspaces(root)
      if (others.some((entry) => entry.manifest.id !== id && entry.manifest.name === trimmed)) {
        const error = new Error(`本盘已有同名工作区：${trimmed}`)
        error.code = 'duplicate-name'
        throw error
      }
      manifest.name = trimmed
    }
  }
  if (patch.password === '' || patch.password === null) manifest.password = null
  else if (typeof patch.password === 'string') manifest.password = hashPassword(patch.password)
  if (typeof patch.passwordHint === 'string') manifest.passwordHint = patch.passwordHint
  if (patch.recovery === null) manifest.recovery = null
  else if (patch.recovery !== undefined && typeof patch.recovery === 'object') manifest.recovery = patch.recovery
  if (typeof patch.notes === 'string') manifest.notes = patch.notes
  if (Array.isArray(patch.plugins)) manifest.plugins = patch.plugins.filter(isPluginEntry).map(cleanPluginEntry)
  const saved = await saveWorkspace(found.paths, manifest)
  return { manifest: saved, paths: found.paths }
}

/**
 * Set a new password (or clear it), mint a fresh one-time recovery code and
 * optionally update the password hint. The plain code is returned once.
 */
export async function rotatePassword(root, id, options = {}) {
  const found = await readWorkspace(root, id)
  if (found === undefined) {
    const error = new Error(`找不到工作区：${id}`)
    error.code = 'not-found'
    throw error
  }
  const password = hashPassword(options.newPassword)
  const recoveryCode = password != null ? generateRecoveryCode() : ''
  const manifest = {
    ...found.manifest,
    password,
    passwordHint: typeof options.hint === 'string' ? options.hint : found.manifest.passwordHint,
    recovery: recoveryCode === '' ? null : hashPassword(recoveryCode),
  }
  const saved = await saveWorkspace(found.paths, manifest)
  return { manifest: saved, paths: found.paths, recoveryCode }
}

/** Delete a workspace directory and its project directory. */
export async function deleteWorkspace(root, id, options = {}) {
  const paths = workspacePaths(root, id)
  if (!(await exists(paths.manifestPath))) {
    const error = new Error(`找不到工作区：${id}`)
    error.code = 'not-found'
    throw error
  }
  await removeTree(paths.dir)
  if (options.keepProjects !== true) await removeTree(paths.projectDir)
  return { id }
}

/* -------------------------------------------------------------------------- */
/* Migration                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Move a workspace to another portable root (or another local disk).
 *
 * The manifest, sessions, storages, logs and project files all move, and the
 * `rootId` in the manifest is repointed, so the workspace keeps its identity
 * after a cut/paste between drives.
 *
 * @param fromRoot - Current portable root.
 * @param id - Workspace id.
 * @param toRoot - Destination portable root (created if needed).
 * @param options - `{ move?: boolean, targetId?: string, onProgress? }`.
 */
export async function migrateWorkspace(fromRoot, id, toRoot, options = {}) {
  const found = await readWorkspace(fromRoot, id)
  if (found === undefined) {
    const error = new Error(`找不到工作区：${id}`)
    error.code = 'not-found'
    throw error
  }
  if (fromRoot.toLowerCase() === toRoot.toLowerCase()) {
    const error = new Error('源盘和目标盘相同，无需迁移')
    error.code = 'invalid-target'
    throw error
  }
  const target = await ensurePortableRoot(toRoot)
  const targetId = typeof options.targetId === 'string' && options.targetId !== '' ? options.targetId : id
  const toPaths = workspacePaths(toRoot, targetId)
  if (await exists(toPaths.manifestPath)) {
    const error = new Error(`目标盘已有同 id 的工作区：${targetId}`)
    error.code = 'target-busy'
    throw error
  }
  await ensureDir(toPaths.dir)
  await copyTree(found.paths.dir, toPaths.dir, {
    skip: (relative) => relative === WORKSPACE_MARKER,
    onProgress: options.onProgress,
  })
  await copyTree(found.paths.projectDir, toPaths.projectDir, { onProgress: options.onProgress })
  const manifest = {
    ...found.manifest,
    id: targetId,
    rootId: String(target.marker.rootId ?? ''),
    updatedAt: Date.now(),
    origin: { ...(found.manifest.origin ?? {}), root: fromRoot, id, migratedAt: Date.now() },
  }
  // Plugins are never copied (the shared profile stays on its own volume), but
  // the destination workspace must declare what the source profile had so the
  // next open offers to reinstall them. Merge without duplicating entries the
  // workspace already declared.
  if (Array.isArray(options.plugins) && options.plugins.length > 0) {
    manifest.plugins = mergePluginsIntoManifest(manifest.plugins, options.plugins)
  }
  await writeJson(toPaths.manifestPath, manifest)
  // Every copied session log still names the source drive in its header, and
  // the JSONL backend derives the log's folder from that header — a stale
  // `cwd` makes the copy unreadable on the new root. Re-point the logs and the
  // Workspace registry at the destination before reporting success.
  const sessions = await healSessionCwds(toPaths).catch(() => ({ rewritten: 0 }))
  const registry = await healWorkspaceRegistry(toPaths).catch(() => 0)
  if (options.move === true) await deleteWorkspace(fromRoot, id)
  return { manifest, fromPaths: found.paths, toPaths, sessions, registry }
}

/* -------------------------------------------------------------------------- */
/* Per-launch patch file                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Where the `workspace-controller` puts the first-use Workspace.
 *
 * The controller joins `<documentsDirectory>/deepseek-harness/default-workspace`,
 * and this plugin points `documentsDirectory` at the workspace's project
 * directory so that work lands under `Projects/<id>` like everything else the
 * user asked to keep on the stick.
 */
export function defaultWorkspaceDirOf(paths) {
  return join(paths.projectDir, 'deepseek-harness', 'default-workspace')
}

/**
 * Repair a Workspace registry that points its default Workspace somewhere else.
 *
 * Two kinds of stale record are re-pointed: `<local Documents>/…` written by a
 * build of this plugin before `workspace-controller` was redirected, and the
 * older `<workspace>/deepseek-harness/default-workspace` location. Each session
 * inherits the default Workspace's path as its `cwd`, so every record has to
 * end up at `defaultWorkspaceDirOf(paths)` — on the stick, under `Projects`.
 *
 * @returns the number of records rewritten.
 */
export async function healWorkspaceRegistry(paths) {
  const file = join(paths.storagesDir, 'workspace.json')
  const raw = await readJson(file).catch(() => undefined)
  if (raw === undefined || raw === null || typeof raw !== 'object') return 0
  const table = raw.tables?.workspaces
  if (table === undefined || table === null || typeof table !== 'object') return 0
  // The controller joins `documentsDirectory` + 'deepseek-harness' +
  // 'default-workspace', so this is where a healthy fresh registry points.
  const target = defaultWorkspaceDirOf(paths)
  let healed = 0
  for (const record of Object.values(table)) {
    if (record === null || typeof record !== 'object') continue
    if (typeof record.path !== 'string' || record.path === '') continue
    if (record.path === target) continue
    // Anywhere else is wrong: a local Documents folder (pre-fix registries) or
    // the older `<workspace>/deepseek-harness` location. Both are re-pointed so
    // one workspace has exactly one default directory again.
    record.path = target
    record.updatedAt = new Date().toISOString()
    healed += 1
  }

  // Re-pointing every record to the same directory is only valid while there
  // is ONE record. A registry that accumulated several (e.g. after opening the
  // same volume from two computers) makes the workspace domain reject the
  // state with "path ... is claimed by both workspace A and B", which in turn
  // keeps session-controller / schedule / workspace-controller pending. Keep a
  // single record — the current default if it exists — and drop the rest.
  const ids = Object.keys(table)
  if (ids.length > 1) {
    const preferred = raw.global?.defaultWorkspaceId
    const keep = (typeof preferred === 'string' && table[preferred] !== undefined)
      ? preferred
      : ids[0]
    for (const id of ids) {
      if (id === keep) continue
      delete table[id]
      healed += 1
    }
    if (Array.isArray(raw.global?.workspaceIds)) {
      raw.global.workspaceIds = raw.global.workspaceIds.filter((id) => id === keep)
    }
    if (raw.global?.defaultWorkspaceId !== keep) raw.global.defaultWorkspaceId = keep
  } else if (ids.length === 1 && raw.global?.defaultWorkspaceId !== ids[0]) {
    // A single stale default id is harmless but make it consistent anyway.
    raw.global.defaultWorkspaceId = ids[0]
  }

  if (healed === 0) return 0
  // The registry reports `missing-dir` for a record whose directory is absent,
  // so materialize it before the record starts pointing there.
  await ensureDir(target).catch(() => undefined)
  await writeJson(file, raw)
  return healed
}

/**
 * Write the `cordis.patch.yml` overlay a portable instance is launched with.
 *
 * The profile layer only knows `$DSH_HOME`; this overlay pins the two roots
 * that must live inside the workspace directory instead, so sessions and
 * storage records of one workspace never mix with another workspace on the
 * same volume.
 *
 * @returns the patch file path.
 */
export async function writeLaunchPatch(paths) {
  const yaml = [
    `# Generated by dsh-portable-workspace for workspace ${paths.id}.`,
    '# Applied after the profile layer with `dsh --patch`.',
    '- id: session-persistence-jsonl',
    '  config:',
    '    compression: zstd',
    `    root: ${JSON.stringify(paths.sessionsDir.replace(/\\/g, '/'))}`,
    '- id: storage-json',
    '  config:',
    `    root: ${JSON.stringify(paths.storagesDir.replace(/\\/g, '/'))}`,
    // Without this the instance falls back to the shipped default directory,
    // which lives under the local user's Documents folder — a new session would
    // then create local state and break "nothing is stored on this computer".
    '- id: working-directory',
    '  config:',
    `    defaultDirectory: ${JSON.stringify(paths.projectDir.replace(/\\/g, '/'))}`,
    // The first-use Workspace is derived from the Host's Documents directory,
    // and the Workspace registry — not `working-directory` — is what stamps a
    // session header's `cwd`. Pointing that lookup inside the workspace folder
    // keeps the default Workspace on the stick instead of
    // `<local Documents>/deepseek-harness/default-workspace`.
    '- id: workspace-controller',
    '  config:',
    `    documentsDirectory: ${JSON.stringify(paths.projectDir.replace(/\\/g, '/'))}`,
    // The shipped default route wants an API key the portable home does not
    // carry; the account route authenticates with the DeepSeek login token that
    // `同步本机登录` copies onto the stick, so a fresh computer works signed in.
    '- id: agent-default-model',
    '  config:',
    '    provider: deepseek-account',
    '    model: deepseek-flash',
    '',
  ].join('\n')
  await writeText(paths.patchPath, yaml)
  return paths.patchPath
}

/** Record the last launch state of a workspace (port, url, pid, time). */
export async function writeRuntime(paths, runtime) {
  await writeJson(paths.runtimePath, runtime)
  return runtime
}

/** Read the last launch state of a workspace. */
export async function readRuntime(paths) {
  return readJson(paths.runtimePath).catch(() => undefined)
}

/** Whether the workspace directory is still reachable on disk. */
export async function workspaceIsReachable(root) {
  return (await statOrUndefined(join(root, ROOT_MARKER))) !== undefined || (await isDirectory(join(root, workspacesDirNameFor(root))))
}

/** Human-readable reason a workspace cannot open, or `undefined` when it can. */
export async function offlineReason(root) {
  if (await readMarkerFile(root)) return undefined
  if (await isDirectory(join(root, workspacesDirNameFor(root)))) return undefined
  return `找不到移动工作区根目录：${root}`
}

/** Stable short key of a workspace path, used for per-machine state. */
export function workspaceKey(root, id) {
  return createHash('sha256').update(`${root.toLowerCase()}|${id}`).digest('hex').slice(0, 16)
}

/** Default project directory name for a workspace. */
export function projectDirName(manifest) {
  return `${manifest.id}_${safeName(manifest.name)}`
}

/** Read the text of a launch log tail; `undefined` when absent. */
export async function readLogTail(paths, lines = 40) {
  const text = await readText(join(paths.logsDir, 'launch.log')).catch(() => undefined)
  if (text === undefined) return undefined
  const all = text.split(/\r?\n/).filter((line) => line !== '')
  return all.slice(-lines).join('\n')
}

/** Unused placeholder so downstream code can rely on `ROOT_DIR_NAME` staying exported. */
export const VOLUME_ROOT_DIR = ROOT_DIR_NAME

/* -------------------------------------------------------------------------- */
/* Backups / restore (0.1.3, zipped in 0.1.4)                                   */
/* -------------------------------------------------------------------------- */

/** Root folder holding all backups of one portable volume. */
export function backupsRootOf(root) {
  return join(root, 'Portable-Backups')
}

/** Folder of one backup instance (0.1.3 scatter layout, kept for reading). */
export function backupDirOf(root, id, stamp) {
  return join(backupsRootOf(root), id, stamp)
}

/** System bsdtar: creates/extracts .zip with zero npm dependencies. */
const SYSTEM_TAR = process.platform === 'win32' ? 'C:/Windows/System32/tar.exe' : 'tar'

function tarAvailable() {
  return process.platform !== 'win32' || existsSync(SYSTEM_TAR)
}

/**
 * All backups under one portable root (all workspaces), newest first.
 * Reads both the 0.1.4 `.zip` + sidecar layout and the 0.1.3 scatter folders,
 * so backups made by older builds stay listable and restorable.
 */
export async function listBackupsUnderRoot(root) {
  const base = backupsRootOf(root)
  const out = []
  if (!(await isDirectory(base))) return out
  for (const ws of await listDir(base)) {
    if (!ws.isDirectory) continue
    let entries
    try { entries = await fsp.readdir(ws.path, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const name = entry.name
      if (entry.isDirectory()) {
        // 0.1.3: <stamp>/{workspace,project,backup.json}
        const meta = await readJson(join(ws.path, name, 'backup.json')).catch(() => undefined)
        if (meta === undefined || meta === null || typeof meta !== 'object') continue
        out.push({ ...meta, dir: join(ws.path, name), stamp: name, zip: false })
      } else if (name.toLowerCase().endsWith('.zip')) {
        // 0.1.4: <stamp>.zip + <stamp>.json sidecar
        const stamp = name.slice(0, -4)
        const meta = await readJson(join(ws.path, `${stamp}.json`)).catch(() => undefined)
        if (meta === undefined || meta === null || typeof meta !== 'object') continue
        out.push({ ...meta, dir: join(ws.path, name), stamp, zip: true })
      }
    }
  }
  return out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
}

/**
 * Snapshot a workspace into `<root>/Portable-Backups/<id>/<stamp>.zip`.
 * A matching `<stamp>.json` sidecar keeps listing cheap; `backup.json` is
 * also stored inside the archive so a manually unzipped backup is readable.
 * Falls back to the 0.1.3 scatter directory when no system tar is available.
 */
export async function createBackup(root, id, paths, options = {}) {
  const manifest = await readJson(paths.manifestPath).catch(() => ({}))
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const holder = join(backupsRootOf(root), id)
  await ensureDir(holder)
  const dir = join(holder, stamp)
  await ensureDir(join(dir, 'workspace'))
  await ensureDir(join(dir, 'project'))
  const ws = await copyTree(paths.dir, join(dir, 'workspace')).catch(() => ({ files: 0 }))
  let proj = 0
  if (await isDirectory(paths.projectDir)) {
    proj = (await copyTree(paths.projectDir, join(dir, 'project')).catch(() => ({ files: 0 }))).files
  }
  const meta = {
    version: 1,
    root,
    workspaceId: id,
    name: manifest?.name ?? '',
    createdAt: Date.now(),
    kind: options.kind ?? 'manual',
    stamp,
    files: ws.files + proj,
  }
  await writeJson(join(dir, 'backup.json'), meta)

  let backupPath = dir
  let zipped = false
  if (tarAvailable()) {
    const zipPath = join(holder, `${stamp}.zip`)
    try {
      await execFileAsync(SYSTEM_TAR, [
        '-a', '-cf', zipPath, '-C', dir, 'workspace', 'project', 'backup.json',
      ], { windowsHide: true, timeout: 10 * 60 * 1000 })
      await writeJson(join(holder, `${stamp}.json`), meta)
      await removeTree(dir).catch(() => undefined)
      backupPath = zipPath
      zipped = true
    } catch {
      // A failed archive must not lose the snapshot: keep the scatter dir.
      backupPath = dir
      zipped = false
    }
  }

  const max = Number(options.maxBackups) > 0 ? Math.min(50, Math.floor(Number(options.maxBackups))) : 5
  // A pre-restore snapshot must not prune: the backup being restored may be
  // the oldest one, and pruning could delete it out from under the restore.
  if (options.prune !== false) {
    let entries
    try { entries = await fsp.readdir(holder, { withFileTypes: true }) } catch { entries = [] }
    const stamps = new Set()
    for (const entry of entries) {
      const name = entry.name
      if (entry.isDirectory()) stamps.add(name)
      else if (name.toLowerCase().endsWith('.zip')) stamps.add(name.slice(0, -4))
      else if (name.toLowerCase().endsWith('.json')) stamps.add(name.slice(0, -5))
    }
    const ordered = [...stamps].sort()
    const keep = new Set(ordered.slice(-max))
    for (const entry of entries) {
      const name = entry.name
      const s = entry.isDirectory() ? name
        : name.toLowerCase().endsWith('.zip') ? name.slice(0, -4)
        : name.toLowerCase().endsWith('.json') ? name.slice(0, -5) : null
      if (s === null || keep.has(s)) continue
      await removeTree(join(holder, name)).catch(() => undefined)
    }
  }
  return { ...meta, dir: backupPath, zip: zipped }
}

/**
 * Restore a backup's files into a target workspace while keeping the target's
 * own identity (id/name/password/rootId) from `targetManifest`.
 * `backupDir` may be a 0.1.4 `.zip` file or a 0.1.3 scatter directory.
 */
export async function applyBackup(backupDir, targetPaths, targetManifest) {
  let source = backupDir
  let tempDir = ''
  if (String(backupDir).toLowerCase().endsWith('.zip')) {
    if (!tarAvailable()) throw new Error('本机缺少 tar，无法解开压缩包备份。')
    tempDir = await fsp.mkdtemp(join(tmpdir(), 'pwp-restore-'))
    await execFileAsync(SYSTEM_TAR, ['-xf', backupDir, '-C', tempDir], {
      windowsHide: true,
      timeout: 10 * 60 * 1000,
    })
    source = tempDir
  }
  try {
    await removeTree(targetPaths.dir)
    await removeTree(targetPaths.projectDir)
    await copyTree(join(source, 'workspace'), targetPaths.dir, {
      skip: (relative) => relative === WORKSPACE_MARKER,
    })
    if (await isDirectory(join(source, 'project'))) {
      await copyTree(join(source, 'project'), targetPaths.projectDir)
    }
    await ensureDir(targetPaths.dir)
    await writeJson(targetPaths.manifestPath, targetManifest)
    return true
  } finally {
    if (tempDir !== '') await removeTree(tempDir).catch(() => undefined)
  }
}
