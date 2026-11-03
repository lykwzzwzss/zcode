/**
 * persisted-reminder-hydration 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import {
  metadataFromSyntheticTextPart,
  syntheticSystemReminderAttachmentFromTextPart,
} from "./contract.js";

/** 合成提醒正文先解析出 runtime metadata，再由同一合同判定能否还原为 reminder attachment。 */
export function exampleHydrateSyntheticReminderText(
  part: Parameters<typeof syntheticSystemReminderAttachmentFromTextPart>[0],
) {
  return {
    metadata: metadataFromSyntheticTextPart(part),
    attachment: syntheticSystemReminderAttachmentFromTextPart(part),
  };
}
