import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { CODEX_DEFAULTS, CodexClient, CodexCompanion } from './codex.js'
import { ReviewerError } from './reviewer-error.js'

export const REVIEWER_TYPES = Object.freeze(['codex', 'claude-code', 'dsh'])

export const REVIEWER_DEFAULTS = Object.freeze({
  reviewer: 'codex',
  binary: 'codex',
  args: ['app-server', '--stdio'],
  claudeBinary: 'claude',
  claudeArgs: [],
  dshProvider: 'deepseek-official',
  dshMaxTokens: 4096,
  requestTimeoutMs: 180_000,
  models: CODEX_DEFAULTS
})

function copyModel (fallback, value) {
  return {
    ...fallback,
    ...(value ?? {}),
    ...(value?.provider === '' ? { provider: undefined } : {})
  }
}

/** Normalize old Codex-only config and the new reviewer backend fields. */
export function resolveReviewerOptions (config = {}) {
  const reviewer = typeof config.reviewer === 'object'
    ? config.reviewer?.type
    : config.reviewer
  const type = reviewer ?? REVIEWER_DEFAULTS.reviewer
  if (!REVIEWER_TYPES.includes(type)) throw new ReviewerError(`unsupported guardian reviewer: ${String(type)}`, 'REVIEWER_UNSUPPORTED')
  return {
    type,
    binary: config.binary ?? REVIEWER_DEFAULTS.binary,
    args: [...(config.args ?? REVIEWER_DEFAULTS.args)],
    claudeBinary: config.claudeBinary ?? REVIEWER_DEFAULTS.claudeBinary,
    claudeArgs: [...(config.claudeArgs ?? REVIEWER_DEFAULTS.claudeArgs)],
    dshProvider: config.dshProvider ?? REVIEWER_DEFAULTS.dshProvider,
    dshMaxTokens: config.dshMaxTokens ?? REVIEWER_DEFAULTS.dshMaxTokens,
    requestTimeoutMs: config.requestTimeoutMs ?? REVIEWER_DEFAULTS.requestTimeoutMs,
    models: {
      luna: copyModel(CODEX_DEFAULTS.luna, config.models?.luna),
      sol: copyModel(CODEX_DEFAULTS.sol, config.models?.sol)
    }
  }
}

function outputText (payload) {
  if (payload?.structured_output !== undefined) return JSON.stringify(payload.structured_output)
  if (typeof payload?.result === 'string') return payload.result
  if (payload?.result !== undefined) return JSON.stringify(payload.result)
  if (typeof payload?.message?.content === 'string') return payload.message.content
  if (Array.isArray(payload?.message?.content)) {
    return payload.message.content.filter(block => block?.type === 'text').map(block => block.text).join('\n')
  }
  return ''
}

const CLAUDE_MANAGED_FLAGS = Object.freeze([
  '--allowed-tools', '--allowedTools', '--dangerously-skip-permissions',
  '--continue', '--disable-slash-commands', '--disallowed-tools',
  '--disallowedTools', '--effort', '--fallback-model',
  '--fork-session', '--json-schema', '--mcp-config', '--model',
  '--no-session-persistence', '--output-format', '--permission-mode',
  '--plugin-dir', '--plugin-url', '--resume', '--safe-mode', '--session-id',
  '--system-prompt', '--tools'
])

function validateClaudeArgs (args) {
  const unsafe = args.find(arg => CLAUDE_MANAGED_FLAGS.some(flag => arg === flag || arg.startsWith(flag + '=')))
  if (unsafe !== undefined) {
    throw new ReviewerError(`claudeArgs cannot override Guardian-managed flag ${unsafe}`, 'CLAUDE_ARGS_CONFLICT')
  }
}

/** One non-interactive, read-only Claude Code process per reviewer turn. */
export class ClaudeCodeClient {
  constructor ({ binary = 'claude', args = [], env, onLog, requestTimeoutMs = 180_000 } = {}) {
    this.type = 'claude-code'
    this.supportsPersistence = true
    validateClaudeArgs(args)
    this.binary = binary
    this.args = args
    this.env = env
    this.onLog = onLog
    this.requestTimeoutMs = requestTimeoutMs
    this.fresh = new Set()
    this.forkParents = new Map()
  }

