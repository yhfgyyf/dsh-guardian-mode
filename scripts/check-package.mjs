import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const patch = await readFile(join(root, manifest.dsh?.bundle?.patch ?? ''), 'utf8')
const preset = await readFile(join(root, 'presets/audit/preset.yml'), 'utf8')
const composition = await readFile(join(root, 'presets/audit/agent.cordis.yml'), 'utf8')
const client = await readFile(join(root, 'lib/client.js'), 'utf8')
const codex = await readFile(join(root, 'lib/codex.js'), 'utf8')
const api = await readFile(join(root, 'lib/api.js'), 'utf8')

assert.equal(manifest.name, 'dsh-audit-mode')
assert.equal(manifest.type, 'module')
assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
assert.equal(manifest.dsh.client.platform, 'web')
assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'))
assert.match(patch, /- id: audit-bundle/mu)
assert.match(patch, /name: dsh-audit-mode/mu)
assert.ok(/^id: audit/mu.test(preset) || /capability: audit/mu.test(preset))
assert.match(composition, /tool-cordis/mu)
assert.match(composition, /mode: !!js/mu)
assert.match(composition, /'ptc' : 'code'/mu)
assert.match(composition, /skill-filesystem/mu)
assert.match(composition, /tool-skill/mu)
assert.doesNotMatch(composition, /customSkillDirs/mu)
assert.ok(manifest.peerDependencies['@deepseek-ai/dsh-llm'])
assert.ok(manifest.peerDependencies['@deepseek-ai/dsh-skill'])
assert.match(client, /id: "audit"/u)
assert.match(client, /order: 5/u)
assert.match(codex, /gpt-5\.6-luna/u)
assert.match(codex, /gpt-5\.6-sol/u)
assert.match(codex, /experimentalApi: true/u)
assert.match(api, /\/snapshot/u)
assert.match(api, /\/watch/u)
assert.match(api, /\/request-now/u)
assert.match(api, /\/accept/u)
assert.match(api, /\/resume/u)

for (const relative of [
  'index.js',
  'lib/client.js',
  'presets/audit/preset.yml',
  'presets/audit/agent.cordis.yml',
  'presets/audit/skills/cordis-plugin-development/SKILL.md',
  'presets/audit/skills/editing-cordis-compositions/SKILL.md',
  'README.md',
  'README.zh-CN.md',
  'LICENSE',
  '.github/workflows/ci.yml'
]) {
  await access(join(root, relative))
}

console.log('dsh.bundle manifest, patch, audit preset, and client dock asset are complete')
