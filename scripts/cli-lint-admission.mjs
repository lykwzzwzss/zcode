import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, posix, resolve } from "node:path";

/** 根 workspace 的 pnpm exec 会混入提示且优先根 binary；直接执行目标包实际解析的版本。 */
export async function oxlintCommand(cwd, node, args) {
  const require = createRequire(join(cwd, "package.json"));
  const manifestPath = require.resolve("oxlint/package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  return { file: node, args: [resolve(dirname(manifestPath), manifest.bin.oxlint), ...args] };
}

/** 当前各包都是直接 oxlint；未知脚本必须显式接入，不能被枚举器悄悄漏过。 */
export function parseLintCommand(command) {
  if (!/^oxlint(?: [\w./*-]+)*$/u.test(command) || /(?:--format| -f)(?: |$)/u.test(command))
    throw new Error(`不支持的 CLI lint 命令：${command}`);
  return command.split(" ").slice(1);
}

export function classifyLintDiagnostics(diagnostics, { relativeDirectory, pristine }) {
  const accepted = [],
    errors = [],
    warnings = [];
  for (const diagnostic of diagnostics) {
    const path = posix.normalize(
      posix.join(relativeDirectory, diagnostic.filename.replaceAll("\\", "/")),
    );
    if (diagnostic.severity !== "error") warnings.push(diagnostic);
    else if (diagnostic.code === "eslint(max-lines)" && pristine.has(path))
      accepted.push(diagnostic);
    else errors.push(diagnostic);
  }
  return { accepted, errors, warnings };
}
