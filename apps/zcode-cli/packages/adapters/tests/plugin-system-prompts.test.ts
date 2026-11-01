import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginDiagnostic, PluginManifest, PluginSystemPromptSection } from "@zcode/contracts";
import { resolvePluginSystemPrompts } from "../src/plugins/system-prompts.js";
import type { LoadedPlugin } from "../src/plugins/types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "plugin-system-prompt-"));
  roots.push(root);
  return root;
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(root, relative);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }
}

function loadedPlugin(root: string, manifest: Record<string, unknown>): LoadedPlugin {
  return {
    id: "demo@local",
    manifest: { name: "demo", version: "1.0.0", ...manifest } as PluginManifest,
    manifestPath: join(root, ".zcode-plugin", "plugin.json"),
    marketplace: "local",
    rootPath: root,
    source: { kind: "directory" } as unknown as LoadedPlugin["source"],
  };
}

function resolve(input: {
  manifest: Record<string, unknown>;
  remainingBudgetBytes?: number;
  root?: string;
}): { bytes: number; diagnostics: PluginDiagnostic[]; sections: PluginSystemPromptSection[] } {
  const root = input.root ?? makeRoot();
  const diagnostics: PluginDiagnostic[] = [];
  const result = resolvePluginSystemPrompts({
    diagnostics,
    loaded: loadedPlugin(root, input.manifest),
    remainingBudgetBytes: input.remainingBudgetBytes ?? Number.MAX_SAFE_INTEGER,
  });
  return { ...result, diagnostics };
}

describe("resolvePluginSystemPrompts", () => {
  it("keeps inline systemPrompt with the default name, order and trimmed body", () => {
    const { bytes, diagnostics, sections } = resolve({ manifest: { systemPrompt: "  be nice  " } });

    expect(diagnostics).toEqual([]);
    expect(sections).toEqual([
      { content: "be nice", name: "plugin:demo@local", order: 100, pluginId: "demo@local" },
    ]);
    expect(bytes).toBe(Buffer.byteLength("be nice", "utf8"));
  });

  it("reads systemPromptPath relative to the plugin root", () => {
    const root = makeRoot();
    writeFiles(root, { "prompts/role.md": "role body\n" });

    const { sections } = resolve({ manifest: { systemPromptPath: "prompts/role.md" }, root });

    expect(sections.map((section) => section.content)).toEqual(["role body"]);
  });

  it("prefers inline systemPrompt over systemPromptPath", () => {
    const root = makeRoot();
    writeFiles(root, { "prompts/role.md": "from file" });

    const { sections } = resolve({
      manifest: { systemPrompt: "from inline", systemPromptPath: "prompts/role.md" },
      root,
    });

    expect(sections.map((section) => section.content)).toEqual(["from inline"]);
  });

  it("deduplicates identical bodies declared more than once", () => {
    const { sections } = resolve({
      manifest: { systemPrompt: "same", systemPrompts: [{ content: "same" }] },
    });

    expect(sections.map((section) => section.content)).toEqual(["same"]);
  });

  it("rejects absolute and escaping paths", () => {
    const absolute = resolve({ manifest: { systemPromptPath: "/etc/passwd" } });
    expect(absolute.sections).toEqual([]);
    expect(absolute.diagnostics.map((item) => item.code)).toContain(
      "plugin_system_prompt_outside_root",
    );

    const escaping = resolve({ manifest: { systemPromptPath: "../outside.md" } });
    expect(escaping.sections).toEqual([]);
    expect(escaping.diagnostics.map((item) => item.code)).toContain(
      "plugin_system_prompt_outside_root",
    );
  });

  it("rejects a file larger than the per-section cap", () => {
    const root = makeRoot();
    writeFiles(root, { "prompts/huge.md": "x".repeat(32 * 1024 + 1) });

    const { sections, diagnostics } = resolve({
      manifest: { systemPromptPath: "prompts/huge.md" },
      root,
    });

    expect(sections).toEqual([]);
    expect(diagnostics.map((item) => item.code)).toContain("plugin_system_prompt_too_large");
  });

  it("stops at the remaining total budget and reports it", () => {
    const { sections, bytes, diagnostics } = resolve({
      manifest: { systemPrompts: [{ content: "first" }, { content: "second" }] },
      // "first" 是 5 字节，预算剩 4 时第一段就放不进去。
      remainingBudgetBytes: 4,
    });

    expect(sections).toEqual([]);
    expect(bytes).toBe(0);
    expect(diagnostics.map((item) => item.code)).toContain("plugin_system_prompt_budget_exceeded");
  });

  it("honors per-entry name and order and reports malformed entries", () => {
    const { sections, diagnostics } = resolve({
      manifest: {
        systemPrompts: [
          { name: "late", order: 200, content: "L" },
          { name: "early", order: 10, content: "E" },
          "not-an-object",
        ],
      },
    });

    expect(sections.map((section) => [section.name, section.order, section.content])).toEqual([
      ["late", 200, "L"],
      ["early", 10, "E"],
    ]);
    expect(diagnostics.map((item) => item.code)).toContain("plugin_system_prompt_invalid");
  });
});
