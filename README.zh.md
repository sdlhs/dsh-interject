# dsh-interject —— 会话插队

[English](README.md) | **中文**

agent 跑长任务（一段深度思考可能就是十几分钟）时，你打的话默认要等**整个 turn** 结束才轮到。
这个插件把新消息**提前到下一个 step 边界**送给模型，而**当前这次模型调用完全不被打断**。

DeepSeek Harness **host 插件**，无 client 半，不改 WebUI，不碰 `app.asar`。

---

## 问题

agent 正在跑一个很长的 turn（一个推理 step 就能跑几分钟）时，你发过去的消息会进入
`next-turn` 收件箱队列，而循环要**等整个 turn 结束**才会来领取它——那可能已经过了很多 step。

## 原理

DSH 收件箱有两条队列：

| 队列 | 谁写进去 | 何时被领取 |
|---|---|---|
| `next-turn` | 繁忙态 Enter（排队发送） | **整个 turn 结束后** |
| `next-step` | Cmd/Ctrl+Enter（插话发送） | **下一个 step 边界**（一个 step = 一次模型调用 + 它的工具） |

插件监听 `agent/inbox/inserted`，命中策略时把消息从 `next-turn` 挪进 `next-step`。
下一个 step 一开始，模型就在历史里看到你的话，而当前这段思考一点不作废。

**为什么不能「边想边读」**：`llm.stream(request)` 的 `messages` 数组在构造请求时就冻结、
HTTP body 已经在线，生成期间没有追加输入的通道。所以只有两条路——等这次调用结束（默认），
或中止再重发（`interrupt`）。

---

## 安装

### 从插件市场

在 DSH 插件市场搜索 `dsh-interject` 安装即可，市场会从本仓库解析包。

### 从源码

```bash
git clone https://github.com/sdlhs/dsh-interject.git
cd dsh-interject
dsh plugin --profile desktop add .
```

包内声明了 `dsh.bundle.patch`，profile 会自动读取 `cordis.patch.yml`，下次启动就挂上。
装完或改完 `lib/index.js` **必须完全重启 DSH**——DSH 以静态 ESM 加载插件，改文件对运行中的
进程无效。

### 手工装配（不用市场）

在 profile 的 `cordis.patch.yml` 里加：

```yaml
- insert:
    - id: dsh-interject
      name: dsh-interject
```

`name` 必须是**包名**，不能写绝对路径——市场按 loader entry 的 `name` 匹配，写绝对路径会让
插件卡片一直显示「已安装，未生效」。

---

## 配置

`~/.dsh/dsh-interject.json`，**热加载**，改完保存即生效，不用重启。

```json
{
  "enabled": true,
  "onQueue": "steer",
  "onSteer": "pass",
  "interruptWhile": "thinking",
  "graceMs": 250,
  "cooldownMs": 2000,
  "includeSubagents": false,
  "stallMs": 120000,
  "log": true
}
```

| 字段 | 取值 | 含义 |
|---|---|---|
| `onQueue` | `steer` / `interrupt` / `pass` | 普通 Enter（进 `next-turn`）时怎么办。`steer` = 升格到 `next-step`（**默认，零浪费**） |
| `onSteer` | `pass` / `interrupt` | Cmd+Enter（进 `next-step`）时怎么办。`pass` = 不插手（**默认**，它本来就等着下个边界） |
| `interruptWhile` | `thinking` / `always` | 硬打断的时机；`thinking` 时跑工具阶段会退化成软插话，不白杀一个长命令 |
| `graceMs` | 毫秒 | 命中后延迟多久动手，用于合并同批消息 |
| `cooldownMs` | 毫秒 | 两次硬打断的最小间隔 |
| `includeSubagents` | bool | 是否也管子 agent（默认只管你看得见的根会话） |
| `stallMs` | 毫秒，`0` 关闭 | 单步超过这么久就在日志里写一行「还在跑」 |
| `log` | bool | 诊断日志开关 |

