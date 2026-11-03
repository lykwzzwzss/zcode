import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../../", import.meta.url));
const cli = join(root, "apps/zcode-cli");
const exec = promisify(execFile);
const turbo = createRequire(import.meta.url).resolve("turbo");
const manifest = JSON.parse(await readFile(join(cli, "package.json"), "utf8"));
const cliPackages = [];
for (const parent of ["packages", "tools"]) {
  for (const entry of await readdir(join(cli, parent), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = `apps/zcode-cli/${parent}/${entry.name}`;
    let pkg;
    try {
      pkg = JSON.parse(await readFile(join(root, directory, "package.json"), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    cliPackages.push({ ...pkg, directory });
  }
}

async function dryRun(args, cwd) {
  const result = await exec(process.execPath, [turbo, ...args, "--dry=json"], {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
    timeout: 60_000,
  });
  assert.doesNotMatch(
    result.stderr,
    /Unable to calculate transitive closures|not found in lockfile/u,
  );
  return JSON.parse(result.stdout);
}

test("CLI 与 App 共用完整的根 workspace 和锁文件", async () => {
  for (const file of ["pnpm-workspace.yaml", "pnpm-lock.yaml", "turbo.json"]) {
    await access(join(root, file));
    await assert.rejects(access(join(cli, file)), { code: "ENOENT" });
  }
  const lock = parse(await readFile(join(root, "pnpm-lock.yaml"), "utf8"));
  for (const pkg of cliPackages) assert.ok(lock.importers[pkg.directory], pkg.directory);
});

for (const task of ["build", "clean", "coverage", "lint:fix", "test", "typecheck"]) {
  test(`CLI ${task} 入口只选择 CLI 包并保留依赖图`, async () => {
    const [command, ...args] = manifest.scripts[task].split(" ");
    assert.equal(command, "turbo");
    const graph = await dryRun(args, cli);
    assert.deepEqual([...graph.packages].sort(), cliPackages.map((pkg) => pkg.name).sort());
    const primary = graph.tasks.filter(
      (entry) => entry.task === task && entry.command !== "<NONEXISTENT>",
    );
    const expected = cliPackages.filter((pkg) => pkg.scripts?.[task]).map((pkg) => pkg.name);
    const cliNames = new Set(cliPackages.map((pkg) => pkg.name));
    assert.deepEqual(
      primary
        .filter((entry) => cliNames.has(entry.package))
        .map((entry) => entry.package)
        .sort(),
      expected.sort(),
    );
    if (task !== "build") assert.ok(primary.every((entry) => cliNames.has(entry.package)));
    assert.ok(
      graph.tasks.every((entry) => entry.package !== "zcode-cli"),
      "聚合脚本不能递归调用自身",
    );
    if (task === "typecheck") {
      const core = graph.tasks.find((entry) => entry.taskId === "@zcode/core#typecheck");
      assert.ok(core.dependencies.includes("@zcode/shared#build"));
      const shared = graph.tasks.find((entry) => entry.taskId === "@zcode/shared#build");
      assert.ok(shared.dependencies.includes("@zcode/model-option-map#build"));
      assert.ok(
        graph.tasks.some(
          (entry) => entry.taskId === "@zcode/model-option-map#build" && entry.command === "tsc",
        ),
      );
      assert.ok(core.hashOfExternalDependencies);

      // 旧子锁缺 workspace 时仍会成功退出，却丢失根依赖；必须核对真实任务图与缓存键。
      const fromRoot = await dryRun(
        ["run", task, "--filter=./apps/zcode-cli/packages/*", "--filter=./apps/zcode-cli/tools/*"],
        root,
      );
      const hashes = (plan) =>
        Object.fromEntries(plan.tasks.map((entry) => [entry.taskId, entry.hash]));
      assert.deepEqual(hashes(graph), hashes(fromRoot));
    }
  });
}

test("桌面 Agent 构建包含根依赖与迁移后的配置缓存输入", async () => {
  const graph = await dryRun(["run", "build:desktop-agent", "--filter=@zcode/cli"], root);
  const task = graph.tasks.find((entry) => entry.taskId === "@zcode/cli#build:desktop-agent");
  for (const dependency of [
    "@zcode/provider-node#build",
    "@zcode/shared#build",
    "@zcode/bootstrap#build",
  ])
    assert.ok(task.dependencies.includes(dependency), dependency);
  for (const file of [
    "config/provider/zcode-builtin.json",
    "pnpm-lock.yaml",
    "apps/zcode-cli/package.json",
  ]) {
    const input = relative(join(root, task.directory), join(root, file)).replaceAll("\\", "/");
    assert.ok(task.inputs[input], file);
  }
  assert.ok(graph.tasks.every((entry) => entry.package !== "zcode-cli"));
});

test("只验证类型或 SDK 的构建不声明虚构 dist 产物", async () => {
  const graph = await dryRun(
    [
      "run",
      "build",
      "--filter=@zcode/office-runtime",
      "--filter=@zcode/zcode-cua",
      "--filter=@zcode/zcode-cua-plugin",
      "--filter=@zcode/typescript",
    ],
    root,
  );
  for (const entry of graph.tasks.filter((entry) => graph.packages.includes(entry.package))) {
    assert.deepEqual(entry.resolvedTaskDefinition.outputs, [], entry.taskId);
  }
});

test("CUA producer checkout 参与 CLI 测试缓存键并由 Turbo 传入", async () => {
  const config = JSON.parse(await readFile(new URL("../../turbo.json", import.meta.url), "utf8"));
  assert.ok(config.tasks.test.env.includes("ZCODE_CUA_REPO"));
  assert.ok(config.tasks.test.env.includes("VITEST_MAX_WORKERS"));
});

test("Browser Use 缓存携带真实的类型和 browser-client 产物", async () => {
  const graph = await dryRun(["run", "build", "--filter=@zcode/browser-use-plugin"], root);
  const task = graph.tasks.find((entry) => entry.taskId === "@zcode/browser-use-plugin#build");
  assert.deepEqual(task.resolvedTaskDefinition.outputs, [
    "dist-types/**",
    "scripts/browser-client.mjs",
  ]);
});

test("压缩 E2E 容器从根 workspace 构建且入口仍存在", async () => {
  const directory = join(cli, "e2e/compact-microcompact");
  const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  const args = pkg.scripts["docker:build"].split(" ");
  const context = resolve(directory, args.at(-1));
  assert.equal(context, resolve(root));
  const dockerfile = await readFile(join(directory, "Dockerfile"), "utf8");
  const entrypoint = JSON.parse(dockerfile.match(/^ENTRYPOINT (.+)$/mu)[1]);
  await access(join(context, entrypoint[1]));
  assert.match(dockerfile, /^COPY \. \.$/mu);
  assert.match(dockerfile, /pnpm install --frozen-lockfile .*--filter @zcode\/cli\.\.\./u);
});

test("CLI 全量测试先准备跨 workspace 的模型映射构建产物", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../../apps/zcode-cli/package.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.scripts.pretest, "pnpm --dir ../.. --filter @zcode/model-option-map build");
});
