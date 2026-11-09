/**
 * The portable DSH profile that lives on the volume, and the plugin inventory
 * checks that gate opening a workspace on a new machine.
 *
 * A profile in DSH is three files in one directory:
 *
 *     <home>/profiles/<name>/
 *       package.json        — `dsh.profile.bundles` (ordered) + `dependencies`
 *       cordis.patch.yml    — profile-local overlay, applied after the bundles
 *       pnpm-workspace.yaml — pnpm settings for this directory
 *
 * `portable` is not one of the shipped template names, so nothing creates it
 * for us: the first workspace opened on a volume scaffolds it here.
 *
 * @module dsh-portable-workspace/lib/profile
 */

import { spawn } from 'node:child_process'
import { existsSync, promises as fsp } from 'node:fs'
import { join, normalize, parse } from 'node:path'

import { PORTABLE_BUNDLES, PROFILE_NAME } from './constants.js'
import { readAsarJson, asarPackagesIn, asarHas } from './asar.js'
import { appendLog, ensureDir, exists, readJson, readText, writeJson, writeText } from './fsx.js'

/** Comment header of a freshly scaffolded profile overlay. */
const PATCH_TEMPLATE = [
  '# Profile overlay of the portable instance.',
  '# Workspace-specific roots are layered on top of this file at launch time,',
  '# so keep this list empty unless a setting must apply to every workspace.',
  '[]',
  '',
].join('\n')

/** pnpm settings DSH writes for every profile. */
const PNPM_WORKSPACE = ['packages:', '  - .', '', 'nodeLinker: hoisted', 'autoInstallPeers: false', ''].join('\n')

/** A package name as pnpm accepts it in a dependency key. */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i

/**
 * Build the three profile files when they are missing.
 *
 * Existing files are never rewritten: a user who edited the overlay or pinned a
 * plugin version keeps that edit across machines.
 *
 * @param layout - Result of `layoutOf(root)`.
 * @param options - `{ bundles?: string[] }`.
 * @returns `{ dir, created }` where `created` lists the written file names.
 */
