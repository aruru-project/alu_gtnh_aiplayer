// 对话线派子思维（agent/helpers.ts）：派一个出去想一件事、看它们在想什么和想出了什么、停掉一个。
// 这里只做参数和措辞，事情本身由 agent/helpers.ts 办。

import { bool, obj, str } from './schema.ts'
import { fail } from './types.ts'
import type { Tool } from './types.ts'

/** 同时最多几个子思维在想（主人定的）。第四个派不出去，如实说是哪三个在想。 */
export const HELPERS_MAX = 3
/** 交给子思维的任务最多这么长：它的背景都要写在里面。 */
export const HELPER_TASK_MAX_CHARS = 8000
const HELPER_ID_RE = /^h\d+$/

export const startHelper: Tool = {
  name: 'start_helper',
  description:
    'Send a part of your mind off to think one thing through by itself while you go on: look things up, work something out, or design a building as a draft. ' +
    "It starts fresh: it has your memory and the base's methods but nothing of this conversation, so the task carries the background it needs. It does not speak, act or record anything. " +
    `This returns at once with its id. When it ends (done, failed, step limit, stopped), the last thing it wrote comes to you whole, as an event that wakes you. At most ${HELPERS_MAX} think at once.`,
  inputSchema: obj({ task: str('What to think through, with its background.', { maxLength: HELPER_TASK_MAX_CHARS }) }, ['task']),
  async run(ctx, i: { task: string }) {
    if (!ctx.helpers) return fail('Helpers are not set up on this brain.')
    const task = i.task.trim()
    if (task.length === 0) return fail('task is empty')
    return ctx.helpers.start(task)
  },
}

export const helperStatus: Tool = {
  name: 'helper_status',
  description: 'Your helpers thinking now and the last ones that ended. id: that one in full (its steps so far, or what it handed back). stop: true with id stops it; what it has so far comes to you as when it ends.',
  inputSchema: obj({ id: str('Like "h3".', { maxLength: 12 }), stop: bool('Stop that helper.') }),
  async run(ctx, i: { id?: string; stop?: boolean }) {
    if (!ctx.helpers) return fail('Helpers are not set up on this brain.')
    const id = i.id?.trim()
    if (id !== undefined && !HELPER_ID_RE.test(id)) return fail(`"${id}" is not a helper id; they look like h3.`)
    if (i.stop === true && id === undefined) return fail('stop needs the id of the helper to stop.')
    return ctx.helpers.status(id, i.stop === true)
  },
}
