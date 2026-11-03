import type { MessageId, SessionId } from "../interfaces/shared.js";
import type {
  CompactStatusInput,
  CompactStatusOutput,
  DecompressContextInput,
  DecompressContextOutput,
  SearchContextInput,
  SearchContextOutput,
} from "../tools/context-memory.js";

/** 直接成员只引用同一 session 的持久化消息；有向无环，原文行永不删除。 */
export interface ContextFoldMetadata {
  memberMessageIds: MessageId[];
  childBoundaryIds: string[];
  level: number;
  originalMessageCount: number;
}

/**
 * SQLite 负责有界 I/O；返回预算内的文字/元数据，不修改会话或发出事件。
 * I/O/取消异常向上抛出；显式 failed 也必须由工具层转为执行失败，not_found 是正常查询结果。
 */
export interface ContextArchivePort {
  search(
    input: SearchContextInput & { sessionId: SessionId; signal?: AbortSignal },
  ): Promise<SearchContextOutput>;
  read(
    input: Omit<DecompressContextInput, "toFile"> & { sessionId: SessionId; signal?: AbortSignal },
  ): Promise<DecompressContextOutput>;
  status(
    input: CompactStatusInput & { sessionId: SessionId; signal?: AbortSignal },
  ): Promise<CompactStatusOutput>;
}

export type {
  CompactStatusInput,
  CompactStatusOutput,
  DecompressContextInput,
  DecompressContextOutput,
  SearchContextInput,
  SearchContextOutput,
} from "../tools/context-memory.js";
