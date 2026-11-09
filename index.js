/**
 * Portable workspaces for DSH: run a whole DeepSeek Harness working state from
 * a removable (or secondary local) disk.
 *
 * The bundle imports no DSH package. `webServer`, `connection` and `tools` are
 * read off `ctx` through the Cordis service registry, which keeps this package
 * installable from a plain directory and free of version coupling.
 *
 * @module dsh-portable-workspace
 */

import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  DELETE_CONFIRM_PHRASE,
  RESTORE_CONFIRM_PHRASE,
  MAX_BODY_BYTES,
  NS,
  PROFILE_NAME,
  ROUTE_PREFIX,
  TOOL_NAME,
  VENDORED_PLUGIN_DIR,
} from './lib/constants.js'
import { appendLog, ensureDir, exists, isDirectory, readJson, readTextFrom, writeJson } from './lib/fsx.js'
import {
  buildLaunchPlan,
  extractUrl,
  probeUrl,
  recordLaunch,
  resolveInstallation,
  startPortable,
  writeStarterScript,
} from './lib/launcher.js'
import {
  activateBundles,
  checkPlugins,
  dshVersionOf,
  ensurePortableProfile,
  installPlugins,
  installedPackages,
  normalizePluginEntry,
  profileExists,
  runPnpm,
  snapshotPlugins,
} from './lib/profile.js'
import {
  createWorkspace,
  deleteWorkspace,
  ensurePortableRoot,
  hashPassword,
  layoutOf,
  listWorkspaces,
  migrateWorkspace,
  offlineReason,
  readRuntime,
  readWorkspace,
  readLogTail,
  healWorkspaceRegistry,
  updateWorkspace,
  verifyPassword,
  workspacePaths,
  writeLaunchPatch,
  writeRuntime,
  defaultWorkspaceDirOf,
  createBackup,
  listBackupsUnderRoot,
  applyBackup,
  rotatePassword,
} from './lib/workspace.js'
import { findPortableRoots, readMarker, rootIsReachable, rootPathOf } from './lib/volumes.js'
import { checkCompatibilities } from './lib/compatibility.js'
import { clearAccount, describeAccount, importAccount, localHome } from './lib/credentials.js'
import { countSessionLogs, healSessionCwds, healProjcacheCwds, listSessions, transferSessions } from './lib/sessions.js'
import { notFoundHint, resolvePluginSpec } from './lib/names.js'
import {
  isAlive,
  killTree,
  listPortableProcesses,
  processesForPatch,
} from './lib/process.js'

export const name = 'dsh-portable-workspace'
export const inject = ['tools']

/* -------------------------------------------------------------------------- */
/* Upgrade awareness                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The electron-updater desktop shell stages a downloaded installer under
 * `%LOCALAPPDATA%/@deepseek-aidsh-desktop-updater/pending/update-info.json`
 * and only consumes it once it can replace `DeepSeek Harness.exe` / `app.asar`.
 * A detached portable instance keeps those files locked, so a pending update
 * is exactly the situation where the panel should offer "stop all instances".
 *
 * @returns {Promise<boolean>} whether a staged, not-yet-applied update exists.
 */
async function upgradePending() {
  const base = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  return exists(join(base, '@deepseek-aidsh-desktop-updater', 'pending', 'update-info.json'))
}

/* -------------------------------------------------------------------------- */
/* Unlock sessions (in memory only, never persisted)                          */
/* -------------------------------------------------------------------------- */

/**
 * Workspaces unlocked during this Host process, keyed by `<root lower>::<id>`.
 *
 * Nothing is written to disk on purpose: restarting the Host, reloading the
 * bundle, unplugging the drive (a rescan while it is away), changing its drive
 * letter, or pressing "Log out" all drop the session, so the next open asks for
 * the password again. Keying by the root path makes a new drive letter a new
 * key even before any pruning happens.
 */
const unlocked = new Map()

function unlockKey(root, id) {
  return `${String(root).toLowerCase()}::${id}`
}

function markUnlocked(root, id, url = '') {
  unlocked.set(unlockKey(root, id), { token: Date.now(), url })
}

function isUnlocked(root, id) {
  return unlocked.has(unlockKey(root, id))
}

/** Bind an unlock granted before the URL was known to the instance that came up. */
function rebindUnlock(root, id, url) {
  if (url === '') return
  const key = unlockKey(root, id)
  const entry = unlocked.get(key)
  if (entry !== undefined && entry.url === '') unlocked.set(key, { ...entry, url })
}

/**
 * An unlock is granted for one running portable instance. If that instance is
 * gone (drive unplugged and replugged, instance restarted, process exited),
 * drop the unlock so the next open asks for the password again. An unlock with
 * no URL yet (granted just before the first launch) is left alone until the
 * launch records its real URL.
 */
async function expireUnlockIfStale(root, id) {
  const key = unlockKey(root, id)
  const entry = unlocked.get(key)
  if (entry === undefined || entry.url === '') return
  if (await probeUrl(entry.url).catch(() => false)) return
  unlocked.delete(key)
}

function clearUnlocked(root, id) {
  unlocked.delete(unlockKey(root, id))
}

/**
 * Roots that were visible the last time we assembled state. A root that is
 * absent for even one scan loses every unlock it held: unplugging the drive
 * (and replugging it, possibly under a different letter) is a fresh session.
 */
let previouslyLive = new Set()

/**
 * Pids this Host process started. `runtime.json` only remembers the LAST pid
 * and `dshmarket`'s recovery can restart the instance under a new one, so a
 * dispose hook cannot rely on the file alone. This set is in-memory only and
 * is intentionally forgotten when the Host exits: the command-line scan in
 * `lib/process.js` is the authoritative way to find survivors across restarts.
 */
const launchedPids = new Set()

/** Forget unlocks whose volume went away or is no longer readable. */
async function pruneUnlocked(liveRoots) {
  const live = new Set(liveRoots.map((root) => String(root).toLowerCase()))
  for (const root of previouslyLive) {
    if (live.has(root)) continue
    const prefix = `${root}::`
    for (const key of [...unlocked.keys()]) {
      if (key.startsWith(prefix)) unlocked.delete(key)
    }
  }
  for (const root of live) {
    if (await rootIsReachable(root).catch(() => false)) continue
    const prefix = `${root}::`
    for (const key of [...unlocked.keys()]) {
      if (key.startsWith(prefix)) unlocked.delete(key)
    }
  }
  previouslyLive = live
}

/**
 * Stop every portable instance belonging to one workspace.
 *
 * `runtime.json` holds only the last recorded pid. A `dshmarket` recovery
 * restart (or two overlapping launches) leaves extra instances running that
 * the old single-pid kill could never reach, and every one of them keeps
 * `DeepSeek Harness.exe` / `app.asar` locked against an in-place upgrade.
 * Match by `--patch <this workspace's patch path>` instead and tree-kill each
 * one so its helper children die too.
 *
 * @param {object} paths - `workspacePaths()` result.
 * @returns {Promise<number>} how many pids a termination was delivered to.
 */
async function stopWorkspaceInstances(paths) {
  const pids = new Set()
  const runtime = await readRuntime(paths).catch(() => undefined)
  if (typeof runtime?.pid === 'number' && runtime.pid > 0 && isAlive(runtime.pid)) pids.add(runtime.pid)
  const procs = await listPortableProcesses()
  for (const proc of processesForPatch(procs, paths.patchPath)) pids.add(proc.pid)
  for (const pid of pids) {
    launchedPids.delete(pid)
    await killTree(pid)
  }
  return pids.size
}

/** Stop a running portable instance so the next open has to start a fresh one. */
async function stopRunningInstance(paths) {
  const killed = await stopWorkspaceInstances(paths)
  await writeRuntime(paths, { url: '', pid: null, lastUrlSeenAt: 0, startedAt: Date.now() }).catch(() => undefined)
  return killed > 0
}

/**
 * Stop EVERY portable CLI instance on this machine, whatever volume it came
 * from, and clear every workspace's recorded runtime state.
 *
 * This is the pre-upgrade escape hatch: it releases the file locks held by
 * detached instances even when their drive has been unplugged (so their
 * `runtime.json` is no longer readable) or the pid was never recorded.
 */
