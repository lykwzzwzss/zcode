import { describe, expect, it } from "vitest";
import {
  createMessageId,
  createPartId,
  createProjectId,
  createSessionId,
  createTraceId,
  CompactTrigger,
  type MessageWithParts,
} from "@zcode/contracts";
import { createSqliteSessionStore } from "../src/storage/index.js";
import { archivePartText } from "../src/native-context/archive-text.js";

async function fixture() {
  const store = await createSqliteSessionStore({ dbPath: ":memory:" });
  const sessionId = createSessionId();
  await store.createSession({
    id: sessionId,
    projectID: createProjectId(),
    directory: process.cwd(),
    slug: "archive",
    title: "archive",
    version: "1",
  });
  let sequence = 0;
  async function message(name: string, text: string, tool = false) {
    const id = createMessageId(name),
      created = ++sequence;
    const record: MessageWithParts = {
      info: { id, sessionID: sessionId, role: tool ? "assistant" : "user", time: { created } },
      parts: [
        tool
          ? {
              id: createPartId(`${name}-tool`),
              messageID: id,
              sessionID: sessionId,
              type: "tool",
              tool: "Bash",
              callID: `${name}-call`,
              state: {
                status: "completed",
                input: { command: "fixture" },
                output: text,
                title: "fixture",
                metadata: {},
                time: { start: created, end: created },
              },
            }
          : {
              id: createPartId(`${name}-text`),
              messageID: id,
              sessionID: sessionId,
              type: "text",
              text,
            },
      ],
    } as MessageWithParts;
    await store.commitMessageBundle!({ sessionID: sessionId, messages: [record] });
    return record;
  }
  async function fold(
    name: string,
    members: MessageWithParts[],
    children: string[] = [],
    level = 1,
    originals = members.length,
  ) {
    const record = await message(name, `summary ${name}`);
    record.info.semantics = {
      kind: "compact_summary",
      providerVisibility: "visible",
    } as typeof record.info.semantics;
    const boundaryId = `boundary-${name}`;
    record.parts.push({
      id: createPartId(`${name}-compaction`),
      messageID: record.info.id,
      sessionID: sessionId,
      type: "compaction",
      auto: false,
      compactBoundary: {
        boundaryId,
        trigger: CompactTrigger.Manual,
        preCompactTokenCount: 100,
        postCompactTokenCount: 10,
        summarizedMessageCount: members.length,
        summaryMessageIds: [record.info.id],
        traceId: createTraceId(),
      },
      metadata: {
        hierarchy: {
          memberMessageIds: members.map((m) => m.info.id),
          childBoundaryIds: children,
          level,
          originalMessageCount: originals,
        },
        cacheUsage: { inputTokens: 100, cacheReadTokens: 80, outputTokens: 10 },
      },
    } as MessageWithParts["parts"][number]);
    await store.commitMessageBundle!({ sessionID: sessionId, messages: [record] });
    return { record, boundaryId };
  }
  return { store, sessionId, message, fold, archive: store.contextArchive };
}

