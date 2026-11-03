import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  PLUGIN_SYSTEM_PROMPT_MAX_BYTES,
  PLUGIN_SYSTEM_PROMPT_MAX_NAME_CHARS,
  PLUGIN_SYSTEM_PROMPT_MAX_SECTIONS,
  PLUGIN_SYSTEM_PROMPTS_TOTAL_MAX_BYTES,
  preparePluginSystemPrompt,
  type PluginDiagnostic,
  type PluginSystemPromptSection,
} from "@zcode/contracts";
import { isRecord } from "./helpers.js";
import type { LoadedPlugin } from "./types.js";

/** 段内默认排序权重：identity/memory 等内建段之后。 */
const DEFAULT_SECTION_ORDER = 100;

interface RawDeclaration {
  content?: string;
  name?: string;
  order?: number;
  path?: string;
}

/**
 * 解析插件清单里的 system prompt 声明（`systemPrompt` / `systemPromptPath` /
 * `systemPrompts[]`），读盘并阻塞越界路径与超限正文。
 *
 * 语义约束：
 * - 只允许相对插件根目录的路径，绝对路径与 `..` 逃逸一律拒绝（`plugin_system_prompt_outside_root`）；
 * - 单段超过 32 KiB 拒绝；调用方按 `remainingBudgetBytes` 做全局 64 KiB 台账；
 * - 任何失败只记诊断并跳过该段，不影响插件其余能力。
 */
