// 活动日志条目 → 界面上画的东西。面板里只有这一处知道日志条目长什么样，条目的形状变了改这里。
// 纯函数，不碰页面（node 里也能跑：test/panel-logmodel.test.ts）。
//
// 日志有新旧两种形状，都认：
//   新：每次模型调用一条 model_call（带 call，想的时候就出现，结束时原地更新）；工具调用带 source（model / program / routine）和 step；
//       它写的程序的一次运行是一条 run（带 run，跑着时原地更新），例程的每一步不再进日志，只有出错的那几步各有一条 tool_result。
//   旧：没有 model_call；例程和程序里调的工具每次各两条，靠正文开头的“[例程 r3] ”“[程序] ”认；一轮调了几次模型只在
//       “第 N 轮结束（调了 N 次模型…）”那一句里。
//
// 画出来的是一条时间线（按条目的先后）：
//   msg    一句话：玩家说的、它说的、主人在面板上说的                             —— 对话
//   relay  两条线之间的一次往来：对话线交事、干活线汇报或提问、叫停                  —— 对话（它是连着两边的线索）
//   work   一轮决策里的一段：模型的若干步，每步下面是它调的工具                     —— 模型的决策
//   run    它写的程序的一次运行（例程，或者没挂在哪一步下面的 run_program）          —— 模型的决策
//   note   一条说明或报错                                                        —— 报错算“模型的决策”，说明算“全部”
//   events 连着的几条游戏事件（系统消息、谁进了服务器、任务开始了……）              —— 全部
// 一轮决策中间插进了别的东西（它说了一句话、别人说了话）时，这一轮切成前后几段，每段各是一个 work，时间线始终是先后顺序。
//
// 两条线（lane）：一个 AI 玩家有“对话”和“干活”两条线，各有各的模型调用（条目的 agent 字段：talk / work；现在后端只有一条 main）。
//   talk  说的话，和对话线自己的那几步；谁进出了服务器
//   work  其余的：干活线（或者唯一的那条线）的每一步、例程、身体的事件、说明和报错
// layoutRows 把时间线排成一行行：每行左边是对话那条线上的东西，右边是紧跟着它的干活那条线上的东西。

/** 时间线上每样东西属于哪一档：1 对话，2 加上模型的决策，3 全部。 */
export const LEVEL = { talk: 1, work: 2, all: 3 }

