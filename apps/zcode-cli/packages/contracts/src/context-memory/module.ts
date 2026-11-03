/** Native context managed module; dependencies match architecture-policy.yaml. */
export const nativeContextModule = {
  id: "native-context-contracts",
  requires: ["zcode-cli"],
  provides: ["native-context-contracts"],
  publicEntrypoints: ["contract.ts", "index.ts"],
} as const;
