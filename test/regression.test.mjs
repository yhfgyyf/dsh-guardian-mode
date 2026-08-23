
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dshRoot = resolve(root, '../dsh-auto-preset-router')

test('the auto router still routes exactly the original four modes', () => {
  const router = readFileSync(join(dshRoot, 'presets/auto/router.js'), 'utf8')
  const match = router.match(/ROUTABLE_PRESETS = Object\.freeze\(\[([^\]]+)]\)/)
  assert.ok(match, 'ROUTABLE_PRESETS declaration found')
  const modes = match[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean)
  assert.deepEqual(modes, ['standard', 'code', 'minimal', 'cordis'])
  assert.ok(!modes.includes('guardian'), 'guardian must not be auto-routed')
  assert.match(router, /decision priority/i)
  // the ROUTER_SYSTEM_PROMPT still names only four presets
  const prompt = router.match(/export const ROUTER_SYSTEM_PROMPT = `([\s\S]*?)`/)
  assert.ok(prompt)
  assert.doesNotMatch(prompt[1], /guardian/)
})

test('the guardian bundle never touches session.delete or session removal APIs', () => {
  const libs = readdirSync(join(root, 'lib'))
  for (const file of libs) {
    const src = readFileSync(join(root, 'lib', file), 'utf8')
    assert.doesNotMatch(src, /session\.delete|sessions\.delete/i, file + ' must not call session.delete')
  }
})

test('image and skill surfaces are preserved in the guardian preset', () => {
  const composition = readFileSync(join(root, 'presets/guardian/agent.cordis.yml'), 'utf8')
  assert.match(composition, /tool-skill/)
  assert.match(composition, /skill-filesystem/)
  assert.match(composition, /tool-bash/)          // shell (image pipelines)
  assert.match(composition, /tool-fs/)            // filesystem reads
  const personality = readFileSync(join(root, 'presets/guardian/agent.cordis.yml'), 'utf8')
  assert.match(personality, /agent-instructions/)
})
