import { bool, int, obj, str } from './schema.ts'
import type { Tool } from './types.ts'
import { fail } from './types.ts'
import { AT, lookFrom } from './where.ts'
import type { At } from './where.ts'

export const ENTITY = obj({ uuid: str(), dim: int() }, ['uuid', 'dim'], 'Stable target from list_entities; mutually exclusive with on.')

export const listEntities: Tool = {
  name: 'list_entities',
  brief: '{radius?,at?,page?,entity?,detail?,path?}: nearby or one -> entities[{uuid,dim,kind,pos,state}], total,more; detail: saved',
  description: 'List loaded nearby entities, or inspect one stable identity. Pages are live observations: moving entities can change order. A missing target is not replaced by another animal.',
  inputSchema: obj({
    radius: int('Radius, default 16.', { min: 1, max: 64 }),
    at: AT,
    page: int('Page, 20 entities each, default 1.', { min: 1 }),
    entity: ENTITY,
    detail: bool('Include a non-player entity\'s own saved data, with explicit omissions.'),
    path: str('Read this saved-data subtree (same syntax as inspect_block).'),
  }),
  async run(ctx, i: { radius?: number; at?: At; page?: number; entity?: { uuid: string; dim: number }; detail?: boolean; path?: string }) {
    if (i.entity) {
      if (i.radius !== undefined || i.at !== undefined || i.page !== undefined) return fail('Use entity for one target, or radius/at/page for a list, not both.')
      const data = await ctx.bridge.worldEntity({ ...i.entity, detail: i.detail, path: i.path })
      return { content: JSON.stringify(data), data, keepWhole: true }
    }
    if (i.detail !== undefined || i.path !== undefined) return fail('detail/path needs entity:{uuid,dim} from the list.')
    const from = await lookFrom(ctx, i.at)
    const data = await ctx.bridge.worldEntities(from.center, { radius: i.radius ?? 16, offset: ((i.page ?? 1) - 1) * 20, limit: 20 })
    const entities = data.entities ?? []
    const offset = data.offset ?? 0
    const total = data.total ?? entities.length
    const more = data.more ?? Math.max(0, total - offset - entities.length)
    const oldBody = entities.some((e) => !e.uuid || e.dim === undefined) || (i.page !== undefined && i.page > 1 && data.offset === undefined)
    const note = oldBody ? ' Body is too old for stable targets/paging; update it before entity actions.' : ''
    return {
      content: `Entities ${offset + (entities.length ? 1 : 0)}–${offset + entities.length} of ${total}; ${more} more${more ? ` (page ${(i.page ?? 1) + 1} next)` : ''}. Live order may change as animals move; use uuid+dim, not list position.${note}\n${entities.map((e) => JSON.stringify(e)).join('\n')}`,
      data,
      keepWhole: true,
    }
  },
}
