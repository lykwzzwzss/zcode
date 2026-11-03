import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CoreErrorType,
  HookEventName,
  SessionEventType,
  createRootTraceContext,
  createSessionId,
  createProjectId,
  createMessageId,
  createPartId,
  createTraceId,
  createToolCallId,
  CompactTrigger,
  DecompressContextInputJsonSchema,
  DecompressContextInputSchema,
  toolResultDisplayPayloadSchema,
  parseCompletedToolPartMetadata,
  type DecompressContextOutput,
  type Model,
  type ModelSelection,
  type SessionEvent,
  type SessionStorePort,
  type MessageWithParts,
} from "@zcode/contracts";
import {
  decompressContextHandler,
  decompressContextToolEntry,
} from "../src/tool/handlers/decompress-context.js";
import {
  searchContextHandler,
  searchContextToolEntry,
} from "../src/tool/handlers/search-context.js";
import {
  compactStatusHandler,
  compactStatusToolEntry,
} from "../src/tool/handlers/compact-status.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import {
  capCompactSummaryMaxOutputTokens,
  resolveCompactSummaryModel,
  type CompactSummaryModelFallbackReason,
} from "../src/runtime/methods/compact-active.js";
import { MAX_OUTPUT_TOKENS_FOR_SUMMARY } from "../src/compact/policy.js";
import type { ToolExecutionContext } from "../src/tool/types.js";
import { createToolResultDisplay } from "../src/tool/executor/result-display.js";
import {
  toolOutputSchema,
  toolCallDisplaySchema,
} from "../../../../../packages/shared/src/zcode-protocol-v4/toolDisplay.js";
import { buildToolOutput } from "../../bootstrap/src/zcode-protocol-v4/projection-rows.js";
import { createSqliteSessionStore } from "../../adapters/src/storage/index.js";

