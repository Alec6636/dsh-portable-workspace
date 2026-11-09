/**
 * End-to-end launch test: create a workspace on a real target root, scaffold the
 * portable profile, start a portable instance and wait for its URL.
 *
 *   node scripts/launch-test.mjs <rootPath> [resourcesPath]
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { resolveInstallation, buildLaunchPlan, startPortable, waitForUrl, recordLaunch } from '../lib/launcher.js'
import { ensurePortableProfile, checkPlugins } from '../lib/profile.js'
import {
  ensurePortableRoot,
  createWorkspace,
  writeLaunchPatch,
  writeRuntime,
  offlineReason,
  workspaceKey,
} from '../lib/workspace.js'

const root = process.argv[2]
if (root === undefined) {
  console.error('usage: node scripts/launch-test.mjs <rootPath> [resourcesPath]')
  process.exit(2)
}

const { layout } = await ensurePortableRoot(root)
console.log('root   ', root)
console.log('home   ', layout.homeDir)

const { manifest, paths } = await createWorkspace(root, {
  name: `端到端测试-${Date.now().toString(36)}`,
  password: '',
})
console.log('created', manifest.id, 'key', workspaceKey(root, manifest.id))
await writeLaunchPatch(paths)
await writeRuntime(paths, {})

const installation = await resolveInstallation(process.argv[3] ?? process.env.DSH_INSTALL_ROOT)
if (installation === undefined) {
  console.error('no DSH installation found; pass the resources directory as the second argument')
  process.exit(1)
}
console.log('cli    ', installation.cli)
console.log('harness', installation.harness)
console.log('electron carrier', installation.electron)

const scaffold = await ensurePortableProfile(layout)
console.log('profile', scaffold.created.join(',') || '(already present)')

const check = await checkPlugins([], { profileDir: layout.profileDir, installation })
console.log('bundles', check.items.length, 'missing', check.missing.length)

const plan = buildLaunchPlan({ paths, installation, patchPath: paths.patchPath, port: 0 })
console.log('command', plan.command)
console.log('args   ', plan.args.join(' '))
console.log('cwd    ', plan.cwd)

const started = await startPortable(plan, paths)
console.log('pid    ', started.pid)
const url = await waitForUrl(started.logPath, 120_000)
console.log('url    ', url ?? '(timeout)')

if (url !== undefined) {
  await recordLaunch(paths, manifest, { pid: started.pid, url, startedAt: Date.now(), port: Number(new URL(url).port) })
}
console.log('offline', await offlineReason(root))
console.log('--- log tail ---')
console.log((await readFile(join(paths.logsDir, 'launch.log'), 'utf8')).slice(-2000))
