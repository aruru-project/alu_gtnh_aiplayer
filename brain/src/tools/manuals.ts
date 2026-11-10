// 手册：各类活具体怎么做，以及主人写的关于这个服务器、这个基地的说明。
// 提示词里只列手册的名字和“什么时候看”；模型要干那类事时用 read_manual 读整本。

import { manualText } from '../store/manuals.ts'
import { obj, str } from './schema.ts'
import { fail } from './types.ts'
import type { Tool } from './types.ts'

export const listManuals: Tool = {
  name: 'list_manuals',
  description:
    'List the manuals: how-to guides for each kind of work, plus notes your owner wrote about this server and this base. Gives each name with one line saying when to read it.',
  inputSchema: obj({}),
  async run(ctx) {
    const all = ctx.manuals.list()
    if (all.length === 0) return 'There are no manuals.'
    const lines = all.map((m) => `- ${m.name}${m.source === 'user' ? ' (written by your owner)' : ''}: ${m.summary}`)
    return `${all.length} manual(s). Read one with read_manual before you start that kind of work:\n${lines.join('\n')}`
  },
}

export const readManual: Tool = {
  name: 'read_manual',
  description:
    'Read one manual in full. Before you start a kind of work, read its manual unless its text is still in this conversation; your current status says which ones are.',
  inputSchema: obj({ name: str('Name of the manual, as listed.', { maxLength: 60 }) }, ['name']),
  async run(ctx, i: { name: string }) {
    const manual = ctx.manuals.get(i.name)
    if (!manual) {
      const names = ctx.manuals.list().map((m) => m.name)
      return fail(`There is no manual named "${i.name.trim()}". The manuals are: ${names.join(', ') || '(none)'}.`)
    }
    return { content: manualText(manual), keepWhole: true }
  },
}
