const args = process.argv.slice(2)

function value (flag) {
  const at = args.indexOf(flag)
  return at < 0 ? undefined : args[at + 1]
}

const required = [
  ['--output-format', 'json'],
  ['--permission-mode', 'plan'],
  ['--tools', '']
]
for (const [flag, expected] of required) {
  if (value(flag) !== expected) {
    process.stderr.write(`missing safe reviewer flag ${flag}\n`)
    process.exit(2)
  }
}
for (const flag of ['--print', '--safe-mode', '--disable-slash-commands', '--model', '--system-prompt']) {
  if (!args.includes(flag)) {
    process.stderr.write(`missing reviewer flag ${flag}\n`)
    process.exit(2)
  }
}

const schema = JSON.parse(value('--json-schema') ?? '{}')
const audit = schema.properties?.verdict !== undefined
const result = audit
  ? { verdict: 'pass', summary: 'claude reviewed', findings: [] }
  : { intent: 'test', progress: 'claude summarized', evidence: ['fixture'], risks: [], next: ['audit'] }
const parent = value('--resume')
const sessionId = args.includes('--fork-session') ? `forked-${parent}` : (value('--session-id') ?? parent)
process.stdout.write(JSON.stringify({ type: 'result', session_id: sessionId, structured_output: result }))
