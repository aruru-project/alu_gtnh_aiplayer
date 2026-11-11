// 占位：这一页还在从旧面板搬过来。
import { h } from './ui.js'
export function enter(el) {
  if (el.childElementCount === 0) el.append(h('p', { class: 'muted', text: '这一页还在搬。' }))
}
export function leave() {}