const ROUTINE_PREFIX = /^\[例程 (r\d+)\] ?/
const PROGRAM_PREFIX = /^\[程序\] ?/
const RUN_STEP_PREFIX = /^\[(?:例程|程序)[^\]#]*(?:#(\d+))?\] ?/
const TURN_START = /^第 (\d+) 轮开始(?:（(.*?)）)?：?([\s\S]*)$/
const TURN_END = /^第 (\d+) 轮结束（调了 (\d+) 次模型(?:，(.*?))?）/
const ROUTINE_START = /^例程 (r\d+)（([\s\S]*?)）开始在后台跑/
const ROUTINE_END = /^例程 (r\d+)（([\s\S]*?)）(跑完了|停了)：?([\s\S]*)$/
const SYSTEM_MESSAGE = /^系统消息：/
const COMINGS = /(进入了服务器|离开了服务器)$/
/** 两条线之间一次往来的正文：去掉开头的“对话线 → 干活线：”“干活线 → 对话线（提问）：”。 */
const RELAY_PREFIX = /^[^：\n]{0,40}→[^：\n]{0,40}：/

/** 条目的 agent → 画在哪条线上。 */
export const laneOfAgent = (agent) => (agent === 'talk' ? 'talk' : 'work')

/**
 * 一条工具调用或结果是谁发起的（模型自己、run_program 的程序、后台的例程），属于哪次程序运行，去掉前缀以后的正文。
 * 新日志用 source / runId 字段；旧日志只能从正文开头的“[例程 r3] ”“[程序] ”认。
 */
export function sourceOf(entry) {
  const text = String(entry.text ?? '')
  if (entry.source === 'model' || entry.source === 'program' || entry.source === 'routine') {
    // 程序运行里出错的那一步，正文开头带着“[例程 r3 #12] ”：是第几次调用单拎出来
    const tagged = entry.source === 'model' ? null : RUN_STEP_PREFIX.exec(text)
    return { source: entry.source, runId: entry.runId, text: tagged ? text.slice(tagged[0].length) : text, n: tagged?.[1] !== undefined ? Number(tagged[1]) : undefined }
  }
  const routine = ROUTINE_PREFIX.exec(text)
  if (routine) return { source: 'routine', runId: routine[1], text: text.slice(routine[0].length) }
  const program = PROGRAM_PREFIX.exec(text)
  if (program) return { source: 'program', runId: entry.runId, text: text.slice(program[0].length) }
  return { source: 'model', runId: entry.runId, text }
}

const seqOf = (entry) => (typeof entry._seq === 'number' ? entry._seq : entry.id)

function newTool(entry, text) {
  return { key: `c${entry.id}`, id: entry.id, name: entry.who ?? '?', time: entry.time, args: text, argsDetail: entry.detail, pending: true, isError: false, result: undefined, resultDetail: undefined, ms: undefined, pictures: [], scenes: [], run: undefined }
}

function finishTool(tool, entry, text) {
  tool.pending = false
  tool.result = text
  tool.resultDetail = entry.detail
  tool.isError = entry.isError === true
  tool.ms = Math.max(0, entry.time - tool.time)
  tool.pictures = entry.pictures ?? []
  tool.scenes = entry.scenes ?? []
}

function newRun(key, fields) {
  return {
    type: 'run',
    level: LEVEL.work,
    key,
    time: fields.time,
    firstId: fields.firstId,
    agent: fields.agent,
    run: { id: fields.id, kind: fields.kind, name: fields.name ?? '', status: 'running', startedAt: fields.time, endedAt: undefined, calls: 0, tasks: 0, errors: 0, waiting: undefined, file: undefined },
    /** 旧日志：只能从条目里数出来的（没有后端给的汇总）。 */
    legacy: fields.legacy === true,
    code: undefined,
    summary: undefined,
    ending: undefined,
    /** 出错的那几步（新日志只有这些进日志；旧日志是全部调用里出错的）。 */
    failed: [],
    /** 旧日志：每一步。新日志的明细在 /api/runs/records 里，这里是空的。 */
    calls: [],
    count: 0,
    rev: 0,
  }
}

function touch(item, entry) {
  item.count++
  const seq = seqOf(entry)
  if (seq > item.rev) item.rev = seq
}

/**
 * 把一批条目（按 id 从小到大）变成时间线。
 * 返回 { items, turns }：items 是时间线；turns 是每一轮的汇总（turn id → 这一轮的头，work 段都指着它）。
 */
export function buildTimeline(entries) {
  const items = []
  /** turn id → 这一轮。 */
  const turns = new Map()
  /** 运行的键 → run。 */
  const runs = new Map()
  /** 旧日志里 r3 现在指的是哪次运行（大脑重启以后编号从头数，同一个 r3 可能是另一次）。 */
  const legacyRunByName = new Map()
  /** 没带 turn 的那些条目（旧日志里程序调的工具）挂到哪：最近一个还开着的、正在等 run_program 结果的工具。 */
  let lastWork

  const push = (item) => {
    if (item.lane === undefined) item.lane = item.type === 'msg' ? 'talk' : laneOfAgent(item.agent)
    items.push(item)
    return item
  }

  const turnOf = (id, entry) => {
    let turn = turns.get(id)
    if (!turn) {
      turn = {
        id,
        key: `t${id}@${entry.id}`,
        agent: entry.agent,
        startedAt: undefined,
        firstTime: entry.time,
        endedAt: undefined,
        open: true,
        /** 这一轮的开头在不在这批条目里（往上翻到一半时可能不在）。 */
        hasStart: false,
        trigger: '',
        model: '',
        /** 给模型看的内容（这一轮开头那条的详情）。 */
        seen: undefined,
        /** 调了几次模型：结束那句里写的，或者数 model_call。 */
        calls: undefined,
        steps: 0,
        tools: 0,
        errors: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        hasTokens: false,
        modelMs: 0,
        parts: [],
        rev: 0,
      }
      turns.set(id, turn)
    }
    return turn
  }

  /** 这一轮现在往里加东西的那一段；时间线上它后面已经插了别的东西时，另开一段。 */
  const partOf = (turn, entry, startsStep) => {
    let part = turn.parts[turn.parts.length - 1]
    const interrupted = part !== undefined && items[items.length - 1] !== part
    if (!part || (interrupted && startsStep)) {
      part = push({ type: 'work', level: LEVEL.work, key: `${turn.key}#${turn.parts.length}`, time: entry.time, agent: entry.agent, turn, index: turn.parts.length, steps: [], notes: [], count: 0, rev: 0 })
      turn.parts.push(part)
    }
    return part
  }

  const newStep = (part, entry, n) => {
    const step = { key: `s${entry.id}`, n, time: entry.time, call: undefined, texts: [], tools: [], notes: [] }
    part.steps.push(step)
    return step
  }

  /** 新日志：按 step 号找这一轮的那一步（可能在前面的段里）；没有就在现在这一段里开一步。 */
  const stepByNumber = (turn, entry) => {
    for (let p = turn.parts.length - 1; p >= 0; p--) {
      const steps = turn.parts[p].steps
      for (let s = steps.length - 1; s >= 0; s--) if (steps[s].n === entry.step) return { part: turn.parts[p], step: steps[s] }
    }
    const part = partOf(turn, entry, true)
    turn.steps++
    return { part, step: newStep(part, entry, entry.step) }
  }

  /** 旧日志没有 step：一轮里的东西顺着排，每条模型文字、每次工具调用都当成可以另起一段的地方。 */
  const legacyStep = (turn, entry, startsStep) => {
    const part = partOf(turn, entry, startsStep)
    let step = part.steps[part.steps.length - 1]
    if (!step) step = newStep(part, entry, undefined)
    return { part, step }
  }

  const stamp = (turn, part, entry) => {
    touch(part, entry)
    const seq = seqOf(entry)
    if (seq > turn.rev) turn.rev = seq
  }

  const pendingTool = (turn, name) => {
    for (let p = turn.parts.length - 1; p >= 0; p--) {
      const steps = turn.parts[p].steps
      for (let s = steps.length - 1; s >= 0; s--) {
        const tools = steps[s].tools
        for (let t = tools.length - 1; t >= 0; t--) if (tools[t].pending && tools[t].name === name) return { part: turn.parts[p], tool: tools[t] }
      }
    }
    return undefined
  }

  const legacyRun = (runId, entry, name) => {
    let run = legacyRunByName.get(runId)
    // 这个编号上一次运行已经结束，又来了新的调用（不是停下时还在路上的那一步的结果）：是另一次运行，只是它的开头不在这批条目里
    if (run && run.run.endedAt !== undefined && entry.kind === 'tool_call' && entry.time > run.run.endedAt + 2000) run = undefined
    if (!run) {
      run = push(newRun(`r${runId}@${entry.id}`, { id: runId, kind: 'routine', name, time: entry.time, firstId: entry.id, agent: entry.agent, legacy: true }))
      runs.set(run.key, run)
      legacyRunByName.set(runId, run)
    }
    return run
  }

  const applyRunSnapshot = (item, snapshot) => {
    if (!snapshot || typeof snapshot !== 'object') return
    const run = item.run
    for (const key of ['id', 'kind', 'name', 'status', 'startedAt', 'endedAt', 'calls', 'tasks', 'errors', 'file']) if (snapshot[key] !== undefined) run[key] = snapshot[key]
    run.waiting = snapshot.status === 'running' ? snapshot.waiting : undefined
  }

  /** 新日志里一次运行的那个 run：按文件名认（唯一），没有文件名的按“编号 + 头一条的 id”。 */
  const runByEntry = (entry) => {
    const snapshot = entry.run
    const id = entry.runId ?? snapshot?.id
    if (id === undefined) return undefined
    const file = snapshot?.file
    let item = file !== undefined ? runs.get(`f:${file}`) : undefined
    // 没带文件名的条目（出错的那几步）：算在这个编号最近的一次运行上
    if (!item) item = legacyRunByName.get(`new:${id}`)
    if (!item || (file !== undefined && item.run.file !== undefined && item.run.file !== file)) {
      item = newRun(file !== undefined ? `f:${file}` : `r${id}@${entry.id}`, { id, kind: snapshot?.kind ?? (entry.source === 'program' ? 'program' : 'routine'), name: snapshot?.name, time: snapshot?.startedAt ?? entry.time, firstId: entry.id, agent: entry.agent })
      // run_program 的程序：挂在等着它的那次工具调用下面；例程自己占时间线上的一行
      const host = item.run.kind === 'program' && lastWork ? pendingTool(lastWork, 'run_program') : undefined
      if (host) {
        host.tool.run = item
        item.host = host.part
      } else {
        push(item)
      }
      legacyRunByName.set(`new:${id}`, item)
    }
    if (file !== undefined) runs.set(`f:${file}`, item)
    return item
  }

  const bump = (item, entry) => {
    touch(item, entry)
    // 挂在某一步下面的运行变了，那一段也要重画
    if (item.host) stamp(item.host.turn, item.host, entry)
  }

  for (const entry of entries) {
    const kind = entry.kind
    const hasTurn = typeof entry.turn === 'number'

    if (kind === 'chat' || kind === 'whisper' || kind === 'say' || kind === 'command') {
      push({
        type: 'msg',
        level: LEVEL.talk,
        key: `m${entry.id}`,
        id: entry.id,
        time: entry.time,
        agent: entry.agent,
        role: kind === 'command' ? 'owner' : kind === 'say' ? 'bot' : 'player',
        whisper: kind === 'whisper',
        who: entry.who ?? (kind === 'command' ? '面板' : ''),
        text: entry.text,
        // 聊天：为什么这句没叫醒模型；它说的：这句是程序替它说的、发出去时被截了几行
        note: entry.detail,
        sent: entry.sent,
        rev: seqOf(entry),
      })
      continue
    }

    if (kind === 'relay') {
      const relay = entry.relay ?? {}
      const text = String(entry.text ?? '')
      push({
        type: 'relay',
        level: LEVEL.talk,
        lane: 'both',
        key: `y${entry.id}`,
        id: entry.id,
        time: entry.time,
        agent: entry.agent,
        // tell 交事或带话 | report 中途汇报 | question 提问、在等回答 | result 一轮结束留下的话 | trouble 出了状况 | stop 叫停
        kind: relay.type ?? 'tell',
        from: relay.from ?? entry.agent ?? 'talk',
        to: relay.to ?? (entry.agent === 'work' ? 'talk' : 'work'),
        quotes: relay.quotes ?? 0,
        text: text.replace(RELAY_PREFIX, ''),
        detail: entry.detail,
        isError: entry.isError === true,
        turn: entry.turn,
        rev: seqOf(entry),
      })
      continue
    }

    if (kind === 'turn' && hasTurn) {
      const turn = turnOf(entry.turn, entry)
      const start = TURN_START.exec(entry.text)
      const end = start ? null : TURN_END.exec(entry.text)
      if (start) {
        turn.hasStart = true
        turn.startedAt = entry.time
        turn.model = start[2] ?? ''
        turn.trigger = (start[3] ?? '').trim()
        turn.seen = entry.detail
        stamp(turn, partOf(turn, entry, true), entry)
      } else {
        turn.open = false
        turn.endedAt = entry.time
        if (end) {
          turn.calls = Number(end[2])
          if (!turn.model && end[3]) turn.model = end[3]
        }
        const part = turn.parts[turn.parts.length - 1] ?? partOf(turn, entry, true)
        stamp(turn, part, entry)
      }
      lastWork = turn
      continue
    }

    if (kind === 'model_call') {
      const call = entry.call ?? {}
      if (!hasTurn || call.purpose === 'compact') {
        push({ type: 'note', level: LEVEL.work, key: `n${entry.id}`, id: entry.id, time: entry.time, agent: entry.agent, tone: entry.isError ? 'error' : 'info', label: '模型', text: entry.text, detail: entry.detail, call, rev: seqOf(entry) })
        continue
      }
      const turn = turnOf(entry.turn, entry)
      const { part, step } = stepByNumber(turn, { ...entry, step: entry.step ?? call.step })
      step.call = { ...call, id: entry.id, text: entry.text, isError: entry.isError === true }
      stamp(turn, part, entry)
      lastWork = turn
      continue
    }

    if (kind === 'model_text' && hasTurn) {
      const turn = turnOf(entry.turn, entry)
      const { part, step } = typeof entry.step === 'number' ? stepByNumber(turn, entry) : legacyStep(turn, entry, true)
      step.texts.push({ id: entry.id, time: entry.time, text: entry.text })
      stamp(turn, part, entry)
      continue
    }

    if (kind === 'tool_call' || kind === 'tool_result') {
      const { source, runId, text } = sourceOf(entry)

      if (source === 'model' && hasTurn) {
        const turn = turnOf(entry.turn, entry)
        if (kind === 'tool_call') {
          const { part, step } = typeof entry.step === 'number' ? stepByNumber(turn, entry) : legacyStep(turn, entry, true)
          step.tools.push(newTool(entry, text))
          turn.tools++
          stamp(turn, part, entry)
        } else {
          const found = pendingTool(turn, entry.who ?? '?')
          if (found) {
            finishTool(found.tool, entry, text)
            if (found.tool.isError) turn.errors++
            stamp(turn, found.part, entry)
          } else {
            // 调用那一条不在这批条目里（往上翻到一半）：结果自己成一行
            const { part, step } = typeof entry.step === 'number' ? stepByNumber(turn, entry) : legacyStep(turn, entry, true)
            const tool = newTool(entry, '')
            tool.args = undefined
            finishTool(tool, entry, text)
            tool.ms = undefined
            step.tools.push(tool)
            turn.tools++
            if (tool.isError) turn.errors++
            stamp(turn, part, entry)
          }
        }
        lastWork = turn
        continue
      }

      if (source === 'routine' && runId !== undefined && entry.source === undefined) {
        // 旧日志：例程的每一步都在日志里，自己数
        const item = legacyRun(runId, entry, '')
        if (kind === 'tool_call') {
          item.calls.push(newTool(entry, text))
          item.run.calls++
          item.run.waiting = `${entry.who ?? '?'} ${text}`
        } else {
          const tool = [...item.calls].reverse().find((t) => t.pending && t.name === (entry.who ?? '?'))
          if (tool) {
            finishTool(tool, entry, text)
            if (/\[(done|failed|canceled)\]/.test(text) || /^Task \S+ \(/.test(text)) item.run.tasks++
            if (tool.isError) {
              item.run.errors++
              item.failed.push(tool)
            }
          }
          item.run.waiting = undefined
        }
        item.lastTime = entry.time
        bump(item, entry)
        continue
      }

      if (entry.source !== undefined && runId !== undefined) {
        // 新日志：程序运行里出错的那一步
        const item = runByEntry(entry)
        if (item) {
          if (kind === 'tool_result') {
            const tool = newTool(entry, undefined)
            finishTool(tool, entry, text)
            tool.ms = undefined
            item.failed.push(tool)
          }
          bump(item, entry)
          continue
        }
      }

      // 旧日志里 run_program 的程序调的工具：挂在等着它的那次 run_program 下面
      const host = lastWork ? pendingTool(lastWork, 'run_program') : undefined
      if (host) {
        let item = host.tool.run
        if (!item) {
          item = newRun(`p@${entry.id}`, { id: 'p', kind: 'program', name: '', time: entry.time, firstId: entry.id, agent: entry.agent, legacy: true })
          item.host = host.part
          host.tool.run = item
        }
        if (kind === 'tool_call') {
          item.calls.push(newTool(entry, text))
          item.run.calls++
        } else {
          const tool = [...item.calls].reverse().find((t) => t.pending && t.name === (entry.who ?? '?'))
          if (tool) {
            finishTool(tool, entry, text)
            if (tool.isError) {
              item.run.errors++
              item.failed.push(tool)
            }
          }
        }
        item.lastTime = entry.time
        item.run.status = 'done'
        item.run.endedAt = entry.time
        bump(item, entry)
        continue
      }

      // 哪儿都挂不上的工具调用：当一条说明
      push({ type: 'note', level: LEVEL.all, key: `n${entry.id}`, id: entry.id, time: entry.time, agent: entry.agent, tone: entry.isError ? 'error' : 'info', label: kind === 'tool_call' ? '调工具' : '结果', text: `${entry.who ?? ''} ${text}`.trim(), detail: entry.detail, rev: seqOf(entry) })
      continue
    }

    if (kind === 'run') {
      const item = runByEntry(entry)
      if (item) {
        applyRunSnapshot(item, entry.run)
        item.text = entry.text
        bump(item, entry)
      }
      continue
    }

    if (kind === 'info' || kind === 'error') {
      // 例程开始、结束的那两条：并进那次运行
      if (entry.runId !== undefined || entry.run !== undefined) {
        const item = runByEntry(entry)
        if (item) {
          applyRunSnapshot(item, entry.run)
          const ended = entry.run?.status !== undefined && entry.run.status !== 'running'
          if (ended) {
            item.summary = entry.detail
            item.ending = entry.text
          } else {
            item.code = entry.detail
          }
          bump(item, entry)
          continue
        }
      }
      const started = ROUTINE_START.exec(entry.text)
      if (started) {
        // 同一个编号又开了一次：是另一次运行
        legacyRunByName.delete(started[1])
        const item = legacyRun(started[1], entry, started[2])
        item.run.name = started[2]
        item.code = entry.detail
        bump(item, entry)
        continue
      }
      const ended = ROUTINE_END.exec(entry.text)
      if (ended) {
        const item = legacyRun(ended[1], entry, ended[2])
        if (!item.run.name) item.run.name = ended[2]
        item.run.status = ended[3] === '跑完了' ? 'done' : 'stopped'
        item.run.endedAt = entry.time
        item.run.waiting = undefined
        item.summary = entry.detail
        item.ending = ended[4]
        bump(item, entry)
        continue
      }
      if (hasTurn) {
        const turn = turnOf(entry.turn, entry)
        const part = partOf(turn, entry, false)
        const step = part.steps[part.steps.length - 1]
        const note = { id: entry.id, time: entry.time, tone: kind, text: entry.text, detail: entry.detail }
        if (step) step.notes.push(note)
        else part.notes.push(note)
        if (kind === 'error') turn.errors++
        stamp(turn, part, entry)
        continue
      }
      push({ type: 'note', level: kind === 'error' ? LEVEL.work : LEVEL.all, key: `n${entry.id}`, id: entry.id, time: entry.time, agent: entry.agent, tone: kind, label: kind === 'error' ? '出错' : '说明', text: entry.text, detail: entry.detail, rev: seqOf(entry) })
      continue
    }

    // 游戏事件，和别的不认识的种类：连着的并成一组
    const last = items[items.length - 1]
    const text = String(entry.text ?? '')
    const system = SYSTEM_MESSAGE.test(text)
    const line = { id: entry.id, time: entry.time, text: system ? text.replace(SYSTEM_MESSAGE, '') : text, detail: entry.detail, system, kind }
    // 谁进出了服务器算在对话那条线上（聊天里也看得到的事），别的事件算在干活那条线上
    const lane = entry.agent !== undefined ? laneOfAgent(entry.agent) : COMINGS.test(text) ? 'talk' : 'work'
    if (last && last.type === 'events' && last.lane === lane) {
      last.lines.push(line)
      touch(last, entry)
    } else {
      const group = push({ type: 'events', level: LEVEL.all, lane, key: `e${entry.id}`, time: entry.time, agent: entry.agent, lines: [line], count: 0, rev: 0 })
      touch(group, entry)
    }
  }

  // 每一轮的账：数步数、加 token
  for (const turn of turns.values()) {
    let calls = 0
    for (const part of turn.parts) {
      for (const step of part.steps) {
        const call = step.call
        if (!call) continue
        calls++
        if (typeof call.inputTokens === 'number') {
          turn.hasTokens = true
          turn.inputTokens += call.inputTokens
          turn.outputTokens += call.outputTokens ?? 0
          turn.cacheReadTokens += call.cacheReadTokens ?? 0
        }
        if (typeof call.ms === 'number') turn.modelMs += call.ms
        if (call.state === 'failed') turn.errors++
      }
    }
    if (calls > 0) turn.calls = Math.max(turn.calls ?? 0, calls)
    /** 旧日志：没有每一步的账。 */
    turn.legacy = calls === 0
  }
  for (const item of items) {
    if (item.type === 'work') item.rev = `${item.count}:${item.rev}:${item.turn.rev}:${item.turn.open ? 1 : 0}`
    else if (item.type === 'run' || item.type === 'events') item.rev = `${item.count}:${item.rev}`
    if (item.type === 'run' && item.legacy && item.run.status === 'running' && item.lastTime !== undefined) item.run.lastActivity = item.lastTime
  }
  return { items, turns }
}

/**
 * 时间线 → 一行行。每行 { key, left, right }：left 是对话那条线上连着的几样东西，right 是紧跟在它们后面的干活那条线上的东西。
 * 干活线上的东西后面又来了对话线上的，就另起一行：所以从上到下、每行先左后右，还是时间顺序。
 * minLevel 以上的不要（1 只要对话，2 加上模型的决策，3 全部）。
 */
export function layoutRows(items, maxLevel = LEVEL.all) {
  const rows = []
  let row
  for (const item of items) {
    if (item.level > maxLevel) continue
    // 两条线之间的往来横跨两边，自己占一行
    if (item.lane === 'both') {
      rows.push({ key: item.key, left: [], right: [], both: item })
      row = undefined
      continue
    }
    const left = item.lane === 'talk'
    if (!row || (left && row.right.length > 0)) {
      row = { key: item.key, left: [], right: [] }
      rows.push(row)
    }
    ;(left ? row.left : row.right).push(item)
  }
  return rows
}

/** 旧日志里一次运行调了哪些工具、各几次（多的在前）。 */
export function toolHistogram(calls) {
  const counts = new Map()
  for (const call of calls) counts.set(call.name, (counts.get(call.name) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }))
}

/** 两条线之间一次往来的叫法。 */
export const RELAY_LABELS = { tell: '交给干活线', report: '干活线汇报', question: '干活线提问', result: '干活线做完了', trouble: '干活线出了状况', stop: '叫停' }

/**
 * “现在”页的“最近几步”：时间线最后的若干样东西，摊平成一行一件事（新的在后）。
 * 每行：{ key, time, kind: 'say' | 'heard' | 'step' | 'tool' | 'run' | 'error', label, text, isError, pending }
 */
export function recentActivity(items, limit = 12) {
  const rows = []
  for (let i = items.length - 1; i >= 0 && rows.length < limit * 3; i--) {
    const item = items[i]
    if (item.type === 'msg') {
      rows.push({ key: item.key, time: item.time, kind: item.role === 'bot' ? 'say' : 'heard', label: item.role === 'bot' ? '它说' : item.role === 'owner' ? '你（面板）' : item.who, text: item.text })
    } else if (item.type === 'relay') {
      rows.push({ key: item.key, time: item.time, kind: 'relay', label: RELAY_LABELS[item.kind] ?? item.kind, text: item.text, isError: item.isError, pending: item.kind === 'question' })
    } else if (item.type === 'run') {
      const r = item.run
      rows.push({ key: item.key, time: r.endedAt ?? item.lastTime ?? item.time, kind: 'run', label: r.kind === 'program' ? '程序' : `例程 ${r.id}`, text: `${r.name || '（没有名字）'}：${r.calls} 次调用`, pending: r.status === 'running', isError: r.status === 'failed' || r.errors > 0, run: r })
    } else if (item.type === 'note' && item.tone === 'error') {
      rows.push({ key: item.key, time: item.time, kind: 'error', label: '出错', text: item.text, isError: true })
    } else if (item.type === 'work') {
      for (let s = item.steps.length - 1; s >= 0; s--) {
        const step = item.steps[s]
        for (let t = step.tools.length - 1; t >= 0; t--) {
          const tool = step.tools[t]
          // 它说的话已经单独有一行了
          if ((tool.name === 'say' || tool.name === 'whisper') && !tool.isError) continue
          rows.push({ key: tool.key, time: tool.time, kind: 'tool', label: tool.name, text: tool.pending ? (tool.args ?? '') : (tool.result ?? ''), args: tool.args, argsFull: tool.argsDetail, isError: tool.isError, pending: tool.pending, turn: item.turn.id, step: step.n })
        }
        for (let x = step.texts.length - 1; x >= 0; x--) rows.push({ key: `x${step.texts[x].id}`, time: step.texts[x].time, kind: 'step', label: '模型的文字', text: step.texts[x].text, turn: item.turn.id, step: step.n })
        if (step.call?.state === 'thinking') rows.push({ key: `k${step.call.id}`, time: step.time, kind: 'step', label: `第 ${step.n ?? '?'} 步`, text: '正在想…', pending: true, turn: item.turn.id, step: step.n })
      }
    }
  }
  rows.sort((a, b) => a.time - b.time)
  return rows.slice(Math.max(0, rows.length - limit))
}

// ── 工具参数：收起来时给人读的一句，不是半截 JSON ──

const QUOTED_KEYS = new Set(['message', 'text', 'note', 'question', 'reason', 'problem', 'goal', 'wish'])
const BARE_KEYS = new Set(['name', 'query', 'player', 'title', 'key', 'home', 'command', 'tool', 'machine', 'kind', 'category'])
const PLACE_WORDS = { from: '从', to: '到', on: '对着', near: '靠近', container: '', at: '', pos: '', block: '', target: '' }
const isPos = (v) => v !== null && typeof v === 'object' && typeof v.x === 'number' && typeof v.y === 'number' && typeof v.z === 'number'
const isItem = (v) => v !== null && typeof v === 'object' && typeof v.id === 'string' && v.id.includes(':')
const clipText = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text)

