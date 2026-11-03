/** Native context managed module; dependencies match architecture-policy.yaml. */
export const nativeContextModule = {
  id: "native-context-adapters",
  requires: ["native-context-contracts", "zcode-cli"],
  provides: ["native-context-adapters"],
  publicEntrypoints: ["contract.ts", "index.ts"],
} as const;
