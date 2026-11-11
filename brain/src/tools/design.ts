// 自己出设计：模型写一段 JavaScript 程序，在沙箱里跑，产物是图纸草稿（存在大脑这边，不在游戏里）。
// 草稿给主人看过、同意了，再发布成服务器上的图纸，之后就用 check_blueprint / build_blueprint 照着盖。
// 程序是纯计算，动不了世界；沙箱保证什么、不保证什么见 docs/SCRIPTS.md。
// 列图纸、草稿、图片合成了一个 list_designs；旧的三个名字（list_blueprints、list_drafts、list_images）不在清单里了，调到照常执行。

import { BridgeError } from '../bridge/protocol.ts'
import { blueprintListing } from './blueprint.ts'
import { DesignBusyError, PROGRAM_TIMEOUT_MAX_MS, PreviewError, SCHEMATIC_MAX_BYTES, blockCount, isValidDraftName, kindKey, materialsOf, renderPreview, toSchematic } from '../design/index.ts'
import type { Axis, DesignWorkspace, Draft, DraftSummary, ProgramRun } from '../design/index.ts'
import { GridError, cropGrid, gridFromDraft, legendLines, renderView } from '../render/index.ts'
import { VIEW_PARAMS, looksForTable, pictureResult, toImage, viewSpec, viewWords } from './pictures.ts'
import { bool, int, obj, str } from './schema.ts'
import { DEFAULT_RESULT_MAX_CHARS, ToolFailure, fail } from './types.ts'
import type { Tool, ToolContext, ToolResult } from './types.ts'

export const PROGRAM_MAX_CHARS = 20_000
/** start_routine 的 minutes 参数在 schema 里最多写到多少（七天）；真正的上限是主人在面板上设的那个。 */
export const ROUTINE_MINUTES_SCHEMA_MAX = 7 * 24 * 60
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
      if (e.frames && e.frames.length > 0) lines.push(`Call stack${e.frames.length >= 6 ? ' (innermost 6 frames)' : ''}: ${e.frames.join('; ')}`)
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

/** “返回值被截了”的说明大约占这么多字符：算还能给返回值留多少地方时先扣掉。 */
const CUT_NOTE_CHARS = 360

/**
 * 程序 return 的值写成给模型看的那一段。total 是它原来多长，room 是这次结果里还放得下多少。
 * 放不下时只给开头，并写明：一共多少字符、给了多少、剩下的怎么拿到。不声不响地截掉会让模型把半截结果当成全部。
 */
export function returnedText(value: string, total: number, room: number, limit: string): string {
  if (total <= value.length && value.length <= room) return `Returned: ${value}`
  const shown = value.slice(0, Math.max(0, room))
  return (
    `Returned (CUT: this is only the first ${shown.length} of ${total} characters; ${limit}. ` +
    `To get the rest, return less at a time: pick the fields you need from r.data, narrow the tool call with its own filters or its page argument, or return a later slice of the text): ${shown}`
  )
}