export async function ensurePortableProfile(layout, options = {}) {
  const dir = layout.profileDir
  await ensureDir(dir)
  const bundles = Array.isArray(options.bundles) && options.bundles.length > 0 ? options.bundles : PORTABLE_BUNDLES
  const created = []

  const manifestPath = join(dir, 'package.json')
  if (!(await exists(manifestPath))) {
    await writeJson(manifestPath, {
      name: `dsh-profile-${PROFILE_NAME}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles } },
    })
    created.push('package.json')
  }

  const patchPath = join(dir, 'cordis.patch.yml')
  if (!(await exists(patchPath))) {
    await writeText(patchPath, PATCH_TEMPLATE)
    created.push('cordis.patch.yml')
  }

  const workspacePath = join(dir, 'pnpm-workspace.yaml')
  if (!(await exists(workspacePath))) {
    await writeText(workspacePath, PNPM_WORKSPACE)
    created.push('pnpm-workspace.yaml')
  }

  // A profile copied from another volume can carry a stale .modules.yaml whose
  // absolute store paths no longer match this drive; heal before the first pnpm run.
  await healStaleStore(dir).catch(() => false)

  return { dir, created }
}

/**
 * Read the declared bundle list and dependencies of a profile.
 *
 * @param dir - Absolute profile directory.
 * @returns `{ bundles, dependencies }`; both empty when the profile is missing.
 */
export async function readProfile(dir) {
  const manifest = await readJson(join(dir, 'package.json')).catch(() => undefined)
  if (manifest == null || typeof manifest !== 'object') return { bundles: [], dependencies: {} }
  const dsh = manifest.dsh != null && typeof manifest.dsh === 'object' ? manifest.dsh : {}
  const profile = dsh.profile != null && typeof dsh.profile === 'object' ? dsh.profile : {}
  const bundles = Array.isArray(profile.bundles) ? profile.bundles.filter((name) => typeof name === 'string') : []
  const dependencies = manifest.dependencies != null && typeof manifest.dependencies === 'object' ? manifest.dependencies : {}
  return { bundles, dependencies }
}

/**
 * Packages already available to a portable instance on this machine.
 *
 * Three places can satisfy a dependency, in DSH's own resolution order:
 *  1. the profile's own `node_modules` (what `dsh plugin add` installed),
 *  2. the packages shipped inside `app.asar` (everything `@deepseek-ai/*`),
 *  3. a `node_modules` directory next to the installation.
 *
 * @param options - `{ profileDir, installation }`.
 * @returns `{ packages: Map<string, string>, sources }` mapping name → where it came from.
 */
export async function installedPackages(options = {}) {
  const packages = new Map()
  const sources = {}

  const profileDir = options.profileDir
  if (typeof profileDir === 'string' && profileDir !== '') {
    const { dependencies } = await readProfile(profileDir)
    for (const name of Object.keys(dependencies)) {
      packages.set(name, 'profile')
      sources[name] = 'profile'
    }
  }

  const asarPath = options.installation?.asar
  if (typeof asarPath === 'string' && asarPath !== '') {
    const scoped = await asarPackagesIn(asarPath, 'dsh/node_modules/@deepseek-ai')
    for (const name of scoped) {
      const full = `@deepseek-ai/${name}`
      if (!packages.has(full)) {
        packages.set(full, 'installation')
        sources[full] = 'installation'
      }
    }
    const unscoped = await asarPackagesIn(asarPath, 'dsh/node_modules')
    for (const name of unscoped) {
      if (!packages.has(name)) {
        packages.set(name, 'installation')
        sources[name] = 'installation'
      }
    }
  }

  return { packages, sources }
}

/**
 * Version of the DSH runtime this installation carries.
 *
 * @param installation - Result of `resolveInstallation`.
 * @returns the version string, or `undefined`.
 */
export async function dshVersionOf(installation) {
  const asarPath = installation?.asar
  if (typeof asarPath !== 'string' || asarPath === '') return undefined
  const manifest = await readAsarJson(asarPath, 'dsh/package.json')
  return typeof manifest?.version === 'string' ? manifest.version : undefined
}

/**
 * Check the plugin list a workspace declares against what this machine has.
 *
 * @param declared - `[{ name, version?, optional? }]` from the workspace manifest.
 * @param options - `{ profileDir, installation }`.
 * @returns `{ items, missing, optionalMissing, allPresent }`.
 */
export async function checkPlugins(declared, options = {}) {
  const list = Array.isArray(declared) ? declared.filter(isDeclaredPlugin) : []
  if (list.length === 0) return { items: [], missing: [], optionalMissing: [], allPresent: true }
  const { packages } = await installedPackages(options)
  const items = list.map((entry) => {
    const present = packages.has(entry.name)
    return {
      name: entry.name,
      version: typeof entry.version === 'string' ? entry.version : '',
      optional: entry.optional === true,
      present,
      source: packages.get(entry.name) ?? '',
      spec: specOf(entry),
    }
  })
  const missing = items.filter((item) => !item.present && !item.optional)
  const optionalMissing = items.filter((item) => !item.present && item.optional)
  return { items, missing, optionalMissing, allPresent: missing.length === 0 && optionalMissing.length === 0 }
}

/**
 * Normalize a plugin entry coming from a manifest or a browser request.
 *
 * @returns `{ name, version, optional }`, or `undefined` when the name is unusable.
 */
export function normalizePluginEntry(raw) {
  if (raw == null || typeof raw !== 'object') return undefined
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (name === '' || !PACKAGE_NAME.test(name)) return undefined
  const version = typeof raw.version === 'string' ? raw.version.trim() : ''
  return { name, version, optional: raw.optional === true }
}

/** Installation spec of one declared plugin. */
export function specOf(entry) {
  return typeof entry.version === 'string' && entry.version !== '' ? `${entry.name}@${entry.version}` : entry.name
}

function isDeclaredPlugin(value) {
  return normalizePluginEntry(value) !== undefined
}

/* -------------------------------------------------------------------------- */
/* Installing into the portable profile                                       */
/* -------------------------------------------------------------------------- */

/** Locate the pnpm entry point that ships with the desktop installation. */
export function pnpmEntryOf(installation) {
  return typeof installation?.pnpm === 'string' && installation.pnpm !== '' ? installation.pnpm : undefined
}

/** Parse the storeDir / virtualStoreDir JSON-string values from .modules.yaml. */
function storeFieldsOf(text) {
  const fields = {}
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    for (const key of ['storeDir', 'virtualStoreDir']) {
      if (!trimmed.startsWith(`"${key}"`)) continue
      const colon = trimmed.indexOf(':')
      if (colon < 0) continue
      const raw = trimmed.slice(colon + 1).trim().replace(/,$/, '').trim()
      try {
        const value = JSON.parse(raw)
        if (typeof value === 'string') fields[key] = value
      } catch {
        // ignore a malformed line
      }
    }
  }
  return fields
}

/**
 * Heal a portable profile whose pnpm store metadata points at another drive.
 *
 * pnpm records absolute storeDir / virtualStoreDir in node_modules/.modules.yaml.
 * When the volume is moved (or the old drive letter disappears) those paths no
 * longer match what pnpm computes now, so the next add / update fails with
 * ERR_PNPM_UNEXPECTED_STORE. Plain `pnpm install`, `--store-dir`, or editing the
 * recorded fields does NOT recover; deleting .modules.yaml and letting pnpm
 * rebuild it is the only reliable cure, and it keeps the installed packages.
 *
 * @param profileDir - Absolute portable profile directory.
 * @param options - `{ dryRun?: boolean }`: report the decision without deleting.
 * @returns {Promise<boolean>} true when the metadata is stale (and, unless dryRun, was removed).
 */
export async function healStaleStore(profileDir, options = {}) {
  const modulesFile = join(profileDir, 'node_modules', '.modules.yaml')
  const text = await readText(modulesFile).catch(() => undefined)
  if (typeof text !== 'string' || text === '') return false
  const { storeDir, virtualStoreDir } = storeFieldsOf(text)
  if (typeof storeDir !== 'string' && typeof virtualStoreDir !== 'string') return false
  const norm = (value) => normalize(String(value)).replace(/[\\/]+$/, '').toLowerCase()
  const volumeOf = (value) => parse(String(value)).root.replace(/[\\/]/g, '').toLowerCase()
  const expectedVirtual = norm(join(profileDir, 'node_modules', '.pnpm'))
  const missingVolumeOf = (value) => {
    const root = parse(String(value)).root
    if (root === '') return false
    try {
      return !existsSync(root)
    } catch {
      return true
    }
  }
  let stale = false
  if (typeof virtualStoreDir === 'string' && norm(virtualStoreDir) !== expectedVirtual) stale = true
  // The old drive letter may have disappeared entirely (e.g. a USB volume moved
  // from H: to F:), or now point at a different volume than the profile.
  if (typeof storeDir === 'string' && volumeOf(storeDir) !== volumeOf(profileDir)) stale = true
  if (typeof storeDir === 'string' && missingVolumeOf(storeDir)) stale = true
  if (typeof virtualStoreDir === 'string' && missingVolumeOf(virtualStoreDir)) stale = true
  if (!stale) return false
  if (options.dryRun === true) return true
  try {
    await fsp.unlink(modulesFile)
    return true
  } catch {
    return false
  }
}

/**
 * Snapshot the third-party plugins installed in a (source) portable profile as
 * a workspace plugin declaration. @deepseek-ai/* packages ship with the host
 * and are always present, so they are omitted; local link:/file:/workspace:/
 * portal: dependencies cannot be reinstalled from a registry and are omitted too.
 *
 * @param profileDir - Absolute portable profile directory, e.g. layoutOf(root).profileDir.
 * @returns {Promise<Array<{ name: string, version: string, optional: boolean }>>}
 */
export async function snapshotPlugins(profileDir) {
  const manifest = await readJson(join(profileDir, 'package.json')).catch(() => undefined)
  if (manifest == null || typeof manifest !== 'object') return []
  const dependencies = manifest.dependencies != null && typeof manifest.dependencies === 'object' ? manifest.dependencies : {}
  const result = []
  for (const [name, version] of Object.entries(dependencies)) {
    if (name.startsWith('@deepseek-ai/')) continue
    const v = typeof version === 'string' ? version.trim() : ''
    if (v.startsWith('link:') || v.startsWith('file:') || v.startsWith('workspace:') || v.startsWith('portal:')) continue
    const entry = normalizePluginEntry({ name, version: v, optional: false })
    if (entry !== undefined) result.push(entry)
  }
  return result
}

/**
 * Run one pnpm command inside the portable profile.
 *
 * The command is spawned with the node that ships in the installation, so a
 * machine without node or pnpm on PATH can still install plugins onto the
 * volume.
 *
 * @param installation - Result of `resolveInstallation`.
 * @param profileDir - Absolute portable profile directory.
 * @param args - pnpm arguments, e.g. `['add', 'pkg@1.2.3']`.
 * @param options - `{ logPath?, timeoutMs? }`.
 * @returns `{ code, output }`; `code` is `-1` when pnpm is unavailable.
 */
export async function runPnpm(installation, profileDir, args, options = {}) {
  const entry = pnpmEntryOf(installation)
  const node = typeof installation?.node === 'string' && installation.node !== '' ? installation.node : process.execPath
  if (entry === undefined) {
    return { code: -1, output: '这台电脑上没有找到随 DSH 一起安装的 pnpm，无法自动安装插件。' }
  }
  const argv = [entry, '--dir', profileDir, ...args]
  // A profile moved between drives keeps stale absolute store paths in
  // node_modules/.modules.yaml; pnpm then refuses to link (see healStaleStore).
  // Heal right before every run so a plain add/update rebuilds the metadata.
  await healStaleStore(profileDir).catch(() => false)
  // A cold install of a real DSH plugin pulls a few hundred transitive
  // packages. On a USB volume that can exceed three minutes, so keep the
  // ceiling generous; warm installs (store cached / already installed) return
  // in milliseconds and never come close to it.
  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 300_000
  return new Promise((resolve) => {
    let output = ''
    let settled = false
    let child
    const finish = (code) => {
      if (settled) return
      settled = true
      resolve({ code, output })
    }
    try {
      child = spawn(node, argv, {
        cwd: profileDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, npm_config_yes: 'true' },
      })
    } catch (error) {
      finish(-1)
      output += String(error)
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      finish(-2)
    }, timeoutMs)
    timer.unref?.()
    const collect = (chunk) => {
      const text = String(chunk)
      output += text
      if (typeof options.logPath === 'string') void appendLog(options.logPath, text.replace(/\s+$/, ''))
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', (error) => {
      clearTimeout(timer)
      output += String(error)
      finish(-1)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish(typeof code === 'number' ? code : -1)
    })
  })
}

