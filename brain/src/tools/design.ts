// 自己出设计：模型写一段 JavaScript 程序，在沙箱里跑，产物是图纸草稿（存在大脑这边，不在游戏里）。
// 草稿给主人看过、同意了，再发布成服务器上的图纸，之后就用 check_blueprint / build_blueprint 照着盖。
// 程序是纯计算，动不了世界；沙箱保证什么、不保证什么见 docs/SCRIPTS.md。

import { BridgeError } from '../bridge/protocol.ts'
import { DesignBusyError, PROGRAM_TIMEOUT_MAX_MS, PreviewError, SCHEMATIC_MAX_BYTES, blockCount, isValidDraftName, kindKey, materialsOf, renderPreview, toSchematic } from '../design/index.ts'
import type { Axis, DesignWorkspace, Draft, DraftSummary, ProgramRun } from '../design/index.ts'
import { GridError, cropGrid, gridFromDraft, legendLines, renderView } from '../render/index.ts'
import { VIEW_PARAMS, looksForTable, pictureResult, toImage, viewSpec, viewWords } from './pictures.ts'
import { bool, int, obj, str } from './schema.ts'
import { ToolFailure, fail } from './types.ts'
import type { Tool, ToolContext, ToolResult } from './types.ts'

export const PROGRAM_MAX_CHARS = 20_000
/** run_program 的程序连同它等查询结果的时间，最多这么久（模型的这一轮在等它）。 */
export const PROGRAM_WALL_MAX_MS = 90_000
/** 一次预览大约画这么多字符的格子。 */
export const PREVIEW_BUDGET_CHARS = 4200
/** 跑完程序顺手带上的预览：草稿小才带。 */
const AUTO_PREVIEW_BUDGET_CHARS = 1500
const MATERIALS_SHOWN = 24

function workspace(ctx: ToolContext): DesignWorkspace {
  if (!ctx.design) throw new ToolFailure('Writing programs and drafts is not set up on this brain.')
  return ctx.design
}

function sizeText(size: { x: number; y: number; z: number }): string {
  return `${size.x}×${size.y}×${size.z}`
}

function summaryText(d: DraftSummary): string {
  return `${sizeText(d.size)} (x east-west × y up × z north-south), ${d.blocks} block(s) of ${d.kinds} kind(s)`
}

/**
 * 没说沿哪个方向切片时：沿最薄的那个方向（片数最少）。一样薄就按 y（一层层俯视）。
 * 竖着的像素画只有一格厚，这样一片就是整幅画，而不是几十层每层一行。
 */
function thinnestAxis(draft: Draft): Axis {
  const { x, y, z } = draft.size
  return y <= x && y <= z ? 'y' : z <= x ? 'z' : 'x'
}

/** 材料表：每种要多少，带中文名（查得到的话）。 */
function materialLines(design: DesignWorkspace, draft: Draft): string[] {
  const all = materialsOf(draft)
  const lines = all.slice(0, MATERIALS_SHOWN).map((m) => {
    const name = design.nameOf(m)
    return `- ${m.count}× ${kindKey(m)}${name ? ` "${name}"` : ''}`
  })
  if (all.length > MATERIALS_SHOWN) {
    const rest = all.slice(MATERIALS_SHOWN)
    lines.push(`- … and ${rest.length} more kinds (${rest.reduce((n, m) => n + m.count, 0)} blocks)`)
  }
  return lines
}

function programFailure(run: ProgramRun, timeoutMs: number): string {
  const o = run.outcome
  switch (o.status) {
    case 'error': {
      const e = o.error
      const where = e.line !== undefined ? ` at line ${e.line}${e.column !== undefined ? `, column ${e.column}` : ''}` : ''
      const lines = [`The program failed${where}: ${e.name}: ${e.message}`]
      if (e.source) lines.push(e.source)
      if (e.frames && e.frames.length > 0) lines.push(`Call stack: ${e.frames.join('; ')}`)
      lines.push('Nothing was saved. Fix the program and run it again.')
      return lines.join('\n')
    }
    case 'timeout':
      return `The program was stopped: it ran longer than ${timeoutMs / 1000} s. Nothing was saved. Look for a loop that never ends, or do less work per run (a longer "timeout" is allowed, up to ${PROGRAM_TIMEOUT_MAX_MS / 1000} s).`
    case 'memory':
      return 'The program was stopped: it used too much memory. Nothing was saved. Keep less in memory at once (smaller arrays, a smaller blueprint or image).'
    case 'output':
      return 'The program was stopped: it produced too much output. Nothing was saved. Log less, and save smaller or simpler drafts.'
    case 'stopped':
      return 'The program was stopped before it finished. Nothing was saved.'
    case 'crashed':
      return `The program could not be run: ${o.detail ?? 'the sandbox process ended unexpectedly'}. Nothing was saved.`
    case 'ok':
      return ''
  }
}

