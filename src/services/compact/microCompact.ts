import { feature } from 'bun:bundle'
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { QuerySource } from '../../constants/querySource.js'
import type { ToolUseContext } from '../../Tool.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../../tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../../tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '../../tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../../tools/GrepTool/prompt.js'
import { WEB_FETCH_TOOL_NAME } from '../../tools/WebFetchTool/prompt.js'
import { WEB_SEARCH_TOOL_NAME } from '../../tools/WebSearchTool/prompt.js'
import type { Message } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { SHELL_TOOL_NAMES } from '../../utils/shell/shellToolUtils.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import { notifyCacheDeletion } from '../api/promptCacheBreakDetection.js'
import { roughTokenCountEstimation } from '../tokenEstimation.js'
import {
  clearCompactWarningSuppression,
  suppressCompactWarning,
} from './compactWarningState.js'
import {
  getTimeBasedMCConfig,
  type TimeBasedMCConfig,
} from './timeBasedMCConfig.js'

// 从 utils/toolResultStorage.ts 内联而来。
// 如果直接导入该文件，会形成 sessionStorage -> utils/messages -> services/api/errors
// 再经 promptCacheBreakDetection 回到本文件的循环依赖。
// 上游用测试校验它和源实现保持一致，避免两边漂移。
export const TIME_BASED_MC_CLEARED_MESSAGE = '[Old tool result content cleared]'

const IMAGE_MAX_TOKEN_SIZE = 2000

// 只压缩这些工具的结果，避免误删模型仍需要的关键上下文。
const COMPACTABLE_TOOLS = new Set<string>([
  FILE_READ_TOOL_NAME,
  ...SHELL_TOOL_NAMES,
  GREP_TOOL_NAME,
  GLOB_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
])

// --- cached microcompact 状态，仅内部构建且开启 CACHED_MICROCOMPACT 时使用 ---

// cached microcompact 模块和状态采用懒初始化，避免外部构建导入内部代码。
// import 和状态都放在 feature() 检查内，方便构建阶段做死代码消除。
let cachedMCModule: typeof import('./cachedMicrocompact.js') | null = null
let cachedMCState: import('./cachedMicrocompact.js').CachedMCState | null = null
let pendingCacheEdits:
  | import('./cachedMicrocompact.js').CacheEditsBlock
  | null = null

async function getCachedMCModule(): Promise<
  typeof import('./cachedMicrocompact.js')
> {
  if (!cachedMCModule) {
    cachedMCModule = await import('./cachedMicrocompact.js')
  }
  return cachedMCModule
}

function ensureCachedMCState(): import('./cachedMicrocompact.js').CachedMCState {
  if (!cachedMCState && cachedMCModule) {
    cachedMCState = cachedMCModule.createCachedMCState()
  }
  if (!cachedMCState) {
    throw new Error(
      'cachedMCState not initialized — getCachedMCModule() must be called first',
    )
  }
  return cachedMCState
}

/**
 * 取出下一次 API 请求需要携带的新 cache edit。
 * 如果没有新的待发送 edit，则返回 null。
 * 读取后会清空 pending 状态，调用方插入后必须把它们 pin 住。
 */
export function consumePendingCacheEdits():
  | import('./cachedMicrocompact.js').CacheEditsBlock
  | null {
  const edits = pendingCacheEdits
  pendingCacheEdits = null
  return edits
}

/**
 * 取出此前已经 pin 住的 cache edit。
 * 这些 edit 必须按原位置重新发送，才能让服务端缓存继续命中。
 */
export function getPinnedCacheEdits(): import('./cachedMicrocompact.js').PinnedCacheEdits[] {
  if (!cachedMCState) {
    return []
  }
  return cachedMCState.pinnedEdits
}

/**
 * 把新的 cache_edits block 绑定到某个 user message 位置。
 * 新 edit 插入后调用这个函数，后续请求才能继续重发它。
 */
