// 集成测试：把真实的 dsh-interject 插件接到一份「按 agent-loop 源码逐行照抄」的迷你 driver 上，
// 验证核心假设——cancel({keepInbox}) + 唤醒闩 之后，被打断的那一轮会让位给新消息。
//
// 迷你 driver 的控制流对应 lib/index.js 里的 ReactLoopAgent.{send,wakeDriver,kick,turn,step}；
// 只保留与插队相关的分支（无工具、无重试）。
//
// 运行：node test/test-interject-loop.mjs
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = process.env.DSH_INTERJECT_ENTRY
  || fileURLToPath(new URL('../lib/index.js', import.meta.url))
const mod = await import(pathToFileURL(PLUGIN).href)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
const failures = []
const check = (name, cond, detail) => {
  if (cond) { pass++; return }
  failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

// ── 迷你 ReactLoopAgent ─────────────────────────────────────────────────────
class MiniAgent {
  constructor (id, bus, { stepMs = 120 } = {}) {
    this.id = id
    this.session = { id }
    this.bus = bus
    this.stepMs = stepMs
    this.admitted = []          // 每次 step 领到的消息 id
    this.turns = 0
    this.inbox = {
      nextTurn: [],
      nextStep: [],
      remove: (mid) => {
        for (const key of ['nextTurn', 'nextStep']) {
          const at = this.inbox[key].findIndex((m) => m.id === mid)
          if (at >= 0) { this.inbox[key].splice(at, 1); return true }
        }
        return false
      },
      append: (target, msg) => {
        const key = target === 'next-turn' ? 'nextTurn' : 'nextStep'
        this.inbox[key].push(msg)
        this.bus.emit('agent/inbox/inserted', { agent: this, message: msg })
      }
    }
    this.phase = { kind: 'idle', lastTurn: 0 }
  }

  get status () { return this.phase.kind === 'idle' ? 'idle' : 'running' }

  hasPending () {
    return this.inbox.nextTurn.length > 0 || this.inbox.nextStep.length > 0
  }

  // — 照抄 ReactLoopAgent.send —
  send (message, target, wakeup) {
    const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
    const resolvedTarget = wakingAfterAbort ? 'next-turn' : target
    const key = resolvedTarget === 'next-turn' ? 'nextTurn' : 'nextStep'
    this.inbox[key].push(message)
    this.bus.emit('agent/inbox/inserted', { agent: this, message })
    if (wakeup) this.wakeDriver(wakingAfterAbort)
  }

  followup (m) { this.send(m, 'next-turn', true) }
  steer (m) { this.send(m, 'next-step', true) }

  // — 照抄 ReactLoopAgent.cancel —
  cancel (cause, options = {}) {
    if (!options.keepInbox) {
      this.inbox.nextStep.length = 0
      this.inbox.nextTurn.length = 0
      if (this.phase.kind !== 'idle') this.phase.wakeRequested = false
    }
    if (this.phase.kind !== 'idle') this.phase.abort.abort(cause)
  }

  // — 照抄 ReactLoopAgent.wakeDriver —
  wakeDriver (wakeAfterAbort = false) {
    if (this.phase.kind !== 'idle') {
      if (this.phase.kind === 'maintenance' || wakeAfterAbort) this.phase.wakeRequested = true
      return
    }
    const lastTurn = this.phase.lastTurn ?? 0
    this.phase = { kind: 'running', abort: new AbortController(), turn: lastTurn, step: 0, wakeRequested: false }
    this.activity = this.kick()
  }

  // — 照抄 ReactLoopAgent.kick —
  async kick () {
    try {
      while (await this.turn()) { /* keep going */ }
    } catch { /* 中止/失败都被吞掉，真实实现也一样 */ } finally {
      if (this.phase.kind === 'running') {
        const { turn, wakeRequested } = this.phase
        this.phase = { kind: 'idle', lastTurn: turn }
        if (wakeRequested && this.hasPending()) this.wakeDriver()
      }
    }
  }

  // — 照抄 Inbox.claim —
  claim (target) {
    const claimed = this.inbox.nextStep.splice(0)
    if (target === 'next-turn') claimed.push(...this.inbox.nextTurn.splice(0, 1))
    return claimed
  }

  // — 照抄 ReactLoopAgent.turn —
  async turn () {
    if (this.phase.kind !== 'running') throw new Error('turn without reservation')
    const phase = this.phase
    const { signal } = phase.abort
    signal.throwIfAborted()
    const turn = phase.turn + 1
    phase.turn = turn
    this.turns++
    this.bus.emit('session/event', this.session, { type: 'turn/start', data: { turn } })
    let turnEnds = null
    let target = 'next-turn'
    try {
      while (true) {
        signal.throwIfAborted()
        const step = phase.step + 1
        this.bus.emit('session/event', this.session, { type: 'step/start', data: { step } })
        const messages = this.claim(target)          // preStep 的领取
        if (turnEnds && messages.length === 0) break
        if (phase.step === 0 && messages.length === 0) {
          turnEnds = { kind: 'completed' }
          return false
        }
        signal.throwIfAborted()
        phase.step = step
        this.admitted.push(messages.map((m) => m.id))
        const stepEnd = await this.step(messages, signal)
        if (turnEnds === null || turnEnds.kind !== 'max-tokens') turnEnds = stepEnd
        this.bus.emit('session/event', this.session, { type: 'step/end', data: { step } })
        signal.throwIfAborted()
        if (turnEnds && this.inbox.nextStep.length === 0) break
        target = 'next-step'
      }
    } finally {
      this.bus.emit('session/event', this.session, { type: 'turn/end', data: { turn } })
    }
    if (!this.hasPending()) return false
    phase.abort = new AbortController()
    phase.wakeRequested = false
    phase.step = 0
    return true
  }

  // — 一次「模型调用」：被 abort 就抛 AbortError，否则正常产出 assistant 消息 —
  async step (messages, signal) {
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, this.stepMs)
        signal.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
        }, { once: true })
      })
    } catch (error) {
      this.aborted++
      throw error
    }
    this.completed++
    this.bus.emit('session/event', this.session, { type: 'assistant/message', data: {} })
    return { kind: 'completed' }
  }
}
MiniAgent.prototype.aborted = 0
MiniAgent.prototype.completed = 0