async function stopAllInstances(settings) {
  const procs = await listPortableProcesses()
  const pids = new Set(procs.map((proc) => proc.pid))
  const collected = await readRuntimeAll(settings)
  for (const entry of collected.pidList) {
    if (typeof entry.pid === 'number' && entry.pid > 0 && isAlive(entry.pid)) pids.add(entry.pid)
  }
  for (const pid of pids) {
    launchedPids.delete(pid)
    await killTree(pid)
  }
  // Clear the launch state so the panel stops reporting "running" and the next
  // open starts cleanly. Non-fatal when a volume is offline.
  for (const paths of collected.pathsList) {
    await writeRuntime(paths, { url: '', pid: null, lastUrlSeenAt: 0, startedAt: Date.now() }).catch(() => undefined)
  }
  return pids.size
}

/** Collect runtime records + path handles across every reachable root. */
async function readRuntimeAll(settings) {
  const pathsList = []
  const pidList = []
  try {
    const remembered = await readIndex()
    const extraPaths = [...new Set([...settings.roots, ...remembered.map((entry) => entry.root)])]
    const found = await findPortableRoots(extraPaths)
    for (const entry of found) {
      for (const item of await listWorkspaces(entry.root).catch(() => [])) {
        pathsList.push(item.paths)
        const r = await readRuntime(item.paths).catch(() => undefined)
        if (r !== undefined) pidList.push(r)
      }
    }
  } catch {
    // Enumeration is best-effort; the command-line scan above still works.
  }
  return { pidList, pathsList }
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Read the plugin config, tolerating Loader defaults we do not own.
 *
 * @param config - Raw plugin config.
 * @returns `{ installationRoot, roots }`.
 */
function resolveSettings(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  return {
    installationRoot: typeof raw.installationRoot === 'string' ? raw.installationRoot : '',
    roots: Array.isArray(raw.roots) ? raw.roots.filter((entry) => typeof entry === 'string') : [],
  }
}

/** Local (non-workspace) cache directory: only paths, never workspace content. */
function stateDir() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, 'portable-workspace')
}

/** Path of the remembered-root index. */
function indexFile() {
  return join(stateDir(), 'roots.json')
}

/** Known portable roots remembered from earlier sessions. */
async function readIndex() {
  const value = await readJson(indexFile()).catch(() => undefined)
  if (value == null || typeof value !== 'object') return []
  const roots = Array.isArray(value.roots) ? value.roots : []
  return roots.filter((entry) => entry != null && typeof entry.root === 'string')
}

/** Persist the reached roots so an unplugged volume can still be listed. */
async function rememberRoots(entries) {
  const seen = new Map()
  for (const entry of await readIndex()) seen.set(entry.root.toLowerCase(), entry)
  for (const entry of entries) {
    seen.set(entry.root.toLowerCase(), {
      root: entry.root,
      drive: entry.drive ?? '',
      rootId: entry.marker?.rootId ?? '',
      lastSeenAt: Date.now(),
    })
  }
  await writeJson(indexFile(), { version: 1, roots: [...seen.values()] })
}

/**
 * Forget every remembered root. The pre-upgrade "stop all" sweep calls this so
 * the plugin leaves no on-disk trace on this PC while DSH replaces its own
 * executables; a later "重新扫描" repopulates the index from the marker files
 * on the volumes. paths only — no workspace content is ever stored here.
 */
async function clearIndex() {
  await writeJson(indexFile(), { version: 1, roots: [] })
}

/* -------------------------------------------------------------------------- */
/* State assembly                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Everything the panel needs: volumes, their workspaces, and remembered roots
 * that are currently unreachable.
 *
 * @param settings - Resolved plugin settings.
 * @returns the state payload.
 */
async function collectState(ctx, settings) {
  const remembered = await readIndex()
  // A root moved to a non-drive-letter location (another disk, a subfolder, a
  // network share) cannot be found by the letter probe. The remembered paths
  // are the bridge: the marker file on the volume still identifies the root,
  // so a migrated workspace keeps being recognised after a re-scan.
  const extraPaths = [...new Set([...settings.roots, ...remembered.map((entry) => entry.root)])]
  const found = await findPortableRoots(extraPaths)
  const installation = await resolveInstallation(settings.installationRoot).catch(() => undefined)
  const dshVersion = installation === undefined ? undefined : await dshVersionOf(installation).catch(() => undefined)

  if (found.length > 0) await rememberRoots(found).catch(() => undefined)
  // A drive that disappeared for one scan (unplugged, then replugged under a
  // new letter) must re-ask for the password on the next open.
  await pruneUnlocked(found.map((entry) => entry.root))

  const live = []
  for (const entry of found) {
    const layout = layoutOf(entry.root)
    const workspaces = await listWorkspaces(entry.root).catch(() => [])
    const profileReady = await profileExists(layout.profileDir).catch(() => false)
    const items = []
    for (const item of workspaces) {
      const runtime = await readRuntime(item.paths).catch(() => undefined)
      const reachable = await rootIsReachable(entry.root).catch(() => false)
      const reason = await offlineReason(entry.root).catch(() => '无法访问')
      // If the instance this unlock was granted for has gone away, the unlock
      // goes with it. This covers unplug/replug and an external instance exit
      // even when the drive letter never changed.
      await expireUnlockIfStale(entry.root, item.manifest.id)
      const running = runtime?.url !== undefined ? await probeUrl(runtime.url).catch(() => false) : false
      if (running) rebindUnlock(entry.root, item.manifest.id, runtime.url)
      items.push({
        id: item.manifest.id,
        name: item.manifest.name,
        createdAt: item.manifest.createdAt,
        updatedAt: item.manifest.updatedAt,
        lastOpenedAt: item.manifest.lastOpenedAt ?? 0,
        notes: item.manifest.notes ?? '',
        passwordProtected: item.manifest.password != null,
        passwordHint: item.manifest.passwordHint ?? '',
        hasRecovery: item.manifest.recovery != null,
        plugins: item.manifest.plugins ?? [],
        origin: item.manifest.origin,
        reachable,
        offlineReason: reachable ? '' : reason,
        running,
        url: running ? runtime.url : '',
        pid: running ? runtime.pid ?? null : null,
        projectDir: item.paths.projectDir,
        dir: item.paths.dir,
        sessionCount: countSessionLogs(item.paths.sessionsDir),
        key: `${entry.root}::${item.manifest.id}`,
        unlocked: isUnlocked(entry.root, item.manifest.id),
      })
    }
    live.push({
      root: entry.root,
      drive: entry.drive ?? '',
      external: entry.external === true,
      rootId: entry.marker?.rootId ?? '',
      space: entry.space ?? undefined,
      profileReady,
      reachable: await rootIsReachable(entry.root).catch(() => false),
      account: await describeAccount(layout.homeDir).catch(() => undefined),
      workspaces: items,
    })
  }

  const known = new Map(live.map((entry) => [entry.root.toLowerCase(), entry]))
  const offline = []
  for (const entry of remembered) {
    if (known.has(entry.root.toLowerCase())) continue
    offline.push({
      root: entry.root,
      drive: entry.drive ?? '',
      lastSeenAt: entry.lastSeenAt ?? 0,
      reason: '移动盘未连接',
    })
  }

  const profileDependencies = installation === undefined
    ? {}
    : (await installedPackages({ profileDir: layoutOf(found[0]?.root ?? '').profileDir, installation })
      .catch(() => ({ sources: {} }))).sources ?? {}

  // Command-line scan is the only source of truth that survives a Host restart
  // and catches instances whose pid was never written to runtime.json.
  const leftovers = await listPortableProcesses()
  const pendingUpgrade = await upgradePending()

  return {
    ok: true,
    profile: PROFILE_NAME,
    dshVersion: dshVersion ?? '',
    leftoverCount: leftovers.length,
    upgradePending: pendingUpgrade,
    installation: installation === undefined
      ? undefined
      : {
        resources: installation.resources,
        hasNode: installation.node !== undefined,
        asar: installation.asar,
      },
    volumes: live,
    offline,
    localHome: localHome(),
    knownPackageCount: Object.keys(profileDependencies).length,
    routePrefix: ROUTE_PREFIX,
  }
}

/* -------------------------------------------------------------------------- */
/* Opening a workspace                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Verify the password, scaffold the profile, and check the plugin inventory.
 *
 * This is the gate that every open goes through, so a volume moved to another
 * computer never starts work with a half-installed plugin set.
 *
 * @returns `{ ok, stage, ... }` describing what still needs the user's decision.
 */
