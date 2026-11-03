import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyLintDiagnostics,
  parseLintCommand,
  packageManagerCommand,
} from "../cli-lint-admission.mjs";

test("CLI lint 同时支持独立 pnpm.exe 与 Node 脚本入口", () => {
  assert.deepEqual(packageManagerCommand("C:/tools/pnpm.exe", "node", ["exec", "oxlint"]), {
    file: "C:/tools/pnpm.exe",
    args: ["exec", "oxlint"],
  });
  assert.deepEqual(packageManagerCommand("/tools/pnpm.cjs", "node", ["exec", "oxlint"]), {
    file: "node",
    args: ["/tools/pnpm.cjs", "exec", "oxlint"],
  });
});

test("只接纳原样上游的行数诊断，其他错误与修改过的文件仍阻断", () => {
  const diagnostics = [
    { filename: "src/original.ts", code: "eslint(max-lines)", severity: "error" },
    { filename: "src/edited.ts", code: "eslint(max-lines)", severity: "error" },
    { filename: "src/original.ts", code: "typescript(no-explicit-any)", severity: "error" },
    { filename: "src/original.ts", code: "eslint(no-unused-vars)", severity: "warning" },
  ];
  const result = classifyLintDiagnostics(diagnostics, {
    relativeDirectory: "apps/zcode-cli/packages/example",
    pristine: new Set(["apps/zcode-cli/packages/example/src/original.ts"]),
  });
  assert.deepEqual(result.accepted, [diagnostics[0]]);
  assert.deepEqual(result.errors, diagnostics.slice(1, 3));
  assert.deepEqual(result.warnings, [diagnostics[3]]);
});

test("保留包原有参数；不默默绕过未知或复合命令", () => {
  assert.deepEqual(parseLintCommand("oxlint src tests --no-ignore"), [
    "src",
    "tests",
    "--no-ignore",
  ]);
  for (const command of [
    "tsc --noEmit",
    "oxlint src && echo done",
    "oxlint 'src path'",
    "oxlint --format text src",
  ])
    assert.throws(() => parseLintCommand(command), /不支持/);
});
