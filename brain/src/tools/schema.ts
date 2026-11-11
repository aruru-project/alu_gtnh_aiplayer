// 工具参数的 schema 写法和校验。只支持工具定义里实际用到的那一小部分 JSON Schema。
// 校验时顺手做两种宽容处理：数字写成了字符串（"64"）、布尔写成了字符串（"true"）。

export type Schema =
  | { type: 'string'; description?: string; enum?: string[]; minLength?: number; maxLength?: number }
  | { type: 'number' | 'integer'; description?: string; minimum?: number; maximum?: number }
  | { type: 'boolean'; description?: string }
  | { type: 'array'; description?: string; items: Schema; minItems?: number; maxItems?: number }
  | ObjectSchema

export interface ObjectSchema {
  type: 'object'
  description?: string
  properties: Record<string, Schema>
  required?: string[]
  additionalProperties?: false
}

// ── 写 schema 的小帮手 ──
// 说明每一轮都发给模型：参数名自己说得清的（x、y、z、id、meta……）可以不写说明（不给或给空串），
// 怎么写交给上一层那个参数的说明去讲（“each {id, meta?, count?}”）。

export function obj(properties: Record<string, Schema>, required: string[] = [], description?: string): ObjectSchema {
  const s: ObjectSchema = { type: 'object', properties, required, additionalProperties: false }
  if (description !== undefined) s.description = description
  return s
}

export function int(description?: string, range: { min?: number; max?: number } = {}): Schema {
  const s: Schema = description ? { type: 'integer', description } : { type: 'integer' }
  if (range.min !== undefined) s.minimum = range.min
  if (range.max !== undefined) s.maximum = range.max
  return s
}

export function num(description?: string, range: { min?: number; max?: number } = {}): Schema {
  const s: Schema = description ? { type: 'number', description } : { type: 'number' }
  if (range.min !== undefined) s.minimum = range.min
  if (range.max !== undefined) s.maximum = range.max
  return s
}

export function str(description?: string, opts: { enum?: string[]; maxLength?: number } = {}): Schema {
  const s: Schema = description ? { type: 'string', description, minLength: 1 } : { type: 'string', minLength: 1 }
  if (opts.enum) s.enum = opts.enum
  if (opts.maxLength !== undefined) s.maxLength = opts.maxLength
  return s
}

export function bool(description?: string): Schema {
  return description ? { type: 'boolean', description } : { type: 'boolean' }
}

export function arr(description: string | undefined, items: Schema, range: { min?: number; max?: number } = {}): Schema {
  const s: Schema = description ? { type: 'array', description, items } : { type: 'array', items }
  if (range.min !== undefined) s.minItems = range.min
  if (range.max !== undefined) s.maxItems = range.max
  return s
}

/** 一个方块的位置 {x, y, z}（整数）。 */
export function pos(description?: string): ObjectSchema {
  return obj({ x: int(), y: int(), z: int() }, ['x', 'y', 'z'], description)
}

// ── 校验 ──

export type ValidationResult = { ok: true; value: unknown } | { ok: false; errors: string[] }

function check(schema: Schema, value: unknown, path: string, errors: string[]): unknown {
  const where = path || 'input'
  switch (schema.type) {
    case 'string': {
      if (typeof value === 'number' || typeof value === 'boolean') value = String(value)
      if (typeof value !== 'string') {
        errors.push(`${where} must be a string`)
        return value
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${where} must not be empty`)
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        errors.push(`${where} is too long (max ${schema.maxLength} characters)`)
      }
      if (schema.enum && !schema.enum.includes(value)) errors.push(`${where} must be one of: ${schema.enum.join(', ')}`)
      return value
    }
    case 'number':
    case 'integer': {
      if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) value = Number(value)
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`${where} must be a number`)
        return value
      }
      if (schema.type === 'integer' && !Number.isInteger(value)) {
        errors.push(`${where} must be an integer`)
        return value
      }
      if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${where} must be >= ${schema.minimum}`)
      if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${where} must be <= ${schema.maximum}`)
      return value
    }
    case 'boolean': {
      if (value === 'true') return true
      if (value === 'false') return false
      if (typeof value !== 'boolean') errors.push(`${where} must be true or false`)
      return value
    }
    case 'array': {
      if (!Array.isArray(value)) {
        errors.push(`${where} must be an array`)
        return value
      }
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        errors.push(`${where} needs at least ${schema.minItems} item(s)`)
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        errors.push(`${where} has ${value.length} items, at most ${schema.maxItems} allowed`)
        return value
      }
      return value.map((item, i) => check(schema.items, item, `${path}[${i}]`, errors))
    }
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        errors.push(`${where} must be an object`)
        return value
      }
      const input = value as Record<string, unknown>
      const out: Record<string, unknown> = {}
      for (const key of schema.required ?? []) {
        if (input[key] === undefined || input[key] === null) errors.push(`${path ? `${path}.` : ''}${key} is required`)
      }
      for (const [key, sub] of Object.entries(schema.properties)) {
        const v = input[key]
        if (v === undefined || v === null) continue
        out[key] = check(sub, v, path ? `${path}.${key}` : key, errors)
      }
      // 多给的字段直接忽略，不算错
      return out
    }
  }
}

/** 校验并返回整理过的参数（多余字段去掉、字符串数字转成数字）。 */
export function validate(schema: Schema, input: unknown): ValidationResult {
  const errors: string[] = []
  const value = check(schema, input ?? {}, '', errors)
  return errors.length > 0 ? { ok: false, errors: errors.slice(0, 8) } : { ok: true, value }
}