describe("SQLite native context archive", () => {
  it("keeps gaps and prefix active when reading persisted ranges without hierarchy metadata", async () => {
    const f = await fixture();
    try {
      const prefix = await f.message("legacy-prefix", "PREFIX_ONLY");
      const left = await f.message("legacy-left", "LEFT_ONLY");
      const gap = await f.message("legacy-gap", "GAP_ONLY");
      const right = await f.message("legacy-right", "RIGHT_ONLY");
      const tail = await f.message("legacy-tail", "TAIL_ONLY");
      const first = await f.fold("legacy-first", [left]),
        second = await f.fold("legacy-second", [right]);
      for (const [node, original] of [
        [first, left],
        [second, right],
      ] as const) {
        const part = node.record.parts.find((part) => part.type === "compaction")!;
        if (part.type !== "compaction") throw new Error("fixture compaction missing");
        part.metadata = {
          compactFormat: "ranges-v1",
          compactRange: {
            rangeId: node.boundaryId,
            startMessageId: original.info.id,
            endMessageId: original.info.id,
            summaryMessageId: node.record.info.id,
          },
        };
        await f.store.commitMessageBundle!({ sessionID: f.sessionId, messages: [node.record] });
      }
      const selected = await f.archive.read({
        sessionId: f.sessionId,
        tier: "original",
        boundaryId: first.boundaryId,
      });
      expect(selected.content).toContain("LEFT_ONLY");
      expect(selected.content).not.toContain("GAP_ONLY");
      expect(selected.content).not.toContain("PREFIX_ONLY");
      const latest = await f.archive.read({ sessionId: f.sessionId, tier: "original" });
      expect(latest.content).toContain("RIGHT_ONLY");
      expect(latest.content).not.toContain("LEFT_ONLY");
      expect(latest.content).not.toContain("TAIL_ONLY");
      const status = await f.archive.status({ sessionId: f.sessionId });
      expect(status.foldedMessageCount).toBe(2);
      expect(status.activeMessageCount).toBe(5);
      expect(status.ranges).toHaveLength(2);
      for (const message of [prefix, gap, tail]) {
        const found = await f.archive.search({
          sessionId: f.sessionId,
          query: String(message.parts[0]!.type === "text" ? message.parts[0]!.text : ""),
          role: "any",
          scope: "messages",
          includeFolded: false,
          maxResults: 8,
        });
        expect(
          found.matches.some((match) => match.messageId === message.info.id && !match.folded),
        ).toBe(true);
      }
      const hidden = await f.archive.search({
        sessionId: f.sessionId,
        query: "LEFT_ONLY",
        role: "any",
        scope: "messages",
        includeFolded: false,
        maxResults: 8,
      });
      expect(hidden.matches).toEqual([]);
    } finally {
      f.store.close();
    }
  });

  it("keeps leading messages, retained summaries and preserved segments outside a persisted prefix fold", async () => {
    const f = await fixture();
    try {
      const leading = await f.message("leading", "LEADING"),
        retained = await f.message("retained", "RETAINED"),
        raw = await f.message("raw-prefix", "FOLDED_ORIGINAL"),
        head = await f.message("head", "PRESERVED_HEAD"),
        tail = await f.message("tail", "PRESERVED_TAIL");
      const node = await f.fold("legacy-prefix-node", [raw]);
      const part = node.record.parts.find((part) => part.type === "compaction")!;
      if (part.type !== "compaction" || !part.compactBoundary)
        throw new Error("fixture compaction missing");
      part.metadata = {
        compactLeadingMessageIds: [leading.info.id],
        compactRetainedMessageIds: [retained.info.id],
      };
      part.compactBoundary.preservedSegment = {
        anchorMessageId: node.record.info.id,
        headMessageId: head.info.id,
        tailMessageId: tail.info.id,
      };
      await f.store.commitMessageBundle!({ sessionID: f.sessionId, messages: [node.record] });
      const page = await f.archive.read({
        sessionId: f.sessionId,
        tier: "original",
        boundaryId: node.boundaryId,
      });
      expect(page.content).toContain("FOLDED_ORIGINAL");
      expect(page.content).not.toContain("LEADING");
      expect(page.content).not.toContain("RETAINED");
      expect(page.content).not.toContain("PRESERVED_");
      expect((await f.archive.status({ sessionId: f.sessionId })).foldedMessageCount).toBe(1);
    } finally {
      f.store.close();
    }
  });

  it.each(["output", "error"] as const)(
    "searches the full %s and applies role/scope filters inside SQLite",
    async (field) => {
      const f = await fixture();
      try {
        const needle = "LONG_TAIL_EXACT",
          raw = await f.message("long-state", "x".repeat(30_000) + needle, true);
        if (field === "error") {
          const part = raw.parts[0]!;
          if (part.type !== "tool") throw new Error("fixture tool missing");
          part.state = {
            status: "error",
            input: {},
            error: "x".repeat(30_000) + needle,
            time: { start: 1, end: 1 },
          };
          await f.store.savePart(part);
        }
        await f.fold("state-node", [raw]);
        const input = {
          sessionId: f.sessionId,
          query: needle,
          role: "assistant" as const,
          scope: "messages" as const,
          includeFolded: true,
          maxResults: 8,
        };
        const result = await f.archive.search(input);
        expect(result.matches[0]).toMatchObject({ messageId: raw.info.id, folded: true });
        expect(result.matches[0]!.snippet).toContain(needle);
        expect(result.matches[0]!.snippet.length).toBeLessThan(500);
        expect((await f.archive.search({ ...input, role: "user" })).matches).toEqual([]);
        expect((await f.archive.search({ ...input, scope: "summaries" })).matches).toEqual([]);
      } finally {
        f.store.close();
      }
    },
  );

  it("recovers full long tool output and Unicode across pages, without calling the full transcript API", async () => {
    const f = await fixture();
    try {
      const text = "中文😀\u0000line\n".repeat(18_000) + "END-ORIGINAL";
      const raw = await f.message("large", text, true);
      const node = await f.fold("large-summary", [raw]);
      f.store.messages = async () => {
        throw new Error("full transcript reads forbidden");
      };
      const expected = archivePartText(JSON.stringify(raw.parts[0]));
      let cursor: string | undefined,
        restored = "",
        pages = 0;
      do {
        const page = await f.archive.read({
          sessionId: f.sessionId,
          tier: "original",
          boundaryId: node.boundaryId,
          maxChars: 80_000,
          cursor,
        });
        expect(page.status).toBe("success");
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(120_000);
        for (const segment of page.segments!) {
          expect(segment.sourceOffset).toBe(restored.length);
          restored += page.content.slice(segment.start, segment.start + segment.length);
        }
        cursor = page.nextCursor;
        pages++;
        expect(pages).toBeLessThan(100);
      } while (cursor);
      expect(pages).toBeGreaterThan(3);
      expect(restored).toBe(expected);
    } finally {
      f.store.close();
    }
  });

  it("expands a 64-generation DAG to originals, browses children and preserves usage", async () => {
    const f = await fixture();
    try {
      const raw = await f.message("raw", "EXACT-SECRET-needle");
      let node = await f.fold("s1", [raw]);
      for (let level = 2; level <= 64; level++)
        node = await f.fold(`s${level}`, [node.record], [node.boundaryId], level, 1);
      const page = await f.archive.read({
        sessionId: f.sessionId,
        tier: "original",
        boundaryId: node.boundaryId,
      });
      expect(page.content).toContain("EXACT-SECRET-needle");
      expect(page.content).not.toContain("summary s");
      expect(page.ranges[0]?.level).toBe(64);
      const summary = await f.archive.read({
        sessionId: f.sessionId,
        tier: "summary",
        boundaryId: "boundary-s10",
      });
      expect(summary.content).toContain("summary s10");
      expect(summary.content).not.toContain("summary s64");
      const explicit = await f.archive.read({
        sessionId: f.sessionId,
        tier: "summary",
        messageIds: [createMessageId("s10")],
      });
      expect(explicit.content).toContain("summary s10");
      expect(explicit.content).not.toContain("summary s64");
      const children = await f.archive.status({
        sessionId: f.sessionId,
        boundaryId: node.boundaryId,
      });
      expect(children.ranges.map((range) => range.boundaryId)).toEqual(["boundary-s63"]);
      const all: string[] = [];
      let cursor: string | undefined;
      do {
        const status = await f.archive.status({ sessionId: f.sessionId, maxRanges: 7, cursor });
        expect(status.ranges.every((range) => range.cacheUsage?.cacheReadTokens === 80)).toBe(true);
        all.push(...status.ranges.map((range) => range.boundaryId));
        cursor = status.nextCursor;
      } while (cursor);
      expect(new Set(all).size).toBe(64);
      const search = await f.archive.search({
        sessionId: f.sessionId,
        query: "SECRET-needle",
        role: "any",
        scope: "messages",
        includeFolded: true,
        maxResults: 8,
      });
      expect(search.matches[0]?.messageId).toBe(raw.info.id);
      expect(search.matches[0]?.folded).toBe(true);
    } finally {
      f.store.close();
    }
  });

  it("pins search pages while new messages append, and rejects a changed query, session or branch", async () => {
    const f = await fixture();
    try {
      for (let i = 0; i < 7; i++) await f.message(`m${i}`, "needle");
      const input = {
        sessionId: f.sessionId,
        query: "needle",
        role: "any" as const,
        scope: "all" as const,
        includeFolded: true,
        maxResults: 2,
      };
      const first = await f.archive.search(input);
      expect(first.nextCursor).toBeTruthy();
      await f.message("new-append", "needle");
      const found = first.matches.map((match) => match.messageId);
      let cursor = first.nextCursor;
      while (cursor) {
        const page = await f.archive.search({ ...input, cursor });
        found.push(...page.matches.map((match) => match.messageId));
        cursor = page.nextCursor;
      }
      expect(found).toHaveLength(7);
      expect(new Set(found).size).toBe(7);
      await expect(
        f.archive.search({ ...input, query: "changed", cursor: first.nextCursor }),
      ).rejects.toThrow("cursor");
      await expect(
        f.archive.search({ ...input, sessionId: createSessionId(), cursor: first.nextCursor }),
      ).rejects.toThrow();
      await f.store.updateSession({
        id: f.sessionId,
        revert: { targetMessageID: createMessageId("m4"), keptMessageIDs: [createMessageId("m0")] },
      });
      await expect(f.archive.search({ ...input, cursor: first.nextCursor })).rejects.toThrow(
        "cursor",
      );
      const active = await f.archive.search(input);
      expect(active.matches.map((match) => match.messageId)).toEqual([createMessageId("m0")]);
    } finally {
      f.store.close();
    }
  });

  it("searches beyond the old 20k tool-output cap and pages a multipart selection exactly", async () => {
    const f = await fixture();
    try {
      const raw = await f.message("multi", "x".repeat(80_000) + "LATE-NEEDLE", true);
      const extra = {
        id: createPartId("multi-extra"),
        messageID: raw.info.id,
        sessionID: f.sessionId,
        type: "text" as const,
        text: "extra 😀 exact",
      };
      await f.store.savePart(extra);
      const search = await f.archive.search({
        sessionId: f.sessionId,
        query: "LATE-NEEDLE",
        role: "any",
        scope: "messages",
        includeFolded: true,
        maxResults: 8,
      });
      expect(search.matches[0]?.snippet).toContain("LATE-NEEDLE");
      const chunks = new Map<string, string>();
      let cursor: string | undefined;
      do {
        const page = await f.archive.read({
          sessionId: f.sessionId,
          tier: "original",
          messageIds: [raw.info.id],
          maxChars: 1024,
          cursor,
        });
        for (const segment of page.segments!) {
          const previous = chunks.get(segment.partId) ?? "";
          expect(segment.sourceOffset).toBe(previous.length);
          chunks.set(
            segment.partId,
            previous + page.content.slice(segment.start, segment.start + segment.length),
          );
        }
        cursor = page.nextCursor;
      } while (cursor);
      expect(chunks.get(String(raw.parts[0]!.id))).toBe(
        archivePartText(JSON.stringify(raw.parts[0])),
      );
      expect(chunks.get(String(extra.id))).toBe(extra.text);
    } finally {
      f.store.close();
    }
  });

  it("honors cancellation and validates read cursor selection", async () => {
    const f = await fixture();
    try {
      const raw = await f.message("cursor", "😀".repeat(30));
      const input = {
        sessionId: f.sessionId,
        tier: "original" as const,
        messageIds: [raw.info.id],
        maxChars: 1,
      };
      const first = await f.archive.read(input);
      expect(first.content).toContain("😀");
      expect(first.nextCursor).toBeTruthy();
      await expect(
        f.archive.read({ ...input, tier: "summary", cursor: first.nextCursor }),
      ).rejects.toThrow("cursor");
      await expect(f.archive.read({ ...input, cursor: "garbage" })).rejects.toThrow("cursor");
      const abort = new AbortController();
      abort.abort();
      await expect(f.archive.read({ ...input, signal: abort.signal })).rejects.toThrow();
    } finally {
      f.store.close();
    }
  });

  it("does not display old summary request totals as post-fold context estimates", async () => {
    const f = await fixture();
    try {
      const raw = await f.message("old-total-source", "original");
      const node = await f.fold("old-total-node", [raw]);
      const part = node.record.parts.find((part) => part.type === "compaction");
      if (!part || part.type !== "compaction" || !part.compactBoundary)
        throw new Error("missing boundary");
      part.compactBoundary.postCompactTokenCount = 100_615;
      delete part.compactBoundary.truePostCompactTokenCount;
      await f.store.savePart(part);
      const old = await f.archive.status({ sessionId: f.sessionId });
      expect(old.ranges[0]?.postCompactTokenCount).toBeUndefined();
      part.compactBoundary.truePostCompactTokenCount = 34_700;
      await f.store.savePart(part);
      const known = await f.archive.status({ sessionId: f.sessionId });
      expect(known.ranges[0]?.postCompactTokenCount).toBe(34_700);
    } finally {
      f.store.close();
    }
  });

  it("defaults to small pages while retaining the complete original through cursors", async () => {
    const f = await fixture();
    try {
      const original = "完整原文😀".repeat(5000);
      const record = await f.message("default-small-pages", original);
      let cursor: string | undefined;
      let restored = "";
      let pages = 0;
      do {
        const page = await f.archive.read({
          sessionId: f.sessionId,
          tier: "original",
          messageIds: [record.info.id],
          cursor,
        });
        const segments = page.segments ?? [];
        expect(segments.reduce((sum, segment) => sum + segment.length, 0)).toBeLessThanOrEqual(
          10_000,
        );
        restored += segments
          .map((segment) => page.content.slice(segment.start, segment.start + segment.length))
          .join("");
        cursor = page.nextCursor;
        if (++pages > 10) throw new Error("default page cursor did not advance");
      } while (cursor);
      expect(pages).toBeGreaterThan(1);
      expect(restored).toBe(original);
    } finally {
      f.store.close();
    }
  });

  it("returns each independently covering summary for multiple message selections", async () => {
    const f = await fixture();
    try {
      const left = await f.message("left", "left original"),
        right = await f.message("right", "right original");
      await f.fold("left-node", [left]);
      await f.fold("right-node", [right]);
      const result = await f.archive.read({
        sessionId: f.sessionId,
        tier: "summary",
        messageIds: [left.info.id, right.info.id],
      });
      expect(result.content).toContain("summary left-node");
      expect(result.content).toContain("summary right-node");
      expect(result.messageCount).toBe(2);
    } finally {
      f.store.close();
    }
  });
});
