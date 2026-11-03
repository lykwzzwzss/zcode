/** Native context managed module; dependencies match architecture-policy.yaml. */
export const nativeContextModule = {
  id: "native-context-runtime",
  requires: ["native-context-contracts", "tool-discovery", "zcode-cli"],
  provides: ["native-context-runtime"],
  publicEntrypoints: ["contract.ts", "index.ts"],
} as const;