async function prepareOpen(ctx, settings, { root, id, password }) {
  const found = await readWorkspace(root, id)
  if (found === undefined) {
    const error = new Error(`找不到工作区：${id}`)
    error.code = 'not-found'
    throw error
  }
  const { manifest, paths } = found
  const layout = layoutOf(root)
  const passwordProtected = manifest.password != null
  // Re-validate the unlock right before opening: if the instance it was
  // granted for has gone away (drive pulled, process exited, replug), the
  // password must be asked again even when the panel was never refreshed.
  await expireUnlockIfStale(root, id)
  const result = {
    ok: true,
    id,
    name: manifest.name,
    root,
    passwordProtected,
    unlocked: isUnlocked(root, id),
    profileReady: false,
    plugins: [],
    missing: [],
    optionalMissing: [],
    conflicts: [],
    installation: undefined,
    alreadyRunning: false,
    url: '',
  }

  // A workspace already unlocked in this Host session does not ask again:
  // replaying an empty password after an install or a re-open must not lock
  // the user out. "Log out", a restart, or unplugging the drive clears it.
  if (passwordProtected && !result.unlocked && !verifyPassword(manifest.password, String(password ?? ''))) {
    return { ...result, ok: false, stage: 'password', message: '工作区密码不正确。' }
  }

  const installation = await resolveInstallation(settings.installationRoot).catch(() => undefined)
  if (installation === undefined) {
    return {
      ...result,
      ok: false,
      stage: 'installation',
      message: '没有找到本机的 DeepSeek Harness 安装目录，无法启动便携实例。',
    }
  }
  result.installation = { resources: installation.resources, asar: installation.asar }

  const profile = await ensurePortableProfile(layout)
  result.profileReady = true
  result.profileCreated = profile.created

  const declared = manifest.plugins ?? []
  const check = await checkPlugins(declared, {
    profileDir: layout.profileDir,
    installation,
  })
  result.plugins = check.items
  result.missing = check.missing.map((item) => ({ name: item.name, version: item.version, spec: item.spec }))
  result.optionalMissing = check.optionalMissing.map((item) => ({ name: item.name, version: item.version, spec: item.spec }))

  // Compatibility pre-flight: a workspace moved to another computer may run a
  // different DSH version. Report installed plugins whose engines.dsh or
  // @deepseek-ai peerDependencies cannot be met here, together with a remedy.
  // This is advisory: it never blocks an install or a launch (the loader is
  // the final authority), but it gives the user something actionable.
  const dshVersion = await dshVersionOf(installation).catch(() => undefined)
  const compat = await checkCompatibilities(declared, {
    profileDir: layout.profileDir,
    installation,
    dshVersion,
  }).catch(() => [])
  result.conflicts = compat
    .filter((item) => item.status === 'incompatible')
    .map((item) => ({ name: item.name, reasons: item.reasons, advice: item.advice, optional: declared.find((d) => d.name === item.name)?.optional === true }))

  const runtime = await readRuntime(paths).catch(() => undefined)
  if (runtime?.url !== undefined && (await probeUrl(runtime.url).catch(() => false))) {
    result.alreadyRunning = true
    result.url = runtime.url
  }

  // Surface the dialog for optional-only gaps and compatibility conflicts too,
  // so the user can choose to install / skip, or read the remedy for a plugin
  // that cannot work with this DSH version. Gaps are enforced again in
  // launchWorkspace; conflicts stay advisory and never block the launch.
  result.stage = result.missing.length > 0 || result.optionalMissing.length > 0 || result.conflicts.length > 0 ? 'plugins' : 'ready'
  return result
}

/**
 * Launch the portable instance of one workspace and wait for its URL.
 *
 * `skipMissingPlugins` is set by the plugin dialog's "open anyway" button:
 * the user has seen the gap and explicitly chose to continue without it.
 *
 * @returns `{ ok, url, pid, logPath, starter }`.
 */
async function launchWorkspace(ctx, settings, { root, id, password, host, skipMissingPlugins }) {
  const prepared = await prepareOpen(ctx, settings, { root, id, password })
  if (prepared.ok !== true) return prepared
  if (prepared.alreadyRunning === true) {
    // Password was accepted (or the workspace is already unlocked in this
    // session): record the unlock against the live instance URL.
    markUnlocked(root, id, prepared.url)
    return { ...prepared, stage: 'running', message: '这个工作区已经在运行。' }
  }
  // Surface the dialog for any gap (required / optional) or compatibility
  // conflict unless the user explicitly chose "open anyway". Required gaps are
  // still called out in the message; conflicts are advisory only.
  const gap = prepared.missing.length > 0 || prepared.optionalMissing.length > 0 || (prepared.conflicts ?? []).length > 0
  if (gap && skipMissingPlugins !== true) {
    return {
      ...prepared,
      ok: false,
      stage: 'plugins',
      message: prepared.missing.length > 0
        ? '还缺少必需的插件，请先安装。'
        : (prepared.conflicts ?? []).length > 0 ? '有插件与本机 DSH 版本不兼容，请查看处理方案。' : '有可选插件未安装。',
    }
  }

  const found = await readWorkspace(root, id)
  const { manifest, paths } = found
  const installation = await resolveInstallation(settings.installationRoot)
  // Older workspaces recorded the local Documents path as their only
  // Workspace; every session then inherited that `cwd`. Repair it before the
  // instance reads the registry.
  const healed = await healWorkspaceRegistry(paths).catch(() => 0)
  // Session logs carry their own `cwd` in the header and the JSONL backend
  // derives the log's folder from it, so a log left on an older path becomes
  // unreadable after a move. Re-point them alongside the registry.
  const sessions = await healSessionCwds(paths).catch(() => ({ rewritten: 0 }))
  await writeLaunchPatch(paths)
  await writeStarterScript(paths, manifest).catch(() => undefined)

  const plan = buildLaunchPlan({
    paths,
    installation,
    patchPath: paths.patchPath,
    port: 0,
    host,
  })
  await ensureDir(paths.logsDir)
  await ensureDir(paths.projectDir)
  // Reap survivors of this workspace before starting a new one. A recovery
  // restart (or a previous launch that never recorded its pid) can leave an
  // instance alive with a different URL; `prepareOpen` then misses it and we
  // would otherwise stack a second instance that also locks the executable.
  // Reaping here guarantees at most one instance per patch path.
  await stopWorkspaceInstances(paths).catch(() => 0)
  const started = await startPortable(plan, paths)
  if (typeof started.pid === 'number' && started.pid > 0) launchedPids.add(started.pid)
  const url = await waitForUrlQuick(started.logPath, started.offset)
  const runtime = {
    url: url ?? '',
    pid: started.pid ?? null,
    logPath: started.logPath,
    lastUrlSeenAt: url === undefined ? 0 : Date.now(),
  }
  await recordLaunch(paths, manifest, runtime)
  const saved = await updateWorkspace(root, id, {}).catch(() => undefined)
  void saved
  // A successful launch (or an accepted password for a running instance)
  // unlocks this workspace for the lifetime of that instance in this Host.
  markUnlocked(root, id, url ?? runtime.url)
  if (url === undefined) {
    return {
      ...prepared,
      ok: true,
      stage: 'launching',
      pid: started.pid ?? null,
      logPath: started.logPath,
      message: '便携实例已启动，还在等待它就绪。',
    }
  }
  return {
    ...prepared,
    ok: true,
    stage: 'launched',
    url,
    pid: started.pid ?? null,
    logPath: started.logPath,
    starter: join(paths.launchDir, 'start-portable.cmd'),
    healedWorkspaces: healed,
    healedSessions: sessions.rewritten,
  }
}

/** Wait up to ~20s for a URL; the full wait happens in a later poll. */
async function waitForUrlQuick(logPath, offset = 0) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    // Byte-safe tail read (see readTextFrom). `offset` is a byte offset; an
    // early poll must NOT fall back to the whole log, or extractUrl returns
    // the previous launch's now-dead URL. Also confirm the port is listening
    // before writing the URL into runtime.json / opening the browser.
    const fresh = await readTextFrom(logPath, offset).catch(() => undefined)
    if (fresh !== undefined && fresh !== '') {
      const url = extractUrl(fresh)
      if (url !== undefined && (await probeUrl(url).catch(() => false))) return url
    }
    await new Promise((resolve) => setTimeout(resolve, 350))
  }
  return undefined
}

