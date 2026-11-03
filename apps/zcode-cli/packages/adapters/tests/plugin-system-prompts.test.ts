import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginDiagnostic, PluginManifest, PluginSystemPromptSection } from "@zcode/contracts";
import { discoverNodePluginsSync } from "../src/plugins/index.js";
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

function writePluginManifest(root: string, manifest: Record<string, unknown>): void {
  writeFiles(root, {
    ".zcode-plugin/plugin.json": JSON.stringify({ version: "1.0.0", ...manifest }),
  });
}

function discover(dirs: string[]) {
  return discoverNodePluginsSync({
    config: {
      dirs,
      enabled: true,
      enabledPlugins: {},
      options: {},
      suppressedBuiltins: [],
    },
    env: {},
    storageRoot: makeRoot(),
    workingDirectory: makeRoot(),
  });
}

function supportsDirectoryLink(): boolean {
  const root = makeRoot();
  const target = makeRoot();
  const link = join(root, "linked");
  try {
    symlinkSync(target, link, "junction");
    // 某些沙箱/文件系统虚拟化层会把 junction 实体化成普通目录，此时 realpath 不会暴露逃逸，
    // 只有真正识别为符号链接的环境才能验证该保护。
    return lstatSync(link).isSymbolicLink();
  } catch {
    return false;
  }
}

const directoryLinksSupported = supportsDirectoryLink();

describe("resolvePluginSystemPrompts", () => {
  it("keeps inline systemPrompt with the default name, order and trimmed body", () => {
    const { bytes, diagnostics, sections } = resolve({ manifest: { systemPrompt: "  be nice  " } });

    expect(diagnostics).toEqual([]);
    expect(sections).toEqual([
      { content: "be nice", name: "plugin:demo@local", order: 100, pluginId: "demo@local" },
    ]);
    expect(bytes).toBe(
      Buffer.byteLength(
        '<plugin_system_prompt name="plugin:demo@local" plugin="demo@local">\nbe nice\n</plugin_system_prompt>',
        "utf8",
      ),
    );
  });

  it("reads systemPromptPath relative to the plugin root", () => {
    const root = makeRoot();
    writeFiles(root, { "prompts/role.md": "role body\n" });

    const { sections } = resolve({ manifest: { systemPromptPath: "prompts/role.md" }, root });

    expect(sections.map((section) => section.content)).toEqual(["role body"]);
  });

  it("rejects oversized metadata and counts escaped labels in the final byte budget", () => {
    const invalid = resolve({
      manifest: { systemPrompts: [{ name: "x".repeat(129), content: "body" }] },
    });
    expect(invalid.sections).toEqual([]);
    expect(invalid.diagnostics.map((item) => item.code)).toContain("plugin_system_prompt_invalid");
    const valid = resolve({
      manifest: { systemPrompts: [{ name: '名字"<&', content: "内容😀" }] },
    });
    const expected =
      '<plugin_system_prompt name="名字&quot;&lt;&amp;" plugin="demo@local">\n内容😀\n</plugin_system_prompt>';
    expect(valid.bytes).toBe(Buffer.byteLength(expected));
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

  it("reports a missing system prompt file as a read failure", () => {
    const { sections, diagnostics } = resolve({
      manifest: { systemPromptPath: "prompts/missing.md" },
    });

    expect(sections).toEqual([]);
    expect(diagnostics.map((item) => item.code)).toContain("plugin_system_prompt_read_failed");
  });

  it.skipIf(!directoryLinksSupported)(
    "rejects a path that escapes the plugin root through a symlink",
    () => {
      const root = makeRoot();
      const outside = makeRoot();
      writeFiles(outside, { "secret.md": "outside body" });
      symlinkSync(outside, join(root, "linked"), "junction");

      const { sections, diagnostics } = resolve({
        manifest: { systemPromptPath: "linked/secret.md" },
        root,
      });

      expect(sections).toEqual([]);
      expect(diagnostics.map((item) => item.code)).toContain("plugin_system_prompt_outside_root");
    },
  );
});

describe("plugin discovery system prompts", () => {
  it("sorts sections across plugins by order", () => {
    const late = makeRoot();
    const early = makeRoot();
    writePluginManifest(late, {
      name: "late-plugin",
      systemPrompts: [{ name: "late", order: 200, content: "late body" }],
    });
    writePluginManifest(early, {
      name: "early-plugin",
      systemPrompts: [{ name: "early", order: 10, content: "early body" }],
    });

    const outcome = discover([late, early]);

    expect(outcome.systemPrompts.map((section) => section.name)).toEqual(["early", "late"]);
    expect(outcome.systemPrompts.map((section) => section.pluginId)).toEqual([
      "early-plugin@inline",
      "late-plugin@inline",
    ]);
  });

  it("only injects system prompts from enabled plugins", () => {
    const enabled = makeRoot();
    const disabled = makeRoot();
    writePluginManifest(enabled, { name: "enabled-plugin", systemPrompt: "enabled body" });
    writePluginManifest(disabled, { name: "disabled-plugin", systemPrompt: "disabled body" });

    const outcome = discoverNodePluginsSync({
      config: {
        dirs: [enabled, disabled],
        enabled: true,
        enabledPlugins: { "disabled-plugin@inline": false },
        options: {},
        suppressedBuiltins: [],
      },
      env: {},
      storageRoot: makeRoot(),
      workingDirectory: makeRoot(),
    });

    expect(outcome.systemPrompts.map((section) => section.content)).toEqual(["enabled body"]);
  });

  it("truncates across plugins at the shared total budget", () => {
    const roots = ["budget-a", "budget-b", "budget-c"].map((name) => {
      const root = makeRoot();
      writePluginManifest(root, { name, systemPrompt: "x".repeat(30 * 1024) });
      return root;
    });

    const outcome = discover(roots);

    // 每段 30 KiB 小于单段 32 KiB 上限；两段合计 60 KiB 后剩余 4 KiB，第三段被整体截断。
    expect(outcome.systemPrompts).toHaveLength(2);
    expect(outcome.systemPrompts.map((section) => section.pluginId)).toEqual([
      "budget-a@inline",
      "budget-b@inline",
    ]);
    expect(outcome.diagnostics.map((item) => item.code)).toContain(
      "plugin_system_prompt_budget_exceeded",
    );
  });

  it("shares the section-count budget across enabled plugins", () => {
    const dirs = ["count-a", "count-b"].map((name) => {
      const root = makeRoot();
      writePluginManifest(root, {
        name,
        systemPrompts: Array.from({ length: 40 }, (_, index) => ({ content: `${name}-${index}` })),
      });
      return root;
    });
    const outcome = discover(dirs);
    expect(outcome.systemPrompts).toHaveLength(64);
    expect(outcome.diagnostics.map((item) => item.code)).toContain(
      "plugin_system_prompt_budget_exceeded",
    );
  });
});