export const runProgramTool: Tool = {
  name: 'run_program',
  description:
    'Run a JavaScript program you write, in a sandbox, and get its result in this turn: design blueprint drafts, read image pixels, calculate, or look many things up at once with await tool(name, input) (query tools only; it cannot start tasks). The code is the body of an async function; "return" a value to see it. Read the "design" manual for the API (drafts, images) and the "routines" manual for tool().',
  inputSchema: obj(
    {
      code: str('The program: JavaScript statements (the body of an async function). No import or require.', { maxLength: PROGRAM_MAX_CHARS }),
      timeout: int('Seconds it may run before it is stopped (default 10).', { min: 1, max: PROGRAM_TIMEOUT_MAX_MS / 1000 }),
    },
    ['code'],
  ),
  async run(ctx, i: { code: string; timeout?: number }): Promise<ToolResult | string> {
    const design = workspace(ctx)
    let run: ProgramRun
    const timeoutMs = (i.timeout ?? 10) * 1000
    try {
      const query = ctx.queryFromProgram
      run = await design.run(i.code, {
        timeoutMs,
        // 程序里可以调查询类的工具；整个程序连等结果的时间有个总上限，到了就停
        hooks: { signal: AbortSignal.timeout(PROGRAM_WALL_MAX_MS), ...(query ? { onCall: (call) => query(call.name, call.input) } : {}) },
      })
    } catch (e) {
      if (e instanceof DesignBusyError) return fail('Another program of yours is still running. Wait for it to finish.')
      throw e
    }
    const o = run.outcome
    const out: string[] = []
    if (o.status === 'ok') out.push(`The program finished in ${(o.durationMs / 1000).toFixed(1)} s.`)
    else out.push(programFailure(run, timeoutMs))
    if (o.logs.length > 0 || o.logDropped > 0) {
      out.push(`Log:\n${o.logs.join('\n')}${o.logDropped > 0 ? `\n… (${o.logDropped} more log line(s) were dropped: the log is full)` : ''}`)
    }
    if (o.status !== 'ok') return fail(out.join('\n'))
    if (o.value !== undefined) out.push(`Returned: ${o.value}`)

    for (const r of run.rejected) out.push(`Draft "${r.name}" was NOT saved: ${r.reason}.`)
    for (const saved of run.saved) {
      const record = design.drafts.get(saved.name)
      if (!record) continue
      out.push(`Saved draft "${saved.name}": ${summaryText(saved)}. It is only a draft on the brain: nothing is in the game yet.`)
      out.push('Materials:', ...materialLines(design, record.draft))
      // 小草稿把预览直接带上，省一次来回；大的让它自己用 view_draft 挑着看
      const preview = renderPreview(record.draft, { along: thinnestAxis(record.draft), budget: AUTO_PREVIEW_BUDGET_CHARS, nameOf: (k) => design.nameOf(k) })
      if (!/^Not drawn:|^Only /m.test(preview)) out.push(preview)
      else out.push(`It is too big to show whole here: look at it with view_draft (name "${saved.name}").`)
      if (ctx.canSeeImages?.() === true) out.push(`To see what it looks like, view_draft with name "${saved.name}" and picture "iso".`)
    }
    if (run.saved.length > 0) {
      out.push('Check the design, then tell your owner what it looks like, what it needs and where you would build it. Publish it with publish_draft only after they agree.')
    }
    return out.join('\n')
  },
}

export const startRoutine: Tool = {
  name: 'start_routine',
  description:
    'Start a JavaScript program that runs in the background and acts: it calls your tools with await tool(name, input), and a tool that starts a task returns when the task has ended. For many similar steps (move every item of a list, a chain of crafts) instead of calling the tools one by one. It returns at once: end your turn; you are woken with its log when it finishes, fails or is stopped. Read the routines manual first.',
  inputSchema: obj(
    {
      code: str('The program: JavaScript statements (the body of an async function).', { maxLength: PROGRAM_MAX_CHARS }),
      name: str('A few words saying what it does (shown to your owner).', { maxLength: 60 }),
      minutes: int('Stop it if it has not finished after this many minutes (default 30).', { min: 1, max: 180 }),
    },
    ['code'],
  ),
  async run(ctx, i: { code: string; name?: string; minutes?: number }): Promise<ToolResult | string> {
    if (!ctx.routines) return fail('Routines are not set up on this brain.')
    const res = ctx.routines.start(i.code, { ...(i.name !== undefined ? { name: i.name } : {}), ...(i.minutes !== undefined ? { minutes: i.minutes } : {}) })
    return 'error' in res ? fail(res.error) : res.started
  },
}