describe("native context display projection", () => {
  it("preserves every node while following real archive cursors for large pages", async () => {
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    const sessionId = createSessionId();
    try {
      await store.createSession({
        id: sessionId,
        projectID: createProjectId(),
        directory: process.cwd(),
        slug: "display",
        title: "display",
        version: "1",
      });
      const records: MessageWithParts[] = Array.from({ length: 201 }, (_, index) => {
        const messageID = createMessageId(`m${index}`);
        return {
          info: { id: messageID, sessionID: sessionId, role: "user", time: { created: index + 1 } },
          parts: [
            {
              id: createPartId(`p${index}`),
              messageID,
              sessionID: sessionId,
              type: "compaction",
              auto: false,
              compactBoundary: {
                boundaryId: `b${index}`,
                trigger: CompactTrigger.Manual,
                summarizedMessageCount: 1,
                summaryMessageIds: [messageID],
                traceId: createTraceId(),
              },
              metadata: {
                hierarchy: {
                  memberMessageIds: [],
                  childBoundaryIds: [],
                  level: 1,
                  originalMessageCount: 1,
                },
                cacheUsage: { outputTokens: index },
              },
            },
          ],
        } as MessageWithParts;
      });
      await store.commitMessageBundle!({ sessionID: sessionId, messages: records });
      for (const maxRanges of [60, 200]) {
        let cursor: string | undefined;
        const received: string[] = [];
        do {
          const page = await store.contextArchive.status({ sessionId, maxRanges, cursor });
          if (!cursor) expect(page.ranges.length).toBeGreaterThan(40);
          const display = createToolResultDisplay("CompactStatus", page);
          if (display?.kind !== "native_context") throw new Error("missing native display");
          expect(display.output.nextCursor).toBe(page.nextCursor);
          expect(
            display.output.ranges?.map((range) => [
              range.boundaryId,
              range.cacheUsage?.outputTokens,
            ]),
          ).toEqual(page.ranges.map((range) => [range.boundaryId, range.cacheUsage?.outputTokens]));
          received.push(...(display.output.ranges ?? []).map((range) => range.boundaryId));
          cursor = page.nextCursor;
        } while (cursor);
        expect(received).toEqual(Array.from({ length: 201 }, (_, index) => `b${200 - index}`));
      }
    } finally {
      store.close();
    }
  });

  it.each([60, 200])("keeps all %i CompactStatus nodes before its next cursor", (pageSize) => {
    const ranges = Array.from({ length: pageSize + 1 }, (_, index) => ({
      boundaryId: `b${index}`,
      messageId: `m${index}`,
      createdAt: 1,
      summarizedMessageCount: 1,
      cacheUsage: { outputTokens: index },
    }));
    const firstPage = ranges.slice(0, pageSize);
    // 样本与实际归档页的字节预算相容，包含逐节点用量；第 201 条属于后续页。
    expect(Buffer.byteLength(JSON.stringify(firstPage))).toBeLessThanOrEqual(26_000);
    const makeOutput = (page: typeof ranges, nextCursor?: string) => ({
      status: "success",
      sessionId: "s",
      messageCount: 201,
      activeMessageCount: 1,
      foldedMessageCount: 200,
      ranges: page,
      nextCursor,
    });
    const cursor = `after-${pageSize}`;
    const display = createToolResultDisplay("CompactStatus", makeOutput(firstPage, cursor));
    if (display?.kind !== "native_context") throw new Error("missing native display");
    expect(toolResultDisplayPayloadSchema.parse(display)).toEqual(display);
    expect(toolCallDisplaySchema.parse(display)).toEqual(display);
    expect(parseCompletedToolPartMetadata({ schemaVersion: 1, display })?.display).toEqual(display);
    expect(
      toolOutputSchema.parse(buildToolOutput({ success: true, content: "status", display }, "call"))
        .display,
    ).toEqual(display);
    expect(display.output.nextCursor).toBe(cursor);
    expect(display.output.displayTruncated).toBe(false);
    expect(
      display.output.ranges?.map((range) => [range.boundaryId, range.cacheUsage?.outputTokens]),
    ).toEqual(firstPage.map((range) => [range.boundaryId, range.cacheUsage.outputTokens]));
    // 继续使用归档游标从同一页末尾读取，展示序列不得缺失或重复。
    const next = createToolResultDisplay("CompactStatus", makeOutput(ranges.slice(pageSize)));
    if (next?.kind !== "native_context") throw new Error("missing continuation display");
    expect(
      [...(display.output.ranges ?? []), ...(next.output.ranges ?? [])].map(
        (range) => range.boundaryId,
      ),
    ).toEqual(ranges.map((range) => range.boundaryId));
  });

  it("carries bounded structured results through both protocol schemas and the v4 output", () => {
    const examples = [
      ["CompactNow", { status: "accepted", message: "queued" }],
      [
        "CompactStatus",
        {
          status: "success",
          sessionId: "s",
          messageCount: 2,
          activeMessageCount: 1,
          foldedMessageCount: 1,
          nextCursor: "next",
          ranges: [
            {
              boundaryId: "b",
              messageId: "m",
              createdAt: 1,
              summarizedMessageCount: 1,
              level: 2,
              preCompactTokenCount: 100,
              postCompactTokenCount: 50,
              cacheUsage: { inputTokens: 12, cacheReadTokens: 8, outputTokens: 3 },
            },
          ],
        },
      ],
      [
        "SearchContext",
        {
          status: "success",
          sessionId: "s",
          query: "needle",
          searchedMessageCount: 2,
          foldedMessageCount: 1,
          truncated: false,
          nextCursor: "search-next",
          matches: [
            {
              messageId: "m",
              role: "user",
              createdAt: 1,
              folded: true,
              score: 1,
              snippet: "needle",
            },
          ],
        },
      ],
      [
        "DecompressContext",
        {
          status: "success",
          sessionId: "s",
          messageCount: 1,
          content: "x".repeat(20_000),
          truncated: false,
          filePath: "page.txt",
          bytesWritten: 12,
          nextCursor: "page-next",
          ranges: [],
        },
      ],
    ] as const;
    for (const [name, output] of examples) {
      const display = createToolResultDisplay(name, output);
      expect(display?.kind).toBe("native_context");
      expect(toolResultDisplayPayloadSchema.parse(display)).toEqual(display);
      expect(toolCallDisplaySchema.parse(display)).toEqual(display);
      expect(parseCompletedToolPartMetadata({ schemaVersion: 1, display })?.display).toEqual(
        display,
      );
      const rowOutput = buildToolOutput({ success: true, content: "model text", display }, "call");
      expect(toolOutputSchema.parse(rowOutput).display).toEqual(display);
      if (display?.kind !== "native_context") throw new Error("missing native display");
      const projected = display.output;
      if (name === "DecompressContext") {
        expect(projected.content).toHaveLength(1_200);
        expect(projected.displayTruncated).toBe(true);
        expect(projected.nextCursor).toBe("page-next");
        expect(projected.filePath).toBe("page.txt");
      }
      if (name === "CompactStatus") {
        expect(projected.nextCursor).toBe("next");
        expect(
          (projected.ranges as Array<{ cacheUsage: { outputTokens: number } }>)[0]?.cacheUsage
            .outputTokens,
        ).toBe(3);
      }
    }
  });
});