/**
 * Install the missing plugins of one workspace into the portable profile.
 *
 * Required and optional entries are installed in one pnpm call so a single
 * resolution pass decides versions consistently; entries already present are
 * skipped, which keeps a re-open on the same machine a no-op.
 *
 * @param declared - `[{ name, version?, optional? }]`.
 * @param options - `{ profileDir, installation, includeOptional?, logPath? }`.
 * @returns `{ installed, skipped, failed, code, output }`.
 */
export async function installPlugins(declared, options = {}) {
  const profileDir = options.profileDir
  if (typeof profileDir !== 'string' || profileDir === '') {
    return { installed: [], skipped: [], failed: [], code: -1, output: '没有可用的便携 profile 目录。' }
  }
  await ensureDir(profileDir)
  const includeOptional = options.includeOptional === true
  const check = await checkPlugins(declared, {
    profileDir,
    installation: options.installation,
  })
  const wanted = check.items.filter((item) => {
    if (item.present) return false
    if (item.optional && !includeOptional) return false
    return true
  })
  const skipped = check.items.filter((item) => item.present || (item.optional && !includeOptional)).map((item) => item.name)
  const specs = wanted.map((item) => item.spec)
  let result = { code: 0, output: '' }
  if (specs.length > 0) {
    result = await runPnpm(options.installation, profileDir, ['add', ...specs], options)
  }
  const ok = result.code === 0
  // Activate every declared plugin that is now installed, not only the ones
  // installed in this call: a dependency already present on the volume (added
  // on another machine, or before activation existed) still needs its bundle
  // row or the portable instance will never load it.
  let activated = []
  if (ok) {
    const names = check.items.map((item) => item.name)
    activated = await activateBundles(profileDir, names).catch(() => [])
  }
  return {
    installed: ok ? specs : [],
    activated,
    skipped,
    failed: ok ? [] : specs,
    code: result.code,
    output: result.output,
  }
}

