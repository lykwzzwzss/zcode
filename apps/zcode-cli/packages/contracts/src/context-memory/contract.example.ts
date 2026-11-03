/**
 * native-context-contracts 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { ContextArchivePort } from "./contract.js";
import type { SessionId } from "../interfaces/shared.js";

export async function recallOriginal(
  archive: ContextArchivePort,
  sessionId: SessionId,
  messageId: string,
) {
  const first = await archive.read({
    sessionId,
    tier: "original",
    messageIds: [messageId],
    maxChars: 20_000,
  });
  return first.nextCursor
    ? archive.read({
        sessionId,
        tier: "original",
        messageIds: [messageId],
        cursor: first.nextCursor,
      })
    : first;
}
