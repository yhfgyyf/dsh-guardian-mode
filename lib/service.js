import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { REVIEWER_MODEL_DEFAULTS } from './codex.js'
import { createReviewerCompanion, resolveReviewerOptions } from './reviewer.js'
import { GuardianEngine } from './engine.js'
import { GUARDIAN_PRESET_ID } from './capability.js'
import { GUARDIAN_SERVICE } from './invariant.js'
import { SidecarStore } from './sidecar.js'
import { redactText } from './trace.js'

const GUARDIAN_PLUGIN = 'dsh-guardian-mode'
const CORDIS_TOOL_NAMES = Object.freeze([
  'cordis_inspect_list',
  'cordis_inspect_query',
  'cordis_inspect_self',
  'cordis_define',
  'cordis_run',
  'cordis_stop',
  'cordis_undefine'
])
const REMEDIATION_SKILLS = Object.freeze([
  {
    name: 'editing-cordis-compositions',
    description: 'Create, modify, or mount-validate a DSH Cordis agent preset or composition.'
  },
  {
    name: 'cordis-plugin-development',
    description: 'Create, inspect, test, repair, or extend a DSH Cordis plugin or model-facing tool when Guardian mode needs a missing capability.'
  }
])
const SKILL_ROOT = new URL('../presets/guardian/skills/', import.meta.url)

function guardianMessage (text) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: GUARDIAN_PLUGIN }
  })
}

function isRemediationMessage (message) {
  return message?.source?.kind === 'plugin' && message.source.plugin === GUARDIAN_PLUGIN
}

