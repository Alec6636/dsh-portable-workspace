// Temporary harness: declare missing plugins on the H: workspace so the
// "missing plugins" dialog can be exercised through the real UI.
import { updateWorkspace, readWorkspace } from '../lib/workspace.js'

const root = 'H:/Portable-DSH'
const id = 'ws-c9390308e09f'
const plugins = process.argv[2] === 'clear'
  ? []
  : [
      { name: 'dsh-pw-required-demo', version: '1.0.0' },
      { name: 'dsh-pw-optional-demo', optional: true },
    ]
await updateWorkspace(root, id, { plugins })
const found = await readWorkspace(root, id)
console.log('plugins now =', JSON.stringify(found.manifest.plugins))
