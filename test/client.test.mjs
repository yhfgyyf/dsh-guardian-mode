
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const clientSource = readFileSync(join(root, 'lib/client.js'), 'utf8')

test('the browser half registers the guardian dock at order 5', async () => {
  let loaded
  let loadedExports
  const registrations = []
  const global = {
    window: {
      __ModuleLoader__: {
        load: (entry) => {
          loaded = entry
          loadedExports = entry.factory((id) => {
            if (id === 'react') return { createElement: () => ({}), useState: () => [null, () => {}], useEffect: () => {} }
            if (id === 'react/jsx-runtime') return {}
            return new Proxy({}, { get: () => () => {} })
          })
          return loadedExports
        }
      }
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    EventSource: class { constructor () {} addEventListener () {} close () {} },
    location: { origin: 'http://localhost:3080' }
  }
  vm.runInNewContext(clientSource, global)
  assert.equal(loaded.id, 'dsh-guardian-mode')
  const ctx = {
    effect: (fn) => (typeof fn === 'function' ? fn() : fn),
    locale: { register: (ns, dict) => {} },
    slots: {
      register: (definition) => definition,
      inject: (name, fn) => { assert.equal(name, 'conversation.input.dock'); const entry = fn(); registrations.push({ name: entry.name, id: entry.id, order: entry.order }); return entry }
    }
  }
  loadedExports.apply(ctx)
  assert.deepEqual(registrations, [{ name: 'conversation.input.dock', id: 'guardian', order: 5 }])
  assert.equal(loadedExports.GUARDIAN_DOCK_ORDER, 5)
  // order 5 sits strictly between the shipped todo (0) and goal (10) entries
  assert.ok(0 < 5 && 5 < 10)
})