function itemText(item, itemName) {
  const name = itemName(item.id, typeof item.meta === 'number' ? item.meta : 0) ?? item.id
  return `${name}${typeof item.count === 'number' ? ` ×${item.count}` : ''}`
}

function placeText(key, v) {
  const word = PLACE_WORDS[key] ?? key
  const slot = typeof v.slot === 'number' ? ` 第 ${v.slot} 格` : ''
  return `${word}${word ? ' ' : ''}(${v.x},${v.y},${v.z})${slot}`
}

function valueText(key, v, itemName) {
  if (v === null || v === undefined) return undefined
  if (typeof v === 'string') {
    if (key === 'code') return `程序（${v.split('\n').length} 行）`
    if (QUOTED_KEYS.has(key)) return `“${clipText(v, 80)}”`
    if (BARE_KEYS.has(key)) return clipText(v, 60)
    // 物品的 id 单独给的（{"id":"mod:name","meta":3}）在外面一起处理；别的字符串写成 键=值
    return `${key}=${clipText(v, 40)}`
  }
  if (typeof v === 'boolean') return v ? key : `${key}=否`
  if (typeof v === 'number') return `${key}=${v}`
  if (Array.isArray(v)) {
    if (v.length === 0) return undefined
    if (v.every(isItem)) return `${v.slice(0, 3).map((i) => itemText(i, itemName)).join('、')}${v.length > 3 ? ` 等 ${v.length} 样` : ''}`
    if (v.every(isPos)) return `${v.length} 个位置`
    if (v.every((x) => typeof x === 'string' || typeof x === 'number')) return `${BARE_KEYS.has(key) || key === 'ids' || key === 'blocks' ? '' : `${key}=`}${clipText(v.join('、'), 60)}`
    return `${key}：${v.length} 项`
  }
  if (isPos(v)) return placeText(key, v)
  if (isItem(v)) return itemText(v, itemName)
  // 套了一层的：{"item":{"id":…}}（随身的包当容器）、{"container":{"item":{…}}}
  const inner = describeObject(v, itemName)
  const word = PLACE_WORDS[key] ?? ''
  return inner ? `${word}${word ? ' ' : ''}${inner}` : undefined
}

