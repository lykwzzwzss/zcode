import { describe, expect, it } from "vitest";
import {
  PLUGIN_SYSTEM_PROMPTS_TOTAL_MAX_BYTES,
  type PluginSystemPromptSection,
} from "@zcode/contracts";
import type { ContextBuilder, ContextSection } from "../src/context/index.js";
import { applyPluginSystemPrompts } from "../src/runtime/methods/context.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

function capture() {
  const sections: ContextSection[] = [];
  const builder = {
    addSection(section: ContextSection) {
      sections.push(section);
      return builder;
    },
  } as unknown as ContextBuilder;
  return { builder, sections };
}

function section(input: Partial<PluginSystemPromptSection> & { content: string }) {
  return {
    content: input.content,
    name: input.name ?? "demo",
    order: input.order ?? 100,
    pluginId: input.pluginId ?? "demo@inline",
  };
}

describe("applyPluginSystemPrompts", () => {
  it("wraps third-party bodies in an explicit boundary section", () => {
    const { builder, sections } = capture();

    applyPluginSystemPrompts(builder, [section({ content: "  be nice  " })]);

    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({
      name: "demo",
      preview: "be nice",
      source: "plugin_system_prompt",
      injectionTarget: "system",
      cacheHint: "stable",
    });
    expect(sections[0]?.content).toBe(
      [
        '<plugin_system_prompt name="demo" plugin="demo@inline">',
        "be nice",
        "</plugin_system_prompt>",
      ].join("\n"),
    );
  });

  it("includes the wrapper tags in the final injection budget", () => {
    const { builder, sections } = capture();
    const body = "a".repeat(32 * 1024);

    // 两段正文占满 64 KiB 时包装标签也需要空间，第二段不能继续注入。
    applyPluginSystemPrompts(builder, [
      section({ content: body, name: "first" }),
      section({ content: body, name: "second" }),
    ]);

    expect(sections.map((item) => item.name)).toEqual(["first"]);
    expect(
      sections.reduce((bytes, item) => bytes + Buffer.byteLength(item.content), 0),
    ).toBeLessThanOrEqual(64 * 1024);
    expect(PLUGIN_SYSTEM_PROMPTS_TOTAL_MAX_BYTES).toBe(64 * 1024);
  });

  it("skips overlarge individual bodies while preserving valid sections", () => {
    const { builder, sections } = capture();

    applyPluginSystemPrompts(builder, [
      section({ content: "a".repeat(60 * 1024), name: "first" }),
      section({ content: "b".repeat(8 * 1024), name: "second" }),
    ]);

    expect(sections.map((item) => item.name)).toEqual(["second"]);
  });

  it("limits section count even when Runtime receives sections directly", () => {
    const { builder, sections } = capture();
    applyPluginSystemPrompts(
      builder,
      Array.from({ length: 100 }, (_, index) =>
        section({ name: `name-${index}`, content: `body-${index}` }),
      ),
    );
    expect(sections).toHaveLength(64);
  });

  it("escapes label attributes and rejects invalid metadata", () => {
    const { builder, sections } = capture();
    applyPluginSystemPrompts(builder, [
      section({ name: 'name"<&', content: "body" }),
      section({ name: "x".repeat(129), content: "invalid" }),
    ]);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.content).toContain('name="name&quot;&lt;&amp;"');
  });

  it("skips empty bodies and tolerates missing sections", () => {
    const { builder, sections } = capture();

    applyPluginSystemPrompts(builder, [section({ content: "   " })]);
    applyPluginSystemPrompts(builder, undefined);
    applyPluginSystemPrompts(builder, []);

    expect(sections).toEqual([]);
  });
});

describe("plugin system prompt request injection", () => {
  it.each([undefined, "", " \n\t"])(
    "injects into the real system request when custom prompt is effectively absent (%j)",
    async (systemPrompt) => {
      const systemRequests: string[] = [];
      const runtime = createTestAgentRuntime(
        "sess_plugin_empty_custom_prompt" as never,
        { systemPrompt, pluginSystemPrompts: [section({ content: "PLUGIN_REQUEST_MARKER" })] },
        {
          eventStore: createTestSessionEventStore(),
          modelFactory: createTestModelFactory({
            async generateText(request) {
              systemRequests.push(
                request.messages
                  .filter((message) => message.role === "system")
                  .map((message) => message.content)
                  .join("\n"),
              );
              return { text: "ok", finishReason: "stop", usage: { totalTokens: 2 } };
            },
          }),
        },
      );

      await runtime.executeTurn("check plugin injection");

      expect(systemRequests).toHaveLength(1);
      expect(systemRequests[0]).toContain("PLUGIN_REQUEST_MARKER");
    },
  );

  it("keeps an explicit nonblank custom prompt free of plugin sections", async () => {
    const systemRequests: string[] = [];
    const runtime = createTestAgentRuntime(
      "sess_plugin_explicit_custom_prompt" as never,
      {
        systemPrompt: "CUSTOM_REQUEST_MARKER",
        pluginSystemPrompts: [section({ content: "PLUGIN_REQUEST_MARKER" })],
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(request) {
            systemRequests.push(
              request.messages
                .filter((message) => message.role === "system")
                .map((message) => message.content)
                .join("\n"),
            );
            return { text: "ok", finishReason: "stop", usage: { totalTokens: 2 } };
          },
        }),
      },
    );

    await runtime.executeTurn("check explicit custom prompt");

    expect(systemRequests[0]).toContain("CUSTOM_REQUEST_MARKER");
    expect(systemRequests[0]).not.toContain("PLUGIN_REQUEST_MARKER");
  });
});
