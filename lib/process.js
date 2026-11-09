/**
 * Portable-instance process bookkeeping.
 *
 * A portable workspace is started with `detached: true` + `child.unref()` so it
 * outlives the Host process. That is what makes it an independent window, but
 * on Windows the running Electron binary keeps `DeepSeek Harness.exe` and
 * `app.asar` locked, which makes an in-place upgrade of the desktop app fail.
 * Worse, `dshmarket`'s recovery surface can restart the instance under a NEW
 * pid, so `runtime.json` (one recorded pid) is not enough to find it again.
 *
 * The only reliable identity is the command line: our instances are the ones
 * launched with `--expose-internals <...>/lib/cli.js portable --patch <path>`.
 * The desktop host uses `lib/index.js` and has no `--patch`, diagnostic shells
 * merely mention the string, so this filter cannot match either of them.
 *
 * This module imports no DSH package and no third-party dependency.
 *
 * @module dsh-portable-workspace/lib/process
 */

import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Normalize a path for case-insensitive, slash-insensitive comparison. */
function normalizePath(value) {
  return String(value ?? '')
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .replace(/\\/g, '/')
    .toLowerCase()
}

/**
 * Pull the `--patch` argument out of a command line.
 *
 * `spawn` quotes arguments that contain spaces, so both
 * `--patch "H:\Some Dir\cordis.patch.yml"` and the usual unquoted form occur.
 * Returns a normalized path, or `''` when the line has no patch argument.
 *
 * @param {string} commandLine - Full process command line.
 * @returns {string} normalized patch path.
 */
export function extractPatchArg(commandLine) {
  const text = String(commandLine ?? '')
  // Quoted form first: it is the only one that can contain spaces.
  const quoted = /--patch\s+"([^"]+\.ya?ml)"/i.exec(text)
  if (quoted !== null) return normalizePath(quoted[1])
  const plain = /--patch\s+(\S+\.ya?ml)(?=\s|$)/i.exec(text)
  if (plain !== null) return normalizePath(plain[1])
  return ''
}

/**
 * Whether a process row is one of OUR portable CLI instances.
 *
 * Requires all four markers together. The desktop host (`lib/index.js`, no
 * `--patch`), Electron helpers (`--type=gpu-process`), and our own diagnostic
 * shells (which merely embed the text `--expose-internals`) all fail at least
 * one check, so they can never be killed by mistake.
 *
 * @param {{ name?: string, commandLine?: string }} row - Process row.
 * @returns {boolean}
 */
export function isPortableInstance(row) {
  const name = String(row?.name ?? row?.Name ?? '')
  const cmd = String(row?.commandLine ?? row?.CommandLine ?? '')
  if (!/DeepSeek Harness\.exe/i.test(name)) return false
  if (!cmd.includes('--expose-internals')) return false
  // The portable launcher uses dsh-desktop-host/lib/cli.js; the desktop host
  // uses lib/index.js. This is the cleanest discriminator.
  if (!/[/\\]cli\.js/i.test(cmd)) return false
  if (!/--patch\b/i.test(cmd)) return false
  // PROFILE_NAME is passed as a standalone positional argument.
  if (!/(?:^|\s)portable(?:\s|$)/i.test(cmd)) return false
  return true
}

/** Enumerate processes on Windows through CIM (no shell, no `$_` quoting). */
async function windowsProcesses() {
  const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress -Depth 3'
  const { stdout } = await execFileAsync(
    join(process.env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 20000, maxBuffer: 16 * 1024 * 1024 },
  )
  const raw = String(stdout ?? '').trim()
  if (raw === '') return []
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  return rows
    .filter((row) => row != null && typeof row === 'object')
    .map((row) => ({
      pid: Number(row.ProcessId),
      ppid: Number(row.ParentProcessId),
      name: String(row.Name ?? ''),
      commandLine: String(row.CommandLine ?? ''),
    }))
}

/** Enumerate processes on POSIX through `ps`. */
async function posixProcesses() {
  const { stdout } = await execFileAsync(
    'ps',
    ['-eo', 'pid=,ppid=,comm=,args='],
    { timeout: 20000, maxBuffer: 16 * 1024 * 1024 },
  )
  const rows = []
  for (const line of String(stdout ?? '').split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (match === null) continue
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      name: match[3],
      commandLine: match[4],
    })
  }
  return rows
}

/**
 * List every live portable CLI instance on this machine.
 *
 * Never throws: enumeration is best-effort, so a failure is reported as an
 * empty list rather than breaking the panel or the dispose hook.
 *
 * @returns {Promise<Array<{ pid: number, ppid: number, name: string, commandLine: string, patchPath: string }>>}
 */
export async function listPortableProcesses() {
  let rows
  try {
    rows = process.platform === 'win32'
      ? await windowsProcesses()
      : await posixProcesses()
  } catch {
    return []
  }
  return rows
    .filter((row) => Number.isInteger(row.pid) && row.pid > 0 && isPortableInstance(row))
    .map((row) => ({ ...row, patchPath: extractPatchArg(row.commandLine) }))
}

/**
 * Narrow a process list to the instances launched for one patch file.
 *
 * @param {Array<{ patchPath: string }>} procs - Output of `listPortableProcesses()`.
 * @param {string} patchPath - `paths.patchPath` of one workspace.
 * @returns {Array<{ patchPath: string }>}
 */
export function processesForPatch(procs, patchPath) {
  const target = normalizePath(patchPath)
  if (target === '') return []
  return procs.filter((proc) => normalizePath(proc.patchPath) === target)
}

/** Whether a pid is still alive (EPERM counts as alive: it exists). */
export function isAlive(pid) {
  const id = Number(pid)
  if (!Number.isInteger(id) || id <= 0) return false
  try {
    process.kill(id, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * Terminate a process AND its children.
 *
 * `taskkill /T /F` is important on Windows: `dshmarket`'s recovery helper and
 * the pnpm/node children of a portable instance must die with it, otherwise a
 * fresh instance is spawned right back and keeps the executable locked.
 *
 * @param {number} pid - Process id.
 * @returns {Promise<boolean>} whether a termination signal was delivered.
 */
export async function killTree(pid) {
  const id = Number(pid)
  if (!Number.isInteger(id) || id <= 0) return false
  if (process.platform === 'win32') {
    try {
      await execFileAsync(
        join(process.env.windir || 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(id), '/T', '/F'],
        { windowsHide: true, timeout: 15000 },
      )
      return true
    } catch {
      // It may already have exited; try the plain signal as a fallback.
    }
  }
  try {
    process.kill(id, 'SIGTERM')
    return true
  } catch {
    return false
  }
}