function capabilityLeasePrompt (remediation, skills) {
  return [
    `<guardian-capability-lease id="${String(remediation.id)}">`,
    'This temporary capability lease is active only for the accepted critical remediation.',
    'Load the `editing-cordis-compositions` skill through the stable `skill` tool before changing DSH.',
    'Load `cordis-plugin-development` only when the accepted remediation changes a plugin or model-facing tool.',
    `Available remediation skills: ${skills.map(skill => `\`${skill.name}\``).join(', ')}.`,
    `Temporarily authorized Cordis tools: ${CORDIS_TOOL_NAMES.map(name => `\`${name}\``).join(', ')}.`,
    'Use search_tools and describe_tools when they are available; otherwise use the exact tools declared by the current DSH presentation.',
    'All calls remain subject to DSH permission, approval, guard, scheduling, and audit policy.',
    '</guardian-capability-lease>'
  ].join('\n')
}

function stripFrontmatter (raw) {
  return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
}

async function loadRemediationSkills () {
  return await Promise.all(REMEDIATION_SKILLS.map(async (summary) => {
    const url = new URL(`${summary.name}/SKILL.md`, SKILL_ROOT)
    return {
      ...summary,
      content: stripFrontmatter(await readFile(url, 'utf8')),
      source: 'bundled',
      path: fileURLToPath(url),
      resourceBase: { kind: 'directory', path: dirname(fileURLToPath(url)) },
      invocation: { modelInvocable: true, userInvocable: false },
      provider: GUARDIAN_PLUGIN
    }
  }))
}

function modelConfig (model, effort) {
  return z.object({
    model: z.string().default(model),
    effort: z.string().default(effort),
    provider: z.string().default('')
  }).default(undefined)
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  reviewer: z.union(['codex', 'claude-code', 'dsh']).default('codex'),
  // Codex app-server (binary/args retain the original public config names).
  binary: z.string().default('codex'),
  args: z.array(z.string()).default(['app-server', '--stdio']),
  // Claude Code print-mode adapter.
  claudeBinary: z.string().default('claude'),
  claudeArgs: z.array(z.string()).default([]),
  // Direct calls through the host DSH LLM runtime.
  dshProvider: z.string().default('deepseek-official'),
  dshMaxTokens: z.number().min(256).default(4096),
  requestTimeoutMs: z.number().min(1000).default(180_000),
  reconcileIntervalMs: z.number().min(1000).default(15_000),
  models: z.object({
    summarizer: modelConfig('gpt-5.6-luna', 'medium'),
    auditor: modelConfig('gpt-5.6-sol', 'max'),
    // Deprecated aliases retained so existing profile patches still validate.
    luna: modelConfig('gpt-5.6-luna', 'medium'),
    sol: modelConfig('gpt-5.6-sol', 'max')
  }).default(REVIEWER_MODEL_DEFAULTS)
})

function selectedPreset (session) {
  let preset = session?.header?.agentPreset ?? session?.meta?.agentPreset
  for (const event of session?.events ?? []) {
    if (event.type === 'agent-preset/selected') preset = event.data?.agentPreset
  }
  return preset
}

function anomalyEvent (event) {
  return event?.type === 'llm/retry' ||
    (event?.type === 'tool/result' && event.data?.error !== undefined) ||
    (event?.type === 'turn/end' && event.data?.reason?.kind === 'error')
}

export class GuardianService extends Service {
  static inject = ['agents', 'sessionPersistence', 'llm']

  constructor (ctx, config = {}) {
    super(ctx, GUARDIAN_SERVICE)
    const reviewer = resolveReviewerOptions(config)
    this.options = {
      enabled: true,
      reconcileIntervalMs: 15_000,
      ...config,
      ...reviewer
    }
    this.store = new SidecarStore()
    this.engines = new Map()
    this.activations = new Map()
    this.listeners = new Map()
    this.locks = new Map()
    this.anomalies = new Set()
    this.missing = new Map()
    this.dynamicCapabilities = new Map()
    this.runtime = new Map()

    ctx.on('session/created', (session) => {
      if (this._guardedSession(session)) void this._withLock(session.id, () => this._activate(session)).catch((error) => this._warn(error))
    })
    ctx.on('agent-preset/selected', (sessionId, preset) => {
      if (preset !== GUARDIAN_PRESET_ID) return
      const agent = ctx.agents.get(String(sessionId))
      if (agent !== undefined) void this._withLock(String(sessionId), async () => {
        await this._activate(agent.session)
        this._ensureCordisRestricted(agent)
      }).catch((error) => this._warn(error))
    })
    ctx.on('session/event', (session, event) => {
      if (!this._guardedSession(session)) return
      const id = String(session.id)
      if (anomalyEvent(event)) this.anomalies.add(id)
      if (event.type === 'step/end') {
        const anomaly = this.anomalies.delete(id)
        void this._withLock(id, async () => {
          const engine = await this._activate(session)
          await engine.noteStep(id, { anomaly })
          this._emit(id)
        }).catch((error) => this._warn(error))
      }
      if (event.type === 'turn/end') {
        void this._withLock(id, () => this._verifyRemediation(id, event.data?.reason)).catch((error) => this._warn(error))
      }
    })
    ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      if (!this._guardedAgent(agent) || !isRemediationMessage(message)) return
      const id = String(agent.session.id)
      void this._withLock(id, async () => {
        const engine = await this._activate(agent.session)
        await engine.remediationRunning(id)
        this._emit(id)
      }).catch((error) => this._warn(error))
    })
    ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
      if (!this._guardedAgent(agent)) return await next()
      const id = String(agent.session.id)
      const blocked = await this._withLock(id, async () => {
        const engine = await this._activate(agent.session)
        this._ensureCordisRestricted(agent)
        let before = await engine.get(id)
        if (before?.remediation?.phase === 'queued' && messages?.some(isRemediationMessage)) {
          await engine.remediationRunning(id)
          before = await engine.get(id)
        }
        if (before?.remediation?.phase === 'running') return false
        if (before?.paused) return true
        if (await engine.due(id)) {
          const result = await engine.audit(id, agent.session.events, {
            objective: this._objective(agent),
            reason: 'auto'
          })
          this._emit(id)
          if (result.state?.paused) {
            this._pauseGoal(agent)
            return true
          }
        }
        return false
      })
      return blocked ? { kind: 'reject' } : await next()
    })
    ctx.on('agent/turn-stopping', async ({ agent }) => {
      if (!this._guardedAgent(agent) || !this._isTaskEnding(agent)) return
      const id = String(agent.session.id)
      await this._withLock(id, async () => {
        const engine = await this._activate(agent.session)
        const before = await engine.get(id)
        if (before?.remediation !== undefined && ['queued', 'running', 'verifying'].includes(before.remediation.phase)) return
        const result = await engine.audit(id, agent.session.events, {
          objective: this._objective(agent),
          reason: 'final',
          final: true,
          force: true
        })
        this._emit(id)
        if (result.state?.paused) this._pauseGoal(agent)
      })
    })
    ctx.on('session/disposed', (session) => {
      const id = String(session.id)
      const engine = this.engines.get(id)
      this.engines.delete(id)
      this._disposeRuntime(id)
      if (engine !== undefined) void engine.close().catch((error) => this._warn(error))
    })

    const timer = setInterval(() => void this.reconcile().catch((error) => this._warn(error)), this.options.reconcileIntervalMs)
    timer.unref?.()
    ctx.effect(() => async () => {
      clearInterval(timer)
      for (const sessionId of [...this.runtime.keys()]) this._disposeRuntime(sessionId)
      await Promise.allSettled([...this.engines.values()].map((engine) => engine.close()))
    }, 'dsh-guardian-mode.shutdown()')
  }

  _warn (error) { this.ctx.logger?.warn?.(error instanceof Error ? error : new Error(String(error))) }

  _guardedSession (session) {
    return this.options.enabled && selectedPreset(session) === GUARDIAN_PRESET_ID
  }

  _guardedAgent (agent) {
    if (!this.options.enabled) return false
    const roster = this.ctx.get('agentPresets')
    return roster?.composedPreset?.(agent.ctx) === GUARDIAN_PRESET_ID || this._guardedSession(agent.session)
  }

  _objective (agent) {
    try {
      const goal = this.ctx.get('goals')?.get(agent)
      if (goal?.objective !== undefined) return goal.objective
    } catch {}
    for (const event of agent?.session?.events ?? []) {
      if (event.type !== 'user/message' || event.data?.source?.kind !== 'user') continue
      const content = event.data?.message?.content ?? event.data?.content
      if (!Array.isArray(content)) continue
      const text = content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
      if (text !== '') return redactText(text).slice(0, 12_000)
    }
    return undefined
  }

  _isTaskEnding (agent) {
    try {
      const goal = this.ctx.get('goals')?.get(agent)
      return goal === undefined || goal.phase === 'complete' || goal.phase === 'blocked'
    } catch { return true }
  }

  _pauseGoal (agent) {
    try {
      const goals = this.ctx.get('goals')
      const goal = goals?.get(agent)
      if (goal?.phase === 'active') goals.pause(agent, { id: goal.id, revision: goal.revision })
    } catch (error) { this._warn(error) }
  }

  _resumeGoal (sessionId) {
    try {
      const agent = this.ctx.agents.get(sessionId)
      const goals = this.ctx.get('goals')
      const goal = agent === undefined ? undefined : goals?.get(agent)
      if (goal?.phase === 'paused') {
        goals.resume(agent, { id: goal.id, revision: goal.revision })
        return true
      }
    } catch (error) { this._warn(error) }
    return false
  }

  _runtimeFor (sessionId) {
    let runtime = this.runtime.get(sessionId)
    if (runtime === undefined) {
      runtime = { restriction: undefined, skillDisposers: [], elevated: false }
      this.runtime.set(sessionId, runtime)
    }
    return runtime
  }

  _serviceFor (agent, name) {
    const roster = this.ctx.get?.('agentPresets')
    return roster?.serviceFor?.(agent, name) ?? agent.ctx?.get?.(name)
  }

  _ensureCordisRestricted (agent) {
    const runtime = this._runtimeFor(String(agent.session.id))
    if (runtime.elevated || runtime.restriction !== undefined) return
    const tools = this._serviceFor(agent, 'tools')
    if (tools === undefined) return
    const available = CORDIS_TOOL_NAMES.filter((name) => tools.get(name, agent) !== undefined)
    if (available.length > 0) runtime.restriction = tools.restrict({ deny: available })
  }

  async _enableRepairRuntime (agent) {
    const runtime = this._runtimeFor(String(agent.session.id))
    runtime.restriction?.()
    runtime.restriction = undefined
    runtime.elevated = true
    try {
      if (runtime.skillDisposers.length > 0) return await loadRemediationSkills()
      const skills = await loadRemediationSkills()
      const registry = this._serviceFor(agent, 'skills')
      if (registry === undefined) throw new Error('guardian: the active preset has no scoped skill registry')
      runtime.skillDisposers = skills.map((skill) => registry.register(skill))
      return skills
    } catch (error) {
      for (const dispose of runtime.skillDisposers.splice(0).reverse()) dispose()
      runtime.elevated = false
      this._ensureCordisRestricted(agent)
      throw error
    }
  }

  _disableRepairRuntime (sessionId) {
    const runtime = this.runtime.get(sessionId)
    if (runtime === undefined) return
    for (const dispose of runtime.skillDisposers.splice(0).reverse()) dispose()
    runtime.elevated = false
    const agent = this.ctx.agents.get(sessionId)
    if (agent !== undefined) this._ensureCordisRestricted(agent)
  }

  _disposeRuntime (sessionId) {
    const runtime = this.runtime.get(sessionId)
    if (runtime === undefined) return
    runtime.restriction?.()
    for (const dispose of runtime.skillDisposers.reverse()) dispose()
    this.runtime.delete(sessionId)
  }

  _haltAgent (agent, reason) {
    this._pauseGoal(agent)
    if (agent.status === 'running') agent.cancel({ kind: 'hook', reason }, { keepInbox: true })
  }

  _queueContinuation (agent) {
    agent.followup(guardianMessage([
      '<guardian-remediation-complete>',
      'Guardian verified the accepted remediation. Continue the original user task from the preserved conversation and current workspace state.',
      'The temporary remediation tool/skill elevation has ended. Do not repeat completed remediation unless new evidence requires it.',
      '</guardian-remediation-complete>'
    ].join('\n')))
  }

  async _verifyRemediation (sessionId, turnReason) {
    const engine = this.engines.get(sessionId)
    const agent = this.ctx.agents.get(sessionId)
    if (engine === undefined || agent === undefined) return
    const state = await engine.get(sessionId)
    if (state?.remediation?.phase !== 'running') return
    if (turnReason?.kind !== 'completed') {
      await engine.remediationFailed(sessionId, turnReason)
      this._disableRepairRuntime(sessionId)
      this._emit(sessionId)
      return
    }
    await engine.remediationVerifying(sessionId)
    this._emit(sessionId)
    const result = await engine.audit(sessionId, agent.session.events, {
      objective: this._objective(agent),
      reason: 'remediation',
      force: true
    })
    const settled = await engine.remediationSettled(sessionId, result.audit)
    this._disableRepairRuntime(sessionId)
    this._emit(sessionId)
    if (!settled?.resumable) return
    if (!this._resumeGoal(sessionId)) this._queueContinuation(agent)
  }

  _newEngine (sessionId, cwd) {
    const companion = createReviewerCompanion(this.ctx, this.options, {
      cwd,
      onLog: (line) => this.ctx.logger?.debug?.(line)
    })
    const engine = new GuardianEngine(this.store, companion, { logger: (line) => this.ctx.logger?.info?.(line) })
    this.engines.set(sessionId, engine)
    return engine
  }

  async _activate (session) {
    const id = String(session.id)
    let engine = this.engines.get(id)
    if (engine !== undefined) {
      const activation = this.activations.get(id)
      if (activation !== undefined) await activation
      return engine
    }
    const cwd = session.header?.cwd ?? session.meta?.cwd ?? process.cwd()
    engine = this._newEngine(id, cwd)
    const activation = (async () => {
      let parentThreads
      let parentReviewer
      const parentId = session.header?.parentSession ?? session.meta?.parentSession
      if (parentId !== undefined) {
        const parent = await this.store.load(String(parentId))
        if (await this.store.load(id) === undefined) await this.store.clone(String(parentId), id)
        parentThreads = parent?.threads
        parentReviewer = parent?.reviewer ?? parent?.lastAudit?.reviewer ?? (parentThreads === undefined ? undefined : 'codex')
      }
      await engine.attach(id, { parentThreads, parentReviewer })
    })()
    this.activations.set(id, activation)
    try {
      await activation
      return engine
    } catch (error) {
      this.engines.delete(id)
      await engine.close().catch(() => {})
      throw error
    } finally {
      this.activations.delete(id)
      this._emit(id)
    }
  }

  async _withLock (sessionId, work) {
    const prior = this.locks.get(sessionId) ?? Promise.resolve()
    const current = prior.catch(() => {}).then(work)
    this.locks.set(sessionId, current)
    try { return await current } finally {
      if (this.locks.get(sessionId) === current) this.locks.delete(sessionId)
    }
  }

  subscribe (sessionId, listener) {
    let listeners = this.listeners.get(sessionId)
    if (listeners === undefined) this.listeners.set(sessionId, (listeners = new Set()))
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  _emit (sessionId) {
    const listeners = this.listeners.get(sessionId)
    if (listeners === undefined) return
    void this.snapshot(sessionId).then((view) => {
      for (const listener of [...listeners]) listener(view)
    }).catch((error) => this._warn(error))
  }

  async snapshot (sessionId) {
    const state = await this.store.load(sessionId)
    if (state === undefined) return { active: false, sessionId }
    const engine = this.engines.get(sessionId)
    return engine?.view(state) ?? {
      active: true,
      sessionId,
      capability: 'guardian',
      status: state.status,
      completedSteps: state.completedSteps,
      auditSequence: state.auditSequence,
      regularAuditCount: state.regularAuditCount,
      lastVerdict: state.lastVerdict,
      paused: state.paused,
      pauseReason: state.pauseReason,
      failureCount: state.failureCount,
      traceCursor: state.traceCursor,
      threads: state.threads,
      reviewer: state.reviewer ?? state.lastAudit?.reviewer ?? this.options.type,
      models: {
        summarizer: this.options.models.summarizer.model,
        auditor: this.options.models.auditor.model
      },
      lastSummary: state.lastSummary,
      lastAudit: state.lastAudit,
      finalAudit: state.finalAudit,
      pendingApproval: state.pendingApproval,
      remediation: state.remediation,
      summaryCount: state.summaries?.length ?? 0,
      auditCount: state.audits?.length ?? 0
    }
  }

  async history (sessionId, limit = 20) {
    const state = await this.store.load(sessionId)
    return state?.audits?.slice(-Math.max(1, limit)) ?? []
  }

  async requestNow (sessionId, { final = false } = {}) {
    return await this._withLock(sessionId, async () => {
      const agent = this.ctx.agents.get(sessionId)
      let events = agent?.session?.events
      if (events === undefined) events = (await this.ctx.sessionPersistence.inspect(sessionId)).events
      let engine = this.engines.get(sessionId)
      if (engine === undefined) {
        const state = await this.store.load(sessionId)
        if (state === undefined) throw new Error('guardian is not active for this session')
        if (agent !== undefined) {
          engine = await this._activate(agent.session)
        } else {
          engine = this._newEngine(sessionId, process.cwd())
          try {
            await engine.attach(sessionId)
          } catch (error) {
            this.engines.delete(sessionId)
            await engine.close().catch(() => {})
            throw error
          }
        }
      }
      const result = await engine.audit(sessionId, events, {
        objective: agent === undefined ? undefined : this._objective(agent),
        reason: final ? 'final' : 'manual',
        final,
        force: true
      })
      if (result.state?.paused && agent !== undefined) this._haltAgent(agent, 'guardian critical review')
      this._emit(sessionId)
      return result.state
    })
  }

  async resume (sessionId) {
    return await this._withLock(sessionId, async () => {
      let engine = this.engines.get(sessionId)
      if (engine === undefined) {
        const state = await this.store.load(sessionId)
        if (state === undefined) throw new Error('guardian is not active for this session')
        const agent = this.ctx.agents.get(sessionId)
        if (agent !== undefined) {
          engine = await this._activate(agent.session)
        } else {
          engine = this._newEngine(sessionId, process.cwd())
          try {
            await engine.attach(sessionId)
          } catch (error) {
            this.engines.delete(sessionId)
            await engine.close().catch(() => {})
            throw error
          }
        }
      }
      const state = await engine.get(sessionId)
      if (state?.pendingApproval?.status === 'pending' && state.pendingApproval.verdict === 'critical') {
        throw new Error('guardian critical review is awaiting approval; accept it before resuming')
      }
      if (state?.remediation !== undefined && state.remediation.phase !== 'completed') {
        throw new Error('guardian remediation has not completed')
      }
      const view = await engine.resume(sessionId)
      this._resumeGoal(sessionId)
      this._emit(sessionId)
      return view
    })
  }

  async accept (sessionId, auditId) {
    return await this._withLock(sessionId, async () => {
      const agent = this.ctx.agents.get(sessionId)
      if (agent === undefined) throw new Error('guardian approval requires a live DSH session')
      const engine = await this._activate(agent.session)
      const before = await engine.get(sessionId)
      let skills = []
      const elevated = (before?.pendingApproval?.status === 'pending' && before.pendingApproval.verdict === 'critical') ||
        (before?.remediation?.elevated === true && ['failed', 'execution-failed', 'verification-failed'].includes(before.remediation.phase))
      if (elevated) skills = await this._enableRepairRuntime(agent)
      let view
      try {
        view = await engine.accept(sessionId, auditId)
      } catch (error) {
        if (elevated) this._disableRepairRuntime(sessionId)
        throw error
      }
      this._haltAgent(agent, 'guardian remediation approved')
      const tail = [view.remediation.prompt]
      if (view.remediation?.elevated) tail.push(capabilityLeasePrompt(view.remediation, skills))
      try {
        agent.send(guardianMessage(tail.join('\n\n')), 'next-turn', true)
      } catch (error) {
        await engine.remediationRunning(sessionId)
        await engine.remediationFailed(sessionId, {
          kind: 'error',
          error: { code: 'QUEUE_FAILED', message: error instanceof Error ? error.message : String(error) }
        })
        this._disableRepairRuntime(sessionId)
        this._emit(sessionId)
        throw error
      }
      this._emit(sessionId)
      return view
    })
  }

  registerCapability (name, handler) {
    if (this.dynamicCapabilities.has(name)) throw new Error(`guardian capability already registered: ${name}`)
    this.dynamicCapabilities.set(name, handler)
    return () => this.dynamicCapabilities.delete(name)
  }

  capabilityNames () { return [...this.dynamicCapabilities.keys()].sort() }

  async invokeCapability (name, input, execution) {
    const handler = this.dynamicCapabilities.get(name)
    if (handler === undefined) throw new Error(`unknown guardian capability: ${name}`)
    return await handler(input, execution)
  }

  /** Archive reviewer threads and remove sidecars after confirmed deletion. */
  async reconcile () {
    for (const sessionId of await this.store.list()) {
      try {
        await this.ctx.sessionPersistence.inspect(sessionId)
        this.missing.delete(sessionId)
      } catch {
        const misses = (this.missing.get(sessionId) ?? 0) + 1
        this.missing.set(sessionId, misses)
        if (misses < 3) continue
        await this._withLock(sessionId, async () => {
          const state = await this.store.load(sessionId)
          if (state === undefined) return
          const engine = this.engines.get(sessionId) ?? this._newEngine(sessionId, process.cwd())
          await engine.archive(sessionId)
          this.engines.delete(sessionId)
          await this.store.remove(sessionId)
          this._disposeRuntime(sessionId)
          this.missing.delete(sessionId)
          this._emit(sessionId)
        })
      }
    }
  }
}
