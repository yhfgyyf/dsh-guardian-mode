// Build presets/audit/agent.cordis.yml from the shipped code + cordis
// compositions: code (PTC) first, then cordis-specific rows replace/append.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

function findShipped (name) {
  const source = process.env.DSH_SOURCE
  if (source === undefined || source === '') {
    throw new Error('DSH_SOURCE must point to the shipped config/agent-presets directory')
  }
  return join(source, name, 'agent.cordis.yml')
}

function parseRows (file) {
  const text = readFileSync(file, 'utf8')
  // the shipped files are literal YAML lists; we re-emit them verbatim for
  // compatibility instead of parsing (comments and !!js expressions survive).
  return text
}

if (!process.argv.includes('--raw-only')) {
  // Take code fully, add the package skill directory to its existing skill
  // provider, and append only Cordis's self-modification tool. Appending the
  // full block would duplicate both skill-filesystem and tool-skill ids.
  const code = parseRows(findShipped('code'))
  const cordis = parseRows(findShipped('cordis'))
  const withSkills = code.replace(
    "- id: skill-filesystem\n  name: '@deepseek-ai/dsh-skill-filesystem'\n",
    "- id: skill-filesystem\n  name: '@deepseek-ai/dsh-skill-filesystem'\n  config:\n    customSkillDirs:\n      - !!js \"process.getBuiltinModule('node:url').fileURLToPath(new URL('skills/', baseUrl))\"\n"
  )
  const toolCordis = cordis.match(/- id: tool-cordis\n  name: '@deepseek-ai\/dsh-tool-cordis'/u)?.[0]
  if (toolCordis === undefined) throw new Error('shipped cordis preset has no tool-cordis row')
  mkdirSync(join(root, 'presets', 'audit'), { recursive: true })
  writeFileSync(join(root, 'presets', 'audit', 'agent.cordis.yml'),
    withSkills.replace(/\n$/, '') + '\n\n# ── self-modification ───────────────────────────────────────────────────────\n\n' + toolCordis + '\n')
  console.log('presets/audit/agent.cordis.yml rebuilt from shipped code + cordis')
}
