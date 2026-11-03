import type { DatabaseSync } from "node:sqlite";

/** 持久化文本的完整可读表示；只在 SQLite 请求单条 part 时构造，不构造整个 transcript。 */
export function archivePartText(data: string): string {
  const part = JSON.parse(data);
  if (part.type === "text") return part.ignored ? "" : String(part.text ?? "");
  if (part.type !== "tool") return "";
  const state = part.state ?? {};
  if (!["completed", "error"].includes(state.status)) return "";
  const input = state.input === undefined ? "-" : JSON.stringify(state.input);
  const output =
    typeof state.error === "string" && state.error
      ? `error: ${state.error}`
      : `output: ${typeof state.output === "string" ? state.output : ""}`;
  return `[tool ${part.tool} ${state.status}] input: ${input} ${output}`;
}
function queryTerms(query: string): string[] {
  const normalized = query.toLowerCase().trim(),
    terms = new Set(normalized.split(/\s+/u).filter(Boolean));
  // 中文检索不能只靠空白分词；短语未完整出现时仍可由相邻双字词片召回。
  for (const run of normalized.match(/[\u4e00-\u9fff]{2,}/gu) ?? []) {
    for (let index = 0; index + 2 <= run.length; index++) terms.add(run.slice(index, index + 2));
  }
  return [...terms];
}
export function textScore(text: string, query: string): number {
  const lower = text.toLowerCase();
  const needle = query.toLowerCase().trim();
  if (!needle) return 0;
  let score = lower.includes(needle) ? 20 : 0;
  for (const term of queryTerms(query)) {
    let index = lower.indexOf(term),
      hits = 0;
    while (index >= 0 && hits < 12) {
      score += 3;
      hits++;
      index = lower.indexOf(term, index + term.length);
    }
  }
  return score;
}
export function textSnippet(text: string, query: string, radius: number): string {
  const lower = text.toLowerCase();
  const terms = [query.trim().toLowerCase(), ...queryTerms(query)];
  const found = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0);
  const foldedAnchor = found[0] ?? 0;
  let anchor = 0,
    foldedOffset = 0;
  // 大小写折叠可能改变字符数（如 İ）；将命中位置映回原文，避免 snippet 切偏。
  for (const character of text) {
    const length = character.toLowerCase().length;
    if (foldedOffset + length > foldedAnchor) break;
    foldedOffset += length;
    anchor += character.length;
    if (foldedOffset === foldedAnchor) break;
  }
  const start = Math.max(0, anchor - radius),
    end = Math.min(text.length, anchor + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}
export function sliceText(text: string, start: number, size: number): string {
  let end = Math.min(text.length, start + size);
  // 不在 UTF-16 代理对中间分页；即使 maxChars=1 也必须有进展且保持原文。
  if (
    end < text.length &&
    /[\uD800-\uDBFF]/u.test(text[end - 1] ?? "") &&
    /[\uDC00-\uDFFF]/u.test(text[end] ?? "")
  )
    end--;
  if (end === start && start < text.length) end = Math.min(text.length, start + 2);
  return text.slice(start, end);
}
export function registerArchiveText(db: DatabaseSync): void {
  db.function("zcode_context_text", { deterministic: true }, (data) =>
    archivePartText(String(data)),
  );
  db.function("zcode_context_score", { deterministic: true }, (text, query) =>
    textScore(String(text), String(query)),
  );
  db.function("zcode_context_snippet", { deterministic: true }, (text, query, radius) =>
    textSnippet(String(text), String(query), Number(radius)),
  );
  db.function("zcode_context_length", { deterministic: true }, (text) => String(text).length);
  db.function("zcode_context_slice", { deterministic: true }, (text, start, size) =>
    sliceText(String(text), Number(start), Number(size)),
  );
}
