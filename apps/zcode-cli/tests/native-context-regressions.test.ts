import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { planCompactRanges } from "../packages/core/src/runtime/methods/compact-active-ranges.js";
import type { AgentRuntimeInternal } from "../packages/core/src/runtime/internal.js";

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
  it("retains conversation and assistant anchors when reopening immediately after a ranges fold", async () => {
    const f = await fixture();
    const modelFactory = createTestModelFactory({
      async generateText() {
        return { text: "synthetic answer", finishReason: "stop", usage: { totalTokens: 2 } };
      },
    });
    const makeRuntime = () =>
      createTestAgentRuntime(
        f.sessionId,
        { workingDirectory: process.cwd(), systemPrompt: "Synthetic review.", modelStreaming: "off", compact: { enabled: false } },
        { sessionStore: f.store, eventStore: createTestSessionEventStore(), modelFactory },
      );
    try {
      const runtime = makeRuntime();
      const live = runtime as unknown as AgentRuntimeInternal;
      for (const text of ["SYNTHETIC_ORIGINAL ".repeat(400), "second turn", "third turn"])
        await runtime.executeTurn(text);
      const first = live.messageHistory.borrowReadOnlyRuntimeEntries().find(
        (entry) => entry.kind !== "attachment" && entry.message.role === "user" && entry.messageId,
      )!;
      const before = {
        conversation: live.latestConversationMessageId,
        assistant: live.latestAssistantMessageId,
        turn: live.latestAssistantTurnId,
      };
      const result = await live.compactActiveConversation(undefined, createRootTraceContext({ sessionId: f.sessionId }), [], {
        trigger: CompactTrigger.Auto,
        ranges: [{ startMessageId: first.messageId!, endMessageId: first.messageId!, summary: "Concise synthetic summary" }],
      });
      expect(result.outcome).toBe("compacted");
      const recovered = makeRuntime();
      await recovered.resumeFromStore();
      const cold = recovered as unknown as AgentRuntimeInternal;
      expect(live.latestConversationMessageId).toBe(before.conversation);
      expect(cold.latestConversationMessageId).toBe(before.conversation);
      expect(cold.latestAssistantMessageId).toBe(before.assistant);
      expect(cold.latestAssistantTurnId).toBe(before.turn);
    } finally {
      f.store.close();
    }
  });

  for (const failurePoint of ["post_compact_hook", "committed_apply"] as const)
    it(`preserves the stop marker through committed-state replay after ${failurePoint} cancellation`, async () => {
      const f = await fixture();
      let selectedId = "", trigger = false, submitted = false;
      const requests: string[] = [];
      const modelFactory = createTestModelFactory({
        async generateText(request) {
          requests.push(JSON.stringify(request.messages));
          if (trigger && !submitted) {
            submitted = true;
            return {
              text: "", finishReason: "tool-calls", usage: { totalTokens: 2 },
              toolCalls: [{ id: "review-cancel-fold", name: "CompactNow", input: {
                ranges: [{ startMessageId: selectedId, endMessageId: selectedId, summary: "REVIEW_COMMITTED_SUMMARY" }],
              } }],
            };
          }
          return { text: "synthetic answer", finishReason: "stop", usage: { totalTokens: 2 } };
        },
      });
      const makeRuntime = () => createTestAgentRuntime(f.sessionId, {
        workingDirectory: process.cwd(), systemPrompt: "Synthetic review.", modelStreaming: "off",
        compact: { enabled: false }, toolAllowlist: ["CompactNow"],
      }, { sessionStore: f.store, eventStore: createTestSessionEventStore(), modelFactory });
      try {
        const runtime = makeRuntime(), live = runtime as unknown as AgentRuntimeInternal;
        await runtime.executeTurn("REVIEW_OLD_ORIGINAL ".repeat(400));
        await runtime.executeTurn("second synthetic turn");
        selectedId = live.messageHistory.borrowReadOnlyRuntimeEntries().find(
          (entry) => entry.kind !== "attachment" && entry.message.role === "user" && entry.messageId,
        )!.messageId!;
        const abort = new AbortController();
        const originalHook = live.runPostCompactHooks;
        if (failurePoint === "post_compact_hook") {
          live.runPostCompactHooks = async () => {
            abort.abort();
            abort.signal.throwIfAborted();
            throw new Error("unreachable");
          };
        } else {
          const commit = f.store.commitMessageBundle!.bind(f.store);
          f.store.commitMessageBundle = async (input) => {
            await commit(input);
            if (input.messages.some((message) => message.parts.some((part) => part.type === "compaction" && part.compactBoundary)))
              abort.abort();
          };
          const replace = live.messageHistory.replaceMessages.bind(live.messageHistory);
          let failOnce = true;
          live.messageHistory.replaceMessages = (entries) => {
            if (failOnce && JSON.stringify(entries).includes("REVIEW_COMMITTED_SUMMARY")) {
              failOnce = false;
              throw new Error("synthetic committed apply failure");
            }
            replace(entries);
          };
        }
        trigger = true;
        await expect(runtime.executeTurn("trigger compact", undefined, { abortSignal: abort.signal }))
          .rejects.toMatchObject({ type: CoreErrorType.TurnCancelled });
        expect(live.pendingCommittedCompactApply).toBeDefined();
        const markers = () => live.messageHistory.borrowReadOnlyRuntimeEntries().filter(
          (entry) => entry.metadata?.source === "interrupt_marker",
        );
        expect(markers()).toHaveLength(1);
        const markerId = markers()[0]!.messageId;
        live.runPostCompactHooks = originalHook;
        await runtime.executeTurn("continue after stopping");
        expect(requests.at(-1)).toContain("[Request interrupted by user]");
        expect(requests.at(-1)).toContain("REVIEW_COMMITTED_SUMMARY");
        expect(requests.at(-1)).not.toContain("REVIEW_OLD_ORIGINAL");
        expect(markers().map((entry) => entry.messageId)).toEqual([markerId]);
        const recovered = makeRuntime();
        await recovered.resumeFromStore();
        expect((recovered as unknown as AgentRuntimeInternal).messageHistory.borrowReadOnlyRuntimeEntries()
          .filter((entry) => entry.metadata?.source === "interrupt_marker")
          .map((entry) => entry.messageId)).toEqual([markerId]);
      } finally {
        f.store.close();
      }
    });

  it("recovers CompactNow ranges after real todo reminder persistence and a cold SQLite reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "todo-range-resume-"));
    const dbPath = join(directory, "session.sqlite"),
      sessionId = createSessionId();
    let store = await createSqliteSessionStore({ dbPath });
    const requests: string[] = [];
    let range: { startMessageId: string; endMessageId: string } | undefined,
      submitted = false;
    const marker = "ORIGINAL_HISTORY_BEFORE_TODO_";
    const summary = "TODO_RANGE_SUMMARY_KEEP_USER_CONSTRAINT";
    const factory = createTestModelFactory({
      async generateText(request) {
        const content = request.messages
          .map((message) =>
            typeof message.content === "string" ? message.content : JSON.stringify(message.content),
          )
          .join("\n");
        requests.push(content);
        if (range && !submitted) {
          submitted = true;
          return {
            text: "",
            finishReason: "tool-calls",
            usage: { totalTokens: 2 },
            toolCalls: [
              {
                id: "todo-range-call",
                name: "CompactNow",
                input: { ranges: [{ ...range, summary }] },
              },
            ],
          };
        }
        return {
          text: "completed synthetic step",
          finishReason: "stop",
          usage: { totalTokens: 2 },
        };
      },
    });
    const makeRuntime = () =>
      createTestAgentRuntime(
        sessionId,
        {
          workingDirectory: directory,
          modelStreaming: "off",
          compact: { enabled: false },
          toolAllowlist: ["CompactNow", "TodoWrite"],
          systemPrompt: "Preserve the user's constraints.",
        },
        { sessionStore: store, eventStore: createTestSessionEventStore(), modelFactory: factory },
      );
    try {
      await store.createSession({
        id: sessionId,
        projectID: createProjectId(),
        directory,
        slug: "todo-range",
        title: "synthetic cold recovery",
        version: "source",
      });
      const runtime = makeRuntime();
      for (let index = 0; index < 12; index++)
        await runtime.executeTurn(index === 0 ? marker.repeat(1000) : `completed request ${index}`);
      const internal = runtime as unknown as AgentRuntimeInternal;
      const persisted = await store.messages({ sessionID: sessionId });
      const reminder = persisted.find(
        (message) => message.info.semantics?.kind === "todo_reminder",
      );
      expect(reminder).toBeDefined();
      const entries = internal.messageHistory.borrowReadOnlyRuntimeEntries();
      expect(
        entries.some(
          (entry) => entry.kind === "attachment" && entry.metadata.source === "todo_reminder",
        ),
      ).toBe(true);
      const users = entries.filter(
        (entry) =>
          entry.kind !== "attachment" &&
          entry.message.role === "user" &&
          entry.metadata?.source === "real_user",
      );
      const first = users[0]!,
        last = users.at(-1)!;
      if (first.kind === "attachment" || last.kind === "attachment")
        throw new Error("missing user endpoints");
      const plan = planCompactRanges(entries, [
        { startMessageId: first.messageId!, endMessageId: last.messageId! },
      ]);
      if (!plan.ok) throw new Error(plan.message);
      range = {
        startMessageId: plan.ranges[0]!.startMessageId,
        endMessageId: plan.ranges[0]!.endMessageId,
      };
      await runtime.executeTurn("fold consumed work now");
      expect(submitted).toBe(true);
      const records = await store.messages({ sessionID: sessionId });
      const folded = records.find((message) =>
        message.parts.some(
          (part) => part.type === "compaction" && part.metadata?.compactFormat === "ranges-v1",
        ),
      );
      expect(folded).toBeDefined();
      const part = folded!.parts.find((part) => part.type === "compaction")!;
      if (part.type !== "compaction") throw new Error("missing compact record");
      expect(part.metadata?.hierarchy?.memberMessageIds).not.toContain(reminder!.info.id);
      const liveIds = internal.messageHistory
        .borrowReadOnlyRuntimeEntries()
        .flatMap((entry) =>
          entry.kind !== "attachment" && entry.messageId ? [entry.messageId] : [],
        );
      store.close();
      store = await createSqliteSessionStore({ dbPath });
      const recovered = makeRuntime();
      await recovered.resumeFromStore();
      const coldIds = (recovered as unknown as AgentRuntimeInternal).messageHistory
        .borrowReadOnlyRuntimeEntries()
        .flatMap((entry) =>
          entry.kind !== "attachment" && entry.messageId ? [entry.messageId] : [],
        );
      expect(coldIds).toEqual(liveIds);
      await recovered.executeTurn("continue after restarting");
      expect(requests.at(-1)).toContain(summary);
      expect(requests.at(-1)).not.toContain(marker);
      const original = await store.contextArchive.read({
        sessionId,
        tier: "original",
        messageIds: [first.messageId!],
        maxChars: 40000,
      });
      expect(original.content).toContain(marker.repeat(1000));
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
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