export function pinCacheEdits(
  userMessageIndex: number,
  block: import('./cachedMicrocompact.js').CacheEditsBlock,
): void {
  if (cachedMCState) {
    cachedMCState.pinnedEdits.push({ userMessageIndex, block })
  }
}

/**
 * 标记所有已注册工具都已经发送给 API。
 * 成功收到 API 响应后调用，避免重复登记同一批工具。
 */
export function markToolsSentToAPIState(): void {
  if (cachedMCState && cachedMCModule) {
    cachedMCModule.markToolsSentToAPI(cachedMCState)
  }
}

export function resetMicrocompactState(): void {
  if (cachedMCState && cachedMCModule) {
    cachedMCModule.resetCachedMCState(cachedMCState)
  }
  pendingCacheEdits = null
}

// 粗估工具结果 token 的辅助函数。
function calculateToolResultTokens(block: ToolResultBlockParam): number {
  if (!block.content) {
    return 0
  }

  if (typeof block.content === 'string') {
    return roughTokenCountEstimation(block.content)
  }

  // 这里可能是 TextBlockParam / ImageBlockParam / DocumentBlockParam 数组。
  return block.content.reduce((sum, item) => {
    if (item.type === 'text') {
      return sum + roughTokenCountEstimation(item.text)
    } else if (item.type === 'image' || item.type === 'document') {
      // 图片和文档无论格式如何，都按约 2000 token 粗估。
      return sum + IMAGE_MAX_TOKEN_SIZE
    }
    return sum
  }, 0)
}

/**
 * 通过抽取文本内容粗估消息 token 数。
 * 当没有准确 API 计数时使用，最后按 4/3 放大，给近似估算留出保守余量。
 */
export function estimateMessageTokens(messages: Message[]): number {
  let totalTokens = 0

  for (const message of messages) {
    if (message.type !== 'user' && message.type !== 'assistant') {
      continue
    }

    if (!Array.isArray(message.message.content)) {
      continue
    }

    for (const block of message.message.content) {
      if (block.type === 'text') {
        totalTokens += roughTokenCountEstimation(block.text)
      } else if (block.type === 'tool_result') {
        totalTokens += calculateToolResultTokens(block)
      } else if (block.type === 'image' || block.type === 'document') {
        totalTokens += IMAGE_MAX_TOKEN_SIZE
      } else if (block.type === 'thinking') {
        // 与 roughTokenCountEstimationForBlock 保持一致：只统计 thinking 文本，
        // 不统计 JSON 包装和 signature；signature 是元数据，不是模型实际分词内容。
        totalTokens += roughTokenCountEstimation(block.thinking)
      } else if (block.type === 'redacted_thinking') {
        totalTokens += roughTokenCountEstimation(block.data)
      } else if (block.type === 'tool_use') {
        // 与 roughTokenCountEstimationForBlock 保持一致：统计 name + input，
        // 不统计 JSON 包装和 id 字段。
        totalTokens += roughTokenCountEstimation(
          block.name + jsonStringify(block.input ?? {}),
        )
      } else {
        // 其他服务端工具块，例如 server_tool_use、web_search_tool_result 等。
        totalTokens += roughTokenCountEstimation(jsonStringify(block))
      }
    }
  }

  // 粗估值按 4/3 放大，避免低估导致后续窗口判断过于乐观。
  return Math.ceil(totalTokens * (4 / 3))
}

export type PendingCacheEdits = {
  trigger: 'auto'
  deletedToolIds: string[]
  // 上一次 API 响应中的累计 cache_deleted_input_tokens 基线。
  // API 返回值是累计值，所以要用它计算本次操作的增量。
  baselineCacheDeletedTokens: number
}

export type MicrocompactResult = {
  messages: Message[]
  compactionInfo?: {
    pendingCacheEdits?: PendingCacheEdits
  }
}

