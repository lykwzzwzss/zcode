import { describe, expect, it } from "vitest";
import type { MessageWithParts } from "@zcode/contracts";
import {
  buildSnippet,
  collectCompactedRanges,
  collectFoldedMessageIndexes,
  renderStoredMessage,
} from "../src/tool/handlers/context-memory-store.js";

function message(id: string, parts: MessageWithParts["parts"], role: "user" | "assistant" = "user") {
  return {
    info: { id, sessionID: "sess_test", role, time: { created: 1 } },
    parts,
  } as unknown as MessageWithParts;
}

function textPart(text: string) {
  return {
    id: `part_${text.slice(0, 4)}`,
    sessionID: "sess_test",
    messageID: "msg",
    type: "text",
    text,
  } as unknown as MessageWithParts["parts"][number];
}

describe("collectFoldedMessageIndexes", () => {
  it("keeps preserved segments, leading announcements and retained summaries out of folded", () => {
    const boundary = message(
      "msg_boundary",
      [
        {
          id: "part_compact",
          sessionID: "sess_test",
          messageID: "msg_boundary",
          type: "compaction",
          auto: false,
          compactBoundary: {
            boundaryId: "compact_test",
            summaryMessageIds: ["msg_boundary"],
            preservedSegment: {
              anchorMessageId: "msg_boundary",
              headMessageId: "msg_head",
              tailMessageId: "msg_tail",
            },
          },
          metadata: {
            compactLeadingMessageIds: ["msg_leading"],
            compactRetainedMessageIds: ["msg_retained"],
          },
        } as unknown as MessageWithParts["parts"][number],
      ],
    );
    const messages = [
      message("msg_leading", [textPart("leading")]),
      message("msg_retained", [textPart("retained")]),
      message("msg_folded_a", [textPart("folded a")]),
      message("msg_folded_b", [textPart("folded b")], "assistant"),
      message("msg_head", [textPart("head")]),
      message("msg_tail", [textPart("tail")], "assistant"),
      boundary,
    ];

    const ranges = collectCompactedRanges(messages);
    const folded = collectFoldedMessageIndexes(messages, ranges);

    expect([...folded].sort((left, right) => left - right)).toEqual([2, 3]);
  });
});

describe("renderStoredMessage", () => {
  const toolMessage = message("msg_tool", [
    {
      id: "part_tool",
      sessionID: "sess_test",
      messageID: "msg_tool",
      type: "tool",
      tool: "Bash",
      callID: "call_1",
      state: { status: "completed", input: { command: "echo hi" }, output: "x".repeat(5_000) },
    } as unknown as MessageWithParts["parts"][number],
  ]);

  it("clips tool output and reports truncation at the default budget", () => {
    const rendered = renderStoredMessage(toolMessage);

    expect(rendered.truncated).toBe(true);
    expect(rendered.text.length).toBeLessThan(2_000);
    expect(rendered.text.endsWith("…")).toBe(true);
  });

  it("returns the whole tool output when asked for the decompress budget", () => {
    const rendered = renderStoredMessage(toolMessage, { toolOutputMaxChars: 20_000 });

    expect(rendered.truncated).toBeUndefined();
    expect(rendered.text).toContain("x".repeat(5_000));
  });
});

describe("buildSnippet", () => {
  it("anchors on the original text when the match is uppercase", () => {
    const text = `${"a".repeat(300)}HELLO WORLD${"b".repeat(300)}`;
    const snippet = buildSnippet(
      { messageId: "msg_1", role: "user", createdAt: 1, text },
      "hello",
      ["hello"],
    );

    expect(snippet).toContain("HELLO WORLD");
    expect(snippet).not.toBe("…");
  });
});
