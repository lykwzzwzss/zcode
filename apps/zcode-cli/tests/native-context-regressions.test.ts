import { describe, expect, it } from "vitest";
import { createSqliteSessionStore } from "../packages/adapters/src/storage/index.js";
import {
  createMessageId,
  createPartId,
  createProjectId,
  createSessionId,
  createTraceId,
  createRootTraceContext,
  CompactTrigger,
  CoreErrorType,
  createCoreError,
} from "../packages/contracts/src/index.js";
import { searchContextHandler } from "../packages/core/src/tool/handlers/search-context.js";
import { createTestAgentRuntime } from "../packages/core/tests/test-agent-runtime.js";
import { createTestModelFactory } from "../packages/core/tests/test-runtime-model.js";
import { createTestSessionEventStore } from "../packages/core/tests/test-event-store.js";
import { archivePartText } from "../packages/adapters/src/native-context/archive-text.js";
import { resolvePluginSystemPrompts } from "../packages/adapters/src/plugins/system-prompts.js";
import { applyPluginSystemPrompts } from "../packages/core/src/runtime/methods/context.js";

async function fixture() {
  const store = await createSqliteSessionStore({ dbPath: ":memory:" }),
    sessionId = createSessionId();
  await store.createSession({
    id: sessionId,
    projectID: createProjectId(),
    directory: process.cwd(),
    slug: "review",
    title: "review",
    version: "1",
  });
  let time = 0;
  async function message(name: string, text: string) {
    const id = createMessageId(name);
    const record: any = {
      info: { id, sessionID: sessionId, role: "user", time: { created: ++time } },
      parts: [
        {
          id: createPartId(name + "-text"),
          messageID: id,
          sessionID: sessionId,
          type: "text",
          text,
        },
      ],
    };
    await store.commitMessageBundle!({ sessionID: sessionId, messages: [record] });
    return record;
  }
  async function fold(name: string, members: any[], children: string[] = [], level = 1) {
    const record = await message(name, "summary " + name);
    record.info.semantics = { kind: "compact_summary", providerVisibility: "visible" };
    const boundaryId = "boundary-" + name;
    record.parts.push({
      id: createPartId(name + "-fold"),
      messageID: record.info.id,
      sessionID: sessionId,
      type: "compaction",
      auto: false,
      compactBoundary: {
        boundaryId,
        trigger: CompactTrigger.Manual,
        summaryMessageIds: [record.info.id],
        summarizedMessageCount: members.length,
        preCompactTokenCount: 100,
        traceId: createTraceId(),
      },
      metadata: {
        hierarchy: {
          memberMessageIds: members.map((m) => m.info.id),
          childBoundaryIds: children,
          level,
          originalMessageCount: members.length,
        },
      },
    });
    await store.commitMessageBundle!({ sessionID: sessionId, messages: [record] });
    return { record, boundaryId };
  }
  function context() {
    return {
      sessionId,
      abortSignal: new AbortController().signal,
      sessionStore: store,
    } as any;
  }
  return { store, sessionId, message, fold, context };
}

