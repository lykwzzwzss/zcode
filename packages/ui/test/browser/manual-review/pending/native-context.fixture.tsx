import { createRoot } from "react-dom/client";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ToolPresentation } from "@/ToolCallBlocks/ToolPresentation.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";
import { toolCallRowSchema } from "@zcode/shared/zcode-protocol-v4";
import "@/styles.css";

const query = new URLSearchParams(location.search);
const theme = query.get("theme") === "light" ? "light" : "dark";
document.documentElement.className = `${theme} theme-zai-${theme}`;

const examples = [
  {
    name: "CompactNow",
    input: {
      reason: "user_request",
      instructions: "keep constraints",
      ranges: [{ startMessageId: "m1", endMessageId: "m2", summary: "summary preview" }],
    },
    output: { status: "accepted", message: "queued" },
  },
  {
    name: "CompactStatus",
    input: {},
    output: {
      status: "success",
      messageCount: 20,
      activeMessageCount: 9,
      foldedMessageCount: 11,
      ranges: [
        {
          boundaryId: "node-1",
          messageId: "m1",
          summarizedMessageCount: 5,
          createdAt: 1,
          level: 2,
          childBoundaryIds: ["node-0"],
          preCompactTokenCount: 1000,
          postCompactTokenCount: 500,
          cacheUsage: { inputTokens: 200, cacheReadTokens: 100, outputTokens: 25 },
        },
      ],
    },
  },
  {
    name: "SearchContext",
    input: { query: "needle" },
    output: {
      status: "success",
      query: "needle",
      matches: [
        {
          messageId: "m1",
          role: "user",
          createdAt: 1,
          folded: true,
          score: 1,
          snippet: "found snippet",
        },
      ],
      nextCursor: "search-next",
    },
  },
  {
    name: "DecompressContext",
    input: {},
    output: {
      status: "success",
      messageCount: 1,
      content: "page preview",
      filePath: "page.txt",
      bytesWritten: 12,
      nextCursor: "page-next",
      displayTruncated: true,
    },
  },
  {
    name: "SearchContext",
    input: { query: "missing" },
    output: { status: "not_found", query: "missing", matches: [] },
  },
  { name: "CompactNow", input: {}, error: "archive unavailable" },
  { name: "DecompressContext", input: {}, legacy: "legacy result text" },
  ...[60, 200].map((size) => ({
    name: "CompactStatus",
    input: { maxRanges: size },
    output: {
      status: "success",
      messageCount: size + 1,
      activeMessageCount: 1,
      foldedMessageCount: size,
      nextCursor: `cursor-${size}`,
      ranges: Array.from({ length: size }, (_, index) => ({
        boundaryId: `page-${size}-node-${index}`,
        messageId: `m${index}`,
        summarizedMessageCount: 1,
        createdAt: 1,
        cacheUsage: { outputTokens: index },
      })),
    },
  })),
];

createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider initialLocale={query.get("locale") === "en-US" ? "en-US" : "zh-CN"}>
    <TooltipProvider>
      <main className="space-y-4 bg-background p-4 text-foreground">
        {examples.map((example, index) => {
          const row = toolCallRowSchema.parse({
            rowId: index + 1,
            turnId: "turn-1",
            createdAt: 1,
            createdAtSeq: index + 1,
            kind: "toolCall",
            toolCallId: `call-${index}`,
            toolName: example.name,
            status: example.error ? "error" : "success",
            inputText: "",
            input: example.input,
            ...(example.error
              ? { error: { code: "failed", message: example.error } }
              : {
                  output: {
                    text: example.legacy ?? "model text",
                    ...(example.output
                      ? {
                          display: {
                            kind: "native_context",
                            toolName: example.name,
                            output: example.output,
                          },
                        }
                      : {}),
                  },
                }),
          });
          return (
            <section key={index} data-testid={`case-${index}`}>
              <ToolPresentation toolCallNode={toolCallRowToLegacyNode(row)} />
            </section>
          );
        })}
      </main>
    </TooltipProvider>
  </ZCodeIntlProvider>,
);
