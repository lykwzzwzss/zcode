import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

const contractsRoot = resolve(import.meta.dirname, "../packages/contracts");
const contracts = JSON.parse(readFileSync(resolve(contractsRoot, "package.json"), "utf8"));

// 原生上下文交付回归：可独立运行，不依赖桌面 App 测试项目或 Turbo。
export default defineConfig({
  root: resolve(import.meta.dirname, ".."),
  // 本入口用于源码验收；不能悄悄读取旧 dist，让 schema 修改必须先构建才能被测试发现。
  resolve: {
    alias: Object.entries(contracts.exports).map(([entry, target]) => ({
      find: new RegExp(`^@zcode/contracts${entry === "." ? "" : entry.slice(1)}$`),
      replacement: resolve(
        contractsRoot,
        target.import.replace("./dist/", "./src/").replace(/\.js$/, ".ts"),
      ),
    })),
  },
  test: {
    include: [
      "packages/adapters/tests/plugin-system-prompts.test.ts",
      "packages/adapters/tests/session-store-compact-bundle.test.ts",
      "packages/contracts/tests/compact-now-ranges.test.ts",
      "packages/contracts/tests/rewind.test.ts",
      "packages/bootstrap/tests/cold-event-merge.test.ts",
      "packages/bootstrap/tests/transcript-hydration.test.ts",
      "packages/core/tests/compact-active-ranges.test.ts",
      "packages/core/tests/tool-search-exposure.test.ts",
      "packages/core/tests/compact-policy.test.ts",
      "packages/core/tests/system-reminder-source.test.ts",
      "packages/core/tests/provider-request-messages.test.ts",
      "packages/core/tests/compact-now-ranges.test.ts",
      "packages/core/tests/compact-persistence-selection.test.ts",
      "packages/core/tests/compact-preserved-inputs.test.ts",
      "packages/core/tests/compact-session-ranges.test.ts",
      "packages/core/tests/compact-status.test.ts",
      "packages/core/tests/compact-summary-model-request.test.ts",
      "packages/core/tests/context-memory-tools.test.ts",
      "packages/core/tests/plugin-system-prompts.test.ts",
      "packages/core/tests/post-compact-file-restore.test.ts",
      "packages/core/tests/runtime-compact-telemetry.test.ts",
      "packages/core/tests/runtime-compact.test.ts",
      "packages/core/tests/session-fork.test.ts",
      "packages/core/tests/session-history-hydrator.test.ts",
      "packages/adapters/tests/native-context-archive.test.ts",
      "tests/native-context-soak.test.ts",
      "tests/native-context-regressions.test.ts",
      "packages/contracts/tests/workspace-hook-trust.test.ts",
      "packages/adapters/tests/runner-options.test.ts",
      "packages/core/tests/tool-contracts.test.ts",
      "packages/adapters/tests/plugins.test.ts",
    ],
  },
});
