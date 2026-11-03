import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  CompactTrigger,
  createRootTraceContext,
  createSessionId,
  type ModelRequest,
} from "../packages/contracts/src/index.js";
import { createSqliteSessionStore } from "../packages/adapters/src/storage/index.js";
import { createTestAgentRuntime } from "../packages/core/tests/test-agent-runtime.js";
import { createTestModelFactory } from "../packages/core/tests/test-runtime-model.js";
import { createTestSessionEventStore } from "../packages/core/tests/test-event-store.js";
import type { AgentRuntimeInternal } from "../packages/core/src/runtime/internal.js";
import { estimateRuntimeEntryTokens } from "../packages/core/src/runtime/helpers/compact-selection.js";

/** 合成 provider 只验证请求、计量和存储链；不把固定摘要当成真实模型质量或服务端缓存命中证据。 */
describe("native context sustained lifecycle", () => {
  it("runs 48 recursive compactions with restart, exact recall, stable prefix and usage conservation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-context-soak-"));
    const dbPath = join(directory, "session.sqlite"),
      sessionId = createSessionId();
    let store = await createSqliteSessionStore({ dbPath });
    let summaries = 0;
    const requests: ModelRequest[] = [],
      latency: number[] = [],
      activeTokens: number[] = [];
    const modelFactory = createTestModelFactory({
      generateText: async (request) => {
        const isSummary = String(request.messages.at(-1)?.content).includes(
          "create a detailed summary",
        );
        if (isSummary) {
          summaries++;
          return {
            text: `<summary>ARCHIVE-NODE-${summaries}: retrieve exact facts through SearchContext and DecompressContext.</summary>`,
            finishReason: "stop",
            usage: { inputTokens: 500, cacheReadTokens: 400, outputTokens: 16, totalTokens: 516 },
          };
        }
        requests.push(structuredClone(request));
        return {
          text: "acknowledged",
          finishReason: "stop",
          usage: { inputTokens: 100, outputTokens: 2, totalTokens: 102 },
        };
      },
    });
    const makeRuntime = () =>
      createTestAgentRuntime(
        sessionId,
        {
          workingDirectory: directory,
          systemPrompt: "Stable native context soak prefix.",
          compact: { enabled: false },
        },
        { modelFactory, sessionStore: store, eventStore: createTestSessionEventStore() },
      );
    let runtime = makeRuntime(),
      internal = runtime as unknown as AgentRuntimeInternal;
    const facts: { id: string; text: string }[] = [];
    const started = performance.now();
    try {
      await runtime.executeTurn("KEEP-PREFIX " + "stable prefix ".repeat(300));
      let previousBoundary: string | undefined;
      let stablePrefix: string | undefined;
      for (let generation = 1; generation <= 48; generation++) {
        const text = `FACT-${generation}-EXACT-${generation * 7919}: 原文😀`;
        await runtime.executeTurn(text);
        const entries = internal.messageHistory.borrowReadOnlyRuntimeEntries();
        const raw = entries.findLast(
          (entry) =>
            entry.kind !== "attachment" &&
            entry.message.role === "user" &&
            !entry.metadata?.compactBoundary &&
            String(entry.message.content).includes(text),
        );
        expect(raw?.messageId).toBeTruthy();
        facts.push({ id: raw!.messageId!, text });
        const summary = entries.find((entry) => entry.metadata?.compactBoundary);
        const id = summary?.messageId ?? raw!.messageId!;
        const before = performance.now();
        const result = await internal.compactActiveConversation(
          undefined,
          createRootTraceContext({ sessionId }),
          [],
          {
            trigger: CompactTrigger.Manual,
            ranges: [{ startMessageId: id, endMessageId: raw!.messageId! }],
          },
        );
        latency.push(performance.now() - before);
        expect(result.outcome).toBe("compacted");
        const active = internal.messageHistory.borrowReadOnlyRuntimeEntries();
        activeTokens.push(estimateRuntimeEntryTokens(active));
        const node = active.find((entry) => entry.metadata?.compactBoundary);
        expect(node?.metadata?.compactHierarchy?.level).toBe(generation);
        if (previousBoundary)
          expect(node?.metadata?.compactHierarchy?.childBoundaryIds).toContain(previousBoundary);
        previousBoundary = node!.metadata!.compactBoundary!.boundaryId;
        await runtime.executeTurn(`probe generation ${generation}`);
        const request = requests.at(-1)!;
        const prefix = JSON.stringify(
          request.messages.slice(
            0,
            request.messages.findIndex((message) =>
              String(message.content).includes("ARCHIVE-NODE-"),
            ),
          ),
        );
        if (stablePrefix === undefined) stablePrefix = prefix;
        else {
          if (prefix !== stablePrefix) {
            let at = 0;
            while (at < prefix.length && prefix[at] === stablePrefix[at]) at++;
            throw new Error(
              `Prefix changed at generation ${generation}, char ${at}: ${stablePrefix.slice(Math.max(0, at - 100), at + 300)} => ${prefix.slice(Math.max(0, at - 100), at + 300)}`,
            );
          }
          expect(prefix).toBe(stablePrefix);
        }
        let cursor: string | undefined,
          original = "";
        do {
          const page = await store.contextArchive.read({
            sessionId,
            tier: "original",
            boundaryId: previousBoundary,
            maxChars: 80_000,
            cursor,
          });
          original += page.content;
          cursor = page.nextCursor;
        } while (cursor);
        expect(original).toContain(facts[0]!.text);
        expect(original).toContain(text);
        if (generation % 8 === 0) {
          store.close();
          store = await createSqliteSessionStore({ dbPath });
          runtime = makeRuntime();
          await runtime.resumeFromStore();
          internal = runtime as unknown as AgentRuntimeInternal;
          expect(
            internal.messageHistory
              .borrowReadOnlyRuntimeEntries()
              .find((entry) => entry.metadata?.compactBoundary)?.metadata?.compactHierarchy?.level,
          ).toBe(generation);
        }
      }
      for (const fact of facts) {
        const found = await store.contextArchive.search({
          sessionId,
          query: fact.text,
          role: "any",
          scope: "messages",
          includeFolded: true,
          maxResults: 2,
        });
        expect(found.matches.some((match) => match.messageId === fact.id && match.folded)).toBe(
          true,
        );
      }
      const ranges = [];
      let statusCursor: string | undefined;
      do {
        const status = await store.contextArchive.status({
          sessionId,
          maxRanges: 100,
          cursor: statusCursor,
        });
        ranges.push(...status.ranges);
        statusCursor = status.nextCursor;
      } while (statusCursor);
      expect(ranges).toHaveLength(48);
      expect(summaries).toBe(48);
      expect(Math.max(...activeTokens)).toBeLessThan(activeTokens[0]! + 1_000);
      const usage = ranges.reduce(
        (sum, range) => ({
          input: sum.input + (range.cacheUsage?.inputTokens ?? 0),
          cacheRead: sum.cacheRead + (range.cacheUsage?.cacheReadTokens ?? 0),
          output: sum.output + (range.cacheUsage?.outputTokens ?? 0),
        }),
        { input: 0, cacheRead: 0, output: 0 },
      );
      expect(usage).toEqual({ input: 24_000, cacheRead: 19_200, output: 768 });
      const report = {
        kind: "synthetic-provider",
        generations: 48,
        restarts: 6,
        exactRecall: "48/48",
        stablePrefixChecks: 47,
        summaryCalls: summaries,
        recordedSummaryUsage: usage,
        activeTokensFirst: activeTokens[0],
        activeTokensMax: Math.max(...activeTokens),
        activeTokensLast: activeTokens.at(-1),
        elapsedMs: performance.now() - started,
        compactLatencyMaxMs: Math.max(...latency),
        compactLatencyAverageMs: latency.reduce((a, b) => a + b, 0) / latency.length,
        limits:
          "Synthetic usage validates accounting only; real provider cache hits, monetary cost and summary quality require upstream measurements.",
      };
      if (process.env.ZCODE_CONTEXT_SOAK_REPORT)
        await writeFile(process.env.ZCODE_CONTEXT_SOAK_REPORT, JSON.stringify(report, null, 2));
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 90_000);

  it("retains more than four prefix summaries within a token budget and merges older layers on pressure", async () => {
    const store = await createSqliteSessionStore({ dbPath: ":memory:" }),
      sessionId = createSessionId();
    let calls = 0;
    const modelFactory = createTestModelFactory({
      generateText: async (request) => {
        if (String(request.messages.at(-1)?.content).includes("create a detailed summary")) {
          calls++;
          return {
            text: `<summary>PREFIX-SUMMARY-${calls} ${"decision archive reference ".repeat(25)}</summary>`,
            finishReason: "stop",
            usage: { totalTokens: 10 },
          };
        }
        return { text: "response", finishReason: "stop", usage: { totalTokens: 2 } };
      },
    });
    const make = () =>
      createTestAgentRuntime(
        sessionId,
        {
          workingDirectory: process.cwd(),
          systemPrompt: "prefix soak",
          compact: { enabled: false },
        },
        { modelFactory, sessionStore: store, eventStore: createTestSessionEventStore() },
      );
    let runtime = make(),
      maxRetained = 0;
    try {
      for (let cycle = 0; cycle < 18; cycle++) {
        for (let turn = 0; turn < 3; turn++)
          await runtime.executeTurn(`prefix fact ${cycle}/${turn}`);
        const internal = runtime as unknown as AgentRuntimeInternal;
        const result = await internal.compactActiveConversation(
          undefined,
          createRootTraceContext({ sessionId }),
          [],
          { trigger: CompactTrigger.Manual },
        );
        expect(result.outcome).toBe("compacted");
        const nodes = internal.messageHistory
          .borrowReadOnlyRuntimeEntries()
          .filter((entry) => entry.metadata?.compactBoundary);
        maxRetained = Math.max(maxRetained, nodes.length);
        const before = nodes.map((entry) => [entry.messageId, entry.metadata?.compactHierarchy]);
        runtime = make();
        await runtime.resumeFromStore();
        const after = (runtime as unknown as AgentRuntimeInternal).messageHistory
          .borrowReadOnlyRuntimeEntries()
          .filter((entry) => entry.metadata?.compactBoundary)
          .map((entry) => [entry.messageId, entry.metadata?.compactHierarchy]);
        expect(after).toEqual(before);
      }
      expect(calls).toBe(18);
      expect(maxRetained).toBeGreaterThan(4);
      const status = await store.contextArchive.status({ sessionId });
      expect(status.ranges.some((range) => (range.level ?? 1) > 1)).toBe(true);
      const found = await store.contextArchive.search({
        sessionId,
        query: "prefix fact 0/0",
        role: "any",
        scope: "messages",
        includeFolded: true,
        maxResults: 8,
      });
      expect(
        found.matches.some((match) => match.snippet.includes("prefix fact 0/0") && match.folded),
      ).toBe(true);
    } finally {
      store.close();
    }
  }, 60_000);
});
