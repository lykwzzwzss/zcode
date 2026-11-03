import type { DatabaseSync } from "node:sqlite";
import type { ContextArchivePort, DecompressContextOutput } from "@zcode/contracts/context-memory";
import { all, ARCHIVE_CTE, assertNotCancelled, encodeCursor, openScope } from "./archive-query.js";
import { selectedRanges } from "./archive-ranges.js";
import { READ_SELECTION } from "./archive-selection.js";
import { sliceText } from "./archive-text.js";

const PAGE_PART_LIMIT = 32;
const PAGE_CONTENT_MAX_BYTES = 72_000;
const DEFAULT_MAX_CHARS = 10_000;

// 先按稳定位置限制 part 数量，再逐条转换正文；不在 LIMIT 之前调用全文 UDF。
const PAGE_SELECTION = `, part_positions as (
 select a.id as message_id,a.pos,a.role,p.id as part_id,
 row_number() over(partition by a.id order by p.sequence is null,p.sequence,p.time_created,p.id) as part_pos
 from allowed a join selected s on s.id=a.id join part p on p.message_id=a.id and p.session_id=$session
 where coalesce(a.visibility,'visible')<>'hidden'
), candidates as (
 select pp.*,0 as legacy_body from part_positions pp
 union all select a.id,a.pos,a.role,'summary-body:'||a.id,0,1 from allowed a join selected s on s.id=a.id
 join summary_bodies b on b.message_id=a.id where coalesce(a.visibility,'visible')<>'hidden'
) select message_id,pos,role,part_id,part_pos,legacy_body from candidates where
 pos>$message or (pos=$message and (part_pos>$part or (part_pos=$part and $complete=0)))
 order by pos,part_pos limit $limit`;
interface PartPosition {
  message_id: string;
  pos: number;
  role: string;
  part_id: string;
  part_pos: number;
  legacy_body: number;
}

export function createArchiveReader(db: DatabaseSync): ContextArchivePort["read"] {
  return async (input) => {
    assertNotCancelled(input.signal);
    const ids = [...new Set(input.messageIds ?? [])].sort();
    const scope = openScope(
      db,
      input.sessionId,
      { operation: "read", tier: input.tier, ids, boundary: input.boundaryId ?? null },
      input.cursor,
    );
    const params = {
      ...scope.params,
      $ids: JSON.stringify(ids),
      $explicit: ids.length ? 1 : 0,
      $boundary: input.boundaryId ?? "",
      $tier: input.tier,
    };
    const rows = all<PartPosition>(db, `${ARCHIVE_CTE}${READ_SELECTION}${PAGE_SELECTION}`, {
      ...params,
      $message: scope.cursor.message,
      $part: scope.cursor.part,
      $complete: scope.cursor.complete ? 1 : 0,
      $limit: PAGE_PART_LIMIT + 1,
    });
    const metadata = selectedRanges(db, params);
    let content = "",
      chars = 0,
      consumed = 0,
      partial = false;
    const segments: NonNullable<DecompressContextOutput["segments"]> = [],
      messages = new Set<string>();
    const budget = input.maxChars ?? DEFAULT_MAX_CHARS;
    for (const row of rows.slice(0, PAGE_PART_LIMIT)) {
      assertNotCancelled(input.signal);
      const stored = row.legacy_body
        ? db
            .prepare(
              "select json_extract(data,'$.summary.body') as text from message where id=? and session_id=?",
            )
            .get(row.message_id, input.sessionId)
        : db
            .prepare(
              "select zcode_context_text(data) as text from part where id=? and message_id=? and session_id=?",
            )
            .get(row.part_id, row.message_id, input.sessionId);
      const text = String(stored?.text ?? "");
      const sourceOffset =
        row.pos === scope.cursor.message && row.part_pos === scope.cursor.part
          ? scope.cursor.character
          : 0;
      if (sourceOffset >= text.length) {
        scope.cursor.message = row.pos;
        scope.cursor.part = row.part_pos;
        scope.cursor.character = text.length;
        scope.cursor.complete = true;
        consumed++;
        continue;
      }
      const header = `${content ? "\n\n" : ""}[${row.role} ${row.message_id} part=${row.part_id} offset=${sourceOffset}]\n`;
      let chunk = sliceText(text, sourceOffset, Math.max(0, budget - chars));
      // 中文与 JSON 转义也占工具预算；缩短本页正文后，游标按实际输出长度继续。
      while (
        chunk &&
        Buffer.byteLength(JSON.stringify(content + header + chunk), "utf8") > PAGE_CONTENT_MAX_BYTES
      ) {
        const shortened = Math.floor(chunk.length * 0.7);
        chunk = shortened < 2 ? "" : sliceText(chunk, 0, shortened);
      }
      if (!chunk) break;
      const start = content.length + header.length;
      content += header + chunk;
      chars += chunk.length;
      messages.add(row.message_id);
      segments.push({
        messageId: row.message_id,
        partId: row.part_id,
        sourceOffset,
        start,
        length: chunk.length,
      });
      scope.cursor.message = row.pos;
      scope.cursor.part = row.part_pos;
      scope.cursor.character = sourceOffset + chunk.length;
      scope.cursor.complete = scope.cursor.character >= text.length;
      consumed++;
      partial = !scope.cursor.complete;
      if (partial || chars >= budget) break;
    }
    const more = partial || consumed < rows.length;
    return {
      sessionId: String(input.sessionId),
      tier: input.tier,
      ...metadata,
      content:
        content ||
        (more
          ? "No readable text in this page; continue with nextCursor."
          : "No readable messages for this context selection."),
      segments,
      messageCount: messages.size,
      status: segments.length || more ? "success" : "not_found",
      truncated: more,
      ...(input.tier === "summary" && messages.size === 1
        ? { summaryMessageId: [...messages][0] }
        : {}),
      ...(more ? { nextCursor: encodeCursor(scope.cursor) } : {}),
    } satisfies DecompressContextOutput;
  };
}
