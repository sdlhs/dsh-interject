// 离线测试 dsh-interject：不启动 DSH，用假 ctx / 假 agent 驱动插件，验证策略与打断动作。
// 每个用例显式声明自己的配置，不依赖全局默认值。
// 运行：node test/test-interject.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 默认测本仓库的 lib/index.js（相对本文件定位，任何机器上都能跑）；
// 用 DSH_INTERJECT_ENTRY 指向别的构建产物。仓库外的副本（例如放进别处当调试脚本）
// 找不到 ../lib 时退回到本机安装位置。
function defaultPlugin () {
  const local = fileURLToPath(new URL('../lib/index.js', import.meta.url))
  if (fs.existsSync(local)) return local
  return path.join(os.homedir(), '.dsh', 'plugins', 'dsh-interject', 'lib', 'index.js')
}

const PLUGIN = process.env.DSH_INTERJECT_ENTRY || defaultPlugin()

const mod = await import(pathToFileURL(PLUGIN).href)

let pass = 0
const failures = []
function check (name, cond, detail) {
  if (cond) { pass++; return }
  failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
}
function eq (name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`)
}

// ── 假世界 ──────────────────────────────────────────────────────────────────
function makeWorld () {
  const listeners = new Map()
  const events = []
  const agents = []
  const ctx = {
    logger: { warn: (m) => events.push(['warn', m]) },
    agents: {
      get: (id) => agents.find((a) => a.id === id),
      list: () => [...agents],
      roots: () => agents.filter((a) => a.isRoot !== false)
    },
    on (event, fn) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(fn)
      return () => {}
    }
  }
  const emit = (event, ...args) => {
    for (const fn of listeners.get(event) ?? []) fn(...args)
  }

  function makeAgent (id, { status = 'running', isRoot = true, withPhase = true } = {}) {
    const agent = {
      id,
      isRoot,
      status,
      calls: { cancel: [], followup: [], steer: [] },
      inbox: { nextTurn: [], nextStep: [] },
      session: { id }
    }
    if (withPhase) agent.phase = { kind: status === 'idle' ? 'idle' : 'running', wakeRequested: false }
    agent.cancel = (cause, options) => { agent.calls.cancel.push({ cause, options }) }
    agent.followup = (msg) => {
      agent.calls.followup.push(msg.id)
      agent.inbox.nextTurn.push(msg)
      emit('agent/inbox/inserted', { agent, message: msg })
    }
    agent.steer = (msg) => {
      agent.calls.steer.push(msg.id)
      agent.inbox.nextStep.push(msg)
      emit('agent/inbox/inserted', { agent, message: msg })
    }
    agent.inbox.remove = (mid) => {
      for (const list of [agent.inbox.nextTurn, agent.inbox.nextStep]) {
        const at = list.findIndex((m) => m.id === mid)
        if (at >= 0) { list.splice(at, 1); return true }
      }
      return false
    }
    agent.inbox.append = (target, msg) => {
      agent.inbox[target === 'next-turn' ? 'nextTurn' : 'nextStep'].push(msg)
      emit('agent/inbox/inserted', { agent, message: msg })
    }
    agents.push(agent)
    return agent
  }

  return { ctx, emit, makeAgent, events, agents }
}

const userMsg = (id) => ({ id, content: [{ type: 'text', text: `msg-${id}` }], source: { kind: 'user', rpcId: `rpc-${id}` } })
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

const tmpConfig = path.join(os.tmpdir(), `dsh-interject-test-${process.pid}.json`)
const tmpLog = path.join(os.tmpdir(), `dsh-interject-test-${process.pid}.log`)
// 必须重定向 boot 标记，否则每跑一次测试都会覆盖 ~/.dsh/dsh-interject-boot.json，
// 把「活着的 DSH 进程跑的是哪一版」这个唯一可信的证据冲掉。
const tmpBoot = path.join(os.tmpdir(), `dsh-interject-test-${process.pid}-boot.json`)
process.env.DSH_INTERJECT_CONFIG = tmpConfig
process.env.DSH_INTERJECT_LOG = tmpLog
process.env.DSH_INTERJECT_BOOT = tmpBoot
try { fs.unlinkSync(tmpConfig) } catch {}
try { fs.unlinkSync(tmpLog) } catch {}
try { fs.unlinkSync(tmpBoot) } catch {}
const writeConfig = (obj) => fs.writeFileSync(tmpConfig, JSON.stringify(obj), 'utf8')
const clearConfig = () => { try { fs.unlinkSync(tmpConfig) } catch {} }

// 需要「硬打断」语义的用例统一用它；不传就用插件真实默认值。
const INTERRUPT = { graceMs: 0, onQueue: 'interrupt' }

// ── 用例 0：出厂默认 —— 普通 Enter 不打断，只升格到下一步 ──────────────────
// 这是「零浪费」档：当前这段思考不会作废，等这次模型调用结束后立刻轮到你的话。
{
  clearConfig()
  const w = makeWorld()
  mod.apply(w.ctx, { graceMs: 0 })
  const a = w.makeAgent('s0')
  w.emit('session/event', a.session, { type: 'step/start' })
  a.followup(userMsg('m0'))
  await tick(5)
  eq('t0 默认不打断', a.calls.cancel.length, 0)
  eq('t0 默认升格到 next-step', a.inbox.nextStep.map((m) => m.id), ['m0'])
}

// ── 用例 1：onQueue=interrupt，繁忙+思考中收到排队消息 → 硬打断并闩唤醒 ────
{
  clearConfig()
  const w = makeWorld()
  mod.apply(w.ctx, INTERRUPT)
  const a = w.makeAgent('s1')
  w.emit('session/event', a.session, { type: 'step/start' })
  a.followup(userMsg('m1'))
  await tick(10)
  eq('t1 cancel 次数', a.calls.cancel.length, 1)
  eq('t1 cancel 保留收件箱', a.calls.cancel[0]?.options, { keepInbox: true })
  eq('t1 cancel 原因 kind', a.calls.cancel[0]?.cause?.kind, 'hook')
  check('t1 wakeRequested 已闩', a.phase.wakeRequested === true)
  check('t1 消息仍在收件箱', a.inbox.nextTurn.some((m) => m.id === 'm1'))
  check('t1 followup 没有被重复调用', a.calls.followup.length === 1)
}

// ── 用例 2：非用户来源（goal 轮次 / 上下文）一律不动 ─────────────────────────
{
  clearConfig()
  const w = makeWorld()
  mod.apply(w.ctx, INTERRUPT)
  const a = w.makeAgent('s2')
  w.emit('session/event', a.session, { type: 'step/start' })
  const goalMsg = { id: 'g1', content: [{ type: 'text', text: 'goal' }], source: { kind: 'goal', round: 2 } }
  a.inbox.nextTurn.push(goalMsg)
  w.emit('agent/inbox/inserted', { agent: a, message: goalMsg })
  await tick(5)
  eq('t2 goal 不打断', a.calls.cancel.length, 0)
}

// ── 用例 3：agent 空闲时不插手（正常提示词由 driver 自己唤醒）────────────────
{
  clearConfig()
  const w = makeWorld()
  mod.apply(w.ctx, INTERRUPT)
  const a = w.makeAgent('s3', { status: 'idle' })
  a.followup(userMsg('m3'))
  await tick(5)
  eq('t3 空闲不打断', a.calls.cancel.length, 0)
}

// ── 用例 4：onQueue=steer → 只升格到 next-step，不打断 ──────────────────────
{
  writeConfig({ onQueue: 'steer' })
  const w = makeWorld()
  mod.apply(w.ctx, { graceMs: 0 })
  const a = w.makeAgent('s4')
  a.followup(userMsg('m4'))
  await tick(5)
  eq('t4 steer 模式不打断', a.calls.cancel.length, 0)
  eq('t4 消息已升格', a.inbox.nextStep.map((m) => m.id), ['m4'])
  eq('t4 next-turn 已清空', a.inbox.nextTurn.map((m) => m.id), [])
  eq('t4 没有无限递归', a.calls.followup.length, 1)
  eq('t4 日志记下升格', /next-turn -> next-step/.test(fs.readFileSync(tmpLog, 'utf8')), true)
}

// ── 用例 5：interruptWhile=thinking，工具在跑 → 退化为软插话 ────────────────
{
  writeConfig({ interruptWhile: 'thinking', onQueue: 'interrupt' })
  const w = makeWorld()
  mod.apply(w.ctx, INTERRUPT)
  const a = w.makeAgent('s5')
  w.emit('session/event', a.session, { type: 'step/start' })
  w.emit('session/event', a.session, { type: 'tool/call' })
  a.followup(userMsg('m5'))
  await tick(5)
  eq('t5 工具阶段不硬打断', a.calls.cancel.length, 0)
  eq('t5 已软插话', a.inbox.nextStep.map((m) => m.id), ['m5'])
}

// ── 用例 6：interruptWhile=always，工具阶段照样打断 ─────────────────────────
{
  writeConfig({ interruptWhile: 'always', onQueue: 'interrupt' })
  const w = makeWorld()
  mod.apply(w.ctx, INTERRUPT)
  const a = w.makeAgent('s6')
  w.emit('session/event', a.session, { type: 'step/start' })
  w.emit('session/event', a.session, { type: 'tool/call' })
  a.followup(userMsg('m6'))
  await tick(5)
  eq('t6 always 打断', a.calls.cancel.length, 1)
}

// ── 用例 7：冷却窗口内不重复打断 ────────────────────────────────────────────
{
  writeConfig({ cooldownMs: 60000, graceMs: 0, onQueue: 'interrupt' })
  const w = makeWorld()
  mod.apply(w.ctx, INTERRUPT)
  const a = w.makeAgent('s7')
  w.emit('session/event', a.session, { type: 'step/start' })
  a.followup(userMsg('m7a'))
  a.followup(userMsg('m7b'))
  await tick(5)
  eq('t7 冷却只打断一次', a.calls.cancel.length, 1)
}

// ── 用例 8：显式插话（next-step）出厂默认不打断，保持原生边界语义 ───────────
{
  clearConfig()
  const w = makeWorld()
  mod.apply(w.ctx, { graceMs: 0 })
  const a = w.makeAgent('s8')
  w.emit('session/event', a.session, { type: 'step/start' })
  a.steer(userMsg('m8'))
  await tick(5)
  eq('t8 默认 steer 不打断', a.calls.cancel.length, 0)
  eq('t8 消息留在 next-step', a.inbox.nextStep.map((m) => m.id), ['m8'])
}

// ── 用例 8b：把 Cmd+Enter 当强制手势时才打断 ───────────────────────────────
{
  writeConfig({ onSteer: 'interrupt', graceMs: 0 })
  const w = makeWorld()
  mod.apply(w.ctx, { graceMs: 0 })
  const a = w.makeAgent('s8b')
  w.emit('session/event', a.session, { type: 'step/start' })
  a.steer(userMsg('m8b'))
  await tick(5)
  eq('t8b onSteer=interrupt 打断', a.calls.cancel.length, 1)
}

// ── 用例 8c：已经在 next-step 的消息不会被重复搬动 ──────────────────────────
{
  clearConfig()
  const w = makeWorld()
  mod.apply(w.ctx, { graceMs: 0 })
  const a = w.makeAgent('s8c')
  w.emit('session/event', a.session, { type: 'step/start' })
  const msg = userMsg('m8c')
  a.inbox.nextStep.push(msg)
  w.emit('agent/inbox/inserted', { agent: a, message: msg })
  await tick(5)
  eq('t8c next-step 不重复搬', a.inbox.nextStep.map((m) => m.id), ['m8c'])
  eq('t8c next-turn 仍空', a.inbox.nextTurn.length, 0)
  eq('t8c 不打断', a.calls.cancel.length, 0)
}

// ── 用例 8d：热路径过滤 —— 非用户来源连状态都不建 ──────────────────────────
{
  clearConfig()
  const w = makeWorld()
  mod.apply(w.ctx, { graceMs: 0 })
  const a = w.makeAgent('s8d')
  const toolCtx = { id: 'ctx1', content: [{ type: 'text', text: 'tool context' }], source: { kind: 'tool' } }
  a.inbox.nextTurn.push(toolCtx)
  w.emit('agent/inbox/inserted', { agent: a, message: toolCtx })
  await tick(5)
  eq('t8d 工具上下文不动', a.inbox.nextTurn.map((m) => m.id), ['ctx1'])
  eq('t8d 不升格', a.inbox.nextStep.length, 0)
}

// ── 用例 9：拿不到内部 phase 时，等 agent/status 报 idle 再补送 ─────────────
// 旧行为是 remove + followup 重入队；但 cancel 之后 phase.abort 已 aborted，
// send() 里的 wakingAfterAbort 会把消息改写回 next-turn —— 等于又回到「等整个 turn」。
// 新行为：先摘出收件箱，等公开的 agent/status 报 idle 再 steer 送过去。
{
  clearConfig()
  const w = makeWorld()
  mod.apply(w.ctx, INTERRUPT)
  const a = w.makeAgent('s9', { withPhase: false })
  w.emit('session/event', a.session, { type: 'step/start' })
  a.followup(userMsg('m9'))
  await tick(5)
  eq('t9 正常打断', a.calls.cancel.length, 1)
  eq('t9 没有退回 followup 重入队', a.calls.followup.length, 1)
  check('t9 消息已摘出收件箱（避免与 steer 撞去重校验）', !a.inbox.nextTurn.some((m) => m.id === 'm9'))
  // driver 收尾 → setPhase 发 agent/status
  a.status = 'idle'
  w.emit('agent/status', { agent: a, status: 'idle' })
  await tick(5)
  eq('t9 idle 后用 steer 补送', a.calls.steer, ['m9'])
  check('t9 消息已落到 next-step', a.inbox.nextStep.some((m) => m.id === 'm9'))
}

// ── 用例 9b：闩不上唤醒 + 一直不回 idle → 兜底超时照样送 ────────────────────
{
  clearConfig()
  const w = makeWorld()
  mod.apply(w.ctx, { ...INTERRUPT, wakeFallbackMs: 20 })
  const a = w.makeAgent('s9b', { withPhase: false })
  w.emit('session/event', a.session, { type: 'step/start' })
  a.followup(userMsg('m9b'))
  await tick(5)
  eq('t9b 已打断', a.calls.cancel.length, 1)
  eq('t9b 还没送', a.calls.steer.length, 0)
  await tick(60)
  eq('t9b 超时兜底送出去了', a.calls.steer, ['m9b'])
}

// ── 用例 9c：agent/status 报 running 时不提前送 ─────────────────────────────
{
  clearConfig()
  const w = makeWorld()
  mod.apply(w.ctx, INTERRUPT)
  const a = w.makeAgent('s9c', { withPhase: false })
  w.emit('session/event', a.session, { type: 'step/start' })
  a.followup(userMsg('m9c'))
  await tick(5)
  w.emit('agent/status', { agent: a, status: 'running' })
  await tick(5)
  eq('t9c running 时不动手', a.calls.steer.length, 0)
  a.status = 'idle'
  w.emit('agent/status', { agent: a, status: 'idle' })
  await tick(5)
  eq('t9c idle 后才送', a.calls.steer, ['m9c'])
}

// ── 用例 10：graceMs 等待期间消息被领走 → 不再打断 ─────────────────────────
{
  writeConfig({ graceMs: 120, onQueue: 'interrupt' })
  const w = makeWorld()
  mod.apply(w.ctx, INTERRUPT)
  const a = w.makeAgent('s10')
  w.emit('session/event', a.session, { type: 'step/start' })
  a.followup(userMsg('m10'))
  a.inbox.remove('m10') // 模拟这一步结束、边界处被领取
  await tick(250)
  eq('t10 已领取不打断', a.calls.cancel.length, 0)
}

// ── 用例 11：enabled=false 全关 ─────────────────────────────────────────────
{
  writeConfig({ enabled: false })
  const w = makeWorld()
  mod.apply(w.ctx, INTERRUPT)
  const a = w.makeAgent('s11')
  w.emit('session/event', a.session, { type: 'step/start' })
  a.followup(userMsg('m11'))
  await tick(5)
  eq('t11 关闭时不动作', a.calls.cancel.length, 0)
  eq('t11 也不软插话', a.inbox.nextStep.length, 0)
}

// ── 用例 12：子 agent 默认不管 ──────────────────────────────────────────────
{
  clearConfig()
  const w = makeWorld()
  mod.apply(w.ctx, INTERRUPT)
  const child = w.makeAgent('s12-child', { isRoot: false })
  w.emit('session/event', child.session, { type: 'step/start' })
  child.followup(userMsg('m12'))
  await tick(5)
  eq('t12 子 agent 不打断', child.calls.cancel.length, 0)
}

// ── 用例 13：诊断日志确实写了 ───────────────────────────────────────────────
{
  clearConfig()
  const w = makeWorld()
  mod.apply(w.ctx, INTERRUPT)
  const a = w.makeAgent('s13')
  w.emit('session/event', a.session, { type: 'step/start' })
  a.followup(userMsg('m13'))
  await tick(20)
  const text = fs.existsSync(tmpLog) ? fs.readFileSync(tmpLog, 'utf8') : ''
  check('t13 日志里有 INTERRUPT', /INTERRUPT/.test(text), text.slice(0, 200))
}

// ── 用例 14：stallMs 看门狗 —— 单步超时写一行诊断日志 ───────────────────────
{
  writeConfig({ stallMs: 60 })
  const w = makeWorld()
  mod.apply(w.ctx, { graceMs: 0 })
  const a = w.makeAgent('s14')
  const before = fs.existsSync(tmpLog) ? fs.readFileSync(tmpLog, 'utf8').length : 0
  w.emit('session/event', a.session, { type: 'step/start', data: { turn: 7, step: 3 } })
  await tick(140)
  const text = fs.readFileSync(tmpLog, 'utf8').slice(before)
  check('t14 超时写了诊断行', /step 3 of turn 7 has been running/.test(text), text)
}

// ── 用例 14b：step 正常结束则不该报超时 ─────────────────────────────────────
{
  writeConfig({ stallMs: 80 })
  const w = makeWorld()
  mod.apply(w.ctx, { graceMs: 0 })
  const a = w.makeAgent('s14b')
  w.emit('session/event', a.session, { type: 'step/start', data: { turn: 8, step: 1 } })
  await tick(20)
  const before = fs.readFileSync(tmpLog, 'utf8').length
  w.emit('session/event', a.session, { type: 'step/end', data: { turn: 8, step: 1 } })
  await tick(140)
  const text = fs.readFileSync(tmpLog, 'utf8').slice(before)
  check('t14b 正常结束不报超时', !/has been running/.test(text), text)
}

// ── 用例 15：搬动途中消息被领走 → 不能再 append（否则会投递两次）─────────────
{
  clearConfig()
  const w = makeWorld()
  mod.apply(w.ctx, { graceMs: 0 })
  const a = w.makeAgent('s15')
  const msg = userMsg('m15')
  // 模拟「inserted 事件派发到插件之前，这一步的边界已经把它领走」
  a.inbox.nextTurn.push(msg)
  const realRemove = a.inbox.remove
  a.inbox.remove = () => { realRemove('m15'); return false } // 返回 false = 已被领取
  w.emit('agent/inbox/inserted', { agent: a, message: msg })
  await tick(5)
  eq('t15 被领走后不再入队', a.inbox.nextStep.length, 0)
  eq('t15 也不会残留在 next-turn', a.inbox.nextTurn.length, 0)
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
try { fs.unlinkSync(tmpConfig) } catch {}
console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.log('  FAIL ' + f)
  process.exitCode = 1
} else {
  console.log('OK: dsh-interject 逻辑自检通过')
}
