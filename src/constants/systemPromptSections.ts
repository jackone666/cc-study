import {
  clearBetaHeaderLatches,
  clearSystemPromptSectionState,
  getSystemPromptSectionCache,
  setSystemPromptSectionCacheEntry,
} from '../bootstrap/state.js'

type ComputeFn = () => string | null | Promise<string | null>

type SystemPromptSection = {
  name: string
  compute: ComputeFn
  cacheBreak: boolean
}

/**
 * 创建可缓存的系统提示词片段；通常直到 /clear 或 /compact 才重新计算。
 *
 * @param name 片段名称，也是缓存 key。
 * @param compute 生成该提示词片段的函数。
 * @returns SystemPromptSection，cacheBreak 为 false，表示可复用缓存。
 */
export function systemPromptSection(
  name: string,
  compute: ComputeFn,
): SystemPromptSection {
  return { name, compute, cacheBreak: false }
}

/**
 * 创建每轮都重新计算的系统提示词片段；值变化会破坏提示词缓存。
 *
 * @param name 片段名称，也是缓存 key。
 * @param compute 每轮生成该提示词片段的函数。
 * @param _reason 使用非缓存片段的原因说明，帮助调用方显式承认缓存影响。
 * @returns SystemPromptSection，cacheBreak 为 true，表示解析时总是重新计算。
 */
export function DANGEROUS_uncachedSystemPromptSection(
  name: string,
  compute: ComputeFn,
  _reason: string,
): SystemPromptSection {
  return { name, compute, cacheBreak: true }
}

/**
 * 解析系统提示词片段，优先复用缓存，必要时调用 compute 重新生成。
 *
 * @param sections 待解析的系统提示词片段列表。
 * @returns 每个片段对应的字符串或 null，顺序与入参 sections 保持一致。
 */
export async function resolveSystemPromptSections(
  sections: SystemPromptSection[],
): Promise<(string | null)[]> {
  const cache = getSystemPromptSectionCache()

  return Promise.all(
    sections.map(async s => {
      if (!s.cacheBreak && cache.has(s.name)) {
        return cache.get(s.name) ?? null
      }
      const value = await s.compute()
      setSystemPromptSectionCacheEntry(s.name, value)
      return value
    }),
  )
}

/**
 * 清空系统提示词片段状态；/clear 和 /compact 后让会话重新评估动态头信息。
 */
export function clearSystemPromptSections(): void {
  clearSystemPromptSectionState()
  clearBetaHeaderLatches()
}
