/**
 * Standalone smoke test of the portable-workspace libraries (no DSH needed).
 *
 *   node scripts/smoke.mjs [rootPath]
 */

import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import { ensurePortableRoot, createWorkspace, listWorkspaces, readWorkspace, updateWorkspace, verifyPassword, workspacePaths, writeLaunchPatch, layoutOf, readLogTail } from '../lib/workspace.js'
import { findPortableRoots, readMarker } from '../lib/volumes.js'
import { resolveInstallation } from '../lib/launcher.js'
import { asarPackagesIn, asarHas } from '../lib/asar.js'
import { checkPlugins, ensurePortableProfile, installedPackages, dshVersionOf, readProfile } from '../lib/profile.js'

const root = process.argv[2] ?? join(process.cwd(), '_pwtest', 'Portable-DSH')

function line(label, value) {
  console.log(`${label.padEnd(28)} ${typeof value === 'string' ? value : JSON.stringify(value)}`)
}

await rm(join(root, '..'), { recursive: true, force: true })

// 1. root marker
const ensured = await ensurePortableRoot(root)
line('root created', ensured.created)
line('rootId', ensured.marker.rootId)
const again = await ensurePortableRoot(root)
line('root idempotent', again.created === false && again.marker.rootId === ensured.marker.rootId)

// 2. scan
const found = await findPortableRoots([root])
line('scan hits', found.map((entry) => `${entry.root}${entry.external ? ' (external)' : ''}`))

// 3. create workspaces
const plain = await createWorkspace(root, { name: '甲方案', password: '' })
line('created (no password)', plain.manifest.id)
const locked = await createWorkspace(root, { name: '乙方案', password: 'hunter2' })
line('created (password)', locked.manifest.id)

let duplicate = 'none'
try {
  await createWorkspace(root, { name: '甲方案' })
} catch (error) {
  duplicate = error.code
}
line('duplicate rejected', duplicate)

// 4. password round-trip
line('verify empty ok', verifyPassword(plain.manifest.password, ''))
line('verify locked ok', verifyPassword(locked.manifest.password, 'hunter2'))
line('verify locked bad', verifyPassword(locked.manifest.password, 'wrong'))

// 5. listing + paths
const listed = await listWorkspaces(root)
line('list count', listed.length)
line('paths of first', Object.keys(workspacePaths(root, plain.manifest.id)))

// 6. launch patch
const patchPath = await writeLaunchPatch(plain.paths)
const patchText = await import('node:fs/promises').then((module) => module.readFile(patchPath, 'utf8'))
console.log('--- patch ---')
console.log(patchText.trim())
console.log('-------------')

// 7. profile scaffold
const layout = layoutOf(root)
const profile = await ensurePortableProfile(layout)
line('profile created', profile.created)
line('profile bundles', (await readProfile(layout.profileDir)).bundles)

// 8. installation + inventory
const installation = await resolveInstallation()
line('installation', installation === undefined ? 'not found' : installation.resources)
if (installation !== undefined) {
  line('asar', installation.asar)
  line('has node', installation.node ?? 'none')
  line('dsh version', await dshVersionOf(installation))
  line('cli in asar', await asarHas(installation.asar, 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'))
  const packages = await asarPackagesIn(installation.asar, 'dsh/node_modules/@deepseek-ai')
  line('@deepseek-ai packages', packages.length)
  line('sample', packages.slice(0, 6))
  const installed = await installedPackages({ profileDir: layout.profileDir, installation })
  line('installed map size', installed.packages.size)
  const check = await checkPlugins(
    [
      { name: '@deepseek-ai/dsh-session-persistence-jsonl' },
      { name: 'dsh-better-sidebar', version: '^0.28.2' },
      { name: 'no-such-package-xyz', optional: true },
    ],
    { profileDir: layout.profileDir, installation },
  )
  line('check items', check.items.map((item) => `${item.name}=${item.present ? item.source : 'missing'}${item.optional ? '(opt)' : ''}`))
  line('missing required', check.missing.length)
  line('missing optional', check.optionalMissing.length)
}

// 9. update / password tri-state
const renamed = await updateWorkspace(root, plain.manifest.id, { name: '甲方案-改' })
line('renamed', renamed.manifest.name)
const unlocked = await updateWorkspace(root, plain.manifest.id, { password: '' })
line('password cleared', unlocked.manifest.password === null)

// 10. offline detection
const offlineFound = await findPortableRoots([root])
line('marker readable', (await readMarker(found[0]?.drive ?? 'Z')) !== undefined)
line('offline scan (missing)', (await findPortableRoots([join(root, 'nope')])).length)
void offlineFound
void readLogTail
void readWorkspace

console.log('\nSMOKE OK')
