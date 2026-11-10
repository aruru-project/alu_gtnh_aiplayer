// 模型调用层的对外入口。上层只从这里导入。

export type {
  Adapter,
  AdapterDeps,
  AdapterOptionInfo,
  AssistantMessage,
  AssistantPart,
  GenerateRequest,
  GenerateResult,
  LlmClient,
  Message,
  OpaquePart,
  ProviderConfig,
  StopReason,
  TextPart,
  ToolCallPart,
  ToolResultPart,
  ToolSpec,
  Usage,
  UsageRecord,
  UserMessage,
  UserPart,
} from './types.ts'
export { LlmError, isLlmError } from './errors.ts'
export type { LlmErrorKind } from './errors.ts'
export { withRetry } from './retry.ts'
export type { RetryOptions } from './retry.ts'
export { ADAPTERS, createClient, isProviderKind, listAdapters } from './registry.ts'
export type { AdapterInfo, CreateClientOptions, ProviderKind } from './registry.ts'
export { testConnection } from './test-connection.ts'
export type { TestConnectionResult } from './test-connection.ts'
export { textOf } from './messages.ts'