describe("native context review regressions", () => {
  it("explicit older summary reports the boundary belonging to that selected summary", async () => {
    const f = await fixture();
    try {
      const raw = await f.message("raw", "original");
      const first = await f.fold("first", [raw]);
      await f.fold("second", [first.record], [first.boundaryId], 2);
      const output = await f.store.contextArchive.read({
        sessionId: f.sessionId,
        tier: "summary",
        messageIds: [first.record.info.id],
      });
      expect(output.content).toContain("summary first");
      expect(output.summaryMessageId).toBe(first.record.info.id);
      console.log(
        "selected boundary",
        JSON.stringify({
          requested: first.boundaryId,
          actual: output.boundaryId,
          ranges: output.ranges.map((r) => r.boundaryId),
        }),
      );
      expect(output.boundaryId).toBe(first.boundaryId);
      expect(output.ranges.map((r) => r.boundaryId)).toEqual([first.boundaryId]);
    } finally {
      f.store.close();
    }
  });
  it("native search retains legacy summary.body-only recall", async () => {
    const f = await fixture();
    try {
      const raw = await f.message("legacy-raw", "original");
      const node = await f.fold("legacy-node", [raw]);
      await f.store.removePart({
        sessionID: f.sessionId,
        messageID: node.record.info.id,
        partID: node.record.parts[0].id,
      });
      node.record.info.summary = { body: "LEGACY_BODY_ONLY_NEEDLE" };
      await f.store.saveMessage(node.record.info);
      const native: any = await searchContextHandler(
        { query: "LEGACY_BODY_ONLY_NEEDLE", scope: "summaries" },
        f.context(),
      );
      console.log("legacy parity", JSON.stringify({ native: native.status }));
      expect(native.status).toBe("success");
      const restored = await f.store.contextArchive.read({
        sessionId: f.sessionId,
        tier: "summary",
        boundaryId: node.boundaryId,
      });
      expect(restored.content).toContain("LEGACY_BODY_ONLY_NEEDLE");
    } finally {
      f.store.close();
    }
  });
  it("native search retains the existing CJK partial-keyword recall", async () => {
    const f = await fixture();
    try {
      await f.message("cjk", "配置放在工作目录下，路径由用户设置。");
      const native: any = await searchContextHandler({ query: "项目配置路径" }, f.context());
      console.log("CJK parity", JSON.stringify({ native: native.status }));
      expect(native.status).toBe("success");
    } finally {
      f.store.close();
    }
  });
  it("fold ancestry preserves dropped originals after a prompt-too-long retry", async () => {
    const store = await createSqliteSessionStore({ dbPath: ":memory:" }),
      sessionId = createSessionId();
    let summaries = 0;
    const modelFactory = createTestModelFactory({
      generateText: async (request: any) => {
        if (String(request.messages.at(-1)?.content).includes("create a detailed summary")) {
          if (++summaries === 1)
            throw createCoreError(
              CoreErrorType.ModelContextExceeded,
              "prompt is too long: 160 tokens > 120 maximum",
              { recoverable: true },
            );
          return {
            text: "<summary>RECENT SUMMARY</summary>",
            finishReason: "stop",
            usage: { inputTokens: 60, outputTokens: 10, totalTokens: 70 },
          };
        }
        return {
          text: "normal response",
          finishReason: "stop",
          usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
        };
      },
    });
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        workingDirectory: process.cwd(),
        systemPrompt: "PTL audit",
        compact: { enabled: false },
        subagents: { enabled: false },
      },
      { modelFactory, sessionStore: store, eventStore: createTestSessionEventStore() },
    );
    try {
      await runtime.executeTurn("FIRST_ORIGINAL_MUST_REMAIN");
      await runtime.executeTurn("SECOND_ORIGINAL_MUST_REMAIN");
      await (runtime as any).compactActiveConversation(
        undefined,
        createRootTraceContext({ sessionId }),
        [],
        { trigger: CompactTrigger.Manual },
      );
      const result = await store.contextArchive.read({
        sessionId,
        tier: "original",
        maxChars: 80_000,
      });
      const located = await store.contextArchive.search({
        sessionId,
        query: "FIRST_ORIGINAL_MUST_REMAIN",
        role: "any",
        scope: "messages",
        includeFolded: true,
        maxResults: 8,
      });
      console.log(
        "PTL originals",
        JSON.stringify({
          summaries,
          content: result.content,
          earliestSearch: located.matches.map((m) => ({ id: m.messageId, folded: m.folded })),
        }),
      );
      expect(located.matches[0]?.folded).toBe(true);
      expect(summaries).toBe(2);
      expect(result.content).toContain("FIRST_ORIGINAL_MUST_REMAIN");
      expect(result.content).toContain("SECOND_ORIGINAL_MUST_REMAIN");
    } finally {
      store.close();
    }
  });
  it("measures the number of full part bodies processed for one small original page", async () => {
    const f = await fixture();
    try {
      const members = [];
      for (let i = 0; i < 300; i++)
        members.push(await f.message("scan-" + i, "body " + i + " " + "x".repeat(1_000)));
      const node = await f.fold("scan-node", members);
      let calls = 0,
        bytes = 0;
      (f.store as any).db.function(
        "zcode_context_text",
        { deterministic: true },
        (data: string) => {
          calls++;
          bytes += data.length;
          return archivePartText(data);
        },
      );
      const output = await f.store.contextArchive.read({
        sessionId: f.sessionId,
        tier: "original",
        boundaryId: node.boundaryId,
        maxChars: 100,
      });
      console.log(
        "page IO",
        JSON.stringify({
          calls,
          bytes,
          returned: output.content.length,
          hasNext: !!output.nextCursor,
        }),
      );
      expect(output.status).toBe("success");
      expect(calls).toBeLessThanOrEqual(32);
    } finally {
      f.store.close();
    }
  });
  it("does not attach an unrelated compaction boundary to an explicit raw message", async () => {
    const f = await fixture();
    try {
      const raw = await f.message("folded", "folded original");
      await f.fold("unrelated", [raw]);
      const outside = await f.message("outside", "not part of any fold");
      const output = await f.store.contextArchive.read({
        sessionId: f.sessionId,
        tier: "original",
        messageIds: [outside.info.id],
      });
      console.log(
        "unrelated metadata",
        JSON.stringify({
          boundary: output.boundaryId,
          ranges: output.ranges.map((r) => r.boundaryId),
          content: output.content,
        }),
      );
      expect(output.boundaryId).toBeUndefined();
      expect(output.ranges).toEqual([]);
    } finally {
      f.store.close();
    }
  });
  it("measures plugin prompt request bytes versus the declared content budget", () => {
    const diagnostics: any[] = [],
      captured: any[] = [];
    const resolved = resolvePluginSystemPrompts({
      loaded: {
        id: "review@inline",
        manifest: {
          systemPrompts: Array.from({ length: 3000 }, (_, i) => ({
            name: "n".repeat(120) + i,
            content: "p" + i,
          })),
        },
      } as any,
      diagnostics,
      remainingBudgetBytes: 64 * 1024,
    });
    applyPluginSystemPrompts(
      { addSection: (s: any) => captured.push(s) } as any,
      resolved.sections,
    );
    const requestBytes = captured.reduce((sum, s) => sum + Buffer.byteLength(s.content), 0);
    console.log(
      "plugin prompt budget",
      JSON.stringify({
        sections: resolved.sections.length,
        injectedBytes: resolved.bytes,
        requestBytes,
        diagnostics: diagnostics.length,
      }),
    );
    expect(resolved.sections.length).toBeGreaterThan(0);
    expect(resolved.sections.length).toBeLessThanOrEqual(64);
    expect(requestBytes).toBeLessThanOrEqual(64 * 1024);
    expect(diagnostics.some((d) => d.code === "plugin_system_prompt_budget_exceeded")).toBe(true);
  });

  it("continues through non-readable parts without rescanning prior pages", async () => {
    const f = await fixture();
    try {
      const raw = await f.message("sparse", "FIRST");
      for (let index = 0; index < 96; index++)
        await f.store.savePart({
          id: createPartId("ignored-" + index),
          sessionID: f.sessionId,
          messageID: raw.info.id,
          type: "text",
          text: "ignored ".repeat(1000),
          ignored: true,
        });
      await f.store.savePart({
        id: createPartId("last-part"),
        sessionID: f.sessionId,
        messageID: raw.info.id,
        type: "text",
        text: "LAST",
      });
      let cursor: string | undefined,
        content = "",
        pages = 0,
        calls = 0;
      (f.store as any).db.function(
        "zcode_context_text",
        { deterministic: true },
        (data: string) => {
          calls++;
          return archivePartText(data);
        },
      );
      do {
        calls = 0;
        const page = await f.store.contextArchive.read({
          sessionId: f.sessionId,
          tier: "original",
          messageIds: [raw.info.id],
          cursor,
        });
        expect(calls).toBeLessThanOrEqual(32);
        if (page.nextCursor) expect(page.status).toBe("success");
        for (const segment of page.segments ?? [])
          content += page.content.slice(segment.start, segment.start + segment.length);
        expect(page.nextCursor).not.toBe(cursor ?? "");
        cursor = page.nextCursor;
        pages++;
        expect(pages).toBeLessThan(6);
      } while (cursor);
      expect(content).toBe("FIRSTLAST");
      expect(pages).toBe(4);
    } finally {
      f.store.close();
    }
  });

  it("pages an old summary body exactly and reports metadata only for selected nodes", async () => {
    const f = await fixture();
    try {
      const raw = await f.message("body-raw", "original"),
        node = await f.fold("body-node", [raw]);
      await f.store.removePart({
        sessionID: f.sessionId,
        messageID: node.record.info.id,
        partID: node.record.parts[0].id,
      });
      const body = "旧摘要😀\u0000".repeat(20);
      node.record.info.summary = { body };
      await f.store.saveMessage(node.record.info);
      const other = await f.fold("other-node", [raw]);
      let cursor: string | undefined,
        content = "";
      do {
        const page = await f.store.contextArchive.read({
          sessionId: f.sessionId,
          tier: "summary",
          messageIds: [node.record.info.id],
          maxChars: 7,
          cursor,
        });
        expect(page.boundaryId).toBe(node.boundaryId);
        expect(page.ranges.map((r) => r.boundaryId)).toEqual([node.boundaryId]);
        for (const segment of page.segments ?? [])
          content += page.content.slice(segment.start, segment.start + segment.length);
        cursor = page.nextCursor;
      } while (cursor);
      expect(content).toBe(body);
      const multi = await f.store.contextArchive.read({
        sessionId: f.sessionId,
        tier: "summary",
        messageIds: [node.record.info.id, other.record.info.id],
      });
      expect(multi.boundaryId).toBeUndefined();
      expect(multi.ranges.map((r) => r.boundaryId)).toEqual([node.boundaryId, other.boundaryId]);
    } finally {
      f.store.close();
    }
  });
});
