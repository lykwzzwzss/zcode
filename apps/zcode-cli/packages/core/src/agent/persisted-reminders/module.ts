export const persistedReminderHydrationModule = {
  id: "persisted-reminder-hydration",
  requires: ["tool-discovery", "zcode-cli"],
  provides: ["persisted-reminder-hydration"],
  publicEntrypoints: ["contract.ts"],
} as const;