/* -------------------------------------------------------------------------- */
/* HTTP surface                                                               */
/* -------------------------------------------------------------------------- */

/** Read a request body as a Buffer, refusing oversized payloads. */
async function readRequestBody(req, cap) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > cap) {
      const error = new Error('请求体过大')
      error.code = 'too-large'
      throw error
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** Serialize a payload as JSON. */
function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('content-length', String(body.length))
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

/** HTTP status of a thrown error. */
function statusOf(error) {
  switch (error?.code) {
    case 'unavailable': return 503
    case 'not-found':
    case 'file-missing': return 404
    case 'too-large': return 413
    case 'password': return 401
    case 'duplicate-name':
    case 'invalid-target':
    case 'target-busy':
    case 'invalid-body':
    case 'missing-field': return 400
    case 'internal': return 500
    default: return 400
  }
}

/** Stable machine code of a thrown error. */
function codeOf(error) {
  return typeof error?.code === 'string' && error.code !== '' ? error.code : 'internal'
}

/** One-line message of a thrown error. */
function errorText(error) {
  return String(error?.message ?? error).split('\n')[0]
}

/** Throw a 401 for a wrong password / missing confirmation on a destructive op. */
function failPassword(message) {
  const error = new Error(message)
  error.code = 'password'
  throw error
}

/**
 * Guard a destructive action. A workspace with a password needs either the
 * correct password or an unlock granted in this Host session; a workspace
 * without one always passes (the user may leave the field blank).
 */
function guardPassword(manifest, password, root, id) {
  if (manifest.password == null) return
  if (isUnlocked(root, id)) return
  if (verifyPassword(manifest.password, String(password ?? ''))) return
  failPassword('工作区密码不正确。')
}

/**
 * Fresh password check for a session container. Unlike guardPassword this
 * never trusts an in-memory unlock: listing/migrating sessions exposes their
 * titles, so a locked portable source must be verified every single time.
 */
async function guardContainer(container, password, label = '') {
  if (container.kind !== 'portable') return
  const root = container.paths.root
  const id = container.paths.id
  const found = await readWorkspace(root, id)
  if (found === undefined || found.manifest.password == null) return
  if (!verifyPassword(found.manifest.password, String(password ?? ''))) {
    failPassword(`${label}工作区密码不正确。`)
  }
}

/** Parse a JSON body into an object. */
async function readJsonBody(req) {
  const buffer = await readRequestBody(req, MAX_BODY_BYTES)
  if (buffer.length === 0) return {}
  try {
    const value = JSON.parse(buffer.toString('utf8'))
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
      const error = new Error('请求体必须是 JSON 对象')
      error.code = 'invalid-body'
      throw error
    }
    return value
  } catch (error) {
    if (error?.code === 'invalid-body') throw error
    const wrapped = new Error('请求体不是合法 JSON')
    wrapped.code = 'invalid-body'
    throw wrapped
  }
}

/** Require a non-empty string field. */
function requireField(body, field) {
  const value = body?.[field]
  if (typeof value !== 'string' || value.trim() === '') {
    const error = new Error(`缺少字段：${field}`)
    error.code = 'missing-field'
    throw error
  }
  return value.trim()
}

/** Optional string field. */
function optionalField(body, field) {
  const value = body?.[field]
  return typeof value === 'string' ? value : undefined
}

/**
 * Route one request.
 *
 * @returns `{ handled: false }` when the path is not ours.
 */
