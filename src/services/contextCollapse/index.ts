type Stats = {
  collapsedSpans: number
  stagedSpans: number
  health: {
    totalErrors: number
    totalEmptySpawns: number
    emptySpawnWarningEmitted: boolean
  }
}

const stats: Stats = {
  collapsedSpans: 0,
  stagedSpans: 0,
  health: {
    totalErrors: 0,
    totalEmptySpawns: 0,
    emptySpawnWarningEmitted: false,
  },
}

const listeners = new Set<() => void>()

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getStats(): Stats {
  return stats
}

export function isContextCollapseEnabled(): boolean {
  return false
}

export function resetContextCollapse(): void {}

/**
 * 在需要时应用 context collapse 投影。
 *
 * 当前恢复树里这是 no-op shim；完整实现应在这里把消息历史折叠成更省 token 的投影。
 *
 * @param messages 待折叠的消息历史或消息容器。
 * @returns 折叠结果；当前实现总是返回原 messages，并标记 changed 为 false。
 */
export async function applyCollapsesIfNeeded<T>(messages: T): Promise<{
  messages: T
  changed: boolean
}> {
  return { messages, changed: false }
}

export function isWithheldPromptTooLong(): boolean {
  return false
}

export function recoverFromOverflow<T>(messages: T): T {
  return messages
}
