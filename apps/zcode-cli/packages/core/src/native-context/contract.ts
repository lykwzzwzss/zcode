/** Context-owned pure fold planning; Runtime remains the sole active-history writer. */
export { buildContextFold, retainedSummaryBudget } from "./hierarchy.js";
export { suggestCompactRanges } from "./range-planner.js";
export type { ContextFoldMetadata } from "@zcode/contracts/context-memory";

const DEEPSEEK_FLASH_MODEL_IDS = new Set(["deepseek-v4.1-flash", "deepseek-flash"]);

/** 按模型 id 识别专项策略；网关/provider 名称不参与，避免换接入方式就丢失预算。 */
export function isDeepSeekFlashModel(model: { modelId: string }): boolean {
  return DEEPSEEK_FLASH_MODEL_IDS.has(model.modelId.toLowerCase());
}
