# dsh-interject

**English** | [中文](README.zh.md)

Delivers a queued chat message at the **next step boundary** instead of waiting for the whole
turn to finish — without aborting the model call that is already running.

A DeepSeek Harness **host plugin**. No client half, no WebUI changes, no `app.asar` edits.

---

## The problem

While an agent is working through a long turn (a single reasoning step can take minutes), a
message you send mid-turn goes into the `next-turn` inbox queue. The loop only claims that queue
**after the entire turn ends** — which may be many steps later.

## What this plugin does

DSH's inbox has two queues:

| Queue | Written by | Claimed at |
|---|---|---|
| `next-turn` | Enter while busy (queue and send) | **after the whole turn ends** |
| `next-step` | Cmd/Ctrl+Enter (interject and send) | **the next step boundary** (one step = one model call plus its tools) |

The plugin listens for `agent/inbox/inserted`. When the policy matches, it moves the message from
`next-turn` into `next-step`. At the start of the next step the model sees your message in its
history, and the reasoning currently in flight is not discarded at all.

**Why it cannot be read mid-generation:** `llm.stream(request)` freezes the `messages` array when
the request is built and the HTTP body is already on the wire — there is no channel to append
input during generation. So there are only two options: wait for the call to finish (the default
here), or abort and resend (`interrupt`).

---

## Install

### From the plugin market

Search for `dsh-interject` in the DSH plugin market and install it. The market resolves the
package from this repository.

### From source

```bash
git clone https://github.com/sdlhs/dsh-interject.git
cd dsh-interject
dsh plugin --profile desktop add .
```

The package declares `dsh.bundle.patch`, so the profile picks up `cordis.patch.yml` automatically
and the row mounts on the next start. Restart DSH fully after installing or editing
`lib/index.js` — DSH loads plugins as static ESM, so file edits do not affect a running process.

### Manual mounting (without the market)

Add to your profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-interject
      name: dsh-interject
```

`name` must be the **package name**, not an absolute path — the market matches loader entries by
name, and an absolute path leaves the plugin card reading "installed, not loaded".

---

## Configuration

`~/.dsh/dsh-interject.json` — **hot-reloaded**, save the file and it takes effect; no restart.

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

| Field | Values | Meaning |
|---|---|---|
| `onQueue` | `steer` / `interrupt` / `pass` | What to do with a message that entered `next-turn`. `steer` = promote it to `next-step` (**default, zero waste**) |
| `onSteer` | `pass` / `interrupt` | What to do with a message that entered `next-step`. `pass` = hands off (**default**, it already waits for the next boundary) |
| `interruptWhile` | `thinking` / `always` | When a hard interrupt is allowed; with `thinking`, the tool-running phase degrades to a soft interjection instead of killing a long command |
| `graceMs` | ms | Delay after a hit, so messages sent in one batch are merged |
| `cooldownMs` | ms | Minimum gap between two hard interrupts on one agent |
| `includeSubagents` | bool | Also handle sub-agents (default: only root sessions you can see) |
| `stallMs` | ms, `0` disables | Write a "still running" line to the log when a single step exceeds this |
| `log` | bool | Diagnostic log switch |

**The default never interrupts.** To make Cmd/Ctrl+Enter a preemption gesture:
`{"onSteer": "interrupt"}`. To switch the plugin off: `{"enabled": false}`.

Environment overrides: `DSH_INTERJECT_CONFIG` (config path), `DSH_INTERJECT_LOG` (log path;
empty string disables logging).

---

## Does it cost more tokens?

**Not with the default configuration.** The plugin sends no extra requests; it only moves a pending
message to a different queue. The only increment is that the message enters history earlier, so
the remaining requests in this turn carry it once more — a prompt-cache prefix hit, which is cheap.

Only `interrupt` really costs: the aborted request's produced output is billed as usual, and then
a full history is resent.

---

## Verifying it works

```powershell
Get-Content "$env:TEMP\dsh-interject.log" -Tail 20
```

A working promotion logs `next-turn -> next-step <id>`. If a single step exceeds `stallMs` you see
`step N of turn M has been running Xs (still going)` — use it to tell "one request is genuinely
stuck" from "a long turn made of many normal steps" (the UI's "thinking, X elapsed" counts the
**whole turn**).

Offline self-check, no DSH needed:

```bash
node test/test-interject.mjs        # 39 checks: policy, capability probing, degraded paths
node test/test-interject-loop.mjs   # 15 checks: mini driver transcribed from agent-loop
```

Both scripts import `../lib/index.js` by default; set `DSH_INTERJECT_ENTRY` to test another build.

---

## Compatibility

Declared: `>=0.2.0-rc.1` with no upper bound. The source of three host versions was read line by
line to confirm the public surface this plugin uses:

| Version | Status |
|---|---|
| `0.2.0-rc.2` | verified (development host) |
| `0.2.1-rc.5` | verified (npm `latest` / `next`) |
| `0.2.2-alpha.2` | verified (npm `alpha`) |

Every capability is **probed, not assumed** — the plugin imports no `@deepseek-ai/*` package and
uses only the `ctx` / `agent` objects the host passes in. That is not for the sake of older
versions: it is so a future rename of an internal field degrades the plugin instead of breaking it.
Anything undetectable falls back to a public path (for example, no `phase` means `remove` +
`followup` instead of the wake latch).

The three versions agree on: `ctx.agents.get/roots`, `agent.session`, `agent.status`,
`agent.inbox.{nextTurn,nextStep,hasPending,claim,append,prepend,replace,remove,splice}`,
`agent.followup/steer/inject/cancel`, the session events `step/start`, `step/end`, `turn/end`,
`assistant/message`, `assistant/attempt`, `tool/call`, `tool/result`, `agent/inbox/inserted`
(payload `{agent, message}`), `agent/disposed` (payload `{agent}`), `message.source.kind === 'user'`,
and the internal field `agent.phase.wakeRequested`.

---

## Known limits

- **`steer` is not zero-latency.** It can only act at the boundary of the current model call. If
  that call runs for ten minutes, you still wait ten minutes.
- **Moving a message leaves one `agent/inbox/spliced` with `outcome: 'canceled'`.** That is the
  shape of the public API (`inbox.remove()` goes through `splice()`). Verified harmless: the goal
  driver's `sameQueued()` requires `source.kind === 'goal'`, and the UI's
  `retireFailedSubmission()` raises nothing for a plain-text submission.
- **`interrupt` mode depends on `agent.phase.wakeRequested`**, the one internal field this plugin
  touches. Without it the plugin falls back to `inbox.remove()` + `agent.followup()`.
- **Editing `lib/index.js` requires a full DSH restart** (tray exit, not just closing the window).
  Only the JSON config is hot-reloaded.

---

## License

MIT