/**
 * 按消息顺序收集可压缩工具的 tool_use id。
 * 两条 microcompact 路径都会复用这个收集逻辑。
 */
function collectCompactableToolIds(messages: Message[]): string[] {
  const ids: string[] = []
  for (const message of messages) {
    if (
      message.type === 'assistant' &&
      Array.isArray(message.message.content)
    ) {
      for (const block of message.message.content) {
        if (block.type === 'tool_use' && COMPACTABLE_TOOLS.has(block.name)) {
          ids.push(block.id)
        }
      }
    }
  }
  return ids
}

// 主线程 querySource 可能带 outputStyle 后缀，因此这里必须用前缀匹配。
function isMainThreadSource(querySource: QuerySource | undefined): boolean {
  return !querySource || querySource.startsWith('repl_main_thread')
}

/**
 * 微压缩入口。
 *
 * 调用顺序：
 * 1. 先尝试基于时间的微压缩，清理旧工具结果，减少冷缓存重写成本。
 * 2. 如果缓存编辑能力可用，再尝试 cached microcompact，通过 API cache edit 删除旧工具结果。
 * 3. 如果都不适用，则原样返回消息，后续由 autocompact 处理整体上下文压力。
 *
 * @param messages 当前 queryLoop 准备送入模型的消息历史。
 * @param toolUseContext 工具上下文；cached microcompact 需要从这里读取模型和运行状态。
 * @param querySource 当前 query 来源，用来限制只有主线程触发真实微压缩。
 * @returns MicrocompactResult；可能包含压缩后的 messages、token 变化和缓存编辑状态。
 */
export async function microcompactMessages(
  messages: Message[],
  toolUseContext?: ToolUseContext,
  querySource?: QuerySource,
): Promise<MicrocompactResult> {
  // 每次微压缩尝试开始时重置警告抑制状态。
  clearCompactWarningSuppression()

  // 时间触发优先：如果服务端缓存大概率已冷，直接清理旧工具结果，减少即将重写的内容。
  const timeBasedResult = maybeTimeBasedMicrocompact(messages, querySource)
  if (timeBasedResult) {
    return timeBasedResult
  }

  // cached microcompact 只在主线程运行，避免子代理把自己的 tool_result 注册进全局缓存编辑状态。
  if (feature('CACHED_MICROCOMPACT')) {
    const mod = await getCachedMCModule()
    const model = toolUseContext?.options.mainLoopModel ?? getMainLoopModel()
    if (
      mod.isCachedMicrocompactEnabled() &&
      mod.isModelSupportedForCacheEditing(model) &&
      isMainThreadSource(querySource)
    ) {
      return await cachedMicrocompactPath(messages, querySource)
    }
  }

  // cached microcompact 不可用时，这里不做局部压缩，交给后续 autocompact 处理整体压力。
  return { messages }
}

/**
 * cached microcompact 路径：通过 API cache edit 删除旧工具结果，不改本地消息内容。
 *
 * 它只排队缓存编辑指令，真正的 cache_reference / cache_edits 会在 API 层注入。
 */
