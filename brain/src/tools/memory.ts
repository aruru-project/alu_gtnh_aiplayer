import { num, obj, str } from './schema.ts'
import { fail } from './types.ts'
import type { Tool } from './types.ts'

export const remember: Tool = {
  name: 'remember',
  description:
    'Save or overwrite a persistent note under a key. All notes are in your prompt on every turn and share one size limit (a note that would exceed it is refused); they outlast restarts and the summarising of old history. Typical notes: places and what they are for, standing instructions from your owner, what you were in the middle of.',
  inputSchema: obj(
    {
      key: str('Short name of the note, e.g. "home:base" or "job".', { maxLength: 64 }),
      text: str('The note.', { maxLength: 1000 }),
    },
    ['key', 'text'],
  ),
  async run(ctx, input: { key: string; text: string }) {
    try {
      ctx.memory.set(input.key, input.text)
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e))
    }
    return `Saved note "${input.key.trim()}".`
  },
}

export const forget: Tool = {
  name: 'forget',
  description: 'Delete a note from your memory.',
  inputSchema: obj({ key: str('Key of the note to delete.') }, ['key']),
  async run(ctx, input: { key: string }) {
    return ctx.memory.delete(input.key) ? `Deleted note "${input.key.trim()}".` : fail(`there is no note with key "${input.key.trim()}"`)
  },
}

export const setReminder: Tool = {
  name: 'set_reminder',
  description:
    'After the given minutes you are woken with the note, as an event of its own (it wakes the line that set it); it survives restarts. For looking at something again later: a machine left running, crops, a promise to a player.',
  inputSchema: obj(
    {
      minutes: num('How many minutes from now (real time).', { min: 0.1, max: 10080 }),
      note: str('What to remind yourself about.', { maxLength: 300 }),
    },
    ['minutes', 'note'],
  ),
  async run(ctx, input: { minutes: number; note: string }) {
    try {
      const r = ctx.reminders.add(ctx.now() + Math.round(input.minutes * 60_000), input.note.trim(), ctx.line)
      return `Reminder ${r.id} set for ${input.minutes} minute(s) from now.`
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e))
    }
  },
}
