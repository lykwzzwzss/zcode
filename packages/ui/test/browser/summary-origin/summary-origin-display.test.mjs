/**
 * compact 分隔线「摘要来源」稳定浏览器验收用例。
 *
 * 覆盖（详见 docs/design/v2/compact/summary-origin-display.md）：
 * - manual + model_written / runtime_generated：来源文案，scope 固定 compaction；
 * - auto + runtime_generated / host_provided / model_written：来源文案；
 * - reactive：投影层折叠为 origin=auto，断言 data-origin=auto 且渲染 auto 文案；
 * - 缺 summaryOrigin 的 success 回退（auto→completedAuto，manual→completed）；
 * - failed / cancelled / noop 即使带 summaryOrigin 也走状态文案；
 * - office 模式：auto 走 contextOptimization 文案，manual 仍走 contextCompaction；
 * - 8 组视口组合（390/1200 × light/dark × zh-CN/en-US）+ 无 pageerror + 无横向溢出。
 *
 * 执行（仓库根目录）：
 *   node --test packages/ui/test/browser/summary-origin/summary-origin-display.test.mjs
 * 需要显式 Chrome 时设置 CHROME_EXECUTABLE_PATH。
 * 该用例为人工开发应用回归，不自动晋升 CI；本文件不改产品行为。
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

// 从 manual-review/pending 移到 summary-origin 后少一层目录，仍向上六层会把 Vite 指向仓库外。
const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/summary-origin/summary-origin-display.fixture.tsx";
const fixturePath = "/summary-origin-fixture?";

let server;
let browser;
let origin;

before(async () => {
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "summary-origin-display-fixture",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith(fixturePath)) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
              ),
            );
          });
        },
      },
    ],
    resolve: { alias: { "@": `${root}packages/ui/src` } },
    optimizeDeps: { entries: [entry.slice(1)] },
    server: { host: "127.0.0.1", port: 0, hmr: false },
  });
  await server.listen();
  origin = server.resolvedUrls.local[0];
  browser = await chromium.launch(
    process.env.CHROME_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROME_EXECUTABLE_PATH }
      : { channel: "chrome" },
  );
});

after(async () => {
  await browser?.close();
  await server?.close();
});

/**
 * 期望矩阵与 docs/design/v2/compact/summary-origin-display.md §7.1 保持一致；
 * 文案常量来自 packages/ui/src/i18n/locales/{zh-CN,en-US}.ts。
 * origin/status 必须与 fixture 中该 testid 的 marker 输入一致。
 */