  async start () { return this }

  async startThread () {
    const id = randomUUID()
    this.fresh.add(id)
    return id
  }

  async resumeThread ({ threadId }) { return threadId }

  async forkThread ({ threadId }) {
    const pending = randomUUID()
    this.forkParents.set(pending, threadId)
    return pending
  }

  async archiveThread () {}
  async setThreadName () {}

  async _run (args) {
    return await new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: this.env ?? process.env
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (callback) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        callback()
      }
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        finish(() => reject(new ReviewerError('claude code reviewer timed out', 'CLAUDE_TURN_TIMEOUT')))
      }, this.requestTimeoutMs)
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => {
        stderr += chunk
        this.onLog?.('[claude.stderr] ' + chunk.trim())
      })
      child.stdout.on('data', () => {
        if (stdout.length > 2_000_000) {
          child.kill('SIGTERM')
          finish(() => reject(new ReviewerError('claude code response exceeded 2 MB', 'CLAUDE_RESPONSE_TOO_LARGE')))
        }
      })
      child.stderr.on('data', () => { if (stderr.length > 200_000) stderr = stderr.slice(-200_000) })
      child.on('error', error => finish(() => reject(new ReviewerError('claude code failed to start: ' + error.message, 'CLAUDE_SPAWN_FAILED'))))
      child.on('exit', (code, signal) => finish(() => {
        if (code === 0) resolve(stdout)
        else reject(new ReviewerError(`claude code exited (${String(code)}, ${String(signal)}): ${stderr.trim().slice(0, 2000)}`, 'CLAUDE_EXITED'))
      }))
    })
  }

  async runTurn ({ threadId, text, model, effort, outputSchema, baseInstructions }) {
    const parent = this.forkParents.get(threadId)
    const command = [
      ...this.args,
      '--print',
      '--output-format', 'json',
      '--permission-mode', 'plan',
      '--tools', '',
      '--safe-mode',
      '--disable-slash-commands',
      '--model', model
    ]
    if (effort !== undefined && effort !== '') command.push('--effort', effort)
    if (outputSchema !== undefined) command.push('--json-schema', JSON.stringify(outputSchema))
    if (baseInstructions !== undefined) command.push('--system-prompt', baseInstructions)
    if (parent !== undefined) command.push('--resume', parent, '--fork-session')
    else if (this.fresh.has(threadId)) command.push('--session-id', threadId)
    else command.push('--resume', threadId)
    command.push(text)

    let payload
    try { payload = JSON.parse((await this._run(command)).trim()) } catch (error) {
      if (error instanceof ReviewerError) throw error
      throw new ReviewerError('claude code returned malformed JSON: ' + error.message, 'CLAUDE_MALFORMED_RESPONSE')
    }
    const answer = outputText(payload).trim()
    if (answer === '') throw new ReviewerError('claude code completed without a result', 'CLAUDE_EMPTY_RESPONSE', payload)
    this.fresh.delete(threadId)
    this.forkParents.delete(threadId)
    return { text: answer, threadId: payload.session_id ?? threadId, result: payload }
  }

  async close () {}
}

function message (role, text, source) {
  return Object.freeze({
    id: `guardian-${randomUUID()}`,
    role,
    content: Object.freeze([{ type: 'text', text }]),
    source: Object.freeze(source)
  })
}

function assembledText (parts) {
  return [...parts.entries()].sort(([left], [right]) => left - right).map(([, value]) => value).join('').trim()
}

function jsonObjects (text) {
  const values = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') {
      if (depth === 0) start = index
      depth += 1
    } else if (char === '}' && depth > 0 && --depth === 0) {
      try { values.push(JSON.parse(text.slice(start, index + 1))) } catch {}
      start = -1
    }
  }
  return values
}

function structuredAnswer (answer, schema) {
  if (schema === undefined) return answer
  const required = Array.isArray(schema.required) ? schema.required : []
  const candidates = jsonObjects(answer).filter(value => (
    typeof value === 'object' && value !== null && !Array.isArray(value) &&
    required.every(key => Object.hasOwn(value, key))
  ))
  return candidates.length === 0 ? answer : JSON.stringify(candidates.at(-1))
}

