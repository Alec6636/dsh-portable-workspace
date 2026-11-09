/**
 * Resolve a plugin spec typed by a human into a real npm package spec.
 *
 * The plugin market shows *display names* (the bare tail of a package name),
 * e.g. `dsh-web-all` / `modlens`, while npm only knows
 * `@linxin666/dsh-web-all` / `@liustack/modlens`. Passing the display name to
 * `pnpm add` produces `ERR_PNPM_FETCH_404` — this was the whole "only
 * dshmarket can be added" failure. `dshmarket` works because it is genuinely
 * unscoped.
 *
 * A second trap: the market filters by the *latest* version's `engines.dsh`.
 * `@linxin666/dsh-web-all@0.4.15` requires DSH `>=0.2.2-rc.1`, so on a
 * `0.2.1-rc.5` host the plugin disappears from search even though `0.4.14`
 * (requiring `>=0.2.1-rc.3`) works perfectly. When the user did not pin a
 * version we therefore pick the newest version that actually fits this host.
 *
 * Zero DSH dependencies: only `node:path`, fsx's `readJson`, the local semver
 * subset and `globalThis.fetch`.
 *
 * @module dsh-portable-workspace/lib/names
 */

import { join } from 'node:path'

import { readJson } from './fsx.js'
import { compareVersions, parseVersion, satisfies } from './compatibility.js'

/** `dsh-web-all@0.4.13` → `{ name:'dsh-web-all', version:'0.4.13' }`. */
export function splitSpec(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return { name: '', version: '' }
  if (text.startsWith('@')) {
    // Scoped: the version separator is the last '@' after the scope slash.
    const slash = text.indexOf('/')
    const at = text.indexOf('@', slash > 0 ? slash + 1 : 1)
    return at > 0
      ? { name: text.slice(0, at), version: text.slice(at + 1) }
      : { name: text, version: '' }
  }
  const at = text.indexOf('@')
  return at > 0
    ? { name: text.slice(0, at), version: text.slice(at + 1) }
    : { name: text, version: '' }
}

/** Bare display name of a possibly scoped package. */
export function bareName(name) {
  const text = String(name ?? '')
  return text.includes('/') ? text.slice(text.indexOf('/') + 1) : text
}