async function dispatch(ctx, settings, connection, req, res) {
  const rejection = typeof connection?.requestRejection === 'function'
    ? connection.requestRejection(req)
    : undefined
  if (rejection !== undefined) {
    res.statusCode = rejection
    res.end()
    return { handled: true }
  }

  const url = new URL(String(req.url ?? '/'), 'http://localhost')
  const path = url.pathname
  if (!path.startsWith(ROUTE_PREFIX)) return { handled: false }
  const route = path.slice(ROUTE_PREFIX.length).replace(/\/+$/, '') || '/'
  const method = String(req.method ?? 'GET').toUpperCase()

  if (method === 'GET' && route === '/state') {
    sendJson(res, 200, await collectState(ctx, settings))
    return { handled: true }
  }

  if (method === 'GET' && route === '/log') {
    const root = url.searchParams.get('root') ?? ''
    const id = url.searchParams.get('id') ?? ''
    const paths = workspacePaths(root, id)
    const text = await readLogTail(paths, 80).catch(() => undefined)
    sendJson(res, 200, { ok: true, log: text ?? '' })
    return { handled: true }
  }

  if (method !== 'POST') {
    sendJson(res, 404, { ok: false, code: 'not-found', message: `没有这个接口：${method} ${route}` })
    return { handled: true }
  }

  const body = await readJsonBody(req)

  switch (route) {
    case '/scan': {
      sendJson(res, 200, await collectState(ctx, settings))
      return { handled: true }
    }

    case '/stop-all': {
      // Release every lock held by a detached portable instance. This is the
      // pre-upgrade escape hatch: it works even for volumes already unplugged
      // and for recovery-restarted instances whose pid was never recorded.
      const killed = await stopAllInstances(settings)
      // Stopping the instances invalidates all in-memory unlocks.
      for (const key of [...unlocked.keys()]) unlocked.delete(key)
      // Leave no on-disk trace of the plugin on this PC while DSH replaces its
      // own executables. The roots index only holds paths; "重新扫描" rebuilds
      // it from the marker files on the volumes after the upgrade.
      const rootsCleared = await clearIndex().then(() => true).catch(() => false)
      sendJson(res, 200, { ok: true, killed, rootsCleared })
      return { handled: true }
    }

    case '/root/init': {
      const root = requireField(body, 'root')
      const result = await ensurePortableRoot(root)
      await rememberRoots([{ root, drive: '', marker: result.marker }]).catch(() => undefined)
      sendJson(res, 200, {
        ok: true,
        root,
        created: result.created,
        rootId: result.marker.rootId,
        layout: {
          workspacesDir: result.layout.workspacesDir,
          projectsDir: result.layout.projectsDir,
          supportDir: result.layout.supportDir,
          homeDir: result.layout.homeDir,
        },
      })
      return { handled: true }
    }

    case '/create': {
      const root = requireField(body, 'root')
      await ensurePortableRoot(root)
      const plugins = Array.isArray(body.plugins)
        ? body.plugins.map(normalizePluginEntry).filter(Boolean)
        : []
      const created = await createWorkspace(root, {
        name: optionalField(body, 'name'),
        password: optionalField(body, 'password') ?? '',
        hint: optionalField(body, 'hint') ?? '',
        plugins,
        notes: optionalField(body, 'notes') ?? '',
      })
      const layout = layoutOf(root)
      await ensurePortableProfile(layout).catch(() => undefined)
      sendJson(res, 200, {
        ok: true,
        id: created.manifest.id,
        name: created.manifest.name,
        passwordProtected: created.passwordProtected,
        dir: created.paths.dir,
        projectDir: created.paths.projectDir,
        recoveryCode: created.recoveryCode,
        passwordHint: created.manifest.passwordHint,
      })
      return { handled: true }
    }

    case '/prepare': {
      const root = requireField(body, 'root')
      const id = requireField(body, 'id')
      sendJson(res, 200, await prepareOpen(ctx, settings, { root, id, password: optionalField(body, 'password') ?? '' }))
      return { handled: true }
    }

    case '/open': {
      const root = requireField(body, 'root')
      const id = requireField(body, 'id')
      const launched = await launchWorkspace(ctx, settings, {
        root,
        id,
        password: optionalField(body, 'password') ?? '',
        host: optionalField(body, 'host'),
        skipMissingPlugins: body.skipMissingPlugins === true,
      })
      if (launched && (launched.stage === 'launched' || launched.stage === 'launching' || launched.stage === 'running')) void maybeAutoBackup(root, id).catch(() => undefined)
      sendJson(res, 200, launched)
      return { handled: true }
    }

    case '/install': {
      const root = requireField(body, 'root')
      const id = requireField(body, 'id')
      const found = await readWorkspace(root, id)
      if (found === undefined) {
        const error = new Error(`找不到工作区：${id}`)
        error.code = 'not-found'
        throw error
      }
      guardPassword(found.manifest, body.password, root, id)
      const layout = layoutOf(root)
      const installation = await resolveInstallation(settings.installationRoot)
      if (installation === undefined) {
        const error = new Error('没有找到本机的 DeepSeek Harness 安装目录。')
        error.code = 'unavailable'
        throw error
      }
      await ensurePortableProfile(layout)
      const declared = found.manifest.plugins ?? []
      const dshVersion = await dshVersionOf(installation).catch(() => undefined)
      const compat = await checkCompatibilities(declared, {
        profileDir: layout.profileDir,
        installation,
        dshVersion,
      }).catch(() => [])
      const conflicts = compat
        .filter((item) => item.status === 'incompatible')
        .map((item) => ({ name: item.name, reasons: item.reasons, advice: item.advice, optional: declared.find((d) => d.name === item.name)?.optional === true }))
      const result = await installPlugins(declared, {
        profileDir: layout.profileDir,
        installation,
        includeOptional: body.includeOptional === true,
        logPath: join(found.paths.logsDir, 'plugins.log'),
      })
      appendLog(
        join(found.paths.logsDir, 'plugins.log'),
        `install code=${result.code} installed=${result.installed.join(',') || '-'} activated=${(result.activated ?? []).join(',') || '-'} failed=${result.failed.join(',') || '-'}`,
      ).catch(() => undefined)
      sendJson(res, 200, {
        ok: result.code === 0,
        code: result.code,
        installed: result.installed,
        activated: result.activated ?? [],
        skipped: result.skipped,
        failed: result.failed,
        conflicts,
        output: result.output.slice(-4000),
      })
      return { handled: true }
    }

    case '/plugins/add': {
      const root = requireField(body, 'root')
      const id = requireField(body, 'id')
      const spec = requireField(body, 'spec')
      const found = await readWorkspace(root, id)
      if (found === undefined) {
        const error = new Error(`找不到工作区：${id}`)
        error.code = 'not-found'
        throw error
      }
      guardPassword(found.manifest, body.password, root, id)
      const installation = await resolveInstallation(settings.installationRoot)
      if (installation === undefined) {
        const error = new Error('没有找到本机的 DeepSeek Harness 安装目录。')
        error.code = 'unavailable'
        throw error
      }
      const layout = layoutOf(root)
      await ensurePortableProfile(layout)
      // The market shows short display names (`dsh-web-all`, `modlens`) but npm
      // only knows scoped names (`@linxin666/dsh-web-all`, `@liustack/modlens`).
      // Resolve first, and when the newest release needs a newer DSH than this
      // host, pin the newest compatible release instead of letting the market
      // hide the plugin entirely.
      const resolved = await resolvePluginSpec(spec, {
        portableHome: layout.homeDir,
        localHome: localHome(),
        profileDir: layout.profileDir,
        dshVersion: await dshVersionOf(installation).catch(() => undefined),
      })
      const hints = [...resolved.hints]
      const result = await runPnpm(installation, layout.profileDir, ['add', resolved.spec], {
        logPath: join(found.paths.logsDir, 'plugins.log'),
      })
      const notFound = /404|not found/i.test(result.output)
      if (notFound) hints.push(notFoundHint(result.output))
      let name = ''
      let activated = []
      if (result.code === 0) {
        const declared = Array.isArray(found.manifest.plugins) ? [...found.manifest.plugins] : []
        name = resolved.name
        if (!declared.some((entry) => entry.name === name)) {
          declared.push({ name, version: '', optional: body.optional === true })
          await updateWorkspace(root, id, { plugins: declared }).catch(() => undefined)
        }
        // pnpm add only writes dependencies; the loader activates a plugin via
        // dsh.profile.bundles. Without this the plugin is installed but never
        // mounted (the exact failure behind "market not visible").
        activated = await activateBundles(layout.profileDir, [name]).catch(() => [])
      }
      sendJson(res, 200, {
        ok: result.code === 0,
        code: result.code,
        name,
        spec: resolved.spec,
        original: resolved.original,
        activated,
        hints,
        output: (result.output + (hints.length > 0 ? `\n${hints.join('\n')}` : '')).slice(-4000),
      })
      return { handled: true }
    }

    case '/plugins/declared': {
      const root = requireField(body, 'root')
      const id = requireField(body, 'id')
      const found = await readWorkspace(root, id)
      if (found === undefined) {
        const error = new Error(`找不到工作区：${id}`)
        error.code = 'not-found'
        throw error
      }
      const plugins = found.manifest.plugins ?? []
      const layout = layoutOf(root)
      const installation = await resolveInstallation(settings.installationRoot).catch(() => undefined)
      const check = await checkPlugins(plugins, { profileDir: layout.profileDir, installation })
      sendJson(res, 200, { ok: true, declared: plugins, items: check.items })
      return { handled: true }
    }

    case '/update': {
      const root = requireField(body, 'root')
      const id = requireField(body, 'id')
      const found = await readWorkspace(root, id)
      if (found === undefined) {
        const error = new Error(`找不到工作区：${id}`)
        error.code = 'not-found'
        throw error
      }
      guardPassword(found.manifest, body.password, root, id)
      const patch = {}
      if (typeof body.name === 'string') patch.name = body.name
      // `newPassword` (not `password`) changes the lock: `password` is the
      // verification field shared by every guarded route since 0.1.4.
      if (body.newPassword === '' || body.newPassword === null) patch.password = null
      else if (typeof body.newPassword === 'string') patch.password = body.newPassword
      if (typeof body.passwordHint === 'string') patch.passwordHint = body.passwordHint
      if (typeof body.notes === 'string') patch.notes = body.notes
      if (Array.isArray(body.plugins)) patch.plugins = body.plugins.map(normalizePluginEntry).filter(Boolean)
      const updated = await updateWorkspace(root, id, patch)
      sendJson(res, 200, {
        ok: true,
        id,
        name: updated.manifest.name,
        passwordProtected: updated.manifest.password != null,
        plugins: updated.manifest.plugins,
        notes: updated.manifest.notes,
      })
      return { handled: true }
    }

    case '/delete': {
      const root = requireField(body, 'root')
      const id = requireField(body, 'id')
      // Destructive actions must be typed out and password-gated. Checking on
      // the Host side also protects direct route calls that bypass the dialog.
      if (String(body.confirmPhrase ?? '') !== DELETE_CONFIRM_PHRASE) {
        failPassword('请输入确认文字后再删除。')
      }
      const found = await readWorkspace(root, id)
      if (found === undefined) {
        const error = new Error(`找不到工作区：${id}`)
        error.code = 'not-found'
        throw error
      }
      guardPassword(found.manifest, body.password, root, id)
      await stopRunningInstance(found.paths).catch(() => false)
      await deleteWorkspace(root, id, { keepProjects: body.keepProjects === true })
      clearUnlocked(root, id)
      sendJson(res, 200, { ok: true, id })
      return { handled: true }
    }

    case '/logout': {
      const root = requireField(body, 'root')
      const id = requireField(body, 'id')
      const found = await readWorkspace(root, id)
      const paths = found === undefined ? workspacePaths(root, id) : found.paths
      // Log out ends the portable instance and forgets the unlock, so the next
      // open asks for the password again (for password-protected workspaces).
      await stopRunningInstance(paths).catch(() => false)
      clearUnlocked(root, id)
      sendJson(res, 200, { ok: true, id })
      return { handled: true }
    }

    case '/password/change': {
      const root = requireField(body, 'root')
      const id = requireField(body, 'id')
      const found = await readWorkspace(root, id)
      if (found === undefined) {
        const error = new Error(`找不到工作区：${id}`)
        error.code = 'not-found'
        throw error
      }
      // Changing the password always requires the current one (or an unlock
      // from this session); a passwordless workspace may set its first one.
      guardPassword(found.manifest, body.oldPassword, root, id)
      const newPassword = typeof body.newPassword === 'string' ? body.newPassword : ''
      const confirmPassword = typeof body.confirmPassword === 'string' ? body.confirmPassword : ''
      if (newPassword !== confirmPassword) {
        failPassword('两次输入的新密码不一致。')
      }
      const rotated = await rotatePassword(root, id, {
        newPassword,
        hint: typeof body.hint === 'string' ? body.hint : found.manifest.passwordHint,
      })
      // Invalidate the old unlock: the credential it stood for has changed.
      clearUnlocked(root, id)
      sendJson(res, 200, {
        ok: true,
        id,
        passwordProtected: rotated.manifest.password != null,
        recoveryCode: rotated.recoveryCode,
        passwordHint: rotated.manifest.passwordHint,
      })
      return { handled: true }
    }

    case '/password/verify': {
      // Gate for privacy-sensitive pages (e.g. the session migration list).
      // Always checks the password itself, never an in-memory unlock.
      const root = requireField(body, 'root')
      const id = requireField(body, 'id')
      const found = await readWorkspace(root, id)
      if (found === undefined) {
        const error = new Error(`找不到工作区：${id}`)
        error.code = 'not-found'
        throw error
      }
      if (found.manifest.password != null && !verifyPassword(found.manifest.password, String(body.password ?? ''))) {
        failPassword('工作区密码不正确。')
      }
      sendJson(res, 200, { ok: true })
      return { handled: true }
    }

    case '/password/recover': {
      // Reset a forgotten lock with the one-time recovery code. The code is
      // stored only as an scrypt hash, and a fresh one is minted on success.
      const root = requireField(body, 'root')
      const id = requireField(body, 'id')
      const found = await readWorkspace(root, id)
      if (found === undefined) {
        const error = new Error(`找不到工作区：${id}`)
        error.code = 'not-found'
        throw error
      }
      if (found.manifest.recovery == null) {
        failPassword('该工作区没有设置恢复密钥。')
      }
      if (!verifyPassword(found.manifest.recovery, String(body.recoveryCode ?? ''))) {
        failPassword('恢复密钥不正确。')
      }
      const newPassword = typeof body.newPassword === 'string' ? body.newPassword : ''
      const confirmPassword = typeof body.confirmPassword === 'string' ? body.confirmPassword : ''
      if (newPassword !== confirmPassword) {
        failPassword('两次输入的新密码不一致。')
      }
      const rotated = await rotatePassword(root, id, {
        newPassword,
        hint: typeof body.hint === 'string' ? body.hint : found.manifest.passwordHint,
      })
      clearUnlocked(root, id)
      sendJson(res, 200, {
        ok: true,
        id,
        passwordProtected: rotated.manifest.password != null,
        recoveryCode: rotated.recoveryCode,
        passwordHint: rotated.manifest.passwordHint,
      })
      return { handled: true }
    }

    case '/account/logout': {
      const root = requireField(body, 'root')
      const layout = layoutOf(root)
      const result = await clearAccount(layout.homeDir)
      // Every workspace on this volume must re-verify next time.
      const prefix = `${String(root).toLowerCase()}::`
      for (const key of [...unlocked.keys()]) {
        if (key.startsWith(prefix)) unlocked.delete(key)
      }
      sendJson(res, 200, { ok: true, ...result })
      return { handled: true }
    }

    case '/migrate': {
      const root = requireField(body, 'root')
      const id = requireField(body, 'id')
      const toRoot = requireField(body, 'toRoot')
      const found = await readWorkspace(root, id)
      if (found !== undefined) {
        // Moving a protected workspace is destructive: require its password (or
        // a prior unlock in this Host session), exactly like deleting it.
        guardPassword(found.manifest, body.password, root, id)
      }
      // Plugins are not copied across volumes; snapshot the source profile's
      // dependencies so the destination offers to reinstall them on next open.
      const snapshot = await snapshotPlugins(layoutOf(root).profileDir).catch(() => [])
      const result = await migrateWorkspace(root, id, toRoot, { move: body.move === true, plugins: snapshot })
      await rememberRoots([{ root: toRoot, drive: '', marker: { rootId: result.manifest.rootId } }]).catch(() => undefined)
      sendJson(res, 200, {
        ok: true,
        id: result.manifest.id,
        name: result.manifest.name,
        toRoot,
        dir: result.toPaths.dir,
        projectDir: result.toPaths.projectDir,
        pluginsQueued: result.manifest.plugins.length,
      })
      return { handled: true }
    }

    case '/settings': {
      const hasPatch = typeof body.maxBackups === 'number' || typeof body.autoBackup === 'boolean'
      const settingsNow = hasPatch ? await writeSettings(body) : await readSettings()
      sendJson(res, 200, { ok: true, ...settingsNow })
      return { handled: true }
    }
    
    case '/backups': {
      const roots = Array.isArray(body.roots) ? body.roots.filter((r) => typeof r === 'string') : []
      const backups = []
      for (const root of [...new Set(roots)]) {
        backups.push(...(await listBackupsUnderRoot(root).catch(() => [])))
      }
      sendJson(res, 200, { ok: true, backups })
      return { handled: true }
    }
    
    case '/backup/create': {
      const root = requireField(body, 'root')
      const id = requireField(body, 'id')
      const found = await readWorkspace(root, id)
      if (found === undefined) {
        const error = new Error(`找不到工作区：${id}`)
        error.code = 'not-found'
        throw error
      }
      guardPassword(found.manifest, body.password, root, id)
      const s = await readSettings()
      const record = await createBackup(root, id, workspacePaths(root, id), {
        kind: body.kind === 'auto' ? 'auto' : 'manual',
        maxBackups: s.maxBackups,
      })
      sendJson(res, 200, { ok: true, backup: record })
      return { handled: true }
    }
    
    case '/restore': {
      // Destructive: exact acknowledgement phrase + password of the overwritten
      // workspace (checked on the Host so a raw route call cannot bypass it).
      if (String(body.confirmPhrase ?? '') !== RESTORE_CONFIRM_PHRASE) {
        failPassword('请输入确认文字后再恢复。')
      }
      const root = requireField(body, 'root')
      const id = requireField(body, 'id')
      const target = await readWorkspace(root, id)
      if (target === undefined) {
        const error = new Error(`找不到工作区：${id}`)
        error.code = 'not-found'
        throw error
      }
      // Force a fresh password check: an in-memory unlock must not bypass it.
      clearUnlocked(root, id)
      guardPassword(target.manifest, body.password, root, id)
      const backupDir = String(body.backupDir ?? '').trim()
      // 0.1.4 backups are .zip archives; 0.1.3 scatter folders stay valid.
      const isZip = backupDir.toLowerCase().endsWith('.zip')
      const backupFound = isZip
        ? await exists(backupDir)
        : await exists(join(backupDir, 'backup.json'))
      if (backupDir === '' || !backupFound) {
        const error = new Error('找不到所选备份。')
        error.code = 'not-found'
        throw error
      }
      const s = await readSettings()
      const savedManifest = { ...target.manifest }
      // Keep a reversible pre-restore snapshot of the target before overwriting.
      await createBackup(root, id, target.paths, { kind: 'pre-restore', maxBackups: s.maxBackups, prune: false }).catch(() => undefined)
      await stopRunningInstance(target.paths).catch(() => false)
      await applyBackup(backupDir, target.paths, savedManifest)
      await healSessionCwds(target.paths).catch(() => ({ rewritten: 0 }))
      await healWorkspaceRegistry(target.paths).catch(() => 0)
      await healProjcacheCwds(target.paths.storagesDir, defaultWorkspaceDirOf(target.paths)).catch(() => 0)
      await writeLaunchPatch(target.paths)
      await writeStarterScript(target.paths, savedManifest).catch(() => undefined)
      await writeRuntime(target.paths, { url: '', pid: null, lastUrlSeenAt: 0, startedAt: Date.now() }).catch(() => undefined)
      clearUnlocked(root, id)
      sendJson(res, 200, { ok: true, id, name: savedManifest.name })
      return { handled: true }
    }
    
    case '/sessions/list': {
      const source = await containerFor(body.source)
      await guardContainer(source, body.password, '来源')
      const sessions = await listSessions(source.sessionsDir, source.storagesDir)
      sendJson(res, 200, {
        ok: true,
        sessions: sessions.map((s) => ({ id: s.id, cwd: s.cwd, createdAt: s.createdAt, title: s.title })),
      })
      return { handled: true }
    }
    
    case '/sessions/migrate': {
      const source = await containerFor(body.source)
      const target = await containerFor(body.target)
      await guardContainer(source, body.password, '来源')
      // Copying a session onto itself (and especially *moving* it) would write
      // the rebuilt header to the very same file and then delete that file.
      // Reject identical containers on the Host, not just in the dialog.
      if (source.sessionsDir.toLowerCase() === target.sessionsDir.toLowerCase()) {
        const error = new Error('来源和目标不能是同一个工作区。')
        error.code = 'invalid-target'
        throw error
      }
      const ids = Array.isArray(body.sessionIds) ? body.sessionIds.map((x) => String(x)) : []
      if (ids.length === 0) {
        const error = new Error('请至少选择一个会话。')
        error.code = 'invalid-body'
        throw error
      }
      const result = await transferSessions(source, target, ids, {
        move: body.move === true,
        copyProjects: source.kind === 'portable' && target.kind === 'portable',
      })
      sendJson(res, 200, { ok: true, ...result })
      return { handled: true }
    }
    
    case '/starter': {
      const root = requireField(body, 'root')
      const id = requireField(body, 'id')
      const found = await readWorkspace(root, id)
      if (found === undefined) {
        const error = new Error(`找不到工作区：${id}`)
        error.code = 'not-found'
        throw error
      }
      await writeLaunchPatch(found.paths)
      const target = await writeStarterScript(found.paths, found.manifest)
      sendJson(res, 200, { ok: true, path: target })
      return { handled: true }
    }

    case '/account/status': {
      const root = requireField(body, 'root')
      const layout = layoutOf(root)
      sendJson(res, 200, { ok: true, ...(await describeAccount(layout.homeDir)) })
      return { handled: true }
    }

    case '/account/import': {
      const root = requireField(body, 'root')
      const overwrite = body?.overwrite === true
      const layout = layoutOf(root)
      const result = await importAccount(layout.homeDir, { overwrite })
      sendJson(res, 200, { ok: true, ...result, account: await describeAccount(layout.homeDir) })
      return { handled: true }
    }

    case '/forget': {
      const root = requireField(body, 'root')
      const rest = (await readIndex()).filter((entry) => entry.root.toLowerCase() !== root.toLowerCase())
      await writeJson(indexFile(), { version: 1, roots: rest })
      sendJson(res, 200, { ok: true })
      return { handled: true }
    }

    case '/package/inspect': {
      const spec = requireField(body, 'spec')
      const installation = await resolveInstallation(settings.installationRoot).catch(() => undefined)
      if (installation === undefined) {
        const error = new Error('没有找到本机的 DeepSeek Harness 安装目录。')
        error.code = 'unavailable'
        throw error
      }
      const { packages } = await installedPackages({ installation })
      const name = spec.includes('@', 1) ? spec.slice(0, spec.lastIndexOf('@')) : spec
      sendJson(res, 200, { ok: true, name, present: packages.has(name), source: packages.get(name) ?? '' })
      return { handled: true }
    }

    default:
      sendJson(res, 404, { ok: false, code: 'not-found', message: `没有这个接口：${method} ${route}` })
      return { handled: true }
  }
}

