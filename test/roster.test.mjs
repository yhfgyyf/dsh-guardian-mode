
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mergePresetLists, installPresetRoot, GUARDIAN_PRESET_ROOT } from '../lib/roster.js'
import { GUARDIAN_PRESET_ID, GUARDIAN_CAPABILITY } from '../lib/capability.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('preset id and capability are fixed', () => {
  assert.equal(GUARDIAN_PRESET_ID, 'guardian')
  assert.equal(GUARDIAN_CAPABILITY, 'guardian')
})

test('preset.yml declares the guardian mode with order 5', () => {
  const preset = readFileSync(join(root, 'presets/guardian/preset.yml'), 'utf8')
  assert.match(preset, /name: 守护模式/)
  assert.match(preset, /order: 5/)
  assert.match(preset, /capability: guardian/)
})

test('the guardian composition combines PTC presentation and the cordis toolset', () => {
  const composition = readFileSync(join(root, 'presets/guardian/agent.cordis.yml'), 'utf8')
  assert.match(composition, /mode: code/, 'PTC presentation is present')
  assert.match(composition, /tool-cordis/, 'cordis runtime toolset is present')
  assert.match(composition, /skill-filesystem/, 'skill discovery is present')
  assert.match(composition, /tool-skill/, 'skill tool is present')
  assert.match(composition, /tool-bash/, 'shell is present')
  assert.match(composition, /tool-fs/, 'filesystem is present')
  assert.match(composition, /tool-goal/, 'goal tool is present')
  assert.match(composition, /GUARDIAN MODE/, 'guardian persona is present')
  assert.ok(existsSync(join(root, 'presets/guardian/skills/editing-cordis-compositions/SKILL.md')))
})

test('mergePresetLists: package presets win duplicate ids', () => {
  const merged = mergePresetLists([{ id: 'guardian', order: 5 }], [{ id: 'guardian', order: 99 }, { id: 'standard' }])
  assert.deepEqual(merged.map((p) => p.id), ['guardian', 'standard'])
  assert.equal(merged[0].order, 5)
})

test('installPresetRoot extends the list seam and restores on dispose', async () => {
  const originalList = async () => [{ id: 'standard' }]
  const agentPresets = { list: originalList }
  const seen = []
  const discover = async (roots) => {
    seen.push(roots)
    return [{ id: 'guardian' }]
  }
  const dispose = installPresetRoot(agentPresets, discover, '/tmp/presets', 'user')
  const listed = await agentPresets.list()
  assert.deepEqual(listed.map((p) => p.id), ['guardian', 'standard'])
  assert.deepEqual(seen, [[{ path: '/tmp/presets', trust: 'user' }]])
  dispose()
  assert.equal(agentPresets.list, originalList)
})