function fixture(overrides: Partial<DecompressContextOutput> = {}) {
  const page: DecompressContextOutput = {
    status: "success",
    sessionId: "sess_test",
    tier: "original",
    content: "原文😀\ncomplete page",
    messageCount: 1,
    ranges: [],
    truncated: false,
    ...overrides,
  };
  const archive = {
    read: vi.fn(async (_input?: unknown) => page),
    search: vi.fn(async (_input?: unknown) => ({
      status: "success",
      sessionId: "sess_test",
      query: "needle",
      matches: [],
      searchedMessageCount: 3,
      foldedMessageCount: 1,
      truncated: false,
    })),
    status: vi.fn(async (_input?: unknown) => ({
      status: "success",
      sessionId: "sess_test",
      messageCount: 3,
      activeMessageCount: 2,
      foldedMessageCount: 1,
      ranges: [],
    })),
  };
  const messages = vi.fn(() => {
      throw new Error("full transcript reads forbidden");
    }),
    writeTextFile = vi.fn(async (_input?: unknown) => undefined);
  const context = {
    sessionId: "sess_test",
    traceId: "trace_test",
    toolCallId: "tool_context_memory",
    abortSignal: new AbortController().signal,
    workspaceRoot: process.cwd(),
    workingDirectory: process.cwd(),
    sessionStore: { contextArchive: archive, messages },
    fileSystemPort: { writeTextFile },
  } as unknown as ToolExecutionContext;
  return { archive, context, page, messages, writeTextFile };
}
const handlers = [
  {
    name: "search",
    handler: searchContextHandler,
    input: {
      query: "needle",
      cursor: "search-cursor",
      scope: "summaries",
      role: "user",
      includeFolded: false,
      maxResults: 2,
      maxChars: 100,
    },
  },
  {
    name: "read",
    handler: decompressContextHandler,
    input: { boundaryId: "boundary", cursor: "read-cursor", tier: "summary", maxChars: 100 },
  },
  {
    name: "status",
    handler: compactStatusHandler,
    input: { boundaryId: "boundary", cursor: "status-cursor", maxRanges: 2 },
  },
] as const;
describe("native context tool ports", () => {
  for (const test of handlers) {
    it(`${test.name}: forwards selection, cursor and cancellation to the archive only`, async () => {
      const f = fixture();
      const result = await test.handler(test.input, f.context);
      expect(f.archive[test.name]).toHaveBeenCalledWith({
        ...test.input,
        sessionId: "sess_test",
        signal: f.context.abortSignal,
      });
      expect(result).toBe(await f.archive[test.name].mock.results[0]!.value);
      expect(f.messages).not.toHaveBeenCalled();
    });
    it.each([false, true])(
      `${test.name}: missing archive fails without full-history fallback (store=%s)`,
      async (hasStore) => {
        const f = fixture();
        const context = {
          ...f.context,
          sessionStore: hasStore ? { messages: f.messages } : undefined,
        } as unknown as ToolExecutionContext;
        await expect(test.handler(test.input, context)).rejects.toMatchObject({
          type: "configuration_error",
          recoverable: false,
        });
        expect(f.messages).not.toHaveBeenCalled();
      },
    );
    it(`${test.name}: reports archive errors`, async () => {
      const f = fixture();
      const error = new Error("archive offline");
      f.archive[test.name].mockRejectedValueOnce(error);
      await expect(test.handler(test.input, f.context)).rejects.toBe(error);
      expect(f.messages).not.toHaveBeenCalled();
    });
    it(`${test.name}: preserves cancellation`, async () => {
      const f = fixture(),
        abort = new AbortController(),
        failure = new Error("cancel archive");
      abort.abort(failure);
      f.archive[test.name].mockRejectedValueOnce(failure);
      await expect(
        test.handler(test.input, { ...f.context, abortSignal: abort.signal }),
      ).rejects.toBe(failure);
    });
  }
});
describe("DecompressContext page delivery", () => {
  it("returns the archive page unchanged inline", async () => {
    const f = fixture();
    expect(await decompressContextHandler({ messageIds: ["msg_one"] }, f.context)).toBe(f.page);
    expect(f.archive.read).toHaveBeenCalledWith({
      messageIds: ["msg_one"],
      tier: "original",
      sessionId: "sess_test",
      signal: f.context.abortSignal,
    });
    expect(f.writeTextFile).not.toHaveBeenCalled();
  });
  it("writes exactly the current page and preserves continuation", async () => {
    const f = fixture({
      truncated: true,
      nextCursor: "next-page",
      segments: [{ messageId: "msg", partId: "part", sourceOffset: 0, start: 0, length: 2 }],
    });
    const output = (await decompressContextHandler(
      { messageIds: ["msg"], toFile: "artifacts/page.md" },
      f.context,
    )) as DecompressContextOutput;
    const path = resolve(process.cwd(), "artifacts/page.md");
    expect(f.archive.read.mock.calls[0]?.[0]).not.toHaveProperty("toFile");
    expect(f.writeTextFile).toHaveBeenCalledWith(
      expect.objectContaining({ path, content: f.page.content, atomic: true, createParents: true }),
      { signal: f.context.abortSignal },
    );
    expect(output).toMatchObject({
      status: "success",
      filePath: path,
      bytesWritten: Buffer.byteLength(f.page.content),
      nextCursor: "next-page",
      truncated: true,
    });
    expect(output.content).not.toContain(f.page.content);
    expect(output.segments).toBeUndefined();
    expect(decompressContextToolEntry.formatModelContent?.(output)).toContain("next-page");
  });
  it.each([resolve(process.cwd(), "absolute.md"), "../outside.md"])(
    "rejects unsafe file paths before querying: %s",
    async (toFile) => {
      const f = fixture();
      await expect(decompressContextHandler({ toFile }, f.context)).rejects.toMatchObject({
        type: CoreErrorType.InvalidInput,
      });
      expect(f.archive.read).not.toHaveBeenCalled();
      expect(f.writeTextFile).not.toHaveBeenCalled();
    },
  );
  it("reports missing FileSystemPort before reading", async () => {
    const f = fixture();
    await expect(
      decompressContextHandler({ toFile: "page.md" }, { ...f.context, fileSystemPort: undefined }),
    ).rejects.toMatchObject({ type: CoreErrorType.ConfigurationError });
    expect(f.archive.read).not.toHaveBeenCalled();
  });
  it("does not write a not-found page", async () => {
    const f = fixture({ status: "not_found", content: "No range" });
    expect(await decompressContextHandler({ toFile: "page.md" }, f.context)).toBe(f.page);
    expect(f.writeTextFile).not.toHaveBeenCalled();
  });
  it("propagates the original write failure without returning a successful page", async () => {
    const f = fixture({ truncated: true, nextCursor: "next-page" });
    const error = new Error("disk full");
    f.writeTextFile.mockRejectedValueOnce(error);
    await expect(decompressContextHandler({ toFile: "page.md" }, f.context)).rejects.toBe(error);
  });
  it("keeps the existing file permission boundary", () => {
    expect(
      decompressContextToolEntry.resolvePermissionCapability?.({ messageIds: ["msg"] }),
    ).toBeUndefined();
    expect(
      decompressContextToolEntry.resolvePermissionCapability?.({ toFile: "page.md" }),
    ).toMatchObject({
      readOnly: false,
      sideEffectScope: "workspace",
      needsApproval: true,
      permission: { permission: "edit" },
    });
  });
  it("keeps default tier and toFile schema bounds", () => {
    expect(DecompressContextInputSchema.parse({}).tier).toBe("original");
    expect(DecompressContextInputSchema.safeParse({ toFile: "" }).success).toBe(false);
    expect(DecompressContextInputSchema.safeParse({ toFile: "a".repeat(4096) }).success).toBe(true);
    expect(DecompressContextInputSchema.safeParse({ toFile: "a".repeat(4097) }).success).toBe(
      false,
    );
    expect(
      (DecompressContextInputJsonSchema.properties as Record<string, unknown>).toFile,
    ).toMatchObject({ type: "string", minLength: 1, maxLength: 4096 });
  });
});