function describeObject(obj, itemName) {
  const parts = []
  const rest = { ...obj }
  // 一样东西直接摊在最外面：{"id":"mod:name","meta":0,"count":3}
  if (isItem(rest)) {
    parts.push(itemText(rest, itemName))
    delete rest.id
    delete rest.meta
    delete rest.count
  }
  // 一块区域、一个位置摊在最外面
  if (['x1', 'z1', 'x2', 'z2'].every((k) => typeof rest[k] === 'number')) {
    const y = typeof rest.y1 === 'number' && typeof rest.y2 === 'number'
    parts.push(y ? `(${rest.x1},${rest.y1},${rest.z1})–(${rest.x2},${rest.y2},${rest.z2})` : `(${rest.x1},${rest.z1})–(${rest.x2},${rest.z2})`)
    for (const k of ['x1', 'y1', 'z1', 'x2', 'y2', 'z2']) delete rest[k]
  } else if (isPos(rest)) {
    parts.push(`(${rest.x},${rest.y},${rest.z})`)
    for (const k of ['x', 'y', 'z']) delete rest[k]
  } else if (typeof rest.x === 'number' && typeof rest.z === 'number') {
    parts.push(`(${rest.x},${rest.z})`)
    delete rest.x
    delete rest.z
  }
  for (const [key, value] of Object.entries(rest)) {
    const text = valueText(key, value, itemName)
    if (text) parts.push(text)
  }
  return parts.join(' · ')
}

/**
 * 一次工具调用的参数 → 一句给人读的话：物品写名字（itemName(id, meta) 查得到就是中文名）和数量，位置写成 (x,y,z)，
 * 说的话加引号，程序只写几行。不认识工具，只看参数长什么样。
 * raw 是参数的 JSON（一行的那个被截短了就解不出来）：解不出来返回 undefined，调用的地方照原样显示。
 * 没有参数（{}）返回空字符串。
 */
export function describeArgs(raw, itemName = () => undefined) {
  if (typeof raw !== 'string') return undefined
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return describeObject(value, itemName)
}