/** Direct provider-neutral call through the host DSH LLM runtime. */
export class DshReviewerClient {
  constructor ({ llm, provider = 'deepseek-official', maxTokens = 4096, requestTimeoutMs = 180_000 } = {}) {
    this.type = 'dsh'
    this.supportsPersistence = false
    this.llm = llm
    this.provider = provider
    this.maxTokens = maxTokens
    this.requestTimeoutMs = requestTimeoutMs
  }

  async start () {
    if (this.llm?.stream === undefined) throw new ReviewerError('DSH reviewer requires the host llm service', 'DSH_LLM_UNAVAILABLE')
    return this
  }

  async startThread () { return `dsh-${randomUUID()}` }
  async resumeThread ({ threadId }) { return threadId }
  async forkThread () { return `dsh-${randomUUID()}` }
  async archiveThread () {}
  async setThreadName () {}

  async runTurn ({ threadId, text, model, effort, provider, outputSchema, baseInstructions }) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new ReviewerError('DSH reviewer timed out', 'DSH_TURN_TIMEOUT')), this.requestTimeoutMs)
    const framed = outputSchema === undefined
      ? text
      : `${text}\n\nReturn one JSON value matching this schema exactly:\n${JSON.stringify(outputSchema)}`
    const route = provider ?? this.provider
    const parts = new Map()
    let terminal
    try {
      for await (const chunk of this.llm.stream({
        provider: route,
        model,
        reasoningEffort: effort,
        messages: [message('user', framed, { kind: 'plugin', plugin: 'dsh-guardian-mode' })],
        system: baseInstructions,
        tools: [],
        temperature: 0,
        maxTokens: this.maxTokens,
        signal: controller.signal
      })) {
        if (chunk.type === 'text-delta') parts.set(chunk.index, `${parts.get(chunk.index) ?? ''}${chunk.text}`)
        else if (chunk.type === 'block-end' && chunk.block?.type === 'text') parts.set(chunk.index, chunk.block.text)
        else if (chunk.type === 'finish') terminal = chunk.reason
      }
    } catch (error) {
      if (controller.signal.aborted) throw new ReviewerError('DSH reviewer timed out', 'DSH_TURN_TIMEOUT')
      throw new ReviewerError('DSH reviewer stream failed: ' + (error?.message ?? String(error)), error?.code ?? 'DSH_STREAM_FAILED')
    } finally {
      clearTimeout(timer)
    }
    const rawAnswer = assembledText(parts)
    if (terminal?.kind === 'error' || terminal?.kind === 'aborted') {
      throw new ReviewerError(terminal.failure?.message ?? 'DSH reviewer failed', terminal.failure?.code ?? 'DSH_PROVIDER_ERROR')
    }
    if (terminal?.kind === 'max-tokens') throw new ReviewerError('DSH reviewer output limit exceeded', 'DSH_MAX_TOKENS')
    if (terminal?.kind === 'tool-calls') throw new ReviewerError('DSH reviewer unexpectedly requested a tool', 'DSH_TOOL_CALLS')
    if (rawAnswer === '') throw new ReviewerError('DSH reviewer completed without text', 'DSH_EMPTY_RESPONSE')
    const answer = structuredAnswer(rawAnswer, outputSchema)
    return {
      text: answer,
      threadId,
      rawText: rawAnswer,
      message: message('assistant', answer, { kind: 'model', provider: route, model })
    }
  }

  async close () {}
}

export function createReviewerCompanion (ctx, config = {}, { cwd = process.cwd(), onLog } = {}) {
  const options = resolveReviewerOptions(config)
  let client
  if (options.type === 'codex') {
    client = new CodexClient({
      binary: options.binary,
      args: options.args,
      requestTimeoutMs: options.requestTimeoutMs,
      onLog
    })
  } else if (options.type === 'claude-code') {
    client = new ClaudeCodeClient({
      binary: options.claudeBinary,
      args: options.claudeArgs,
      requestTimeoutMs: options.requestTimeoutMs,
      onLog
    })
  } else {
    client = new DshReviewerClient({
      llm: ctx?.llm,
      provider: options.dshProvider,
      maxTokens: options.dshMaxTokens,
      requestTimeoutMs: options.requestTimeoutMs
    })
  }
  return new CodexCompanion(client, { models: options.models, cwd })
}

export { ReviewerError }