/**
 * Register the browser routes.
 *
 * `webServer` and `connection` may not exist yet during a cold boot, so the
 * registration waits for them through `ctx.inject` instead of reading `ctx`.
 */

/* -------------------------------------------------------------------------- */
/* 0.1.3 helpers: settings, session containers, auto-backup                    */
/* -------------------------------------------------------------------------- */

/** Backup settings live beside roots.json (never inside a workspace). */
async function readSettings() {
  const v = await readJson(join(stateDir(), 'settings.json')).catch(() => undefined)
  return {
    maxBackups: Number(v?.maxBackups) > 0 ? Math.min(50, Math.floor(Number(v.maxBackups))) : 5,
    autoBackup: v?.autoBackup === true,
  }
}

async function writeSettings(patch) {
  const cur = await readSettings()
  const next = {
    maxBackups: Number(patch?.maxBackups) > 0 ? Math.min(50, Math.floor(Number(patch.maxBackups))) : cur.maxBackups,
    autoBackup: typeof patch?.autoBackup === 'boolean' ? patch.autoBackup : cur.autoBackup,
  }
  await writeJson(join(stateDir(), 'settings.json'), { version: 1, ...next })
  return next
}

/** A portable-workspace session container. */
function portableContainer(root, id) {
  const paths = workspacePaths(root, id)
  return {
    kind: 'portable',
    paths,
    sessionsDir: paths.sessionsDir,
    storagesDir: paths.storagesDir,
    projectDir: paths.projectDir,
    cwd: defaultWorkspaceDirOf(paths),
  }
}