function encodeName(name) {
  return String(name).replace(/%/g, '%25').replace(/\//g, '%2F')
}

/** Read one market cache's `entries` keys (full package names). */
async function cacheNames(file) {
  const data = await readJson(file).catch(() => undefined)
  const entries = data?.entries
  if (entries == null || typeof entries !== 'object') return {}
  return entries
}

/**
 * Collect the sources used to map a display name to a real package name.
 * All reads are best-effort: a missing cache on a fresh drive is fine.
 */
async function nameSources(options) {
  const portableHome = options.portableHome
  const localHome = options.localHome
  const profileDir = options.profileDir
  const files = []
  const depsFiles = []
  if (typeof portableHome === 'string' && portableHome !== '') {
    files.push(join(portableHome, 'profiles', 'portable', '.dsh-market', 'discovery-compatibility-v1.json'))
  }
  if (typeof profileDir === 'string' && profileDir !== '') {
    files.push(join(profileDir, '.dsh-market', 'discovery-compatibility-v1.json'))
    depsFiles.push(join(profileDir, 'package.json'))
  }
  if (typeof localHome === 'string' && localHome !== '') {
    files.push(join(localHome, 'profiles', 'desktop', '.dsh-market', 'discovery-compatibility-v1.json'))
    depsFiles.push(join(localHome, 'profiles', 'desktop', 'package.json'))
  }
  const caches = []
  for (const file of [...new Set(files)]) caches.push(await cacheNames(file))
  const deps = []
  for (const file of [...new Set(depsFiles)]) {
    const manifest = await readJson(file).catch(() => undefined)
    const names = Object.keys(manifest?.dependencies ?? {})
    for (const name of names) deps.push(name)
  }
  return { caches, deps }
}

/** Find full package names whose bare tail equals `short`. */
async function candidatesFor(short, options) {
  const { caches, deps } = await nameSources(options)
  const wanted = short.toLowerCase()
  const exact = []
  const scoped = []
  const seen = new Set()
  const consider = (name) => {
    if (typeof name !== 'string' || name === '' || seen.has(name)) return
    seen.add(name)
    if (name.toLowerCase() === wanted) exact.push(name)
    else if (name.includes('/') && bareName(name).toLowerCase() === wanted) scoped.push(name)
  }
  for (const cache of caches) for (const name of Object.keys(cache)) consider(name)
  for (const name of deps) consider(name)
  // A real exact hit (e.g. `dshmarket`) wins. Otherwise the scoped package is
  // the answer: never let the bare display name we were given outrank a real
  // scoped package found in the market cache.
  if (exact.length > 0) return [...exact, ...scoped]
  const invented = short.toLowerCase() === wanted ? [short] : []
  return [...scoped, ...invented]
}

/**
 * Fetch the full npm packument (it carries the `dsh.engines.dsh` field, unlike
 * the abbreviated install-v1 document). Returns undefined on any failure.
 */
async function fetchPackument(name, timeoutMs) {
  const fetchFn = globalThis.fetch
  if (typeof fetchFn !== 'function') return undefined
  try {
    const response = await fetchFn(`https://registry.npmjs.org/${encodeName(name)}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return undefined
    return await response.json()
  } catch {
    return undefined
  }
}

function enginesOf(packument, version) {
  const pkg = packument?.versions?.[version]
  const dsh = pkg?.dsh?.engines?.dsh
  if (typeof dsh === 'string' && dsh.trim() !== '') return dsh.trim()
  const top = pkg?.engines?.dsh
  return typeof top === 'string' && top.trim() !== '' ? top.trim() : ''
}

/**
 * Choose the newest version of `name` compatible with `dshVersion`.
 *
 * @returns `{ version, latest, latestEngines, compatible, fromPackument }`.
 */
export async function chooseVersion(name, pinned, dshVersion, options = {}) {
  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 8000
  const packument = await fetchPackument(name, timeoutMs)
  if (packument == null || packument.versions == null || typeof packument.versions !== 'object') {
    // Fall back to the cached "latest" fact; no network → no version pinning.
    const { caches } = await nameSources(options)
    for (const cache of caches) {
      const facts = cache[name]?.facts
      if (facts != null && typeof facts.version === 'string' && facts.version !== '') {
        const engines = typeof facts.enginesDsh === 'string' ? facts.enginesDsh : ''
        return { version: pinned || facts.version, latest: facts.version, latestEngines: engines, compatible: engines === '' || dshVersion === '' || satisfies(dshVersion, engines), fromPackument: false }
      }
    }
    return { version: pinned, latest: '', latestEngines: '', compatible: true, fromPackument: false }
  }
  const versions = Object.keys(packument.versions)
  const latest = packument['dist-tags']?.latest ?? versions[versions.length - 1] ?? ''
  const latestEngines = enginesOf(packument, latest)
  if (typeof pinned === 'string' && pinned !== '') {
    return { version: pinned, latest, latestEngines, compatible: true, fromPackument: true }
  }
  if (latestEngines === '' || typeof dshVersion !== 'string' || dshVersion === '' || satisfies(dshVersion, latestEngines)) {
    return { version: latest, latest, latestEngines, compatible: true, fromPackument: true }
  }
  // Latest is incompatible: walk backwards to the newest compatible release.
  const parsed = versions
    .map((text) => ({ text, parsed: parseVersion(text) }))
    .filter((entry) => entry.parsed != null)
    .sort((a, b) => compareVersions(b.parsed, a.parsed))
  for (const entry of parsed) {
    const engines = enginesOf(packument, entry.text)
    if (engines === '' || satisfies(dshVersion, engines)) {
      return { version: entry.text, latest, latestEngines, compatible: false, fromPackument: true }
    }
  }
  return { version: latest, latest, latestEngines, compatible: false, fromPackument: true }
}

/**
 * Resolve a user-typed spec into `{ spec, name, version, hints }`.
 *
 * @param rawSpec - e.g. `dsh-web-all`, `modlens@3.27.2`, `@liustack/modlens`.
 * @param options - `{ portableHome, localHome, profileDir, dshVersion, timeoutMs }`.
 */
export async function resolvePluginSpec(rawSpec, options = {}) {
  const { name, version } = splitSpec(rawSpec)
  const hints = []
  if (name === '') return { spec: String(rawSpec ?? '').trim(), name: '', version, hints }
  const candidates = await candidatesFor(name, options)
  const chosen = candidates[0] ?? name
  if (chosen !== name) hints.push(`已把市场短名 ${name} 解析为完整包名 ${chosen}。`)
  const pick = await chooseVersion(chosen, version, options.dshVersion, options)
  if (!pick.compatible && pick.latest !== '' && pick.version !== '' && pick.version !== pick.latest) {
    hints.push(`最新版 ${pick.latest} 要求 DSH ${pick.latestEngines}，本机 ${options.dshVersion} 不满足，已改用兼容版 ${pick.version}。`)
  } else if (!pick.compatible && pick.latest !== '') {
    hints.push(`最新版 ${pick.latest} 要求 DSH ${pick.latestEngines}，本机 ${options.dshVersion} 不满足，且没有找到兼容的旧版本。`)
  }
  const spec = pick.version !== '' ? `${chosen}@${pick.version}` : chosen
  return {
    spec,
    name: chosen,
    version: pick.version,
    original: String(rawSpec ?? '').trim(),
    candidates,
    hints,
    latest: pick.latest,
    latestEngines: pick.latestEngines,
    latestCompatible: pick.compatible,
  }
}

/** Human hint for a pnpm 404, used when resolution could not help. */
export function notFoundHint(output) {
  if (!/404|not found/i.test(String(output ?? ''))) return ''
  return 'npm 上没有这个包名。插件市场里显示的是短名，正式包名往往带作者前缀（例如 dsh-web-all 应写成 @linxin666/dsh-web-all、modlens 应写成 @liustack/modlens）。请填写完整包名。'
}
