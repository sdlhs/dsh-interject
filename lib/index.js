// dsh-interject — 会话插队（DeepSeek Harness host 插件，无 client 半）
//
// 解决的问题：agent 正在跑一个很长的 turn（深度思考时一个 step 就能跑几十秒到十几分钟），
// 这时你打一句话提交过去，DSH 默认只把它放进 inbox 的 `next-turn`，要等**整个 turn** 结束才轮到它。
//
// 本插件做的事：监听收件箱插入事件，命中策略时把这条消息从 `next-turn` 搬到 `next-step`。
// 循环的下一个 step 边界会立刻领取 `next-step` 里的全部消息，于是：
//   · 当前这次模型调用**不被打断**（继续跑完，已产出的思考全部保留）
//   · 你的话在下一个 step 开始时进入历史，模型下一条请求就能看到
//
// 为什么不是「把消息塞进已经发出的请求」：请求（messages 数组）在 buildRequest 里就被冻结、
// HTTP body 已经在线上，生成期间没有任何追加输入的通道。所以「让模型现在就读到」只有两条路：
//   A. 等这次调用结束（本插件默认，零浪费）
//   B. 中止当前请求再重发（配置成 `interrupt`，代价是尚未吐出的推理作废）
//
// ── 跨版本兼容 ──────────────────────────────────────────────────────────────
// 兼容下限 0.2.0-rc.1，向上不设上限（package.json 里 peerDependencies / engines.dsh
// 声明的就是 `>=0.2.0-rc.1` 展开后的等价区间）。逐个源码核对过的版本：
//   · 0.2.0-rc.2   （本机安装版；inbox 类是 ReactLoopInbox，住在 dsh-agent-loop 里）
//   · 0.2.1-rc.5   （npm `latest` / `next` 线）
//   · 0.2.2-alpha.2（npm `alpha` 线，ReactLoopInbox 构造函数签名变了，但门面不变）
// 这三版一致的公开面：`ctx.agents.get/roots`、`agent.session`、`agent.status`、
// `agent.inbox.{nextTurn,nextStep,hasPending,claim,append,prepend,replace,remove,splice}`、
// `agent.followup/steer/inject/cancel`、`session/event`（`step/start`、`step/end`、`turn/end`、
// `assistant/message`、`assistant/attempt`、`tool/call`、`tool/result`）、
// `agent/inbox/inserted`（payload `{agent,message}`）、`agent/disposed`（payload `{agent}`）、
// `message.source.kind === 'user'`、以及内部字段 `agent.phase.wakeRequested`。
//
// 插件不 import 任何 `@deepseek-ai/*` 包，只用宿主传进来的 ctx / agent 对象，
// 因此每个能力都做**探测**而不是假设它存在。这样做的目的不是兼容更老的版本，
// 而是让它在**未来**的 0.3 / 0.4 上不会因为某个内部字段被改名就整个失效：
// 探测不到的东西一律退化为公开写法（例如拿不到 `phase` 就走 remove + followup），
// 绝不因为某个内部字段消失就把主流程打断。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-interject'

/** 需要 agents 服务（收件箱 / 取消都挂在 Agent 句柄上）。 */
export const inject = ['agents']

/** 默认配置；JSON 配置文件里的同名字段覆盖它。 */
export const DEFAULTS = Object.freeze({
  // 总开关
  enabled: true,
  // 普通排队消息（繁忙态 Enter = 排队发送 → next-turn）的处理方式
  //   'steer'     软插话：只把它挪进 next-step，等当前这次模型调用一结束就轮到它（默认，零浪费）
  //   'interrupt' 立刻打断当前轮次，把它提到新的一轮（最快，但当前这段思考作废）
  //   'pass'      保持 DSH 原生排队行为（等整个 turn 结束）
  onQueue: 'steer',
  // 显式插话消息（Cmd/Ctrl+Enter → next-step）的处理方式
  //   'pass'      保持原生语义（默认）。next-step 本来就在下一个 step 边界被领取，
  //               也就是「等这次模型调用结束再插入」，正是想要的行为，插件不需要插手
  //   'interrupt' 立刻打断（把 Cmd+Enter 当成「我要现在打断」的强制手势）
  onSteer: 'pass',
  // 什么时候才允许「硬打断」（只在 action 解析成 interrupt 时才看这个）：
  //   'thinking'  只在模型正在思考 / 生成（请求在途或流式输出中）时打断；
  //               工具正在跑的时候退化为软插话，避免白杀一个长命令（默认）
  //   'always'    任何时候都打断
  interruptWhile: 'thinking',
  // 命中后延迟多久再动手，留给同批消息（比如一次性插话多条）合并
  graceMs: 250,
  // 同一个 agent 两次硬打断之间的最小间隔，防止刷屏式打断
  cooldownMs: 2000,
  // 是否也管子 agent（默认只管你看得见的根会话）
  includeSubagents: false,
  // 单次模型调用超过多少毫秒就往诊断日志里写一行「还在跑」；
  // 用来区分「一个请求真的很慢」和「一直在正常推进」，0 = 关闭
  stallMs: 120000,
  // 是否写诊断日志
  log: true
})

