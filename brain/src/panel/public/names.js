// 物品的中文名：对话页把工具参数里的物品 id 写成名字用。
// 问过的记着（查不到的也记着，不再问）；没问过的先用 id 顶着，攒一小会儿一起去问，问到了通知一声让页面重画。

import { api, bus } from './ui.js'

/** "id/meta" → 名字；查不到的是 null。 */
const known = new Map()
const wanted = new Set()
let timer
/** 每问到一批加一：页面拿它当“名字变了没有”的版本。 */
export let namesVersion = 0

async function ask() {
  timer = undefined
  const batch = [...wanted].slice(0, 150)
  for (const key of batch) wanted.delete(key)
  if (batch.length === 0) return
  let names = {}
  try {
    names = (await api('GET', `/items/names?q=${encodeURIComponent(batch.join(','))}`)).names ?? {}
  } catch {
    /* 这个版本的大脑不会查，或者一时没连上：当查不到 */
  }
  let found = false
  for (const key of batch) {
    known.set(key, names[key] ?? null)
    if (names[key]) found = true
  }
  if (found) {
    namesVersion++
    bus.emit('names')
  }
  if (wanted.size > 0) timer = setTimeout(ask, 50)
}

/** 一样东西的名字；还不知道时返回 undefined（并记下去问）。 */
export function itemName(id, meta = 0) {
  const key = `${id}/${meta}`
  const name = known.get(key)
  if (name === undefined && !wanted.has(key)) {
    wanted.add(key)
    timer ??= setTimeout(ask, 120)
  }
  return name ?? undefined
}