async function cachedMicrocompactPath(
  messages: Message[],
  querySource: QuerySource | undefined,
): Promise<MicrocompactResult> {
  const mod = await getCachedMCModule()
  const state = ensureCachedMCState()
  const config = mod.getCachedMCConfig()

  const compactableToolIds = new Set(collectCompactableToolIds(messages))
  // 第二遍扫描：按 user message 分组登记可编辑的 tool_result。
  for (const message of messages) {
    if (message.type === 'user' && Array.isArray(message.message.content)) {
      const groupIds: string[] = []
      for (const block of message.message.content) {
        if (
          block.type === 'tool_result' &&
          compactableToolIds.has(block.tool_use_id) &&
          !state.registeredTools.has(block.tool_use_id)
        ) {
          mod.registerToolResult(state, block.tool_use_id)
          groupIds.push(block.tool_use_id)
        }
      }
      mod.registerToolMessage(state, groupIds)
    }
  }

  const toolsToDelete = mod.getToolResultsToDelete(state)

  if (toolsToDelete.length > 0) {
    // 创建 cache_edits block 并排队，后续由 API 层真正注入请求。
    const cacheEdits = mod.createCacheEditsBlock(state, toolsToDelete)
    if (cacheEdits) {
      pendingCacheEdits = cacheEdits
    }

    logForDebugging(
      `Cached MC deleting ${toolsToDelete.length} tool(s): ${toolsToDelete.join(', ')}`,
    )

    // 记录本次 cached microcompact 事件。
    logEvent('tengu_cached_microcompact', {
      toolsDeleted: toolsToDelete.length,
      deletedToolIds: toolsToDelete.join(
        ',',
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      activeToolCount: state.toolOrder.length - state.deletedRefs.size,
      triggerType:
        'auto' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      threshold: config.triggerThreshold,
      keepRecent: config.keepRecent,
    })

    // 成功压缩后抑制本轮上下文窗口警告。
    suppressCompactWarning()

    // 通知缓存断裂检测：接下来 cache read 下降是本次压缩导致的正常现象。
    if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
      // 传入真实 querySource。isMainThreadSource 会做前缀匹配，
      // 因此带 output style 的变体也能进入这里；getTrackingKey 仍使用完整 source 字符串，
      // 而不是只使用 repl_main_thread 前缀。
      notifyCacheDeletion(querySource ?? 'repl_main_thread')
    }

    // 本地 messages 保持不变；cache_reference 和 cache_edits 会由 API 层追加。
    // 边界消息延后到 API 响应后再写入，这样可以使用 API 返回的真实
    // cache_deleted_input_tokens，而不是客户端估算值。
    // 这里先捕获最近 assistant 消息里的累计基线，API 调用后再计算本次增量。
    const lastAsst = messages.findLast(m => m.type === 'assistant')
    const baseline =
      lastAsst?.type === 'assistant'
        ? ((
            lastAsst.message.usage as unknown as Record<
              string,
              number | undefined
            >
          )?.cache_deleted_input_tokens ?? 0)
        : 0

    return {
      messages,
      compactionInfo: {
        pendingCacheEdits: {
          trigger: 'auto',
          deletedToolIds: toolsToDelete,
          baselineCacheDeletedTokens: baseline,
        },
      },
    }
  }

  // 没有需要压缩的内容，原样返回消息。
  return { messages }
}

/**
 * 基于时间的 microcompact。
 * 当距离上一次主循环 assistant 消息的时间超过阈值时，清空除最近 N 个以外的
 * 可压缩工具结果内容。
 *
 * 未触发时返回 null，例如开关关闭、来源不对、间隔不足或没有可清理内容；
 * 调用方随后会继续尝试其他压缩路径。
 *
 * 和 cached microcompact 不同，这条路径会直接修改消息内容。
 * 此时缓存大概率已经变冷，因此无需通过 cache_edits 保留缓存前缀。
 */
/**
 * 判断本次请求是否应该触发基于时间的 microcompact。
 *
 * 触发时返回测得的间隔分钟数；不触发时返回 null。
 * 不触发原因包括开关关闭、来源不对、未达到阈值、没有历史 assistant 消息、
 * 或时间戳无法解析。
 *
 * 抽成独立函数，是为了让其他请求前路径也能复用同一判断逻辑，
 * 例如强制 snip，而不必耦合到工具结果清理动作。
 */
