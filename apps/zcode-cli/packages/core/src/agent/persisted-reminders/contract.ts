/** Pure persisted reminder identity shared by history hydration and compact replay. */
export {
  dedupeParts,
  isProviderWrappedSystemReminderText,
  metadataFromSyntheticTextPart,
  runtimeMessageMetadataFromPartMetadata,
  syntheticSystemReminderAttachmentFromParts,
  syntheticSystemReminderAttachmentFromTextPart,
} from "./hydration.js";