/** Default cwd of the local (non-portable) DSH home. */
async function localDefaultCwd() {
  const file = join(localHome(), 'storages', 'workspace.json')
  const raw = await readJson(file).catch(() => undefined)
  const table = raw?.tables?.workspaces
  if (table !== undefined && table !== null && typeof table === 'object') {
    const preferred = raw?.global?.defaultWorkspaceId
    const rec = (typeof preferred === 'string' && table[preferred] !== undefined)
      ? table[preferred]
      : Object.values(table)[0]
    if (rec?.path) return String(rec.path)
  }
  return join(localHome(), 'Documents', 'deepseek-harness', 'default-workspace')
}

/** The local DSH home as a session container (no projectDir). */
async function localContainer() {
  const home = localHome()
  return {
    kind: 'local',
    sessionsDir: join(home, 'sessions'),
    storagesDir: join(home, 'storages'),
    projectDir: undefined,
    cwd: await localDefaultCwd(),
  }
}

async function containerFor(spec) {
  if (spec?.kind === 'local') return localContainer()
  const root = String(spec?.root ?? '').trim()
  const id = String(spec?.id ?? '').trim()
  if (root === '' || id === '') {
    const error = new Error('缺少来源/目标盘或工作区 id。')
    error.code = 'missing-field'
    throw error
  }
  return portableContainer(root, id)
}

/** Fire-and-forget automatic snapshot before/after a successful open. */
async function maybeAutoBackup(root, id) {
  const s = await readSettings().catch(() => ({ autoBackup: false, maxBackups: 5 }))
  if (s.autoBackup !== true) return
  const paths = workspacePaths(root, id)
  await createBackup(root, id, paths, { kind: 'auto', maxBackups: s.maxBackups }).catch(() => undefined)
}

function registerRoutes(ctx, settings) {
  ctx.inject(['webServer', 'connection'], (webCtx) => {
    const webServer = webCtx.get('webServer')
    const connection = webCtx.get('connection')
    if (webServer === undefined || connection === undefined) return
    webCtx.effect(
      () => webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (req, res) => {
          dispatch(ctx, settings, connection, req, res).catch((error) => {
            try {
              sendJson(res, statusOf(error), { ok: false, code: codeOf(error), message: errorText(error) })
            } catch {
              res.destroy()
            }
          })
        },
      }),
      'portable-workspace: browser routes',
    )
  })
}

/* -------------------------------------------------------------------------- */
/* Agent tool                                                                 */
/* -------------------------------------------------------------------------- */

const TOOL_DESCRIPTION = [
  'Inspect and drive the portable workspaces of this machine: a portable workspace is a complete DeepSeek Harness working state (sessions, storages, project files, logs) stored on a removable or secondary disk under <drive>:\\Portable-DSH.',
  'Use action "list" to see every reachable volume, its workspaces and whether one is already running.',
  'Use action "create" with a volume root and a name to make a workspace (an optional password protects it).',
  'Use action "open" with the workspace id to verify its password, scaffold the portable profile, check the plugin inventory and launch it.',
  'Use action "status" for one workspace, "install" to install its missing plugins, "migrate" to move it to another volume.',
  'Use action "stop-all" to stop every detached portable instance before upgrading DeepSeek Harness: they hold DeepSeek Harness.exe / app.asar locked. Also fully quit the main app before upgrading.',
]

const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'create', 'open', 'status', 'install', 'migrate', 'stop-all'],
    },
    root: { type: 'string', description: 'Portable root, e.g. H:\\Portable-DSH.' },
    id: { type: 'string', description: 'Workspace id.' },
    name: { type: 'string', description: 'Workspace name when creating.' },
    password: { type: 'string', description: 'Workspace password, when one is set.' },
    hint: { type: 'string', description: 'Optional password hint shown when unlocking.' },
    toRoot: { type: 'string', description: 'Destination portable root when migrating.' },
    move: { type: 'boolean', description: 'Delete the source after migrating.' },
    includeOptional: { type: 'boolean', description: 'Also install optional plugins.' },
  },
  required: ['action'],
  additionalProperties: false,
}