/**
 * Activate freshly installed plugins in the profile's `dsh.profile.bundles`.
 *
 * `pnpm add` only records a package in `dependencies`; DSH loads plugins from
 * the ordered `dsh.profile.bundles` list. Without this step a workspace that
 * declares a missing plugin installs it yet still opens without it.
 *
 * Only packages that actually declare `dsh.bundle` are activated: some
 * dependencies are plain libraries and adding them to the bundle list would
 * make the portable instance fail to boot ("declares no dsh.bundle").
 *
 * @param profileDir - Absolute portable profile directory.
 * @param names - Plain package names (no version suffix).
 * @returns the names newly appended to the bundle list.
 */
export async function activateBundles(profileDir, names) {
  const manifestPath = join(profileDir, 'package.json')
  const manifest = await readJson(manifestPath).catch(() => undefined)
  if (manifest == null || typeof manifest !== 'object') return []
  const dsh = manifest.dsh != null && typeof manifest.dsh === 'object' ? manifest.dsh : {}
  const profile = dsh.profile != null && typeof dsh.profile === 'object' ? dsh.profile : {}
  const bundles = Array.isArray(profile.bundles) ? profile.bundles.filter((name) => typeof name === 'string') : []
  const added = []
  for (const name of names) {
    if (typeof name !== 'string' || name === '' || bundles.includes(name)) continue
    const segments = name.split('/')
    const pkg = await readJson(join(profileDir, 'node_modules', ...segments, 'package.json')).catch(() => undefined)
    if (pkg == null || typeof pkg !== 'object' || pkg.dsh?.bundle === undefined) continue
    bundles.push(name)
    added.push(name)
  }
  if (added.length === 0) return []
  manifest.dsh = { ...dsh, profile: { ...profile, bundles } }
  await writeJson(manifestPath, manifest)
  return added
}

/** Record installed plugin names into a workspace manifest field. */
export function pluginsFromDeclaration(declared) {
  return (Array.isArray(declared) ? declared : []).map(normalizePluginEntry).filter(Boolean)
}

/** Whether the portable profile has a `package.json` yet. */
export async function profileExists(dir) {
  return exists(join(dir, 'package.json'))
}

/** Whether the installation archive really holds the CLI entry point. */
export async function installationLooksUsable(installation) {
  const asarPath = installation?.asar
  if (typeof asarPath !== 'string' || asarPath === '') return false
  return asarHas(asarPath, 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js')
}
