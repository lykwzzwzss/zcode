import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/native-context.fixture.tsx";
let server, browser, origin;
before(async () => {
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "native-context-fixture",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
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

for (const width of [390, 1200])
  for (const theme of ["light", "dark"])
    for (const locale of ["zh-CN", "en-US"]) {
      test(`native context ${width} ${theme} ${locale}`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${origin}fixture?theme=${theme}&locale=${locale}`);
        for (let i = 0; i < 9; i++) {
          const trigger = page.getByTestId(`case-${i}`).getByRole("button").first();
          await trigger.focus();
          await page.keyboard.press("Enter");
          await assertEventuallyExpanded(trigger);
        }
        const first = page.getByTestId("case-0");
        await first
          .getByText(locale === "zh-CN" ? /压缩请求已排队/ : /request is queued/)
          .waitFor();
        await first.getByText("summary preview", { exact: true }).waitFor();
        assert.equal(await first.locator("details[open]").count(), 0);
        await page
          .getByTestId("case-1")
          .getByText(/1,000 → 500/)
          .waitFor();
        await page
          .getByTestId("case-1")
          .getByText(/200.*100.*25/)
          .waitFor();
        await page.getByTestId("case-2").getByText("found snippet", { exact: true }).waitFor();
        await page.getByTestId("case-2").getByText("search-next", { exact: true }).waitFor();
        await page.getByTestId("case-3").getByText("page-next", { exact: true }).waitFor();
        await page.getByTestId("case-3").getByText("page.txt", { exact: true }).waitFor();
        await page
          .getByTestId("case-4")
          .getByText(locale === "zh-CN" ? "没有匹配结果。" : "No matches found.")
          .waitFor();
        await page.getByTestId("case-5").getByText("archive unavailable").waitFor();
        await page.getByTestId("case-6").getByText("legacy result text").waitFor();
        for (const [index, size] of [
          [7, 60],
          [8, 200],
        ]) {
          const section = page.getByTestId(`case-${index}`);
          const nodes = section
            .locator("span")
            .filter({ hasText: new RegExp(`^page-${size}-node-\\d+$`) });
          assert.equal(await nodes.count(), size);
          const last = section.getByText(`page-${size}-node-${size - 1}`, { exact: true });
          await last.waitFor();
          await last
            .locator("xpath=../..")
            .getByText(new RegExp(`${locale === "zh-CN" ? "输出" : "output"} ${size - 1}`))
            .waitFor();
          await section.getByText(`cursor-${size}`, { exact: true }).waitFor();
        }
        await first.locator("summary").click();
        assert.equal(await first.locator("details[open]").count(), 1);
        assert.deepEqual(errors, []);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
          false,
        );
        await page.close();
      });
    }

async function assertEventuallyExpanded(trigger) {
  await trigger.waitFor();
  assert.equal(await trigger.getAttribute("aria-expanded"), "true");
}
