import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  classifyLintDiagnostics,
  oxlintCommand,
  parseLintCommand,
} from "../cli-lint-admission.mjs";

test("CLI lint 使用包实际解析的版本并保留 cwd、参数，不经过 pnpm 输出", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cli lint-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, "apps/cli");
  const cwd = join(cli, "packages/example");
  await mkdir(cwd, { recursive: true });
  for (const [parent, version] of [
    [root, "root"],
    [cli, "cli"],
  ]) {
    const directory = join(parent, "node_modules/oxlint");
    await mkdir(join(directory, "bin"), { recursive: true });
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        name: "oxlint",
        bin: { oxlint: "bin/lint.cjs" },
      }),
    );
    await writeFile(
      join(directory, "bin/lint.cjs"),
      `console.log(JSON.stringify({version: '${version}', cwd: process.cwd(), args: process.argv.slice(2)}));`,
    );
  }
  const args = ["src", "--no-ignore", "--format", "json"];
  const command = await oxlintCommand(cwd, process.execPath, args);
  const result = await promisify(execFile)(command.file, command.args, { cwd });
  assert.deepEqual(JSON.parse(result.stdout), {
    version: "cli",
    cwd,
    args,
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
