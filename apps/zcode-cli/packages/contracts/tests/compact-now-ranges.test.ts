import { describe, expect, it } from "vitest";

import {
  CompactNowInputJsonSchema,
  CompactNowInputSchema,
  CompactNowOutputSchema,
} from "../src/tools/context-memory.js";

function range(index: number) {
  return { startMessageId: `msg_start_${index}`, endMessageId: `msg_end_${index}` };
}

describe("CompactNow ranges contract", () => {
  it("accepts bounded model-written summaries and rejects empty or excessive bodies", () => {
    expect(
      CompactNowInputSchema.parse({ ranges: [{ ...range(1), summary: "  keep constraints  " }] })
        .ranges?.[0]?.summary,
    ).toBe("keep constraints");
    for (const summary of ["   ", "x".repeat(24_001)]) {
      expect(() => CompactNowInputSchema.parse({ ranges: [{ ...range(1), summary }] })).toThrow();
    }
  });
  it("keeps the existing input shape when ranges are omitted", () => {
    const parsed = CompactNowInputSchema.parse({ instructions: "keep tests" });
    expect(parsed.ranges).toBeUndefined();
    expect(parsed.reason).toBe("context_pressure");
  });

  it("accepts one or more explicit ranges", () => {
    const parsed = CompactNowInputSchema.parse({ ranges: [range(1), range(2)] });
    expect(parsed.ranges).toEqual([range(1), range(2)]);
  });

  it("rejects malformed, empty and oversized range arrays", () => {
    expect(() => CompactNowInputSchema.parse({ ranges: [] })).toThrow();
    expect(() =>
      CompactNowInputSchema.parse({
        ranges: Array.from({ length: 17 }, (_, index) => range(index)),
      }),
    ).toThrow();
    expect(() => CompactNowInputSchema.parse({ ranges: [{ startMessageId: "msg_a" }] })).toThrow();
    expect(() =>
      CompactNowInputSchema.parse({ ranges: [{ ...range(1), unexpected: true }] }),
    ).toThrow();
    expect(() =>
      CompactNowInputSchema.parse({ ranges: [{ startMessageId: "", endMessageId: "msg_b" }] }),
    ).toThrow();
  });

  it("publishes ranges as an optional model-facing input field", () => {
    const schema = CompactNowInputJsonSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.properties?.ranges).toBeDefined();
    expect(schema.required ?? []).not.toContain("ranges");
  });

  it("accepts the ranges_not_supported rejection output", () => {
    expect(
      CompactNowOutputSchema.parse({
        status: "rejected",
        message: "Selective range compaction is not enabled yet.",
        reason: "ranges_not_supported",
      }),
    ).toMatchObject({ reason: "ranges_not_supported", status: "rejected" });
  });
});