describe("native context executor failure lifecycle", () => {
  it("records toFile IO failure through the executor rather than returning a successful page", async () => {
    const f = fixture();
    f.writeTextFile.mockRejectedValueOnce(new Error("disk full"));
    const registry = createToolRegistry();
    registry.register(decompressContextToolEntry);
    const sessionId = createSessionId();
    const events: SessionEvent[] = [];
    const executor = createToolExecutor({
      registry,
      sessionId,
      traceContext: createRootTraceContext({ sessionId }),
      permissionService: new PermissionService(defaultPermissionConfig),
      permissionBroker: { requestPermission: async () => ({ decision: "allow" }) },
      workspaceRoot: process.cwd(),
      workingDirectory: process.cwd(),
      fileSystemPort: f.context.fileSystemPort,
      sessionStore: {
        getSession: async () => null,
        contextArchive: f.archive,
      } as unknown as SessionStorePort,
      emitEvent: async (event) => {
        events.push(event);
      },
    });
    const result = await executor.execute({
      id: createToolCallId(),
      name: "DecompressContext",
      input: { toFile: "page.md" },
    });
    expect(f.writeTextFile).toHaveBeenCalledOnce();
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("disk full");
    expect(events.filter((event) => event.type === SessionEventType.ToolCallError)).toHaveLength(1);
    expect(events.some((event) => event.type === SessionEventType.ToolCallResult)).toBe(false);
  });

  it("keeps an ordinary not-found query as a successful execution", async () => {
    const f = fixture({ status: "not_found", content: "No matching range" });
    const registry = createToolRegistry();
    registry.register(decompressContextToolEntry);
    const sessionId = createSessionId();
    const events: SessionEvent[] = [];
    const executor = createToolExecutor({
      registry,
      sessionId,
      traceContext: createRootTraceContext({ sessionId }),
      permissionService: new PermissionService(defaultPermissionConfig),
      sessionStore: {
        getSession: async () => null,
        contextArchive: f.archive,
      } as unknown as SessionStorePort,
      emitEvent: async (event) => {
        events.push(event);
      },
    });
    const result = await executor.execute({
      id: createToolCallId(),
      name: "DecompressContext",
      input: {},
    });
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ status: "not_found" });
    expect(result.display).toMatchObject({
      kind: "native_context",
      output: { status: "not_found" },
    });
    expect(
      events.find((event) => event.type === SessionEventType.ToolCallResult)?.payload,
    ).toMatchObject({
      result: { display: { kind: "native_context", output: { status: "not_found" } } },
    });
    expect(events.some((event) => event.type === SessionEventType.ToolCallError)).toBe(false);
  });

  for (const [entry, method, input] of [
    [searchContextToolEntry, "search", { query: "needle" }],
    [decompressContextToolEntry, "read", {}],
    [compactStatusToolEntry, "status", {}],
  ] as const) {
    it.each(["throws", "failed output"])(
      `${entry.metadata.name}: %s is a failed call`,
      async (mode) => {
        const f = fixture();
        if (mode === "throws")
          f.archive[method].mockRejectedValueOnce(new Error("archive offline"));
        else
          f.archive[method].mockResolvedValueOnce({
            ...(await f.archive[method]()),
            status: "failed",
            error: "archive offline",
          } as never);
        const registry = createToolRegistry();
        registry.register(entry);
        const sessionId = createSessionId();
        const events: SessionEvent[] = [];
        const hookEvents: string[] = [];
        const executor = createToolExecutor({
          registry,
          sessionId,
          traceContext: createRootTraceContext({ sessionId }),
          permissionService: new PermissionService(defaultPermissionConfig),
          sessionStore: {
            getSession: async () => null,
            contextArchive: f.archive,
          } as unknown as SessionStorePort,
          emitEvent: async (event) => {
            events.push(event);
          },
          hookRunner: {
            run: async (event) => {
              hookEvents.push(event.hookEventName);
              return { additionalContexts: [] };
            },
          },
        });
        const result = await executor.execute({
          id: createToolCallId(),
          name: entry.metadata.name,
          input,
        });
        expect(result.success).toBe(false);
        expect(result.error?.message).toContain("archive offline");
        expect(
          events.filter((event) => event.type === SessionEventType.ToolCallError),
        ).toHaveLength(1);
        expect(events.some((event) => event.type === SessionEventType.ToolCallResult)).toBe(false);
        expect(hookEvents).toContain(HookEventName.PostToolUseFailure);
        expect(hookEvents).not.toContain(HookEventName.PostToolUse);
      },
    );
  }
});