/** 配置文件位置（可用环境变量覆盖）。 */
function configPath() {
  return process.env.DSH_INTERJECT_CONFIG || path.join(os.homedir(), '.dsh', 'dsh-interject.json')
}

/** 诊断日志位置；设为空字符串即关闭。 */
function logPath() {
  return process.env.DSH_INTERJECT_LOG ?? path.join(os.tmpdir(), 'dsh-interject.log')
}

function appendLog(line) {
  const target = logPath()
  if (!target) return
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.appendFileSync(target, `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    /* 日志失败绝不影响主流程 */
  }
}

const ACTIONS = new Set(['interrupt', 'steer', 'pass'])
const WHILES = new Set(['thinking', 'always'])

/** 把任意来源的配置夹成合法值，非法值回落到默认。 */
function normalize(raw, base) {
  const out = { ...base }
  if (raw === null || typeof raw !== 'object') return out
  for (const key of ['enabled', 'includeSubagents', 'log']) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key]
  }
  if (ACTIONS.has(raw.onQueue)) out.onQueue = raw.onQueue
  if (ACTIONS.has(raw.onSteer)) out.onSteer = raw.onSteer
  if (WHILES.has(raw.interruptWhile)) out.interruptWhile = raw.interruptWhile
  for (const key of ['graceMs', 'cooldownMs', 'stallMs']) {
    const value = raw[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out[key] = value
  }
  return out
}

/** 热加载轮询间隔：stat 一个文件很便宜，但没必要每个事件都做。 */
const CONFIG_POLL_MS = 1000

// ── 能力探测 ────────────────────────────────────────────────────────────────
// 宿主版本之间唯一确定的事就是「不确定」。下面每个函数都只回答一个具体问题，
// 拿不到就返回 undefined / false，让调用方走退化路径。

function isFn(value) {
  return typeof value === 'function'
}

/** 读 agent.status；拿不到就用 phase.kind 推（0.2.x 的 get status() 就是这么实现的）。 */
function statusOf(agent) {
  const direct = agent?.status
  if (typeof direct === 'string') return direct
  const kind = agent?.phase?.kind
  if (typeof kind === 'string') return kind === 'idle' || kind === 'maintenance' ? 'idle' : 'running'
  return undefined
}

/**
 * 取出 agent 的收件箱门面。
 * @returns `{ inbox, step, turn }`，或 undefined（没有可用收件箱）。
 */
function inboxOf(agent) {
  const inbox = agent?.inbox
  if (inbox === null || typeof inbox !== 'object') return undefined
  const step = Array.isArray(inbox.nextStep) ? inbox.nextStep : undefined
  const turn = Array.isArray(inbox.nextTurn) ? inbox.nextTurn : undefined
  if (step === undefined && turn === undefined) return undefined
  return { inbox, step: step ?? [], turn: turn ?? [] }
}

/** 这条消息此刻是否还在某个待处理队列里（是的话返回 'next-step' / 'next-turn'）。 */
function pendingIn(agent, messageId) {
  const view = inboxOf(agent)
  if (view === undefined) return undefined
  if (view.step.some((pending) => pending?.id === messageId)) return 'next-step'
  if (view.turn.some((pending) => pending?.id === messageId)) return 'next-turn'
  return undefined
}

/**
 * 装配插件。
 * @param {object} ctx Cordis 上下文（提供 agents 服务与事件）。
 * @param {object} [config] loader 行内 config，作为 JSON 配置文件的基线。
 */
export function apply(ctx, config) {
  const base = normalize(config, DEFAULTS)
  let logEnabled = base.log !== false

  /** 诊断日志出口（受配置 log 开关约束）。 */
  function note(line) {
    if (!logEnabled) return
    appendLog(line)
  }

  function warn(message) {
    try {
      ctx.logger?.warn?.(`dsh-interject: ${message}`)
    } catch {
      /* ignore */
    }
  }

  // 配置热加载：最多每秒 stat 一次，文件没变就用缓存。
  // 这样调策略不用重启 DSH（这个 harness 里重启是很贵的操作）。
  let cache = { mtimeMs: -1, value: base, checkedAt: 0 }
  function settings(force = false) {
    const now = Date.now()
    if (!force && now - cache.checkedAt < CONFIG_POLL_MS) return cache.value
    cache.checkedAt = now
    const file = configPath()
    try {
      const stat = fs.statSync(file)
      if (stat.mtimeMs === cache.mtimeMs) return cache.value
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      cache = { mtimeMs: stat.mtimeMs, value: normalize(parsed, base), checkedAt: now }
      logEnabled = cache.value.log !== false
      note(`config reloaded from ${file}: ${JSON.stringify(cache.value)}`)
      return cache.value
    } catch {
      // 文件不存在 / 坏 JSON：静默回落到当前生效值（不打断主流程）
      return cache.value
    }
  }

  // ── 装配期能力盘点 ────────────────────────────────────────────────────────
  // 只算一次，写进诊断日志。用户报「插件好像没反应」时先看这一行，
  // 就能分清是「宿主没有这个能力」还是「策略没命中」。
  const caps = {
    agentsGet: isFn(ctx.agents?.get),
    agentsRoots: isFn(ctx.agents?.roots),
    cancel: undefined, // 首次拿到 agent 时再探测
    phase: undefined,
    stream: false
  }
  if (!caps.agentsGet) {
    warn('ctx.agents.get is unavailable — plugin disabled')
    return
  }

  /** 每个 live agent 的运行态。 */
  const states = new Map()

  function stateFor(agent) {
    const existing = states.get(agent.id)
    if (existing !== undefined && existing.agent === agent) return existing
    const state = {
      agent,
      /** 当前 step 是否处在「模型请求在途 / 流式生成中」，即还没开始跑工具。 */
      thinking: false,
      /** 上次硬打断的时间戳。 */
      lastInterruptAt: 0,
      /** 正在搬动消息时用来挡住自己触发的 inserted 事件。 */
      moving: new Set(),
      /** 待触发的打断定时器。 */
      timers: new Set(),
      /** `ctx.agents.roots()` 的结果缓存（undefined = 还没算过）。 */
      root: undefined,
      /** 当前 step 的计时（`stallMs` 看门狗用）；idle 时为 undefined。 */
      stepWatch: undefined
    }
    // 顺手把 agent 级能力也记下来（不同宿主版本可能给不同的 Agent 实现）。
    if (caps.cancel === undefined) caps.cancel = isFn(agent.cancel)
    if (caps.phase === undefined) caps.phase = agent.phase !== null && typeof agent.phase === 'object'
    states.set(agent.id, state)
    return state
  }

  function isRoot(state) {
    if (state.root === undefined) {
      if (!caps.agentsRoots) {
        // 宿主没有 roots()：没法区分主/子 agent，就当它是根会话。
        // 比「一个都不管」更符合直觉——用户装了插件却完全没反应更难排查。
        state.root = true
      } else {
        try {
          state.root = ctx.agents.roots().includes(state.agent)
        } catch {
          state.root = true
        }
      }
    }
    return state.root
  }

  // ── 运行态跟踪 ────────────────────────────────────────────────────────────
  // 「思考中」= 这一步已经开始，但模型还没交付 assistant 消息、也还没派发工具。
  // 用 session 事件而不是 assistant-stream 的首帧，因为首个 token 之前可能静默几分钟
  // （深度思考），那段时间恰恰最需要能插队。这条路径不依赖任何可选事件，永远成立。
  ctx.on('session/event', (session, event) => {
    let next
    switch (event?.type) {
      case 'step/start':
        next = true
        break
      case 'assistant/message':
      case 'assistant/attempt':
      case 'tool/call':
      case 'tool/result':
      case 'step/end':
      case 'turn/end':
        next = false
        break
      default:
        // 绝大多数 session 事件（chunk 记账、投影、附件……）在这里就被挡掉，
        // 不再走后面的 agent 查找。
        return
    }
    const sessionId = session?.id
    if (typeof sessionId !== 'string') return
    let state = states.get(sessionId)
    if (state === undefined || state.agent.session !== session) {
      let agent
      try {
        agent = ctx.agents.get(sessionId)
      } catch {
        return
      }
      if (agent === undefined || agent?.session !== session) return
      state = stateFor(agent)
    }
    state.thinking = next
    if (event.type === 'step/start') armStepWatch(state, event.data)
    else if (event.type === 'step/end' || event.type === 'turn/end') clearStepWatch(state)
  })

  /**
   * 单步看门狗：一个 step 超过 `stallMs` 就在日志里记一行。
   * 用户看到的「深度求索中，用时 30 分钟」是整个 turn 的累计时间，
   * 到底是「一个请求卡住了」还是「很多个正常 step 堆出来的」，看这行日志就分得清。
   * @param state agent 运行态。
   * @param data `step/start` 事件的 payload（含 turn / step）。
   */
  function armStepWatch(state, data) {
    const stall = Number(settings().stallMs) || 0
    if (stall <= 0) return
    clearStepWatch(state)
    const turn = data?.turn
    const step = data?.step
    const startedAt = Date.now()
    const timer = setTimeout(() => {
      state.stepWatch = undefined
      note(`${state.agent.id}: step ${step} of turn ${turn} has been running ${Math.round((Date.now() - startedAt) / 1000)}s (still going)`)
    }, stall)
    // 只是诊断，不该拖住宿主进程退出。
    timer.unref?.()
    state.stepWatch = timer
  }

  function clearStepWatch(state) {
    if (state.stepWatch === undefined) return
    clearTimeout(state.stepWatch)
    state.stepWatch = undefined
  }

  // 重试路径不会重新发 step/start，用流帧补齐（start → 思考中，end → 结束）。
  // 这条是热路径（每个 chunk 一帧），所以只做 Map 查表，不分配任何对象。
  // 事件不存在时注册会抛，所以整段包在 try 里：探测失败就退化成纯 session 事件判断。
  try {
    ctx.on('agent/assistant-stream', ({ agent, frame } = {}) => {
      if (frame === undefined || agent === undefined) return
      const state = states.get(agent.id)
      if (state === undefined || state.agent !== agent) return
      if (frame.type === 'start') state.thinking = true
      else if (frame.type === 'end') state.thinking = false
    })
    caps.stream = true
  } catch (error) {
    warn(`agent/assistant-stream listener unavailable: ${String(error)}`)
  }

  ctx.on('agent/disposed', ({ agent } = {}) => {
    if (agent === undefined) return
    const state = states.get(agent.id)
    if (state === undefined || state.agent !== agent) return
    for (const timer of state.timers) clearTimeout(timer)
    state.timers.clear()
    clearStepWatch(state)
    states.delete(agent.id)
  })

  // ── 主逻辑 ────────────────────────────────────────────────────────────────
  ctx.on('agent/inbox/inserted', ({ agent, message } = {}) => {
    try {
      handleInserted(agent, message)
    } catch (error) {
      warn(`inserted handler failed: ${String(error)}`)
    }
  })

  function handleInserted(agent, message) {
    // 热路径：工具上下文 / runtime-context / subagent 结果插入极频繁，
    // 先做最便宜的过滤，再碰配置与状态。
    if (agent === undefined || message?.id === undefined) return
    if (message?.source?.kind !== 'user') return
    if (statusOf(agent) !== 'running') return

    const s = settings()
    if (!s.enabled) return

    const state = stateFor(agent)
    if (state.moving.has(message.id)) return
    if (!s.includeSubagents && !isRoot(state)) return

    const where = pendingIn(agent, message.id)
    if (where === undefined) return

    const inStep = where === 'next-step'
    const action = inStep ? s.onSteer : s.onQueue
    if (action === 'pass' || action === undefined) return

    // 软插话：只是把它提到「下一个 step 边界」，不动正在跑的东西。
    // 已经在 next-step 的消息本来就等着下一个边界，无事可做。
    if (action === 'steer') {
      if (inStep) return
      if (promoteToNextStep(agent, message, state)) {
        note(`${agent.id}: next-turn -> next-step ${message.id}`)
      }
      return
    }

    // 硬打断：工具正在跑的时候是否也动手。
    if (s.interruptWhile === 'thinking' && !state.thinking) {
      if (promoteToNextStep(agent, message, state)) {
        note(`${agent.id}: soft-steer (not thinking) ${message.id}`)
      }
      return
    }

    const now = Date.now()
    if (now - state.lastInterruptAt < s.cooldownMs) {
      note(`${agent.id}: interrupt skipped (cooldown ${now - state.lastInterruptAt}ms) ${message.id}`)
      return
    }
    state.lastInterruptAt = now
    scheduleInterrupt(agent, message, state, s)
  }

  /**
   * 把 next-turn 里的消息挪到 next-step（公开 API，两步 splice；中间不会同时存在）。
   * 顺序不能颠倒：`mutate` 有跨队列去重校验，先 append 会抛
   * `message "..." is already pending`。
   * @returns 是否真的搬动了。
   */
  function promoteToNextStep(agent, message, state) {
    const view = inboxOf(agent)
    if (view === undefined) return false
    if (view.step.some((pending) => pending?.id === message.id)) return false
    if (!isFn(view.inbox.remove) || !isFn(view.inbox.append)) return false
    state.moving.add(message.id)
    try {
      // remove 返回 false 说明这条消息刚被这一步领走了（已经进档）。
      // 这时绝不能再 append，否则它会以「新消息」的身份被投递第二次。
      if (!view.inbox.remove(message.id)) return false
      view.inbox.append('next-step', message)
      return true
    } catch (error) {
      warn(`promote failed for ${message.id}: ${String(error)}`)
      return false
    } finally {
      state.moving.delete(message.id)
    }
  }

  function scheduleInterrupt(agent, message, state, s) {
    const fire = () => {
      try {
        interruptNow(agent, message, s)
      } catch (error) {
        warn(`interrupt failed: ${String(error)}`)
      }
    }
    const grace = Number(s.graceMs) || 0
    if (grace <= 0) {
      fire()
      return
    }
    const timer = setTimeout(() => {
      state.timers.delete(timer)
      fire()
    }, grace)
    state.timers.add(timer)
  }

  /**
   * 真正动手：中止当前活动（保留收件箱），再闩上唤醒，让 driver 立刻开新的一轮。
   * @param agent 目标 agent。
   * @param message 触发这次插队的消息（用来判断它还在不在待处理里）。
   * @param s 当前生效配置。
   */
  function interruptNow(agent, message, s) {
    try {
      if (ctx.agents.get(agent.id) !== agent) return
    } catch {
      return
    }
    if (statusOf(agent) !== 'running') return
    // 消息已经在这一步被领取入档了，就没有必要再打断。
    if (pendingIn(agent, message.id) === undefined) return
    if (!isFn(agent.cancel)) {
      note(`${agent.id}: cancel() unavailable — soft-steer instead ${message.id}`)
      promoteToNextStep(agent, message, stateFor(agent))
      return
    }

    const state = stateFor(agent)
    const wasThinking = state.thinking
    agent.cancel({ kind: 'hook', reason: '用户插队（dsh-interject）' }, { keepInbox: true })
    if (!latchWake(agent)) requeueAndWake(agent, message, state)
    note(`${agent.id}: INTERRUPT (${wasThinking ? 'thinking' : 'tool/other'}, policy=${s.interruptWhile}) ${message.id}`)
  }

  /**
   * 给正在跑的 driver 闩上 `wakeRequested`，这样它收尾时 `kick()` 的 finally 会自己再起来。
   * `cancel()` 不清收件箱（keepInbox），但也不会置这个标志——不闩的话被打断的轮次结束后
   * 待处理消息会静静躺在那儿，直到用户再发一条。这是本插件唯一用到的实现细节，
   * 拿不到（结构变了 / 不是内置 driver）就返回 false 走公开退化路径。
   *
   * 已核对 0.2.0-rc.2 / 0.2.1-rc.5 / 0.2.2-alpha.2 三版此字段一致。
   * @returns 是否闩成功。
   */
  function latchWake(agent) {
    const phase = agent.phase
    if (phase === null || typeof phase !== 'object') return false
    if (phase.kind !== 'running') return false
    if (!('wakeRequested' in phase)) return false
    phase.wakeRequested = true
    return true
  }

  /** 退化路径：把消息从待处理里摘掉，再用 followup 重新入队并唤醒。 */
  function requeueAndWake(agent, message, state) {
    const view = inboxOf(agent)
    // 挡住 followup 反手触发的 inserted 事件，避免 cooldownMs=0 时自己递归自己。
    state.moving.add(message.id)
    try {
      if (view !== undefined && isFn(view.inbox.remove)) view.inbox.remove(message.id)
    } catch {
      /* 已经被领取也无所谓 */
    }
    try {
      if (isFn(agent.followup)) agent.followup(message)
      else warn(`followup() unavailable — ${message.id} left in the inbox`)
    } catch (error) {
      warn(`requeue failed for ${message.id}: ${String(error)}`)
    } finally {
      state.moving.delete(message.id)
    }
  }

  // 启动痕迹：日志里出现这一行，就说明插件确实被装配了（排查时第一个看的地方）。
  try {
    const effective = settings(true)
    note(`dsh-interject loaded (config ${configPath()}): ${JSON.stringify(effective)}`)
    note(`dsh-interject capabilities: agents.get=yes agents.roots=${caps.agentsRoots ? 'yes' : 'no'} assistant-stream=${caps.stream ? 'yes' : 'no'}`)
  } catch (error) {
    warn(`startup note failed: ${String(error)}`)
  }
}