export const routineStatus: Tool = {
  name: 'routine_status',
  description: 'How your routine is doing: running or how it ended, the step it is waiting for, its last tool calls and its log.',
  inputSchema: obj({}),
  async run(ctx) {
    if (!ctx.routines) return fail('Routines are not set up on this brain.')
    return ctx.routines.status() ?? 'No routine has been started since the brain came up.'
  },
}

export const stopRoutine: Tool = {
  name: 'stop_routine',
  description: 'Stop your running routine and cancel the task it is waiting for. What it already did stays done.',
  inputSchema: obj({}),
  async run(ctx) {
    if (!ctx.routines) return fail('Routines are not set up on this brain.')
    return ctx.routines.stop() ? 'The routine was stopped. You will be woken with its log.' : 'No routine is running.'
  },
}

export const listImages: Tool = {
  name: 'list_images',
  description:
    'List the images your owner uploaded on the panel (for pixel art or as a reference): name and size in pixels. A program reads one with image(name).',
  inputSchema: obj({}),
  async run(ctx) {
    const images = workspace(ctx).images.list()
    if (images.length === 0) return 'There are no images. Your owner can upload some on the "图纸" page of the control panel.'
    return `${images.length} image(s) (name: width×height in pixels):\n${images.map((i) => `- ${i.name}: ${i.width}×${i.height}`).join('\n')}`
  },
}

