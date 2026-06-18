import { randomUUID } from 'crypto'
import { queryModelWithStreaming } from '../services/api/claude.js'
import { autoCompactIfNeeded } from '../services/compact/autoCompact.js'
import { microcompactMessages } from '../services/compact/microCompact.js'

// query() 的 I/O 依赖集中在这里，测试可以通过 QueryParams.deps 直接注入 fake。
// 使用 `typeof fn` 让依赖签名自动跟真实实现保持一致。
export type QueryDeps = {
  // 模型请求入口，生产环境映射到 queryModelWithStreaming。
  callModel: typeof queryModelWithStreaming

  // 上下文压缩入口，生产环境分别映射到 microcompactMessages 和 autoCompactIfNeeded。
  microcompact: typeof microcompactMessages
  autocompact: typeof autoCompactIfNeeded

  // 平台能力：生成 query chain、compact turn 等需要的 UUID。
  uuid: () => string
}

/**
 * queryLoop 的生产依赖映射。
 *
 * 文档里的 `deps.callModel`、`deps.microcompact`、`deps.autocompact`
 * 都通过这里落到具体实现。
 *
 * @returns QueryDeps 对象，包含真实模型调用、微压缩、自动压缩和 uuid 生成函数。
 */
export function productionDeps(): QueryDeps {
  return {
    callModel: queryModelWithStreaming,
    microcompact: microcompactMessages,
    autocompact: autoCompactIfNeeded,
    uuid: randomUUID,
  }
}