// ── 假 ctx ──────────────────────────────────────────────────────────────────
function makeBus () {
  const listeners = new Map()
  const bus = {
    listeners,
    emit (event, ...args) {
      for (const fn of listeners.get(event) ?? []) fn(...args)
    },
    ctx: {
      logger: { warn: (m) => bus.warnings.push(m) },
      warnings: [],
      agents: {
        get: (id) => bus.agents.find((a) => a.id === id),
        list: () => [...bus.agents],
        roots: () => [...bus.agents]
      },
      on (event, fn) {
        if (!listeners.has(event)) listeners.set(event, [])
        listeners.get(event).push(fn)
        return () => {}
      }
    },
    agents: []
  }
  return bus
}

const msg = (id) => ({ id, content: [{ type: 'text', text: id }], source: { kind: 'user', rpcId: `rpc-${id}` } })

// ── 用例 A：插件在场时，思考中插话 → 立刻让位 ───────────────────────────────
{
  process.env.DSH_INTERJECT_CONFIG = path.join(process.env.TEMP ?? '/tmp', 'dsh-interject-loop-none.json')
  process.env.DSH_INTERJECT_LOG = ''
  const bus = makeBus()
  mod.apply(bus.ctx, { graceMs: 0, cooldownMs: 0, onQueue: 'interrupt' })
  const agent = new MiniAgent('loop-a', bus, { stepMs: 400 })
  bus.agents.push(agent)

  agent.followup(msg('a1'))          // 第一轮开始，进入长思考
  await sleep(60)
  check('A: 第一轮已开始', agent.admitted.length === 1 && agent.admitted[0][0] === 'a1', JSON.stringify(agent.admitted))
  check('A: 此刻状态 running', agent.status === 'running')

  agent.followup(msg('a2'))          // 用户插队
  await sleep(60)
  check('A: 当前思考被打断', agent.aborted === 1, `aborted=${agent.aborted}`)

  await sleep(700)
  check('A: 新消息被领进新一轮', JSON.stringify(agent.admitted.at(-1)) === JSON.stringify(['a2']), JSON.stringify(agent.admitted))
  check('A: 最终回到 idle', agent.status === 'idle', agent.status)
  check('A: 收件箱已清空', agent.hasPending() === false)
}

