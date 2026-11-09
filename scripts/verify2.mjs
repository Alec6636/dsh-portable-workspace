// Focused verification for the remaining plugin-dependency + migration logic.
// Runs in plain node (no DSH host), using the portable libs directly.
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import {
  ensurePortableRoot, createWorkspace, readWorkspace, listWorkspaces,
  migrateWorkspace, saveWorkspace, workspacePaths, layoutOf,
} from '../lib/workspace.js'
import { checkPlugins } from '../lib/profile.js'
import { resolveInstallation } from '../lib/launcher.js'
import { findPortableRoots } from '../lib/volumes.js'
import { healSessionCwds, countSessionLogs } from '../lib/sessions.js'
import { readJson, writeJson, writeText, ensureDir, removeTree, exists } from '../lib/fsx.js'

const base = join('E:/DSH工作区/portable-workspace-plugin', '_verify2')
const src = join(base, 'src', 'Portable-DSH')
const dst = join(base, 'dst', 'Portable-DSH')

function log(...args) { console.log(...args) }

// ---- 1. plugin classification (required / optional / present) -------------
const installation = await resolveInstallation('D:/Programs/DeepSeek Harness/resources')
if (installation === undefined) throw new Error('resolveInstallation failed')
const decl = [
  { name: '@deepseek-ai/dsh-session-persistence-jsonl' }, // present in asar
  { name: 'dsh-some-required-plugin', version: '1.2.3' }, // missing required
  { name: 'dsh-some-optional-plugin', optional: true },    // missing optional
]
const check = await checkPlugins(decl, { profileDir: join(base, 'no-such-profile'), installation })
log('[plugins] items=', check.items.map(i => `${i.name}:${i.present ? 'present' : i.optional ? 'optional-missing' : 'required-missing'}`).join(', '))
log('[plugins] missing=', check.missing.map(i => i.name).join(',') || '(none)')
log('[plugins] optionalMissing=', check.optionalMissing.map(i => i.name).join(',') || '(none)')
log('[plugins] gaps surfaced =', check.missing.length > 0 || check.optionalMissing.length > 0)
if (check.missing.length !== 1 || check.optionalMissing.length !== 1 || check.items[0].present !== true) {
  throw new Error('plugin classification broken')
}

// ---- 2. migration: build a source root with one workspace + one session ---
await removeTree(base).catch(() => {})
await ensurePortableRoot(src)
const created = await createWorkspace(src, { name: '迁移验证', password: '' })
const { paths } = created
const wd = join(paths.projectDir, 'deepseek-harness', 'default-workspace')
await ensureDir(wd)
// fake session log with an absolute cwd pointing at the old machine path
const oldCwd = 'C:\\Users\\Alec\\Documents\\deepseek-harness\\default-workspace'
await ensureDir(join(paths.sessionsDir, '--C-Users-Alec-Documents-deepseek-harness-default-workspace--', 'session-fake'))
await writeText(join(paths.sessionsDir, '--C-Users-Alec-Documents-deepseek-harness-default-workspace--', 'session-fake', 'session.v4.jsonl.zstd'), 'placeholder')
// workspace registry pointing at old cwd
await writeJson(join(paths.storagesDir, 'workspace.json'), { tables: { workspaces: [{ id: 'w1', path: oldCwd, name: 'x' }] } })
// declare plugins so they survive the copy
const before = await readWorkspace(src, created.manifest.id)
before.manifest.plugins = decl
await saveWorkspace(paths, before.manifest)

log('[migrate] source sessions before =', countSessionLogs(paths.sessionsDir))

// ---- 3. migrate copy (move:false) ------------------------------------------
const copyResult = await migrateWorkspace(src, created.manifest.id, dst, { move: false })
const { toPaths } = copyResult
log('[migrate] copy dir =', toPaths.dir)
log('[migrate] sessions healed =', copyResult.sessions.rewritten, 'registry healed =', copyResult.registry)
const copied = await readWorkspace(dst, created.manifest.id)
log('[migrate] copied rootId =', copied.manifest.rootId, 'origin =', JSON.stringify(copied.manifest.origin))
log('[migrate] copied plugins =', copied.manifest.plugins.length)
const srcStill = await readWorkspace(src, created.manifest.id)
log('[migrate] source still present (copy) =', srcStill !== undefined)
if (copied.manifest.rootId === before.manifest.rootId) throw new Error('rootId not re-pointed')
if (copied.manifest.plugins.length !== 3) throw new Error('plugins lost in copy')
if (srcStill === undefined) throw new Error('copy deleted source')
if (copyResult.registry !== 1) throw new Error('registry not healed')

// ---- 4. findPortableRoots sees the non-drive target via extraPaths ---------
const roots = await findPortableRoots([src, dst])
log('[roots] found =', roots.map(r => `${r.root}${r.external ? ' (external)' : ''}`).join(' | '))
const externalHit = roots.find(r => r.root.replace(/\\/g, '/').toLowerCase() === dst.replace(/\\/g, '/').toLowerCase() && r.external === true)
if (externalHit === undefined) throw new Error('migrated root not re-discovered via extraPaths')

// ---- 5. migrate move (move:true) deletes the source ------------------------
const moveResult = await migrateWorkspace(dst, created.manifest.id, join(base, 'dst2', 'Portable-DSH'), { move: true })
log('[migrate] move dir =', moveResult.toPaths.dir)
const gone = await readWorkspace(dst, created.manifest.id)
log('[migrate] source deleted after move =', gone === undefined)
if (gone !== undefined) throw new Error('move did not delete source')

log('=== ALL VERIFY2 CHECKS PASSED ===')
