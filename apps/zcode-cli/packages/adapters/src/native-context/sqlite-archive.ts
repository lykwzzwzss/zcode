import type { DatabaseSync } from "node:sqlite";
import type { ContextArchivePort, SearchContextOutput } from "@zcode/contracts/context-memory";
import {
  all,
  ARCHIVE_CTE,
  archiveCounts,
  assertNotCancelled,
  encodeCursor,
  openScope,
} from "./archive-query.js";
import { createArchiveReader } from "./archive-read.js";
import { FOLD_PROJECTION, rangeOutput, type FoldRow } from "./archive-ranges.js";
import { registerArchiveText } from "./archive-text.js";

export function createSqliteContextArchive(db: DatabaseSync): ContextArchivePort {
  registerArchiveText(db);
  return {
    read: createArchiveReader(db),
    search: async (input) => {
      assertNotCancelled(input.signal);
      const scope = openScope(
        db,
        input.sessionId,
        {
          operation: "search",
          query: input.query,
          role: input.role,
          scope: input.scope,
          includeFolded: input.includeFolded,
        },
        input.cursor,
      );
      const counts = archiveCounts(db, scope);
      const base = {
        query: input.query,
        sessionId: String(input.sessionId),
        searchedMessageCount: counts.messageCount,
        foldedMessageCount: counts.foldedMessageCount,
      };
      if (!input.query.trim())
        return { ...base, status: "not_found", matches: [], truncated: false };
      const rows = all<{
        id: string;
        kind: "message" | "summary";
        role: "user" | "assistant";
        time_created: number;
        boundary_id: string | null;
        folded: number;
        score: number;
        snippet: string;
      }>(
        db,
        `${ARCHIVE_CTE}, candidates as (
        select a.id,a.role,a.time_created,a.pos,case when a.kind='compact_summary' or f.summary_id is not null then 'summary' else 'message' end as kind,
        f.boundary_id,case when exists(select 1 from folded d where d.id=a.id) then 1 else 0 end as folded,
        zcode_context_text(p.data) as text from allowed a join part p on p.message_id=a.id and p.session_id=$session
        left join folds f on f.summary_id=a.id where a.role in ('user','assistant') and coalesce(a.visibility,'visible')<>'hidden'
        union all select a.id,a.role,a.time_created,a.pos,'summary',f.boundary_id,
        case when exists(select 1 from folded d where d.id=a.id) then 1 else 0 end,b.text
        from summary_bodies b join allowed a on a.id=b.message_id left join folds f on f.summary_id=a.id
        where a.role in ('user','assistant') and coalesce(a.visibility,'visible')<>'hidden'
      ), scored as (
        select *,zcode_context_score(text,$query) as score from candidates where ($role='any' or role=$role)
        and ($scope='all' or ($scope='summaries' and kind='summary') or ($scope='messages' and kind='message')) and ($include=1 or folded=0)
      ), ranked as (
        select *,row_number() over(partition by id order by score desc) as ranking from scored where score>0
      ) select id,kind,role,time_created,boundary_id,folded,score,zcode_context_snippet(text,$query,case when kind='summary' then 400 else 220 end) as snippet
        from ranked where ranking=1 order by score desc,kind='summary',pos desc,id limit $limit offset $offset`,
        {
          ...scope.params,
          $query: input.query,
          $role: input.role,
          $scope: input.scope,
          $include: input.includeFolded ? 1 : 0,
          $limit: input.maxResults + 1,
          $offset: scope.cursor.offset,
        },
      );
      const matches: SearchContextOutput["matches"] = [];
      let chars = 0;
      for (const row of rows.slice(0, input.maxResults)) {
        const remaining = (input.maxChars ?? 20_000) - chars;
        if (remaining <= 0) break;
        const snippet = row.snippet.slice(0, remaining);
        const match = {
          kind: row.kind,
          messageId: row.id,
          role: row.role,
          createdAt: Number(row.time_created),
          folded: Boolean(row.folded),
          score: row.score,
          snippet,
          ...(row.kind === "summary"
            ? {
                summaryMessageId: row.id,
                ...(row.boundary_id ? { boundaryId: row.boundary_id } : { retained: true }),
              }
            : {}),
        };
        if (
          matches.length &&
          Buffer.byteLength(JSON.stringify([...matches, match]), "utf8") > 55_000
        )
          break;
        matches.push(match);
        chars += snippet.length;
      }
      scope.cursor.offset += matches.length;
      const more = rows.length > matches.length;
      return {
        ...base,
        status: matches.length ? "success" : "not_found",
        matches,
        truncated: more,
        ...(more && matches.length ? { nextCursor: encodeCursor(scope.cursor) } : {}),
      };
    },
    status: async (input) => {
      assertNotCancelled(input.signal);
      const scope = openScope(
        db,
        input.sessionId,
        { operation: "status", boundary: input.boundaryId ?? null },
        input.cursor,
      );
      const size = input.maxRanges ?? 40;
      const rows = all<FoldRow>(
        db,
        `${ARCHIVE_CTE} select ${FOLD_PROJECTION} from folds where $boundary='' or boundary_id in (
        select j.value from folds parent,json_each(parent.data,'$.metadata.hierarchy.childBoundaryIds') j where parent.boundary_id=$boundary)
        order by pos desc limit $limit offset $offset`,
        {
          ...scope.params,
          $boundary: input.boundaryId ?? "",
          $limit: size + 1,
          $offset: scope.cursor.offset,
        },
      );
      const ranges = [];
      let bytes = 0;
      for (const row of rows.slice(0, size)) {
        const range = rangeOutput(row),
          length = Buffer.byteLength(JSON.stringify(range));
        if (ranges.length && bytes + length > 26_000) break;
        ranges.push(range);
        bytes += length;
      }
      scope.cursor.offset += ranges.length;
      const last = all<{ time: number }>(
        db,
        `${ARCHIVE_CTE} select max(time_created) as time from folds`,
        scope.params,
      )[0]?.time;
      return {
        status: "success",
        sessionId: String(input.sessionId),
        ...archiveCounts(db, scope),
        ranges,
        ...(last !== null && last !== undefined ? { lastCompactAt: Number(last) } : {}),
        ...(rows.length > ranges.length ? { nextCursor: encodeCursor(scope.cursor) } : {}),
      };
    },
  };
}