// ── 用例 B（对照组）：没有插件 / 插件不打断 → 只能干等 ─────────────────────
{
  const bus = makeBus()
  const agent = new MiniAgent('loop-b', bus, { stepMs: 200 })
  bus.agents.push(agent)
  agent.followup(msg('b1'))
  await sleep(40)
  agent.followup(msg('b2'))          // 等价于 DSH 原生排队
  await sleep(40)
  check('B(对照): 当前思考没有被打断', agent.aborted === 0, `aborted=${agent.aborted}`)
  await sleep(400)
  check('B(对照): b2 只能等第一轮跑完', JSON.stringify(agent.admitted) === JSON.stringify([['b1'], ['b2']]), JSON.stringify(agent.admitted))
}

// ── 用例 C：工具阶段 + interruptWhile=thinking → 不打断，只升格 ─────────────
{
  const bus = makeBus()
  mod.apply(bus.ctx, { graceMs: 0, cooldownMs: 0, interruptWhile: 'thinking', onQueue: 'interrupt' })
  const agent = new MiniAgent('loop-c', bus, { stepMs: 300 })
  bus.agents.push(agent)
  agent.followup(msg('c1'))
  await sleep(40)
  bus.emit('session/event', agent.session, { type: 'tool/call', data: {} })   // 假装进入工具阶段
  agent.followup(msg('c2'))
  await sleep(40)
  check('C: 工具阶段不硬打断', agent.aborted === 0, `aborted=${agent.aborted}`)
  check('C: c2 已升格到 next-step', agent.inbox.nextStep.map((m) => m.id).join(',') === 'c2', JSON.stringify(agent.inbox.nextStep.map((m) => m.id)))
  await sleep(500)
  check('C: 这一轮结束后 c2 仍被领到', JSON.stringify(agent.admitted.at(-1)) === JSON.stringify(['c2']), JSON.stringify(agent.admitted))
}

// ── 用例 D（反证）：只 cancel 不打唤醒闩 → driver 停在 idle，消息僵死 ───────
// 这就是「为什么必须闩 wakeRequested」的证据：DSH 的 Stop 按钮只做这一步，
// 所以 Stop 之后排队消息会一直躺着，直到你再发一条把它叫起来。
{
  const bus = makeBus()
  const agent = new MiniAgent('loop-d', bus, { stepMs: 400 })
  bus.agents.push(agent)
  agent.followup(msg('d1'))
  await sleep(60)
  agent.followup(msg('d2'))                       // 排队
  agent.cancel({ kind: 'hook', reason: 'no-latch' }, { keepInbox: true })  // 只中止，不闩
  await sleep(300)
  check('D(反证): 当前思考被打断', agent.aborted === 1, `aborted=${agent.aborted}`)
  check('D(反证): driver 停在 idle', agent.status === 'idle', agent.status)
  check('D(反证): d2 僵死在收件箱里', agent.inbox.nextTurn.some((m) => m.id === 'd2'))
  check('D(反证): d2 没有被领到', !agent.admitted.flat().includes('d2'), JSON.stringify(agent.admitted))
}

console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.log('  FAIL ' + f)
  process.exitCode = 1
} else {
  console.log('OK: 插队（打断→让位→送达）在迷你 driver 上成立')
}
