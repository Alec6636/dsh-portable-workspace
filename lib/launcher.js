/**
 * Launch a portable DSH instance for one workspace.
 *
 * The portable instance is an ordinary `dsh <profile>` process with three
 * things pinned to the removable volume:
 *
 *   DSH_HOME        -> <root>/support/home          (profile, plugin packages, caches)
 *   sessions root   -> <root>/Portable-Workspaces/<id>/sessions   (via --patch)
 *   storages root   -> <root>/Portable-Workspaces/<id>/storages   (via --patch)
 *
 * Nothing is written under the local user's home, so pulling the drive takes
 * the whole working state with it.
 *
 * @module dsh-portable-workspace/lib/launcher
 */

import { spawn } from 'node:child_process'
import { constants as fsConstants, promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'

import { PROFILE_NAME } from './constants.js'
import { asarHas } from './asar.js'
import { appendLog, ensureDir, exists, readTextFrom, writeText } from './fsx.js'
import { readRuntime, writeRuntime } from './workspace.js'

/** How long a launch may take before we give up waiting for its URL. */
const LAUNCH_TIMEOUT_MS = 90_000
/** Relative path of the CLI entry inside the DSH resources directory. */
const CLI_ENTRY = 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'

/**
 * Locate the running DSH installation.
 *
 * @returns `{ resources, cli, runtime, node, electron }` or `undefined` when
 *   this plugin runs outside a packaged installation.
 */
export async function resolveInstallation(configuredRoot) {
  const candidates = []
  if (typeof configuredRoot === 'string' && configuredRoot.trim() !== '') candidates.push(configuredRoot.trim())
  if (typeof process.resourcesPath === 'string' && process.resourcesPath !== '') candidates.push(process.resourcesPath)
  const execDir = dirname(process.execPath)
  candidates.push(join(execDir, 'resources'), execDir, dirname(execDir))

  for (const resources of candidates) {
    const asar = join(resources, 'app.asar')
    // The CLI lives *inside* the archive, so its presence is an entry in the
    // asar file table, not a file on disk.
    if (!(await asarHas(asar, CLI_ENTRY))) continue
    const cli = join(asar, ...CLI_ENTRY.split('/'))
    const runtime = join(resources, 'runtime')
    const nodeExe = join(runtime, 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe')
    // Plain node cannot read files inside an asar archive; the Electron binary
    // can, so it is the carrier the launcher must use.
    const harness = await findHarnessExecutable(dirname(resources))
    return {
      resources,
      asar,
      cli,
      runtime,
      harness,
      node: (await exists(nodeExe)) ? nodeExe : undefined,
      pnpm: join(runtime, 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'),
      electron: typeof process.versions?.electron === 'string',
    }
  }
  return undefined
}

/** Locate the DeepSeek Harness executable that owns `resources`. */
async function findHarnessExecutable(appDir) {
  for (const name of ['DeepSeek Harness.exe', 'DeepSeek Harness.app']) {
    const candidate = join(appDir, name)
    if (await exists(candidate)) return candidate
  }
  return undefined
}

/** The command line for booting a portable profile. */
function commandOf(installation, args) {
  // The CLI lives inside app.asar, and only the Electron binary can execute a
  // module that sits in an archive — plain node reports MODULE_NOT_FOUND.
  // Running it as Node needs ELECTRON_RUN_AS_NODE plus --expose-internals.
  const command = installation.harness ?? (installation.electron ? process.execPath : (installation.node ?? process.execPath))
  return { command, argv: ['--expose-internals', installation.cli, ...args] }
}

/** Environment of a portable instance. */
function environmentOf(paths, installation, extra = {}) {
  const env = { ...process.env, ...extra }
  env.DSH_HOME = paths.homeDir
  env.DSH_PROFILE = PROFILE_NAME
  delete env.DSH_AGENTS_HOME
  // The harness binary is Electron: it only behaves as the CLI host when this
  // flag is set, and the CLI shell script sets it too.
  env.ELECTRON_RUN_AS_NODE = '1'
  if (installation.node !== undefined) env.DSH_DESKTOP_NODE_EXECUTABLE = installation.node
  return env
}

/**
 * Build (without running) the launch plan of one workspace.
 *
 * @returns `{ command, args, env, cwd, logPath, patchPath }`.
 */
export function buildLaunchPlan({ paths, installation, patchPath, port = 0, host }) {
  // Launcher flags must come before the app's own flags: the CLI turns on
  // passThroughOptions, so everything after the first unknown flag (`--port`)
  // belongs to the app, and a late `--patch` is then rejected by the app.
  const args = [PROFILE_NAME, '--patch', patchPath]
  if (typeof host === 'string' && host !== '') args.push('--host', host)
  args.push('--port', String(port ?? 0), '--no-open')
  const { command, argv } = commandOf(installation, args)
  return {
    command,
    args: argv,
    env: environmentOf(paths, installation),
    cwd: paths.projectDir,
    logPath: join(paths.logsDir, 'launch.log'),
    patchPath,
  }
}

/** Quote one argument for a Windows `.cmd` shim. */
function cmdQuote(text) {
  return /[\s"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * Write a double-clickable starter for machines whose DSH lives elsewhere.
 *
 * The generated file only assumes "DeepSeek Harness is installed in its default
 * location"; the plugin itself carries no path so it keeps working after the
 * app is updated.
 */
export async function writeStarterScript(paths, manifest) {
  const target = join(paths.launchDir, 'start-portable.cmd')
  const installation = await resolveInstallation()
  // The starter has to work on machines where this plugin was imported from a
  // different installation, so a live probe wins and the default location is
  // the fallback.
  const harness = installation?.harness ?? '%ProgramFiles%\\DeepSeek Harness\\DeepSeek Harness.exe'
  const lines = [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    `set "DSH_HOME=${paths.homeDir}"`,
    `set "DSH_PROFILE=${PROFILE_NAME}"`,
    'set "ELECTRON_RUN_AS_NODE=1"',
    `set "DSH_EXE=${harness}"`,
    'if not exist "%DSH_EXE%" set "DSH_EXE=%LOCALAPPDATA%\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe"',
    'if not exist "%DSH_EXE%" (',
    '  echo DeepSeek Harness was not found on this machine; install it first.',
    '  pause',
    '  exit /b 1',
    ')',
    `cd /d ${cmdQuote(paths.projectDir)}`,
    `"%DSH_EXE%" --expose-internals "%DSH_EXE%\\..\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js" ${PROFILE_NAME} --patch ${cmdQuote(paths.patchPath)} %*`,
    'endlocal',
    '',
  ]
  await writeText(target, lines.join('\r\n'))
  await appendLog(
    join(paths.logsDir, 'launch.log'),
    `starter written for ${manifest.name} (${manifest.id})`,
  )
  return target
}

/**
 * Parse the portable-instance URL out of launch output.
 *
 * The launch log mixes the real `dsh web:` URL with many other URLs. In
 * particular the model-listing plugin prints `https://api.deepseek.com/models`
 * repeatedly AFTER the web line, so taking the LAST URL of any kind returns
 * that external API endpoint and the "在新窗口打开" button opens an invalid
 * link (it only works when the timing happens to leave `dsh web:` last).
 *
 * Only loopback http(s) URLs belong to the portable instance; everything else
 * is noise. Prefer one carrying the per-launch `?token=`, and among those take
 * the most recent (callers slice the log to the current launch). `ws://` relay
 * URLs are ignored because the pattern only matches http/https.
 */
export function extractUrl(text) {
  const pattern = /https?:\/\/[\w.\-[\]:]+(?::\d+)?\/[^\s"']*/g
  const loopback = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[?::1\]?)(?::\d+)?\//i
  const candidates = []
  for (const match of String(text ?? '').matchAll(pattern)) {
    if (loopback.test(match[0])) candidates.push(match[0])
  }
  if (candidates.length === 0) return undefined
  const tokenized = candidates.filter((url) => /[?&]token=/.test(url))
  const pool = tokenized.length > 0 ? tokenized : candidates
  return pool[pool.length - 1]
}

/**
 * Start the portable instance of one workspace in the background.
 *
 * @returns `{ pid, logPath }` once the process is spawned. The URL arrives
 *   later; poll {@link waitForUrl} (or read the log) for it.
 */
export async function startPortable(plan, paths) {
  await ensureDir(paths.logsDir)
  await ensureDir(plan.cwd)
  // The instance outlives this process, so its output goes straight to the log
  // file descriptor instead of through pipes: a piped child would keep our event
  // loop (and therefore the whole host) alive until it exits.
  const logHandle = await fsp.open(plan.logPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND)
  const logPath = plan.logPath
  try {
    // Remember where this launch starts writing: the log is shared by every
    // start of the workspace, and an old URL in it must never be mistaken for
    // the one this launch is about to print.
    const before = await fsp.stat(logPath).catch(() => undefined)
    const offset = before?.size ?? 0
    await logHandle.write(
      `\n=== ${new Date().toISOString()} launch pid-parent ${process.pid}\n${plan.command} ${plan.args.join(' ')}\n`,
    )
    const child = spawn(plan.command, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      stdio: ['ignore', logHandle.fd, logHandle.fd],
      windowsHide: true,
      detached: true,
    })
    child.on('error', (error) => {
      appendLog(logPath, `spawn failed: ${error.message}`)
    })
    child.unref()
    return { pid: child.pid, logPath, offset }
  } finally {
    await logHandle.close().catch(() => undefined)
  }
}

/**
 * Read the launch log until it carries a URL.
 *
 * @param offset byte offset where the current launch began, so URLs printed by
 *   earlier starts (still present further up the file) are ignored.
 * @returns the URL, or `undefined` when the deadline passes.
 */
export async function waitForUrl(logPath, timeoutMs = LAUNCH_TIMEOUT_MS, offset = 0) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    // `offset` is a BYTE offset from fsp.stat().size. readTextFrom slices the
    // raw buffer by bytes and returns '' until the log has actually grown, so
    // an early poll can never see a previous launch's URL.
    const fresh = await readTextFrom(logPath, offset).catch(() => undefined)
    if (fresh !== undefined && fresh !== '') {
      const url = extractUrl(fresh)
      // A URL printed by a process that already died is not usable either.
      if (url !== undefined && (await probeUrl(url).catch(() => false))) return url
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  return undefined
}

/**
 * Record that a workspace was launched, refreshing `lastOpenedAt`.
 *
 * @returns the runtime record written next to the manifest.
 */
export async function recordLaunch(paths, manifest, runtime) {
  const previous = (await readRuntime(paths)) ?? {}
  const record = {
    ...previous,
    ...runtime,
    startedAt: Date.now(),
  }
  await writeRuntime(paths, record)
  return record
}

/** Whether a previously launched instance still answers. */
export async function probeUrl(url) {
  if (typeof url !== 'string' || url === '') return false
  try {
    const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(1500) })
    return response.status > 0
  } catch {
    return false
  }
}