**默认 = 完全不打断。** 想让 Cmd+Enter 变成抢断手势：`{"onSteer": "interrupt"}`。
想彻底关掉：`{"enabled": false}`。

环境变量覆盖：`DSH_INTERJECT_CONFIG`（配置路径）、`DSH_INTERJECT_LOG`（日志路径，空串关闭日志）。

---

## 会不会更费 token

**默认配置不会**：插件没有多发任何请求，只是把一条待处理消息换了个队列。唯一增量是这句话
更早进历史，本 turn 剩余请求多带它一遍——走 prompt cache 前缀命中，单价很低。

只有 `interrupt` 才真花钱：被中止那次请求已产生的输出照常计费，然后重发一整条历史。

---

## 验证

```powershell
Get-Content "$env:TEMP\dsh-interject.log" -Tail 20
```

正常工作时能看到 `next-turn -> next-step <id>`；单步超过 `stallMs` 会出现
`step N of turn M has been running Xs (still going)` —— 用它可以分清「一个请求真卡了」
和「很多正常 step 堆出来的长 turn」（UI 上那个「深度求索中，用时 X」算的是**整个 turn**）。

离线自检（不需要 DSH）：

```bash
node test/test-interject.mjs        # 39 项：策略、能力探测、退化路径
node test/test-interject-loop.mjs   # 15 项：接一份照抄 agent-loop 的迷你 driver
```

两个脚本默认测 `../lib/index.js`；用 `DSH_INTERJECT_ENTRY` 可指向别的构建产物。

---

## 兼容性

声明为 `>=0.2.0-rc.1`，不设上限。为了确认插件用到的公开面，逐行读过三个宿主版本的源码：

| 版本 | 状态 |
|---|---|
| `0.2.0-rc.2` | 已核对（开发用宿主） |
| `0.2.1-rc.5` | 已核对（npm `latest` / `next`） |
| `0.2.2-alpha.2` | 已核对（npm `alpha`） |

每个能力都是**探测**而不是假设它存在——插件不 import 任何 `@deepseek-ai/*` 包，只用宿主传进来的
`ctx` / `agent` 对象。这样做不是为了兼容更老的版本，而是让它在未来的 0.3 / 0.4 上不会因为某个
内部字段改名就整个失效：探测不到的一律退化为公开写法（例如拿不到 `phase` 就走 `remove` +
`followup`，而不是唤醒闩）。

这三个版本一致的公开面：`ctx.agents.get/roots`、`agent.session`、`agent.status`、
`agent.inbox.{nextTurn,nextStep,hasPending,claim,append,prepend,replace,remove,splice}`、
`agent.followup/steer/inject/cancel`、session 事件 `step/start`、`step/end`、`turn/end`、
`assistant/message`、`assistant/attempt`、`tool/call`、`tool/result`、`agent/inbox/inserted`
（payload `{agent, message}`）、`agent/disposed`（payload `{agent}`）、`message.source.kind === 'user'`、
以及内部字段 `agent.phase.wakeRequested`。

---

## 已知边界

- **`steer` 不是零延迟**：它只能等到当前这次模型调用的边界。那次调用要跑十分钟还是得等十分钟。
- **搬消息会留下一次 `outcome: 'canceled'` 的 `agent/inbox/spliced`**：公开 API 的固有形状
  （`inbox.remove()` 走 `splice()`）。已核实无害：goal driver 的 `sameQueued()` 要求
  `source.kind === 'goal'`；UI 的 `retireFailedSubmission()` 对纯文本提交不产生错误。
- **`interrupt` 模式依赖 `agent.phase.wakeRequested`** 这一处内部字段；拿不到时自动退化为
  `inbox.remove()` + `agent.followup()`。
- **改 `lib/index.js` 必须完全重启 DSH**（托盘退出，不是关窗口）。只有 JSON 配置是热加载的。

---

## 许可

MIT
