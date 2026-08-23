import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CODEX_DEFAULTS, CodexClient, CodexCompanion } from './codex.js'
import { GuardianEngine } from './engine.js'
import { GUARDIAN_PRESET_ID } from './capability.js'
import { GUARDIAN_SERVICE } from './invariant.js'
import { SidecarStore } from './sidecar.js'
import { redactText } from './trace.js'

export const Config = z.object({
  enabled: z.boolean().default(true),
  binary: z.string().default('codex'),
  args: z.array(z.string()).default(['app-server', '--stdio']),
  requestTimeoutMs: z.number().min(1000).default(180_000),
  reconcileIntervalMs: z.number().min(1000).default(15_000),
  models: z.object({
    luna: z.object({ model: z.string().default('gpt-5.6-luna'), effort: z.string().default('medium') }),
    sol: z.object({ model: z.string().default('gpt-5.6-sol'), effort: z.string().default('max') })
  }).default(CODEX_DEFAULTS)
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
  static inject = ['agents', 'sessionPersistence']

  constructor (ctx, config = {}) {
    super(ctx, GUARDIAN_SERVICE)
    this.options = {
      enabled: true,
      binary: 'codex',
      args: ['app-server', '--stdio'],
      requestTimeoutMs: 180_000,
      reconcileIntervalMs: 15_000,
      models: structuredClone(CODEX_DEFAULTS),
      ...config
    }
    this.store = new SidecarStore()
    this.engines = new Map()
    this.activations = new Map()
    this.listeners = new Map()
    this.locks = new Map()
    this.anomalies = new Set()
    this.missing = new Map()
    this.dynamicCapabilities = new Map()

    ctx.on('session/created', (session) => {
      if (this._guardedSession(session)) void this._withLock(session.id, () => this._activate(session)).catch((error) => this._warn(error))
    })
    ctx.on('agent-preset/selected', (sessionId, preset) => {
      if (preset !== GUARDIAN_PRESET_ID) return
      const agent = ctx.agents.get(String(sessionId))
      if (agent !== undefined) void this._withLock(String(sessionId), () => this._activate(agent.session)).catch((error) => this._warn(error))
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
    })
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      if (!this._guardedAgent(agent)) return await next()
      const id = String(agent.session.id)
      const blocked = await this._withLock(id, async () => {
        const engine = await this._activate(agent.session)
        const before = await engine.get(id)
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
      if (engine !== undefined) void engine.close().catch((error) => this._warn(error))
    })

    const timer = setInterval(() => void this.reconcile().catch((error) => this._warn(error)), this.options.reconcileIntervalMs)
    timer.unref?.()
    ctx.effect(() => async () => {
      clearInterval(timer)
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
      if (goal?.phase === 'paused') goals.resume(agent, { id: goal.id, revision: goal.revision })
    } catch (error) { this._warn(error) }
  }

  _newEngine (sessionId, cwd) {
    const client = new CodexClient({
      binary: this.options.binary,
      args: this.options.args,
      requestTimeoutMs: this.options.requestTimeoutMs,
      onLog: (line) => this.ctx.logger?.debug?.(line)
    })
    const companion = new CodexCompanion(client, { models: this.options.models, cwd })
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
      const parentId = session.header?.parentSession ?? session.meta?.parentSession
      if (parentId !== undefined) {
        const parent = await this.store.load(String(parentId))
        if (await this.store.load(id) === undefined) await this.store.clone(String(parentId), id)
        parentThreads = parent?.threads
      }
      await engine.attach(id, { parentThreads })
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
      lastSummary: state.lastSummary,
      lastAudit: state.lastAudit,
      finalAudit: state.finalAudit,
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
      const view = await engine.resume(sessionId)
      this._resumeGoal(sessionId)
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
          this.missing.delete(sessionId)
          this._emit(sessionId)
        })
      }
    }
  }
}