export function evaluateTimeBasedTrigger(
  messages: Message[],
  querySource: QuerySource | undefined,
): { gapMinutes: number; config: TimeBasedMCConfig } | null {
  const config = getTimeBasedMCConfig()
  // 这里要求显式 main-thread querySource。
  // isMainThreadSource 为了兼容 cached microcompact，会把 undefined 当作主线程；
  // 但 /context、/compact、analyzeContext 等分析路径调用 microcompactMessages 时没有 source，
  // 这些场景不应该触发真正清理。
  if (!config.enabled || !querySource || !isMainThreadSource(querySource)) {
    return null
  }
  const lastAssistant = messages.findLast(m => m.type === 'assistant')
  if (!lastAssistant) {
    return null
  }
  const gapMinutes =
    (Date.now() - new Date(lastAssistant.timestamp).getTime()) / 60_000
  if (!Number.isFinite(gapMinutes) || gapMinutes < config.gapThresholdMinutes) {
    return null
  }
  return { gapMinutes, config }
}

function maybeTimeBasedMicrocompact(
  messages: Message[],
  querySource: QuerySource | undefined,
): MicrocompactResult | null {
  const trigger = evaluateTimeBasedTrigger(messages, querySource)
  if (!trigger) {
    return null
  }
  const { gapMinutes, config } = trigger

  const compactableIds = collectCompactableToolIds(messages)

  // 至少保留 1 个：slice(-0) 会返回完整数组，反而什么都不清；
  // 如果清空所有结果，模型又会失去当前工作上下文。
  // 两种极端都不合理，所以始终至少保留最后一个。
  const keepRecent = Math.max(1, config.keepRecent)
  const keepSet = new Set(compactableIds.slice(-keepRecent))
  const clearSet = new Set(compactableIds.filter(id => !keepSet.has(id)))

  if (clearSet.size === 0) {
    return null
  }

  let tokensSaved = 0
  const result: Message[] = messages.map(message => {
    if (message.type !== 'user' || !Array.isArray(message.message.content)) {
      return message
    }
    let touched = false
    const newContent = message.message.content.map(block => {
      if (
        block.type === 'tool_result' &&
        clearSet.has(block.tool_use_id) &&
        block.content !== TIME_BASED_MC_CLEARED_MESSAGE
      ) {
        tokensSaved += calculateToolResultTokens(block)
        touched = true
        return { ...block, content: TIME_BASED_MC_CLEARED_MESSAGE }
      }
      return block
    })
    if (!touched) return message
    return {
      ...message,
      message: { ...message.message, content: newContent },
    }
  })

  if (tokensSaved === 0) {
    return null
  }

  logEvent('tengu_time_based_microcompact', {
    gapMinutes: Math.round(gapMinutes),
    gapThresholdMinutes: config.gapThresholdMinutes,
    toolsCleared: clearSet.size,
    toolsKept: keepSet.size,
    keepRecent: config.keepRecent,
    tokensSaved,
  })

  logForDebugging(
    `[TIME-BASED MC] gap ${Math.round(gapMinutes)}min > ${config.gapThresholdMinutes}min, cleared ${clearSet.size} tool results (~${tokensSaved} tokens), kept last ${keepSet.size}`,
  )

  suppressCompactWarning()
  // cached microcompact 的模块级状态保存了前几轮登记过的工具 id。
  // 这里刚刚清空了其中一些工具内容，并且修改 prompt 内容导致服务端缓存失效。
  // 如果下一轮继续带着旧状态运行 cached microcompact，就会尝试编辑服务端已不存在的条目。
  // 因此必须重置 cached microcompact 状态。
  resetMicrocompactState()
  // 刚刚修改了 prompt 内容，所以下一次响应的 cache read 下降是预期结果，不是缓存异常断裂。
  // 通知检测器预期这次下降，避免误报。
  // 这里使用已导入的 notifyCacheDeletion，而不是再引入 notifyCompaction；
  // 两者都能抑制误报，额外导入会触发循环依赖检查。
  // 传入真实 querySource：getTrackingKey 使用完整 source 字符串，
  // 例如 repl_main_thread:outputStyle:custom，而不是只使用前缀。
  if (feature('PROMPT_CACHE_BREAK_DETECTION') && querySource) {
    notifyCacheDeletion(querySource)
  }

  return { messages: result }
}
