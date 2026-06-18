import { feature } from 'bun:bundle'
import { markPostCompaction } from 'src/bootstrap/state.js'
import { getSdkBetas } from '../../bootstrap/state.js'
import type { QuerySource } from '../../constants/querySource.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { getGlobalConfig } from '../../utils/config.js'
import { getContextWindowForModel } from '../../utils/context.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { hasExactErrorMessage } from '../../utils/errors.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { logError } from '../../utils/log.js'
import { tokenCountWithEstimation } from '../../utils/tokens.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import { getMaxOutputTokensForModel } from '../api/claude.js'
import { notifyCompaction } from '../api/promptCacheBreakDetection.js'
import { setLastSummarizedMessageId } from '../SessionMemory/sessionMemoryUtils.js'
import {
  type CompactionResult,
  compactConversation,
  ERROR_MESSAGE_USER_ABORT,
  type RecompactionInfo,
} from './compact.js'
import { runPostCompactCleanup } from './postCompactCleanup.js'
import { trySessionMemoryCompaction } from './sessionMemoryCompact.js'

// 压缩摘要需要预留输出空间；当前值覆盖历史 p99.99 的摘要输出规模。
const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000

/**
 * 返回模型可用于输入上下文的有效窗口。
 *
 * 总窗口需要扣掉压缩摘要本身的输出预算，否则压缩请求可能输入刚好没超，
 * 但模型生成摘要时仍然因为输出空间不足而失败。
 */
export function getEffectiveContextWindowSize(model: string): number {
  const reservedTokensForSummary = Math.min(
    getMaxOutputTokensForModel(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  )
  let contextWindow = getContextWindowForModel(model, getSdkBetas())

  const autoCompactWindow = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  if (autoCompactWindow) {
    const parsed = parseInt(autoCompactWindow, 10)
    if (!isNaN(parsed) && parsed > 0) {
      contextWindow = Math.min(contextWindow, parsed)
    }
  }

  return contextWindow - reservedTokensForSummary
}

export type AutoCompactTrackingState = {
  compacted: boolean
  turnCounter: number
  // 每次成功压缩后生成一个新的轮次 ID，便于分析链内重复压缩。
  turnId: string
  // 连续自动压缩失败次数；成功后清零，用于熔断明显无法恢复的超窗会话。
  consecutiveFailures?: number
}

export const AUTOCOMPACT_BUFFER_TOKENS = 13_000
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000

// 连续失败达到阈值后停止自动压缩，避免同一会话反复发起注定失败的压缩请求。
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3

export function getAutoCompactThreshold(model: string): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(model)

  const autocompactThreshold =
    effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS

  // 测试和调试时可用环境变量临时降低自动压缩阈值。
  const envPercent = process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
  if (envPercent) {
    const parsed = parseFloat(envPercent)
    if (!isNaN(parsed) && parsed > 0 && parsed <= 100) {
      const percentageThreshold = Math.floor(
        effectiveContextWindow * (parsed / 100),
      )
      return Math.min(percentageThreshold, autocompactThreshold)
    }
  }

  return autocompactThreshold
}

/**
 * 根据当前 token 使用量计算上下文窗口状态。
 *
 * 调用方用这些布尔值决定 UI 警告、自动压缩、硬阻塞等行为。
 *
 * @param tokenUsage 当前消息历史的 token 使用量，可以是估算值。
 * @param model 当前主循环模型名，用来读取模型上下文窗口和压缩阈值。
 * @returns 窗口余量百分比，以及 warning、error、autocompact、blocking 四类阈值状态。
 */
