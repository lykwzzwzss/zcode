import type { DatabaseSync } from "node:sqlite";
import type { CompactStatusOutput, DecompressContextOutput } from "@zcode/contracts/context-memory";
import { all, ARCHIVE_CTE, type Params } from "./archive-query.js";
import { READ_SELECTION } from "./archive-selection.js";

const READ_RANGE_LIMIT = 40;
const READ_RANGE_MAX_BYTES = 20_000;

export interface FoldRow {
  summary_id: string;
  boundary_id: string;
  pos: number;
  time_created: number;
  data: string;
  members?: number;
  children?: number;
  child_ids?: string;
}
export const FOLD_PROJECTION = `summary_id,boundary_id,pos,time_created,
  json_array_length(data,'$.metadata.hierarchy.memberMessageIds') as members,
  json_array_length(data,'$.metadata.hierarchy.childBoundaryIds') as children,
  (select json_group_array(value) from (select value from json_each(folds.data,'$.metadata.hierarchy.childBoundaryIds') limit 40)) as child_ids,
  json_remove(data,'$.metadata.hierarchy.memberMessageIds','$.metadata.hierarchy.childBoundaryIds') as data`;
export function rangeOutput(row: FoldRow): CompactStatusOutput["ranges"][number] {
  const part = JSON.parse(row.data),
    boundary = part.compactBoundary,
    meta = part.metadata ?? {};
  const hierarchy = meta.hierarchy;
  const usage = Object.fromEntries(
    Object.entries(meta.cacheUsage ?? {}).filter(
      ([key, value]) =>
        ["inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens"].includes(key) &&
        Number.isSafeInteger(value) &&
        Number(value) >= 0,
    ),
  );
  return {
    boundaryId: row.boundary_id,
    messageId: row.summary_id,
    summaryMessageId: row.summary_id,
    createdAt: Number(row.time_created),
    summarizedMessageCount: boundary.summarizedMessageCount ?? 0,
    lastSummarizedMessageId: boundary.lastSummarizedMessageId,
    preCompactTokenCount: boundary.preCompactTokenCount,
    // 旧 post 字段可能是摘要请求 input+output；缺少上下文估算时宁可未知，不能显示成窗口大小。
    postCompactTokenCount: boundary.truePostCompactTokenCount,
    trigger: boundary.trigger,
    phase: boundary.phase,
    ...(Object.keys(usage).length ? { cacheUsage: usage } : {}),
    ...(hierarchy
      ? {
          level: hierarchy.level,
          originalMessageCount: hierarchy.originalMessageCount,
          memberMessageCount: Number(row.members ?? hierarchy.memberMessageIds?.length ?? 0),
          childBoundaryCount: Number(row.children ?? hierarchy.childBoundaryIds?.length ?? 0),
          childBoundaryIds: row.child_ids
            ? JSON.parse(row.child_ids)
            : (hierarchy.childBoundaryIds ?? []).slice(0, 40),
        }
      : {}),
  };
}
export function selectedRanges(
  db: DatabaseSync,
  params: Params,
): { ranges: DecompressContextOutput["ranges"]; boundaryId?: string } {
  const rows = all<FoldRow>(
    db,
    `${ARCHIVE_CTE}${READ_SELECTION} select ${FOLD_PROJECTION} from folds
    where summary_id in (select id from selected_folds) order by pos limit ${READ_RANGE_LIMIT + 1}`,
    params,
  );
  const ranges: DecompressContextOutput["ranges"] = [];
  let bytes = 0;
  for (const row of rows.slice(0, READ_RANGE_LIMIT)) {
    const { cacheUsage: _usage, ...range } = rangeOutput(row);
    bytes += Buffer.byteLength(JSON.stringify(range));
    if (bytes > READ_RANGE_MAX_BYTES) break;
    ranges.push(range);
  }
  return { ranges, ...(rows.length === 1 ? { boundaryId: rows[0]!.boundary_id } : {}) };
}
