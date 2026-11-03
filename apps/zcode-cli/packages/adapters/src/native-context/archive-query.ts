import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

export type Params = Record<string, SQLInputValue>;
export interface ArchiveCursor {
  v: 1;
  session: string;
  branch: string;
  selection: string;
  watermark: number;
  excluded: string[];
  offset: number;
  message: number;
  part: number;
  character: number;
  complete?: boolean;
}
export interface ArchiveScope {
  cursor: ArchiveCursor;
  params: Params;
}

export function all<T>(db: DatabaseSync, sql: string, params: Params): T[] {
  const statement = db.prepare(sql);
  statement.setAllowUnknownNamedParameters(true);
  return statement.all(params) as T[];
}
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function openScope(
  db: DatabaseSync,
  session: string,
  selection: unknown,
  encoded?: string,
): ArchiveScope {
  const stored = db.prepare("select revert from session where id=?").get(session);
  if (!stored) throw new Error("Session not found");
  const revert = stored.revert ? JSON.parse(String(stored.revert)) : null;
  const branch = digest(revert);
  const signature = digest(selection);
  let cursor: ArchiveCursor;
  if (encoded) {
    try {
      cursor = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch {
      throw new Error("Invalid context cursor");
    }
    if (
      cursor.v !== 1 ||
      cursor.session !== session ||
      cursor.branch !== branch ||
      cursor.selection !== signature ||
      (cursor.complete !== undefined && typeof cursor.complete !== "boolean") ||
      ![cursor.watermark, cursor.offset, cursor.message, cursor.part, cursor.character].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      ) ||
      !Array.isArray(cursor.excluded) ||
      cursor.excluded.length > 64 ||
      !cursor.excluded.every((value) => typeof value === "string")
    ) {
      throw new Error("Context cursor does not match this session, selection or current branch");
    }
  } else {
    const watermark = Number(
      db
        .prepare("select coalesce(max(rowid),0) as value from message where session_id=?")
        .get(session)?.value ?? 0,
    );
    // 正在运行的工具会在本次调用后覆写 part；将其消息排除在快照外，后续追加不改变已选原文页。
    const excluded = all<{ id: string }>(
      db,
      `select distinct message_id as id from part where session_id=$session and json_extract(data,'$.type')='tool' and json_extract(data,'$.state.status') in ('pending','running') limit 65`,
      { $session: session },
    ).map((row) => row.id);
    if (excluded.length > 64)
      throw new Error("Too many unfinished messages for a stable context snapshot");
    cursor = {
      v: 1,
      session,
      branch,
      selection: signature,
      watermark,
      excluded,
      offset: 0,
      message: 0,
      part: 0,
      character: 0,
    };
  }
  return {
    cursor,
    params: {
      $session: session,
      $watermark: cursor.watermark,
      $excluded: JSON.stringify(cursor.excluded),
      $rewind: revert?.targetMessageID ? 1 : 0,
      $target: revert?.targetMessageID ?? "",
      $cut: revert?.branchCutAfterMessageID ?? "",
      $created: revert?.createdMessageID ?? "",
      $kept: JSON.stringify(revert?.keptMessageIDs ?? null),
    },
  };
}
export function encodeCursor(cursor: ArchiveCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}
export function assertNotCancelled(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

/** 只在 SQLite 内处理位置与成员索引，不向 JS 取出整条会话正文。 */
export const READABLE_PART = `(json_extract(p.data,'$.type')='text' and coalesce(json_extract(p.data,'$.ignored'),0)=0 and coalesce(json_extract(p.data,'$.text'),'')<>'') or
 (json_extract(p.data,'$.type')='tool' and json_extract(p.data,'$.state.status') in ('completed','error'))`;
export const ARCHIVE_CTE = `with recursive
ordered as (
 select id,rowid as source_rowid,time_created,
 row_number() over(order by sequence is null,sequence,time_created,rowid) as pos
 from message where session_id=$session and rowid<=$watermark and id not in (select value from json_each($excluded))
), allowed as (
 select o.*,json_extract(m.data,'$.role') as role,json_extract(m.data,'$.semantics.kind') as kind,
 json_extract(m.data,'$.semantics.providerVisibility') as visibility from ordered o join message m on m.id=o.id
 where $rewind=0 or (
  (case when json_type($kept)='array' then o.id in (select value from json_each($kept))
   when exists(select 1 from ordered where id=$target) then o.pos<(select pos from ordered where id=$target) else 1 end)
  or (case when $cut<>'' then o.pos>(select pos from ordered where id=$cut)
   when $created<>'' then o.pos>=(select pos from ordered where id=$created) else 0 end)
 )
), folds as (
 select a.id as summary_id,a.pos,a.time_created,p.data,
 json_extract(p.data,'$.compactBoundary.boundaryId') as boundary_id
 from allowed a join part p on p.message_id=a.id and p.session_id=$session
 where json_extract(p.data,'$.type')='compaction' and json_type(p.data,'$.compactBoundary')='object'
), member_edges(summary_id,member_id) as (
 select f.summary_id,j.value from folds f,json_each(f.data,'$.metadata.hierarchy.memberMessageIds') j
 union select f.summary_id,c.summary_id from folds f,json_each(f.data,'$.metadata.hierarchy.childBoundaryIds') j join folds c on c.boundary_id=j.value
 union select f.summary_id,a.id from folds f join allowed a on a.pos<f.pos
 where json_type(f.data,'$.metadata.hierarchy') is null and (
  (json_type(f.data,'$.metadata.compactRange')='object' and a.pos between
   (select pos from ordered where id=json_extract(f.data,'$.metadata.compactRange.startMessageId')) and
   (select pos from ordered where id=json_extract(f.data,'$.metadata.compactRange.endMessageId')))
  or (json_type(f.data,'$.metadata.compactRange') is null and
   a.id not in (select value from json_each(f.data,'$.metadata.compactLeadingMessageIds')) and
   a.id not in (select value from json_each(f.data,'$.metadata.compactRetainedMessageIds')) and
   not coalesce(a.pos between (select pos from ordered where id=json_extract(f.data,'$.compactBoundary.preservedSegment.headMessageId')) and
   (select pos from ordered where id=json_extract(f.data,'$.compactBoundary.preservedSegment.tailMessageId')),0))
 )
), folded as (select distinct member_id as id from member_edges), summary_bodies as (
 select a.id as message_id,json_extract(m.data,'$.summary.body') as text from allowed a join message m on m.id=a.id
 where (a.kind='compact_summary' or exists(select 1 from folds f where f.summary_id=a.id))
 and json_type(m.data,'$.summary.body')='text' and json_extract(m.data,'$.summary.body')<>''
 and not exists(select 1 from part p where p.message_id=a.id and p.session_id=$session and (${READABLE_PART}))
)
`;

export function archiveCounts(db: DatabaseSync, scope: ArchiveScope) {
  const row = all<{ count: number; folded: number }>(
    db,
    `${ARCHIVE_CTE} select count(*) as count,coalesce(sum(case when exists(select 1 from folded f where f.id=a.id) then 1 else 0 end),0) as folded from allowed a`,
    scope.params,
  )[0]!;
  return {
    messageCount: Number(row.count),
    foldedMessageCount: Number(row.folded),
    activeMessageCount: Number(row.count) - Number(row.folded),
  };
}
