// 意见簿：模型觉得哪里有问题时自己记一条（缺工具、工具结果不对或看不懂、同一件事反复失败、手册和实际不符、
// 主人让做却做不到）。记下的东西主人在面板的“意见簿”页看。提交不是求助：记完照常干活。

import { FEEDBACK_CATEGORIES, FEEDBACK_LIMITS } from '../store/feedback.ts'
import type { FeedbackCategory } from '../store/feedback.ts'
import { obj, str } from './schema.ts'
import { ToolFailure } from './types.ts'
import type { Tool } from './types.ts'

export const reportProblem: Tool = {
  name: 'report_problem',
  description:
    'Write a note in the feedback book for the people who maintain you, when something about your tools gets in the way: no tool fits what you want to do, a tool result is wrong or cannot be understood, the same thing keeps failing, a manual does not match what happens, or your owner asks for something you cannot do. What you were just doing is attached automatically. It only records the note: nobody answers it, so afterwards carry on, or tell the player what you could not do. One note per problem is enough.',
  inputSchema: obj(
    {
      title: str('The problem in one sentence.', { maxLength: FEEDBACK_LIMITS.title }),
      category: str(
        'missing_tool (no tool for it), tool_problem (a tool misbehaves or its result is wrong or unclear), data_or_manual (pack data or a manual is wrong or missing), cannot_do (asked for something you cannot do), or other.',
        { enum: [...FEEDBACK_CATEGORIES] },
      ),
      goal: str('What you were trying to do.', { maxLength: FEEDBACK_LIMITS.goal }),
      problem: str('What happened instead: which tool, what it said, what you expected.', { maxLength: FEEDBACK_LIMITS.problem }),
      wish: str('What would have helped: a tool, a parameter, a clearer result, a manual entry.', { maxLength: FEEDBACK_LIMITS.wish }),
    },
    ['title', 'category', 'goal', 'problem'],
  ),
  async run(ctx, i: { title: string; category: string; goal: string; problem: string; wish?: string }) {
    if (!ctx.feedback) throw new ToolFailure('The feedback book is not set up on this brain. Carry on without it.')
    const res = ctx.feedback.submit({ title: i.title, category: i.category as FeedbackCategory, goal: i.goal, problem: i.problem, ...(i.wish !== undefined ? { wish: i.wish } : {}) })
    if ('full' in res) return 'Not recorded: the feedback book has taken many notes today already. Carry on with what you were doing.'
    if (res.merged) {
      return `Already noted (${res.id}): this is the same problem as an earlier note, which now counts ${res.count} times. No need to report it again. Carry on with what you were doing.`
    }
    return `Noted as ${res.id}. Nobody will answer it: carry on with what you were doing, or tell the player what you could not do.`
  },
}