export function calculateTokenWarningState(
  tokenUsage: number,
  model: string,
): {
  percentLeft: number
  isAboveWarningThreshold: boolean
  isAboveErrorThreshold: boolean
  isAboveAutoCompactThreshold: boolean
  isAtBlockingLimit: boolean
} {
  const autoCompactThreshold = getAutoCompactThreshold(model)
  const threshold = isAutoCompactEnabled()
    ? autoCompactThreshold
    : getEffectiveContextWindowSize(model)

  const percentLeft = Math.max(
    0,
    Math.round(((threshold - tokenUsage) / threshold) * 100),
  )

  const warningThreshold = threshold - WARNING_THRESHOLD_BUFFER_TOKENS
  const errorThreshold = threshold - ERROR_THRESHOLD_BUFFER_TOKENS

  const isAboveWarningThreshold = tokenUsage >= warningThreshold
  const isAboveErrorThreshold = tokenUsage >= errorThreshold

  const isAboveAutoCompactThreshold =
    isAutoCompactEnabled() && tokenUsage >= autoCompactThreshold

  const actualContextWindow = getEffectiveContextWindowSize(model)
  const defaultBlockingLimit =
    actualContextWindow - MANUAL_COMPACT_BUFFER_TOKENS

  // 测试和调试时可覆盖硬阻塞阈值。
  const blockingLimitOverride = process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE
  const parsedOverride = blockingLimitOverride
    ? parseInt(blockingLimitOverride, 10)
    : NaN
  const blockingLimit =
    !isNaN(parsedOverride) && parsedOverride > 0
      ? parsedOverride
      : defaultBlockingLimit

  const isAtBlockingLimit = tokenUsage >= blockingLimit

  return {
    percentLeft,
    isAboveWarningThreshold,
    isAboveErrorThreshold,
    isAboveAutoCompactThreshold,
    isAtBlockingLimit,
  }
}

export function isAutoCompactEnabled(): boolean {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) {
    return false
  }
  // 只关闭自动压缩时，手动 /compact 仍然可用。
  if (isEnvTruthy(process.env.DISABLE_AUTO_COMPACT)) {
    return false
  }
  // 最后读取用户设置里的自动压缩开关。
  const userConfig = getGlobalConfig()
  return userConfig.autoCompactEnabled
}

/**
 * 判断当前消息历史是否已经超过自动压缩阈值。
 *
 * @param messages 当前准备送入模型的消息历史。
 * @param model 当前主循环模型名，用于计算自动压缩阈值。
 * @param querySource 当前 query 来源；压缩代理、session memory 等来源会被排除，避免递归压缩。
 * @param snipTokensFreed 已通过 snip 释放的 token 数，用来修正历史 usage 估算。
 * @returns true 表示应触发自动压缩；false 表示继续原流程。
 */