/** 程序的日志满了时跟在日志后面的那句话。dropped 是没留下（或者只留下开头）的条数。 */
export function logFullNote(dropped: number, logChars: number): string {
  return `… (the log is full: it holds ${logChars} characters in all, so ${dropped} log line(s) after this point were cut short or dropped. Log less, or return what you need)`
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
    // 返回值最多给多少：跟“单个工具结果上限”那个设置走，和模型直接调工具时看到的一样多
    const resultMax = ctx.maxResultChars?.() ?? DEFAULT_RESULT_MAX_CHARS
    try {
      const query = ctx.queryFromProgram
      ctx.hooks.programStarted?.(i.code)
      run = await design.run(i.code, {
        timeoutMs,
        valueChars: resultMax,
        ...(ctx.programSlot !== undefined ? { slot: ctx.programSlot } : {}),
        // 程序里可以调查询类的工具；整个程序连等结果的时间有个总上限，到了就停
        hooks: { signal: AbortSignal.timeout(PROGRAM_WALL_MAX_MS), ...(query ? { onCall: (call) => query(call.name, call.input) } : {}) },
      })
      ctx.hooks.programEnded?.({ ok: run.outcome.status === 'ok', note: run.outcome.status })
    } catch (e) {
      ctx.hooks.programEnded?.({ ok: false, note: e instanceof Error ? e.message : String(e) })
      if (e instanceof DesignBusyError) return fail('Another program of yours is still running. Wait for it to finish.')
      throw e
    }
    const o = run.outcome
    const out: string[] = []
    if (o.status === 'ok') out.push(`The program finished in ${(o.durationMs / 1000).toFixed(1)} s.`)
    else out.push(programFailure(run, timeoutMs))
    if (o.logs.length > 0 || o.logDropped > 0) {
      out.push(`Log:\n${o.logs.join('\n')}${o.logDropped > 0 ? `\n${logFullNote(o.logDropped, design.logChars)}` : ''}`)
    }
    if (o.status !== 'ok') return fail(out.join('\n'))
    if (o.value !== undefined) {
      // 整个结果（连前面的日志）不超过上限：返回值放不下的部分在这里截掉并写明，不留给外层去拦腰截
      const total = o.valueLength ?? o.value.length
      const used = out.reduce((n, part) => n + part.length + 1, 0) + 'Returned: '.length
      const fits = total <= o.value.length && used + o.value.length <= resultMax
      const room = fits ? o.value.length : resultMax - used - CUT_NOTE_CHARS
      out.push(returnedText(o.value, total, room, `one result holds at most ${resultMax} characters${out.length > 1 ? ', the log above included' : ''}`))
    }

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
    'Start a JavaScript program that runs in the background and acts: it calls your tools with await tool(name, input), and a tool that starts a task returns when the task has ended. Many similar steps (moving every item of a list, a chain of crafts) fit in one routine instead of one tool call each: its calls cost no model call, and there is no limit on how many it makes. The library functions listed under run_program can be called here too. It returns at once; you are woken with its log when it finishes, fails or is stopped. Details: routines manual.',
  inputSchema: obj(
    {
      code: str('The program: JavaScript statements (the body of an async function).', { maxLength: PROGRAM_MAX_CHARS }),
      name: str('A few words saying what it does (shown to your owner).', { maxLength: 60 }),
      minutes: int('Stop it if it has not finished after this many minutes. The default and the longest allowed are set by your owner; the result says how long it may run.', { min: 1, max: ROUTINE_MINUTES_SCHEMA_MAX }),
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
    return ctx.routines.stop() ? 'The routine was stopped. Where it stopped and its log come to you as an event.' : 'No routine is running.'
  },
}

/** 主人传的图片：给模型看的那段文字，和给程序用的列表。 */
function imageListing(design: DesignWorkspace): { text: string; images: { name: string; width: number; height: number }[] } {
  const images = design.images.list().map((i) => ({ name: i.name, width: i.width, height: i.height }))
  const text =
    images.length === 0
      ? 'There are no images. Your owner can upload some on the "图纸" page of the control panel.'
      : `${images.length} image(s) (name: width×height in pixels):\n${images.map((i) => `- ${i.name}: ${i.width}×${i.height}`).join('\n')}`
  return { text, images }
}

/** 它的程序存下的草稿：给模型看的那段文字，和给程序用的列表。 */
function draftListing(ctx: ToolContext, design: DesignWorkspace): { text: string; drafts: DraftSummary[] } {
  const drafts = design.drafts.list()
  if (drafts.length === 0) return { text: 'There are no drafts. A program saves one with blueprint(...).save(name) (see the "design" manual).', drafts }
  const age = (at: number): string => {
    const minutes = Math.max(0, Math.round((ctx.now() - at) / 60_000))
    return minutes < 60 ? `${minutes} min ago` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / 1440)} days ago`
  }
  return { text: `${drafts.length} draft(s), newest first:\n${drafts.map((d) => `- ${d.name}: ${summaryText(d)}, saved ${age(d.savedAt)}`).join('\n')}`, drafts }
}

/** 旧名字：不在发给模型的清单里（并进了 list_designs），程序里、旧笔记里调到它照常执行。 */
export const listImages: Tool = {
  name: 'list_images',
  description:
    'List the images your owner uploaded on the panel (for pixel art or as a reference): name and size in pixels. A program reads one with image(name).',
  inputSchema: obj({}),
  async run(ctx): Promise<ToolResult> {
    const listing = imageListing(workspace(ctx))
    return { content: listing.text, data: { images: listing.images } }
  },
}

/** 旧名字，同上。 */
export const listDrafts: Tool = {
  name: 'list_drafts',
  description:
    'List the blueprint drafts your programs saved: name, size and number of blocks. Drafts live on the brain, not in the game; publish_draft turns one into a blueprint on the server.',
  inputSchema: obj({}),
  async run(ctx): Promise<ToolResult> {
    const listing = draftListing(ctx, workspace(ctx))
    return { content: listing.text, data: { drafts: listing.drafts } }
  },
}

export const DESIGN_KINDS = ['blueprints', 'drafts', 'images'] as const
type DesignKind = (typeof DESIGN_KINDS)[number]

/**
 * 能照着盖、能拿来设计的三样东西一起列：服务器上的图纸、大脑这边的草稿、主人传的图片。
 * 不给 kind 就三样都列；那时哪一样列不出来（没连上游戏、这个大脑没配设计用的目录）就在那一段里照实说，别的照列。
 */
export const listDesigns: Tool = {
  name: 'list_designs',
  description:
    'List what there is to build from and to design with. "blueprints": the Schematica .schematic files on the game server that build_blueprint builds from (name, size, number of blocks; a file that cannot be read is listed with the reason). "drafts": the blueprint drafts your programs saved on the brain (name, size, blocks; publish_draft turns one into a blueprint). "images": what your owner uploaded on the panel for pixel art or as a reference (name, size in pixels; a program reads one with image(name)).',
  inputSchema: obj({ kind: str('Only this kind. Omit for all three.', { enum: [...DESIGN_KINDS] }) }),
  async run(ctx, i: { kind?: DesignKind }): Promise<ToolResult> {
    const parts: string[] = []
    const data: { blueprints?: unknown[]; drafts?: unknown[]; images?: unknown[] } = {}
    for (const kind of i.kind ? [i.kind] : DESIGN_KINDS) {
      if (kind === 'blueprints') {
        try {
          const listing = await blueprintListing(ctx)
          parts.push(listing.text)
          data.blueprints = listing.blueprints
        } catch (e) {
          // 只问图纸时照常报错；三样一起列时这一样列不出来不该挡住另外两样
          if (i.kind !== undefined || !(e instanceof BridgeError)) throw e
          parts.push(`The blueprints on the game server could not be listed (${e.code}: ${e.message}).`)
        }
        continue
      }
      if (!ctx.design) {
        if (i.kind !== undefined) return fail('Writing programs and drafts is not set up on this brain.')
        if (kind === 'drafts') parts.push('Drafts and images: writing programs and drafts is not set up on this brain.')
        continue
      }
      if (kind === 'drafts') {
        const listing = draftListing(ctx, ctx.design)
        parts.push(listing.text)
        data.drafts = listing.drafts
      } else {
        const listing = imageListing(ctx.design)
        parts.push(listing.text)
        data.images = listing.images
      }
    }
    return { content: parts.join('\n'), data }
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

const coordinate = int(undefined, { min: 0 })

const VIEW_DRAFT_TEXT = 'Look at a blueprint draft: size, materials, and its cells drawn in characters, slice by slice. x1..x2, y1..y2, z1..z2 show only that part (cells count from 0).'
/** view_draft 不管模型能不能看图都有的参数（文字那一半）。 */
const viewDraftTextParams = {
  name: str('Draft name, as list_designs shows it.', { maxLength: 60 }),
  along: str('Slice along y (layers, bottom up), z (upright slices seen from the south) or x (upright, seen from the west). Default: the thinnest way.', { enum: ['x', 'y', 'z'] }),
  x1: coordinate,
  x2: coordinate,
  y1: coordinate,
  y2: coordinate,
  z1: coordinate,
  z2: coordinate,
  program: bool('true: also show the program that made it.'),
}

/**
 * 看一张草稿。文字那一半（尺寸、材料表、字符画、生成它的程序）谁都用得上，所以模型不能看图时它留在清单里，
 * 只是换成不提图的那份说明和参数（textOnly）；画成图的三个参数只给能看图的模型。执行的都是同一个函数。
 */
export const viewDraft: Tool = {
  name: 'view_draft',
  picture: true,
  textOnly: { description: VIEW_DRAFT_TEXT, inputSchema: obj(viewDraftTextParams, ['name']) },
  description: `${VIEW_DRAFT_TEXT} Give "picture" for a drawing instead of characters (pictures manual).`,
  inputSchema: obj(
    {
      ...viewDraftTextParams,
      picture: { ...VIEW_PARAMS.view, description: `Get a picture instead of characters. ${VIEW_PARAMS.view.description}`.replace(' (default)', '') },
      from: VIEW_PARAMS.from,
      layer: int('For picture "layer": which layer (y, from 0).', { min: 0 }),
    },
    ['name'],
  ),
  async run(ctx, i: ViewInput): Promise<ToolResult | string> {
    const design = workspace(ctx)
    const record = design.drafts.get(i.name.trim())
    if (!record) return fail(`There is no draft named "${i.name.trim()}". list_designs shows the ones there are.`)
    const { draft } = record
    // data：给程序用的那一半（尺寸和材料表；每一格是什么，程序自己画的草稿它自己知道）
    const data = { name: draft.name, size: draft.size, blocks: blockCount(draft), materials: materialsOf(draft).map((m) => ({ id: m.id, meta: m.meta, ...(design.nameOf(m) ? { name: design.nameOf(m) } : {}), count: m.count })) }
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
        const result = pictureResult(
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
        return { ...result, data }
      }
      // 预览自己按预算裁过了，不要再被“单个工具结果上限”拦腰截断
      return { content: [head, 'Materials:', ...materialLines(design, draft), preview(), ...program].join('\n'), data, keepWhole: true }
    } catch (e) {
      if (e instanceof PreviewError || e instanceof GridError) return fail(`${e.message}.`)
      throw e
    }
  },
}

export const publishDraft: Tool = {
  name: 'publish_draft',
  description:
    'Send a draft to the game server as a blueprint (a .schematic file), so that build_blueprint (and the library function check_blueprint) can use it. A blueprint of the same name is replaced. Until it is published a draft exists only on the brain, where your owner sees it on the control panel.',
  inputSchema: obj(
    {
      name: str('Draft name as list_designs shows it.', { maxLength: 60 }),
      as: str('Name for the blueprint on the server (default: the draft name).', { maxLength: 60 }),
    },
    ['name'],
  ),
  async run(ctx, i: { name: string; as?: string }): Promise<ToolResult | string> {
    const design = workspace(ctx)
    const record = design.drafts.get(i.name.trim())
    if (!record) return fail(`There is no draft named "${i.name.trim()}". list_designs shows the ones there are.`)
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
      `build_blueprint builds it, given name "${saved.name ?? target}" and the x, y, z where its lowest corner goes; check_blueprint (a library function, same arguments) shows beforehand what that would place, dig and leave. The draft stays on the brain until you delete it.`
    )
  },
}

export const deleteDraft: Tool = {
  name: 'delete_draft',
  description: 'Delete a blueprint draft from the brain. A blueprint already published to the server is not affected.',
  inputSchema: obj({ name: str('Draft name as list_designs shows it.', { maxLength: 60 }) }, ['name']),
  async run(ctx, i: { name: string }) {
    const removed = workspace(ctx).drafts.remove(i.name.trim())
    return removed ? `Deleted draft "${i.name.trim()}".` : fail(`There is no draft named "${i.name.trim()}". list_designs shows the ones there are.`)
  },
}