const CASES = [
  // coding：manual 也可以由模型写摘要，origin 与 summaryOrigin 相互独立。
  {
    testid: "marker-manual-model_written-running",
    origin: "manual",
    status: "running",
    zh: "模型摘要已提交，正在保存",
    en: "Model summary submitted, saving",
  },
  {
    testid: "marker-manual-model_written-success",
    origin: "manual",
    status: "success",
    zh: "模型摘要已完成",
    en: "Model summary completed",
  },
  {
    testid: "marker-manual-runtime_generated-success",
    origin: "manual",
    status: "success",
    zh: "运行时摘要已完成",
    en: "Runtime summary completed",
  },
  // coding：auto 三个来源。
  {
    testid: "marker-auto-runtime_generated-running",
    origin: "auto",
    status: "running",
    zh: "正在生成运行时摘要",
    en: "Generating runtime summary",
  },
  {
    testid: "marker-auto-runtime_generated-success",
    origin: "auto",
    status: "success",
    zh: "运行时摘要已完成",
    en: "Runtime summary completed",
  },
  {
    testid: "marker-auto-host_provided-success",
    origin: "auto",
    status: "success",
    zh: "宿主摘要已完成",
    en: "Host summary completed",
  },
  {
    testid: "marker-auto-model_written-success",
    origin: "auto",
    status: "success",
    zh: "模型摘要已完成",
    en: "Model summary completed",
  },
  // reactive：reactive trigger 投影后 origin=auto，无专属文案分支。
  {
    testid: "marker-reactive-auto-runtime_generated-success",
    origin: "auto",
    status: "success",
    zh: "运行时摘要已完成",
    en: "Runtime summary completed",
  },
  // 缺 summaryOrigin 的成功回退。
  {
    testid: "marker-auto-fallback-success",
    origin: "auto",
    status: "success",
    zh: "上下文已自动压缩",
    en: "Context automatically compressed",
  },
  {
    testid: "marker-manual-fallback-success",
    origin: "manual",
    status: "success",
    zh: "上下文已压缩",
    en: "Context compressed",
  },
  // 非 running/success：来源被忽略，走状态文案。
  {
    testid: "marker-manual-summaryOrigin-failed",
    origin: "manual",
    status: "failed",
    zh: "上下文压缩失败",
    en: "Context compression failed",
  },
  {
    testid: "marker-auto-summaryOrigin-cancelled",
    origin: "auto",
    status: "cancelled",
    zh: "上下文压缩已中断",
    en: "Context compression interrupted",
  },
  {
    testid: "marker-manual-summaryOrigin-noop",
    origin: "manual",
    status: "noop",
    zh: "上下文已是最新，无需压缩",
    en: "Context is up to date; no compression needed",
  },
  // office：auto 走 contextOptimization。
  {
    testid: "marker-office-auto-model_written-running",
    origin: "auto",
    status: "running",
    zh: "模型优化摘要已提交，正在保存",
    en: "Model optimization summary submitted, saving",
  },
  {
    testid: "marker-office-auto-runtime_generated-success",
    origin: "auto",
    status: "success",
    zh: "上下文优化摘要已完成",
    en: "Context optimization summary completed",
  },
  {
    testid: "marker-office-auto-host_provided-success",
    origin: "auto",
    status: "success",
    zh: "宿主优化摘要已完成",
    en: "Host optimization summary completed",
  },
  {
    testid: "marker-office-auto-fallback-success",
    origin: "auto",
    status: "success",
    zh: "已优化对话",
    en: "Conversation optimized",
  },
  {
    testid: "marker-office-auto-fallback-failed",
    origin: "auto",
    status: "failed",
    zh: "优化对话失败",
    en: "Conversation optimization failed",
  },
  // office：manual 不属于自动优化对话，仍用 compaction scope。
  {
    testid: "marker-office-manual-model_written-success",
    origin: "manual",
    status: "success",
    zh: "模型摘要已完成",
    en: "Model summary completed",
  },
];

for (const width of [390, 1200])
  for (const theme of ["light", "dark"])
    for (const locale of ["zh-CN", "en-US"]) {
      test(`summary origin display ${width} ${theme} ${locale}`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${origin}summary-origin-fixture?theme=${theme}&locale=${locale}`);

        for (const expected of CASES) {
          const section = page.getByTestId(expected.testid);
          await section.waitFor();
          await section
            .getByText(locale === "zh-CN" ? expected.zh : expected.en, { exact: true })
            .waitFor();
          const row = section.locator('[data-testid^="v4-row-"]').first();
          assert.equal(await row.getAttribute("data-row-kind"), "timelineMarker");
          assert.equal(await row.getAttribute("data-marker-type"), "compact");
          // data-origin 直接来自 projection 行：reactive 必须已折叠为 auto。
          assert.equal(await row.getAttribute("data-origin"), expected.origin);
          assert.equal(await row.getAttribute("data-status"), expected.status);
        }

        // reactive 用例额外确认：UI 收到的行是 auto，且没有 reactive 属性残留。
        const reactiveRow = page
          .getByTestId("marker-reactive-auto-runtime_generated-success")
          .locator('[data-testid^="v4-row-"]')
          .first();
        assert.equal(await reactiveRow.getAttribute("data-origin"), "auto");

        assert.deepEqual(errors, []);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
          false,
        );
        await page.close();
      });
    }