export function resolvePluginSystemPrompts(input: {
  diagnostics: PluginDiagnostic[];
  loaded: LoadedPlugin;
  remainingBudgetBytes: number;
  remainingSections?: number;
}): { bytes: number; sections: PluginSystemPromptSection[] } {
  const declarations = collectDeclarations(input.loaded, input.diagnostics);
  const sections: PluginSystemPromptSection[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (const declaration of declarations) {
    const content = readDeclaration(declaration, input.loaded, input.diagnostics);
    if (content === undefined) continue;
    const trimmed = content.trim();
    if (trimmed.length === 0) continue;
    // `systemPrompt` 与 `systemPrompts[]` 可以同时声明同一段正文；按正文去重，
    // 避免同一份提示词被注入两次、白花预算。
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    const section = {
      content: trimmed,
      name:
        declaration.name ??
        `plugin:${input.loaded.id}`.slice(0, PLUGIN_SYSTEM_PROMPT_MAX_NAME_CHARS),
      order: declaration.order ?? DEFAULT_SECTION_ORDER,
      pluginId: input.loaded.id,
    };
    const prepared = preparePluginSystemPrompt(section);
    if (!prepared.ok) {
      input.diagnostics.push({
        code:
          prepared.reason === "too_large"
            ? "plugin_system_prompt_too_large"
            : "plugin_system_prompt_invalid",
        message:
          prepared.reason === "too_large"
            ? `Plugin system prompt exceeds ${PLUGIN_SYSTEM_PROMPT_MAX_BYTES} bytes and was skipped`
            : "Plugin system prompt metadata is invalid or exceeds its length limit",
        path: declaration.path,
        pluginId: input.loaded.id,
        severity: "error",
      });
      continue;
    }
    if (
      bytes + prepared.bytes > input.remainingBudgetBytes ||
      sections.length >=
        Math.min(
          PLUGIN_SYSTEM_PROMPT_MAX_SECTIONS,
          input.remainingSections ?? PLUGIN_SYSTEM_PROMPT_MAX_SECTIONS,
        )
    ) {
      input.diagnostics.push({
        code: "plugin_system_prompt_budget_exceeded",
        message: `Plugin system prompts exceed the ${PLUGIN_SYSTEM_PROMPTS_TOTAL_MAX_BYTES} injected bytes or ${PLUGIN_SYSTEM_PROMPT_MAX_SECTIONS} sections budget and were truncated`,
        pluginId: input.loaded.id,
        severity: "warning",
      });
      break;
    }
    bytes += prepared.bytes;
    sections.push(section);
  }
  return { bytes, sections };
}

function collectDeclarations(
  loaded: LoadedPlugin,
  diagnostics: PluginDiagnostic[],
): RawDeclaration[] {
  const declarations: RawDeclaration[] = [];
  const manifest = loaded.manifest;
  const inline = manifest.systemPrompt;
  if (inline !== undefined && inline !== null) {
    if (typeof inline === "string") {
      declarations.push({ content: inline });
    } else {
      diagnostics.push({
        code: "plugin_system_prompt_invalid",
        message: "Plugin systemPrompt must be a string and was ignored",
        path: loaded.manifestPath,
        pluginId: loaded.id,
        severity: "warning",
      });
    }
  }
  const promptPath = manifest.systemPromptPath;
  if (declarations.length === 0 && promptPath !== undefined && promptPath !== null) {
    if (typeof promptPath === "string" && promptPath.trim().length > 0) {
      declarations.push({ path: promptPath.trim() });
    } else {
      diagnostics.push({
        code: "plugin_system_prompt_invalid",
        message: "Plugin systemPromptPath must be a non-empty string and was ignored",
        path: loaded.manifestPath,
        pluginId: loaded.id,
        severity: "warning",
      });
    }
  }
  const multi = manifest.systemPrompts;
  if (multi !== undefined && multi !== null) {
    if (!Array.isArray(multi)) {
      diagnostics.push({
        code: "plugin_system_prompt_invalid",
        message: "Plugin systemPrompts must be an array and was ignored",
        path: loaded.manifestPath,
        pluginId: loaded.id,
        severity: "warning",
      });
    } else {
      for (const entry of multi) {
        const declaration = normalizeMultiEntry(entry);
        if (!declaration) {
          diagnostics.push({
            code: "plugin_system_prompt_invalid",
            message:
              "Plugin systemPrompts entry must be an object with content or path and was ignored",
            path: loaded.manifestPath,
            pluginId: loaded.id,
            severity: "warning",
          });
          continue;
        }
        declarations.push(declaration);
      }
    }
  }
  return declarations;
}

function normalizeMultiEntry(entry: unknown): RawDeclaration | undefined {
  if (!isRecord(entry)) return undefined;
  const declaration: RawDeclaration = {};
  if (typeof entry.name === "string" && entry.name.trim().length > 0) {
    declaration.name = entry.name.trim();
  }
  if (typeof entry.order === "number" && Number.isFinite(entry.order)) {
    declaration.order = entry.order;
  }
  if (typeof entry.content === "string") {
    declaration.content = entry.content;
    return declaration;
  }
  if (typeof entry.path === "string" && entry.path.trim().length > 0) {
    declaration.path = entry.path.trim();
    return declaration;
  }
  return undefined;
}

function readDeclaration(
  declaration: RawDeclaration,
  loaded: LoadedPlugin,
  diagnostics: PluginDiagnostic[],
): string | undefined {
  if (declaration.content !== undefined) return declaration.content;
  const rawPath = declaration.path;
  if (rawPath === undefined) return undefined;
  if (rawPath.includes("\u0000") || isAbsolute(rawPath)) {
    diagnostics.push({
      code: "plugin_system_prompt_outside_root",
      message: `Plugin system prompt path must stay inside the plugin root: ${rawPath}`,
      path: rawPath,
      pluginId: loaded.id,
      severity: "error",
    });
    return undefined;
  }
  const absolute = resolve(loaded.rootPath, rawPath);
  const relativePath = relative(loaded.rootPath, absolute);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    diagnostics.push({
      code: "plugin_system_prompt_outside_root",
      message: `Plugin system prompt path escapes the plugin root: ${rawPath}`,
      path: rawPath,
      pluginId: loaded.id,
      severity: "error",
    });
    return undefined;
  }
  // 上面的字面路径校验挡不住符号链接：插件根内放一个指向根外的链接仍能读到外部文件。
  // 再用 realpath 对"根"和"目标"各解析一次，链接逃逸一律拒绝。
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = realpathSync(loaded.rootPath);
    realTarget = realpathSync(absolute);
  } catch (error) {
    diagnostics.push({
      code: "plugin_system_prompt_read_failed",
      message: `Plugin system prompt could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
      path: absolute,
      pluginId: loaded.id,
      severity: "error",
    });
    return undefined;
  }
  const realRelativePath = relative(realRoot, realTarget);
  if (realRelativePath.startsWith("..") || isAbsolute(realRelativePath)) {
    diagnostics.push({
      code: "plugin_system_prompt_outside_root",
      message: `Plugin system prompt resolves outside the plugin root via symlink: ${rawPath}`,
      path: rawPath,
      pluginId: loaded.id,
      severity: "error",
    });
    return undefined;
  }
  try {
    // 先看大小再读盘：启动路径上不该把一个超大文件整个读进内存。
    // 文件级上限与单段上限同口径；纯空白超限属于病态输入，直接拒绝。
    if (statSync(absolute).size > PLUGIN_SYSTEM_PROMPT_MAX_BYTES) {
      diagnostics.push({
        code: "plugin_system_prompt_too_large",
        message: `Plugin system prompt exceeds ${PLUGIN_SYSTEM_PROMPT_MAX_BYTES} bytes and was skipped`,
        path: absolute,
        pluginId: loaded.id,
        severity: "error",
      });
      return undefined;
    }
    return readFileSync(absolute, "utf8");
  } catch (error) {
    diagnostics.push({
      code: "plugin_system_prompt_read_failed",
      message: `Plugin system prompt could not be read: ${error instanceof Error ? error.message : String(error)}`,
      path: absolute,
      pluginId: loaded.id,
      severity: "error",
    });
    return undefined;
  }
}