export const listDrafts: Tool = {
  name: 'list_drafts',
  description:
    'List the blueprint drafts your programs saved: name, size and number of blocks. Drafts live on the brain, not in the game; publish_draft turns one into a blueprint on the server.',
  inputSchema: obj({}),
  async run(ctx) {
    const drafts = workspace(ctx).drafts.list()
    if (drafts.length === 0) return 'There are no drafts. A program saves one with blueprint(...).save(name) (see the "design" manual).'
    const age = (at: number): string => {
      const minutes = Math.max(0, Math.round((ctx.now() - at) / 60_000))
      return minutes < 60 ? `${minutes} min ago` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / 1440)} days ago`
    }
    return `${drafts.length} draft(s), newest first:\n${drafts.map((d) => `- ${d.name}: ${summaryText(d)}, saved ${age(d.savedAt)}`).join('\n')}`
  },
}

interface ViewInput {
  name: string
  along?: string
  x1?: number
  x2?: number
  y1?: number
  y2?: number
  z1?: number
  z2?: number
  program?: boolean
  picture?: string
  from?: string
  layer?: number
}

const coordinate = (axis: string, end: string) => int(`Show only from/to this ${axis} (${end} end of the range; cells count from 0).`, { min: 0 })

export const viewDraft: Tool = {
  name: 'view_draft',
  description:
    'Look at a blueprint draft: size, materials, and its cells drawn in characters, slice by slice ("along": y for layers from above, z or x for upright slices). Give x1..z2 to see a part. Give "picture" for a drawing instead of characters (pictures manual).',
  inputSchema: obj(
    {
      name: str('Draft name as list_drafts shows it.', { maxLength: 60 }),
      along: str('Which way to slice: y (layers from the bottom up), z (upright slices seen from the south) or x (upright slices seen from the west).', { enum: ['x', 'y', 'z'] }),
      x1: coordinate('x', 'low'),
      x2: coordinate('x', 'high'),
      y1: coordinate('y', 'low'),
      y2: coordinate('y', 'high'),
      z1: coordinate('z', 'low'),
      z2: coordinate('z', 'high'),
      program: bool('Also show the program that made the draft (to change it and run it again).'),
      picture: { ...VIEW_PARAMS.view, description: `Get a picture instead of characters. ${VIEW_PARAMS.view.description}`.replace('(default; best', '(best') },
      from: VIEW_PARAMS.from,
      layer: int('For picture "layer": which layer (y, counting from 0).', { min: 0 }),
    },
    ['name'],
  ),
  async run(ctx, i: ViewInput): Promise<ToolResult | string> {
    const design = workspace(ctx)
    const record = design.drafts.get(i.name.trim())
    if (!record) return fail(`There is no draft named "${i.name.trim()}". list_drafts shows the ones there are.`)
    const { draft } = record
    const head = `Draft "${draft.name}": ${sizeText(draft.size)} (x east-west × y up × z north-south), ${blockCount(draft)} block(s) of ${draft.kinds.length} kind(s). It is a draft on the brain, not in the game.`
    const box = Object.fromEntries((['x1', 'x2', 'y1', 'y2', 'z1', 'z2'] as const).flatMap((k) => (i[k] === undefined ? [] : [[k, i[k]]])))
    const preview = (): string => renderPreview(draft, { along: (i.along as Axis | undefined) ?? thinnestAxis(draft), box, budget: PREVIEW_BUDGET_CHARS, nameOf: (k) => design.nameOf(k) })
    const program = i.program ? [record.program !== undefined ? `Program that made it:\n${record.program}` : 'The program that made it was not kept.'] : []
    try {
      if (i.picture !== undefined) {
        const grid = cropGrid(gridFromDraft(draft), box)
        const spec = viewSpec({ view: i.picture, from: i.from, layer: i.layer }, grid, (layer) => layer - grid.origin.y)
        // 图上的字只有 ASCII：名字里有别的字就不写名字
        const picture = renderView(grid, looksForTable(design.colors()), spec, { title: /^[\x20-\x7e]+$/.test(draft.name) ? `Draft "${draft.name}"` : 'Draft' })
        const words = viewWords(spec, grid)
        return pictureResult(
          ctx,
          [
            head,
            ...(ctx.canSeeImages?.() === true ? [`Picture: ${words}, ${picture.width}×${picture.height} px, 1 block = ${picture.cell} px.`] : []),
            `${spec.view === 'layer' ? 'In that layer' : 'In it'} (most common first):`,
            ...legendLines(picture.legend, (k) => design.nameOf(k)),
            'The picture is a schematic drawing made from block colours, not what it will look like in the game: use it for shape and looks; the materials list is what counts.',
            ...program,
          ],
          toImage(picture, `${words} of the draft "${draft.name}"`, grid),
          () => [preview()],
        )
      }
      // 预览自己按预算裁过了，不要再被“单个工具结果上限”拦腰截断
      return { content: [head, 'Materials:', ...materialLines(design, draft), preview(), ...program].join('\n'), keepWhole: true }
    } catch (e) {
      if (e instanceof PreviewError || e instanceof GridError) return fail(`${e.message}.`)
      throw e
    }
  },
}

export const publishDraft: Tool = {
  name: 'publish_draft',
  description:
    'Send a draft to the game server as a blueprint (a .schematic file), so that check_blueprint and build_blueprint can use it. A blueprint of the same name is replaced. Do this only after your owner has seen the design and agreed, unless they told you to just build it.',
  inputSchema: obj(
    {
      name: str('Draft name as list_drafts shows it.', { maxLength: 60 }),
      as: str('Name for the blueprint on the server (default: the draft name).', { maxLength: 60 }),
    },
    ['name'],
  ),
  async run(ctx, i: { name: string; as?: string }): Promise<ToolResult | string> {
    const design = workspace(ctx)
    const record = design.drafts.get(i.name.trim())
    if (!record) return fail(`There is no draft named "${i.name.trim()}". list_drafts shows the ones there are.`)
    const target = (i.as ?? record.draft.name).trim()
    if (!isValidDraftName(target)) return fail(`"${target}" cannot be a blueprint name: no / \\ : * ? " < > | and no leading dot.`)
    const file = toSchematic(record.draft)
    if (file.length > SCHEMATIC_MAX_BYTES) {
      return fail(`The draft makes a ${(file.length / 1024 / 1024).toFixed(1)} MiB file; the server takes at most ${SCHEMATIC_MAX_BYTES / 1024 / 1024} MiB. Split the design into parts.`)
    }
    let saved: Awaited<ReturnType<ToolContext['bridge']['blueprintPut']>>
    try {
      saved = await ctx.bridge.blueprintPut(target, file.toString('base64'))
    } catch (e) {
      // 身体不收这个文件：把它的原话给模型，草稿还在
      if (e instanceof BridgeError && e.code === 'bad_request') return fail(`The game server did not accept the blueprint: ${e.message}. The draft is still there.`)
      throw e
    }
    const size = saved.size ? `${sizeText(saved.size)}, ` : ''
    return (
      `Published draft "${record.draft.name}" as blueprint "${saved.name ?? target}" on the server (${size}${saved.blocks ?? blockCount(record.draft)} blocks). ` +
      `Next: check_blueprint with name "${saved.name ?? target}" and the x, y, z where its lowest corner goes, then build_blueprint. The draft stays on the brain until you delete it.`
    )
  },
}

export const deleteDraft: Tool = {
  name: 'delete_draft',
  description: 'Delete a blueprint draft from the brain. A blueprint already published to the server is not affected.',
  inputSchema: obj({ name: str('Draft name as list_drafts shows it.', { maxLength: 60 }) }, ['name']),
  async run(ctx, i: { name: string }) {
    const removed = workspace(ctx).drafts.remove(i.name.trim())
    return removed ? `Deleted draft "${i.name.trim()}".` : fail(`There is no draft named "${i.name.trim()}". list_drafts shows the ones there are.`)
  },
}
