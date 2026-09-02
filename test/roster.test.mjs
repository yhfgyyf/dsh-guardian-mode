
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mergePresetLists, installPresetRoot, AUDIT_PRESET_ROOT } from '../lib/roster.js'
import { AUDIT_PRESET_ID, AUDIT_CAPABILITY } from '../lib/capability.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('preset id and capability are fixed', () => {
  assert.equal(AUDIT_PRESET_ID, 'audit')
  assert.equal(AUDIT_CAPABILITY, 'audit')
})

test('preset.yml declares the audit mode with order 5', () => {
  const preset = readFileSync(join(root, 'presets/audit/preset.yml'), 'utf8')
  assert.match(preset, /name: 审计模式/)
  assert.match(preset, /order: 5/)
  assert.match(preset, /capability: audit/)
})

test('the audit composition combines PTC presentation and the cordis toolset', () => {
  const composition = readFileSync(join(root, 'presets/audit/agent.cordis.yml'), 'utf8')
  assert.match(composition, /mode: !!js/, 'presentation mode follows the installed DSH enum')
  assert.match(composition, /'ptc' : 'code'/, 'alpha and rc presentation enums are supported')
  assert.match(composition, /tool-cordis/, 'cordis runtime toolset is present')
  assert.match(composition, /skill-filesystem/, 'skill discovery is present')
  assert.match(composition, /tool-skill/, 'skill tool is present')
  assert.doesNotMatch(composition, /customSkillDirs/, 'remediation skills are not standing catalog entries')
  assert.match(composition, /tool-bash/, 'shell is present')
  assert.match(composition, /tool-fs/, 'filesystem is present')
  assert.match(composition, /tool-goal/, 'goal tool is present')
  assert.match(composition, /AUDIT MODE/, 'audit persona is present')
  assert.ok(existsSync(join(root, 'presets/audit/skills/editing-cordis-compositions/SKILL.md')))
})

test('mergePresetLists: package presets win duplicate ids', () => {
  const merged = mergePresetLists([{ id: 'audit', order: 5 }], [{ id: 'audit', order: 99 }, { id: 'standard' }])
  assert.deepEqual(merged.map((p) => p.id), ['audit', 'standard'])
  assert.equal(merged[0].order, 5)
})

test('installPresetRoot extends the list seam and restores on dispose', async () => {
  const originalList = async () => [{ id: 'standard' }]
  const originalResolve = async function (id) { return (await this.list()).find((preset) => preset.id === id) }
  const agentPresets = { list: originalList, resolve: originalResolve }
  const seen = []
  const discover = async (roots, harnessBase) => {
    seen.push({ roots, harnessBase })
    return [{ id: 'audit' }]
  }
  const dispose = installPresetRoot(agentPresets, discover, '/tmp/presets', 'user', 'file:///harness/')
  const listed = await agentPresets.list()
  assert.deepEqual(listed.map((p) => p.id), ['audit', 'standard'])
  assert.deepEqual(seen, [{
    roots: [{ path: '/tmp/presets', trust: 'user' }],
    harnessBase: 'file:///harness/'
  }])
  const retiredId = ['guard', 'ian'].join('')
  assert.equal((await agentPresets.resolve(retiredId)).id, 'audit')
  dispose()
  assert.equal(agentPresets.list, originalList)
  assert.equal(agentPresets.resolve, originalResolve)
})