function fakeCompactModel(providerId: string, modelId: string, maxOutputTokens = 1_000_000): Model {
  return {
    providerId,
    modelId,
    optionSpecs: { maxOutputTokens: { max: maxOutputTokens, default: maxOutputTokens } },
    options: { reasoningLevel: "high" },
    properties: {},
    async generateText() {
      throw new Error("fake model is only used by resolution tests");
    },
    // 不写成 async generator：它永远不会被调用，避免 require-yield 噪声。
    streamText() {
      throw new Error("fake model is only used by resolution tests");
    },
  } as unknown as Model;
}

interface CapturedCompactLog {
  message: string;
  context?: Record<string, unknown>;
}

function createCompactResolutionLogger(): {
  infos: CapturedCompactLog[];
  warnings: CapturedCompactLog[];
  logger: {
    info(message: string, context?: Record<string, unknown>): void;
    warn(message: string, context?: Record<string, unknown>): void;
  };
} {
  const infos: CapturedCompactLog[] = [];
  const warnings: CapturedCompactLog[] = [];
  return {
    infos,
    warnings,
    logger: {
      info(message, context) {
        infos.push({ context, message });
      },
      warn(message, context) {
        warnings.push({ context, message });
      },
    },
  };
}

function catalogEntry(input: {
  providerId: string;
  modelId: string;
  defaultReasoningLevel?: string;
  disabledReason?: string;
  reasoningLevels?: string[];
}) {
  return {
    current: false,
    providerId: input.providerId,
    modelId: input.modelId,
    reasoningLevels: input.reasoningLevels ?? ["low", "high"],
    ...(input.defaultReasoningLevel ? { defaultReasoningLevel: input.defaultReasoningLevel } : {}),
    ...(input.disabledReason ? { disabledReason: input.disabledReason } : {}),
  };
}

