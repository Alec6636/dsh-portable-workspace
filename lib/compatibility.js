/**
 * Compatibility pre-flight for plugins declared by a portable workspace.
 *
 * DSH plugins state their runtime requirements in `engines.dsh` (a semver
 * range such as `>=0.2.0-rc.2 <0.2.1-0 || >=0.2.1-rc.2 <0.2.2-0`) and in
 * `peerDependencies` (ranges against `@deepseek-ai/*` packages). A workspace
 * opened on a different computer may meet a different DSH version, so the
 * missing-plugin dialog must be able to say "this plugin needs a newer DSH"
 * instead of silently installing a package that will fail to load.
 *
 * This module implements just enough semver to evaluate those ranges. It is
 * deliberately dependency-free: the portable plugin must run from a plain
 * workspace directory with no `node_modules` of its own.
 *
 * @module dsh-portable-workspace/lib/compatibility
 */

/** Parse a version into comparable parts; tolerates prerelease tags. */
export function parseVersion(raw) {
  const text = String(raw ?? '').trim().replace(/^v/, '')
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text)
  if (m === null) return undefined
  return {
    major: Number(m[1]),
    minor: m[2] === undefined ? 0 : Number(m[2]),
    patch: m[3] === undefined ? 0 : Number(m[3]),
    pre: m[4] === undefined ? [] : m[4].split('.'),
  }
}

/** Compare two parsed versions: -1 / 0 / 1. */
export function compareVersions(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  // A version without prerelease outranks one with it (1.0.0 > 1.0.0-rc.1).
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  const len = Math.max(a.pre.length, b.pre.length)
  for (let i = 0; i < len; i += 1) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1
    if (xn) return -1 // numeric identifiers rank below alphanumeric
    if (yn) return 1
    return x < y ? -1 : 1
  }
  return 0
}

function compareOp(version, op, target) {
  const c = compareVersions(version, target)
  switch (op) {
    case '<': return c < 0
    case '<=': return c <= 0
    case '>': return c > 0
    case '>=': return c >= 0
    case '=': case '': return c === 0
    default: return false
  }
}

/**
 * Test one comparator set, e.g. `>=0.2.0-rc.2 <0.2.1-0`.
 * Supports `*`, exact, `~`, `^`, hyphen ranges and the four inequality ops.
 */
function testComparatorSet(version, set) {
  const parts = String(set).trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0 || parts[0] === '*' || parts[0] === 'x') return true
  for (const part of parts) {
    // Hyphen range: `1.2.3 - 2.3.4`
    if (/\s-\s/.test(part)) continue // handled below (rare; split already done)
    let token = part
    let op = ''
    const m = /^(<=|>=|<|>|=)?\s*(.+)$/.exec(token)
    if (m !== null) { op = m[1] ?? ''; token = m[2] }
    if (token.startsWith('~') || token.startsWith('^')) {
      const base = parseVersion(token.slice(1))
      if (base === undefined) return false
      if (token[0] === '~') {
        const upper = { ...base, minor: base.minor + 1, patch: 0, pre: [] }
        if (!(compareVersions(version, base) >= 0 && compareVersions(version, upper) < 0)) return false
      } else {
        const upper = base.major > 0
          ? { major: base.major + 1, minor: 0, patch: 0, pre: [] }
          : base.minor > 0
            ? { major: 0, minor: base.minor + 1, patch: 0, pre: [] }
            : { major: 0, minor: 0, patch: base.patch + 1, pre: [] }
        if (!(compareVersions(version, base) >= 0 && compareVersions(version, upper) < 0)) return false
      }
      continue
    }
    // Partial versions (1.2, 1) act as a range with the missing parts wild.
    const pm = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?([-+].*)?$/.exec(token)
    if (pm !== null && pm[4] === undefined && (pm[2] === undefined || pm[3] === undefined)) {
      const lower = { major: Number(pm[1]), minor: pm[2] === undefined ? 0 : Number(pm[2]), patch: pm[3] === undefined ? 0 : Number(pm[3]), pre: [] }
      const upper = pm[2] === undefined
        ? { major: lower.major + 1, minor: 0, patch: 0, pre: [] }
        : { major: lower.major, minor: lower.minor + 1, patch: 0, pre: [] }
      if (op === '>' || op === '>=') {
        if (!compareOp(version, op, lower)) return false
      } else if (op === '<' || op === '<=') {
        if (!compareOp(version, op, op === '<=' ? upper : lower)) return false
      } else if (!(compareVersions(version, lower) >= 0 && compareVersions(version, upper) < 0)) {
        return false
      }
      continue
    }
    const target = parseVersion(token)
    if (target === undefined) return false
    if (!compareOp(version, op === '' ? '=' : op, target)) return false
  }
  return true
}