/** Render a tool result as one text block. */
function renderText(text) {
  return [{ type: 'text', text: String(text) }]
}

/** Human-readable summary of the state for the agent tool. */
function describeState(state) {
  const lines = []
  if (state.volumes.length === 0) lines.push('没有发现可用的移动工作区根目录。')
  for (const volume of state.volumes) {
    lines.push(`盘 ${volume.root}（${volume.workspaces.length} 个工作区）`)
    for (const workspace of volume.workspaces) {
      const flags = [
        workspace.passwordProtected ? '带密码' : '无密码',
        workspace.running ? `运行中 ${workspace.url}` : '未运行',
        workspace.reachable ? '在线' : `离线：${workspace.offlineReason}`,
      ]
      lines.push(`  - ${workspace.name} [${workspace.id}] ${flags.join(' / ')}`)
    }
  }
  for (const entry of state.offline) {
    lines.push(`离线盘 ${entry.root}（${entry.reason}）`)
  }
  if (state.leftoverCount > 0) {
    lines.push(`⚠ 还有 ${state.leftoverCount} 个残留便携实例正锁住安装文件，升级前请执行 stop-all 并完全退出主程序。`)
  }
  if (state.upgradePending === true) {
    lines.push('⚠ 检测到待安装的 DeepSeek Harness 升级，升级前请执行 stop-all（关闭全部便携实例）并完全退出主程序。')
  }
  return lines.join('\n')
}

/** Register the agent tool. */
function registerTool(ctx, settings) {
  const tools = ctx.get('tools')
  if (tools === undefined || typeof tools.register !== 'function') return
  ctx.effect(
    () => tools.register({
      name: TOOL_NAME,
      description: TOOL_DESCRIPTION.join(' '),
      parameters: TOOL_PARAMETERS,
      output: {
        schema: { type: 'string' },
        render: (_args, value) => renderText(value),
      },
      async execute(args) {
        const action = String(args?.action ?? 'list')
        if (action === 'list') {
          const state = await collectState(ctx, settings)
          return describeState(state)
        }
        if (action === 'stop-all') {
          const killed = await stopAllInstances(settings)
          for (const key of [...unlocked.keys()]) unlocked.delete(key)
          const cleared = await clearIndex().then(() => true).catch(() => false)
          return `已关闭 ${killed} 个便携实例、清空解锁态${cleared ? '并清除本机根路径索引（升级后重新扫描即可恢复）' : ''}；升级 DeepSeek Harness 前还请完全退出主程序。`
        }
        if (action === 'create') {
          const root = String(args?.root ?? '').trim()
          if (root === '') return '需要提供 root，例如 H:\\Portable-DSH。'
          await ensurePortableRoot(root)
          const created = await createWorkspace(root, {
            name: args?.name,
            password: args?.password ?? '',
            hint: args?.hint ?? '',
          })
          await ensurePortableProfile(layoutOf(root)).catch(() => undefined)
          const recoveryLine = created.recoveryCode === ''
            ? ''
            : `\n恢复密钥（只显示这一次，请立刻抄写保存）：${created.recoveryCode}`
          return `已创建移动工作区「${created.manifest.name}」[${created.manifest.id}]，工程目录 ${created.paths.projectDir}。${recoveryLine}`
        }
        if (action === 'status') {
          const state = await collectState(ctx, settings)
          return describeState(state)
        }
        if (action === 'open') {
          const root = String(args?.root ?? '').trim()
          const id = String(args?.id ?? '').trim()
          if (root === '' || id === '') return '需要提供 root 与 id。'
          const result = await launchWorkspace(ctx, settings, { root, id, password: args?.password ?? '' })
          if (result.ok !== true) return `无法打开：${result.message ?? result.stage}`
          if (result.url !== undefined && result.url !== '') return `已启动：${result.url}`
          return `已启动，地址还在准备中，日志：${result.logPath ?? ''}`
        }
        if (action === 'install') {
          const root = String(args?.root ?? '').trim()
          const id = String(args?.id ?? '').trim()
          const found = await readWorkspace(root, id)
          if (found === undefined) return `找不到工作区：${id}`
          const installation = await resolveInstallation(settings.installationRoot)
          if (installation === undefined) return '没有找到本机的 DeepSeek Harness 安装目录。'
          const layout = layoutOf(root)
          await ensurePortableProfile(layout)
          const result = await installPlugins(found.manifest.plugins ?? [], {
            profileDir: layout.profileDir,
            installation,
            includeOptional: args?.includeOptional === true,
            logPath: join(found.paths.logsDir, 'plugins.log'),
          })
          if (result.code === 0) return `已安装：${result.installed.join(', ') || '（无需安装）'}`
          return `安装失败（code ${result.code}）：${result.output.slice(-1200)}`
        }
        if (action === 'migrate') {
          const root = String(args?.root ?? '').trim()
          const id = String(args?.id ?? '').trim()
          const toRoot = String(args?.toRoot ?? '').trim()
          if (root === '' || id === '' || toRoot === '') return '需要提供 root、id 与 toRoot。'
          const found = await readWorkspace(root, id)
          if (found !== undefined) {
            try {
              guardPassword(found.manifest, args?.password, root, id)
            } catch (error) {
              return `迁移被拒绝：${errorText(error)}`
            }
          }
          const snapshot = await snapshotPlugins(layoutOf(root).profileDir).catch(() => [])
          const result = await migrateWorkspace(root, id, toRoot, { move: args?.move === true, plugins: snapshot })
          return `已迁移到 ${toRoot}，工作区 id ${result.manifest.id}；已把 ${result.manifest.plugins.length} 个插件写入清单，下次打开会提示安装。`
        }
        return `不认识的 action：${action}`
      },
    }),
    'portable-workspace: agent tool',
  )
}

/* -------------------------------------------------------------------------- */
/* Entry                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Mount the bundle.
 *
 * @param ctx - Cordis context.
 * @param config - Plugin config.
 */
export function apply(ctx, config) {
  const settings = resolveSettings(config)
  const logger = typeof ctx.logger === 'function' ? ctx.logger(NS) : undefined
  if (logger !== undefined) logger.info?.(`portable workspace mounted (profile ${PROFILE_NAME})`)

  registerRoutes(ctx, settings)
  registerTool(ctx, settings)

  // When the bundle is reloaded or the Host shuts down, stop the portable
  // instances this process started.
  //
  // IMPORTANT — this disposer MUST stay synchronous and do ZERO async I/O.
  // DSH's updater calls host.stop(requireGraceful) and demands the host process
  // exit within 10s. The host awaits application.shutdown.shutdown(0), which
  // awaits every Cordis ctx.effect disposer (see app.asar: Cordis dispose uses
  // `await Promise.allSettled(...)`). An async disposer here used to spawn a
  // PowerShell process-enumeration + probe 24 drive letters + read marker
  // files on an unplugged removable drive (unbounded). That I/O can push the
  // host past the 10s graceful window, producing the exact error the user saw:
  //   "Host did not complete graceful task teardown (... graceful deadline
  //    exceeded true)" -> preparationFailure="stop-failed" -> upgrade refused.
  // So: only signal the pids we already know, in memory, synchronously. The
  // detached children are signalled here; command-line sweeping (which needs
  // process enumeration / disk I/O) is deliberately NOT done at shutdown — it
  // remains available through the explicit "关闭全部便携实例" / stop-all action,
  // which the user runs BEFORE starting an upgrade.
  ctx.effect(
    () => () => {
      for (const pid of launchedPids) {
        try {
          process.kill(pid, 'SIGTERM')
        } catch {
          // Already gone.
        }
      }
      launchedPids.clear()
      for (const key of [...unlocked.keys()]) unlocked.delete(key)
    },
    'portable-workspace: stop portable instances on dispose (sync, no I/O)',
  )
}

export { NS, PROFILE_NAME, ROUTE_PREFIX, VENDORED_PLUGIN_DIR, hashPassword }
export { dirname, exists, isDirectory }