describe("compact summary model resolution", () => {
  it("returns the untouched default model when compactSummaryModel is absent", () => {
    const fallback = fakeCompactModel("session", "main");
    const created: ModelSelection[] = [];
    const capture = createCompactResolutionLogger();

    const resolved = resolveCompactSummaryModel({
      createModel: (selection) => {
        created.push(selection);
        return fakeCompactModel(selection.providerId, selection.modelId);
      },
      fallbackModel: fallback,
      logger: capture.logger,
    });

    expect(resolved.model).toBe(fallback);
    expect(resolved.source).toBe("default");
    expect(resolved.fallbackReason).toBeUndefined();
    // 未配置时不得额外创建模型：行为与加配置前完全一致。
    expect(created).toHaveLength(0);
    expect(capture.infos.at(-1)?.context?.model).toBe("session/main");
    expect(capture.warnings).toHaveLength(0);
  });

  it("uses the configured model and completes the reasoning level from the catalog", () => {
    const created: ModelSelection[] = [];
    const capture = createCompactResolutionLogger();

    const resolved = resolveCompactSummaryModel({
      catalog: {
        listModels: () => [
          catalogEntry({ providerId: "cheap", modelId: "mini", defaultReasoningLevel: "low" }),
        ],
      },
      configured: { providerId: "cheap", modelId: "mini" },
      createModel: (selection) => {
        created.push(selection);
        return fakeCompactModel(selection.providerId, selection.modelId);
      },
      fallbackModel: fakeCompactModel("session", "main"),
      logger: capture.logger,
    });

    expect(resolved.source).toBe("configured");
    expect(resolved.model.providerId).toBe("cheap");
    expect(resolved.model.modelId).toBe("mini");
    expect(created).toEqual([
      { providerId: "cheap", modelId: "mini", options: { reasoningLevel: "low" } },
    ]);
    expect(capture.infos.at(-1)?.context).toMatchObject({
      model: "cheap/mini",
      source: "configured",
    });
    expect(capture.warnings).toHaveLength(0);
  });

  it("falls back with a warning when the configured model is missing, disabled, or has a bad level", () => {
    const cases: Array<{
      entry?: ReturnType<typeof catalogEntry>;
      configured: ModelSelection;
      reason: CompactSummaryModelFallbackReason;
    }> = [
      {
        configured: { providerId: "cheap", modelId: "mini" },
        reason: "model_not_found",
      },
      {
        configured: { providerId: "cheap", modelId: "mini" },
        entry: catalogEntry({
          disabledReason: "provider has no credentials",
          modelId: "mini",
          providerId: "cheap",
        }),
        reason: "model_disabled",
      },
      {
        configured: { providerId: "cheap", modelId: "mini", options: { reasoningLevel: "ultra" } },
        entry: catalogEntry({ modelId: "mini", providerId: "cheap" }),
        reason: "reasoning_level_not_supported",
      },
      {
        // 目录里没有任何推理档位、配置也没写：ModelFactory 要求完整 Selection，只能回退。
        configured: { providerId: "cheap", modelId: "mini" },
        entry: catalogEntry({ modelId: "mini", providerId: "cheap", reasoningLevels: [] }),
        reason: "reasoning_level_missing",
      },
    ];

    for (const item of cases) {
      const fallback = fakeCompactModel("session", "main");
      const capture = createCompactResolutionLogger();
      const resolved = resolveCompactSummaryModel({
        catalog: { listModels: () => (item.entry ? [item.entry] : []) },
        configured: item.configured,
        createModel: () => {
          throw new Error("createModel must not run for an unusable selection");
        },
        fallbackModel: fallback,
        logger: capture.logger,
      });

      expect(resolved.model).toBe(fallback);
      expect(resolved.source).toBe("default");
      expect(resolved.fallbackReason).toBe(item.reason);
      expect(capture.warnings).toHaveLength(1);
      expect(capture.warnings[0]?.context).toMatchObject({ fallbackReason: item.reason });
    }
  });

  it.each(["factory", "catalog"])(
    "propagates an internal %s error without warning or fallback",
    (source) => {
      const fallback = fakeCompactModel("session", "main");
      const capture = createCompactResolutionLogger();

      const error = new Error(`${source} internal bug`);
      const createModel = vi.fn(() => {
        throw error;
      });
      expect(() =>
        resolveCompactSummaryModel({
          configured: { providerId: "ghost", modelId: "model" },
          ...(source === "catalog"
            ? {
                catalog: {
                  listModels: () => {
                    throw error;
                  },
                },
              }
            : {}),
          createModel,
          fallbackModel: fallback,
          logger: capture.logger,
        }),
      ).toThrow(error);
      expect(capture.warnings).toHaveLength(0);
      if (source === "catalog") expect(createModel).not.toHaveBeenCalled();
    },
  );

  it("caps the summary request at MAX_OUTPUT_TOKENS_FOR_SUMMARY regardless of the model ceiling", () => {
    expect(capCompactSummaryMaxOutputTokens(fakeCompactModel("big", "model", 1_000_000))).toBe(
      MAX_OUTPUT_TOKENS_FOR_SUMMARY,
    );
    // 模型自身上限更小时仍取更小值，不能借摘要模型绕过模型能力。
    expect(capCompactSummaryMaxOutputTokens(fakeCompactModel("small", "model", 4_000))).toBe(4_000);
  });
});