/** Does `version` satisfy the semver `range`? */
export function satisfies(versionText, range) {
  const version = parseVersion(versionText)
  if (version === undefined) return false
  const text = String(range ?? '').trim()
  if (text === '' || text === '*' || text === 'x' || text === 'latest') return true
  // Split on `||` first, then on whitespace inside each comparator set.
  return text.split('||').some((set) => testComparatorSet(version, set.trim()))
}

/**
 * Pre-flight one declared plugin against the local DSH runtime.
 *
 * @param declared - `{ name, version?, optional? }`.
 * @param options - `{ profileDir, installation, dshVersion }`.
 * @returns `{ name, status, reasons, advice }` where status is
 *   `compatible` | `incompatible` | `unknown` | `not-installed`.
 */
export async function checkCompatibility(declared, options = {}) {
  const name = declared.name
  const profileDir = options.profileDir
  const segments = name.split('/')
  let pkg
  if (typeof profileDir === 'string' && profileDir !== '') {
    // Lazily import to keep this module usable from scripts without fsx loaded.
    const { readJson } = await import('./fsx.js')
    pkg = await readJson(`${profileDir}/node_modules/${segments.join('/')}/package.json`).catch(() => undefined)
  }
  if (pkg == null || typeof pkg !== 'object') {
    return { name, status: 'not-installed', reasons: [], advice: '' }
  }

  const reasons = []
  const dshRange = pkg.engines?.dsh
  if (typeof dshRange === 'string' && dshRange.trim() !== '') {
    const dshVersion = options.dshVersion
    if (typeof dshVersion !== 'string' || dshVersion === '') {
      reasons.push(`插件要求 DSH ${dshRange}，但无法读取本机 DSH 版本`)
    } else if (!satisfies(dshVersion, dshRange)) {
      reasons.push(`本机 DSH ${dshVersion} 不满足插件要求 ${dshRange}`)
    }
  }

  const peers = pkg.peerDependencies
  if (peers != null && typeof peers === 'object') {
    for (const [peer, range] of Object.entries(peers)) {
      if (!peer.startsWith('@deepseek-ai/') || typeof range !== 'string') continue
      // The installation ships most @deepseek-ai packages inside the asar.
      // Client-only peers may live elsewhere; when we cannot read a real
      // version, skip the check rather than guessing from the DSH version
      // (a wrong number would produce a false conflict).
      let installedVersion
      const asarPath = options.installation?.asar
      if (typeof asarPath === 'string' && asarPath !== '') {
        const { readAsarJson } = await import('./asar.js')
        const manifest = await readAsarJson(asarPath, `dsh/node_modules/${peer}/package.json`).catch(() => undefined)
        if (typeof manifest?.version === 'string') installedVersion = manifest.version
      }
      if (typeof installedVersion === 'string' && installedVersion !== '' && !satisfies(installedVersion, range)) {
        reasons.push(`依赖 ${peer} 版本 ${installedVersion} 不满足 ${range}`)
      }
    }
  }

  if (reasons.length === 0) {
    return { name, status: 'compatible', reasons: [], advice: '' }
  }
  const advice = `建议升级本机 DeepSeek Harness 到该插件支持的版本，或在工作区设置里改用兼容版本${declared.optional === true ? '；该插件为可选，也可以跳过不安装' : ''}。`
  return { name, status: 'incompatible', reasons, advice }
}

/** Check a whole declared list. */
export async function checkCompatibilities(declared, options = {}) {
  const list = Array.isArray(declared) ? declared : []
  return Promise.all(list.map((entry) => checkCompatibility(entry, options)))
}