export async function shouldAutoCompact(
  messages: Message[],
  model: string,
  querySource?: QuerySource,
  // snip 删除了历史，但保留下来的 usage 仍可能反映删除前 token，需要手动扣减。
  snipTokensFreed = 0,
): Promise<boolean> {
  // 压缩代理本身不能再触发自动压缩，否则会递归卡住。
  if (querySource === 'session_memory' || querySource === 'compact') {
    return false
  }
  // context-collapse 代理使用共享模块状态，不能让它触发自动压缩后清掉主线程 collapse 日志。
  if (feature('CONTEXT_COLLAPSE')) {
    if (querySource === 'marble_origami') {
      return false
    }
  }

  if (!isAutoCompactEnabled()) {
    return false
  }

  // reactive-only 模式下不主动压缩，等 API 返回 prompt-too-long 后再走恢复压缩。
  if (feature('REACTIVE_COMPACT')) {
    if (getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_raccoon', false)) {
      return false
    }
  }

  // context-collapse 打开时由 collapse 系统管理窗口，避免和 autocompact 争抢同一段历史。
  if (feature('CONTEXT_COLLAPSE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { isContextCollapseEnabled } =
      require('../contextCollapse/index.js') as typeof import('../contextCollapse/index.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    if (isContextCollapseEnabled()) {
      return false
    }
  }

  const tokenCount = tokenCountWithEstimation(messages) - snipTokensFreed
  const threshold = getAutoCompactThreshold(model)
  const effectiveWindow = getEffectiveContextWindowSize(model)

  logForDebugging(
    `autocompact: tokens=${tokenCount} threshold=${threshold} effectiveWindow=${effectiveWindow}${snipTokensFreed > 0 ? ` snipFreed=${snipTokensFreed}` : ''}`,
  )

  const { isAboveAutoCompactThreshold } = calculateTokenWarningState(
    tokenCount,
    model,
  )

  return isAboveAutoCompactThreshold
}

/**
 * 在 query 主循环中执行自动压缩：先判断阈值，再优先尝试 session memory 压缩，最后退回传统摘要压缩。
 *
 * @param messages 当前有效消息历史。
 * @param toolUseContext 工具执行上下文，提供应用状态、权限、abortController、进度回调等。
 * @param cacheSafeParams 可安全传入压缩代理的缓存相关参数。
 * @param querySource 当前 query 来源，用于避免压缩代理递归触发。
 * @param tracking 自动压缩连续失败等追踪状态。
 * @param snipTokensFreed 已由 snip 释放的 token 数，用于阈值判断修正。
 * @returns 自动压缩结果；未压缩时 wasCompacted 为 false，压缩成功时携带 CompactionResult。
 */
export async function autoCompactIfNeeded(
  messages: Message[],
  toolUseContext: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  querySource?: QuerySource,
  tracking?: AutoCompactTrackingState,
  snipTokensFreed?: number,
): Promise<{
  wasCompacted: boolean
  compactionResult?: CompactionResult
  consecutiveFailures?: number
}> {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) {
    return { wasCompacted: false }
  }

  // 连续失败后熔断，避免每一轮都重复发起必然失败的压缩请求。
  if (
    tracking?.consecutiveFailures !== undefined &&
    tracking.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
  ) {
    return { wasCompacted: false }
  }

  const model = toolUseContext.options.mainLoopModel
  const shouldCompact = await shouldAutoCompact(
    messages,
    model,
    querySource,
    snipTokensFreed,
  )

  if (!shouldCompact) {
    return { wasCompacted: false }
  }

  const recompactionInfo: RecompactionInfo = {
    isRecompactionInChain: tracking?.compacted === true,
    turnsSincePreviousCompact: tracking?.turnCounter ?? -1,
    previousCompactTurnId: tracking?.turnId,
    autoCompactThreshold: getAutoCompactThreshold(model),
    querySource,
  }

  // 优先尝试 session memory 压缩；成功时会直接返回新的压缩结果。
  const sessionMemoryResult = await trySessionMemoryCompaction(
    messages,
    toolUseContext.agentId,
    recompactionInfo.autoCompactThreshold,
  )
  if (sessionMemoryResult) {
    // 压缩会裁剪历史，旧的最后摘要消息 ID 可能已经不存在。
    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup(querySource)
    // 重置提示词缓存基线，避免把压缩导致的 token 下降误报为缓存破坏。
    if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
      notifyCompaction(querySource ?? 'compact', toolUseContext.agentId)
    }
    markPostCompaction()
    return {
      wasCompacted: true,
      compactionResult: sessionMemoryResult,
    }
  }

  try {
    const compactionResult = await compactConversation(
      messages,
      toolUseContext,
      cacheSafeParams,
      true, // 自动压缩时禁止追问用户。
      undefined, // 自动压缩没有额外自定义指令。
      true, // 标记这是自动压缩。
      recompactionInfo,
    )

    // 传统压缩会替换消息数组，因此旧的摘要游标需要清空。
    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup(querySource)

    return {
      wasCompacted: true,
      compactionResult,
      // 成功后重置熔断计数。
      consecutiveFailures: 0,
    }
  } catch (error) {
    if (!hasExactErrorMessage(error, ERROR_MESSAGE_USER_ABORT)) {
      logError(error)
    }
    // 失败次数回传给 query 主循环，下一轮可据此熔断。
    const prevFailures = tracking?.consecutiveFailures ?? 0
    const nextFailures = prevFailures + 1
    if (nextFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
      logForDebugging(
        `autocompact: circuit breaker tripped after ${nextFailures} consecutive failures — skipping future attempts this session`,
        { level: 'warn' },
      )
    }
    return { wasCompacted: false, consecutiveFailures: nextFailures }
  }
}
