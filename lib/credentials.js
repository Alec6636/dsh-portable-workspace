/**
 * Carry the local DSH account onto a portable volume.
 *
 * A portable home starts empty, which also means it starts signed out. The
 * account material DSH keeps outside of sessions is small and lives in two
 * files at the home root:
 *
 *   .credentials.yaml   — account record, device identity, browser grant
 *   .anonymous-user-id  — the stable anonymous identifier
 *
 * Copying them makes the portable instance "already signed in" on every
 * machine, which is what seamless continuation means in practice. The copy is
 * one-way and explicit: nothing is ever pulled back from the volume.
 *
 * @module dsh-portable-workspace/lib/credentials
 */

import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promises as fsp } from 'node:fs'

import { appendLog, ensureDir, exists, readText, writeText } from './fsx.js'

/** Files that make up the portable account state. */
const ACCOUNT_FILES = ['.credentials.yaml', '.anonymous-user-id']

/** The DSH home of the process that hosts this plugin. */
export function localHome() {
  const configured = typeof process.env?.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return configured !== '' ? configured : join(homedir(), '.dsh')
}

/** Record keys declared in a credentials file, without their payloads. */
function recordKeys(text) {
  const keys = []
  for (const line of String(text ?? '').split('\n')) {
    const match = line.match(/^ {2}([^:\s][^:]*):\s*$/)
    if (match !== null && match[1].includes('/')) keys.push(match[1].trim())
  }
  return keys
}

/** Describe the account state of one portable home. */
export async function describeAccount(homeDir) {
  const local = localHome()
  const localFile = join(local, '.credentials.yaml')
  const portableFile = join(homeDir, '.credentials.yaml')
  const localText = (await exists(localFile)) ? await readText(localFile).catch(() => '') : ''
  const portableText = (await exists(portableFile)) ? await readText(portableFile).catch(() => '') : ''
  return {
    localHome: local,
    portableHome: homeDir,
    localPresent: localText !== '',
    portablePresent: portableText !== '',
    // A fresh home only carries the browser-session grant; anything account
    // shaped means the user already signed in on this volume.
    portableSignedIn: recordKeys(portableText).some((key) => !key.startsWith('client-connection/')),
    localRecords: recordKeys(localText),
    portableRecords: recordKeys(portableText),
    sameHome: local.toLowerCase() === homeDir.toLowerCase(),
  }
}

/**
 * Copy the local account files into a portable home.
 *
 * @returns `{ copied, skipped, overwritten }`.
 */
export async function importAccount(homeDir, { overwrite = false } = {}) {
  const local = localHome()
  if (local.toLowerCase() === homeDir.toLowerCase()) {
    return { copied: [], skipped: ACCOUNT_FILES, overwritten: false, sameHome: true }
  }
  await ensureDir(homeDir)
  const copied = []
  const skipped = []
  let overwritten = false
  for (const name of ACCOUNT_FILES) {
    const source = join(local, name)
    const target = join(homeDir, name)
    if (!(await exists(source))) {
      skipped.push(name)
      continue
    }
    const present = await exists(target)
    if (present && !overwrite) {
      skipped.push(name)
      continue
    }
    if (present) overwritten = true
    const text = await readText(source)
    await writeText(target, text)
    copied.push(name)
  }
  await appendLog(
    join(homeDir, 'portable-account.log'),
    `${new Date().toISOString()} import from ${local}: copied=[${copied.join(',')}] skipped=[${skipped.join(',')}]`,
  )
  // Keep the pairing between a volume and the home it belongs to visible in
  // logs, since this is the one place we read from the local machine.
  void basename(dirname(homeDir))
  return { copied, skipped, overwritten, sameHome: false }
}

/**
 * Sign the portable instance out: remove the copied account material from the
 * volume so it no longer carries usable credentials. Local DSH is never
 * touched. Returns the list of files actually removed.
 */
export async function clearAccount(homeDir) {
  const removed = []
  for (const name of ACCOUNT_FILES) {
    const target = join(homeDir, name)
    if (!(await exists(target))) continue
    await fsp.rm(target, { force: true }).catch(() => undefined)
    removed.push(name)
  }
  await appendLog(
    join(homeDir, 'portable-account.log'),
    `${new Date().toISOString()} sign-out: removed=[${removed.join(',')}]`,
  ).catch(() => undefined)
  return { removed, account: await describeAccount(homeDir) }
}
