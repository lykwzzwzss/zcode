/**
 * compact 分隔线「摘要来源」浏览器验收 fixture。
 *
 * 为 `summary-origin-display.test.mjs` 提供稳定渲染入口：按 testid 渲染一组 compact
 * timelineMarker 行，覆盖 manual / auto / reactive（投影后 origin=auto）三条路径、
 * 三个 summaryOrigin、running/success 与各类回退状态，以及 office 模式的优化文案。
 *
 * 本文件只构造「投影后的行」并交给真实 ConversationRowView 渲染，不修改产品行为。
 * 注意：reactive 在投影层已折叠为 origin="auto"（product-projection mapCompactMarkerOrigin），
 * UI 收不到 reactive；因此这里用 `marker-reactive-auto-*` 用例表示「reactive 投影结果」。
 */
import { createRoot } from "react-dom/client";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ConversationRowView } from "@/v4/ConversationRowView.js";
import { StoreContext } from "@/store/StoreProvider.js";
import "@/styles.css";

const query = new URLSearchParams(location.search);
const theme = query.get("theme") === "light" ? "light" : "dark";
document.documentElement.className = `${theme} theme-zai-${theme}`;

type SummaryOrigin = "model_written" | "runtime_generated" | "host_provided";
type CompactStatus = "running" | "success" | "failed" | "noop" | "cancelled";

interface MarkerCase {
  testid: string;
  rowId: number;
  origin: "manual" | "auto";
  status: CompactStatus;
  /** 缺省表示不写 summaryOrigin（走状态回退文案）。 */
  summaryOrigin?: SummaryOrigin;
  /** true 时挂 office 界面模式的 StoreContext mock。 */
  office?: boolean;
}

const CASES: MarkerCase[] = [
  // ---- coding 模式（无 StoreContext：useIsOfficeMode 回退 false）----
  // manual 也可以由模型写摘要（origin 与 summaryOrigin 相互独立）。
  {
    testid: "marker-manual-model_written-running",
    rowId: 610,
    origin: "manual",
    status: "running",
    summaryOrigin: "model_written",
  },
  {
    testid: "marker-manual-model_written-success",
    rowId: 611,
    origin: "manual",
    status: "success",
    summaryOrigin: "model_written",
  },
  {
    testid: "marker-manual-runtime_generated-success",
    rowId: 612,
    origin: "manual",
    status: "success",
    summaryOrigin: "runtime_generated",
  },
  // auto：三个来源 + running 文案。
  {
    testid: "marker-auto-runtime_generated-running",
    rowId: 613,
    origin: "auto",
    status: "running",
    summaryOrigin: "runtime_generated",
  },
  {
    testid: "marker-auto-runtime_generated-success",
    rowId: 614,
    origin: "auto",
    status: "success",
    summaryOrigin: "runtime_generated",
  },
  {
    testid: "marker-auto-host_provided-success",
    rowId: 615,
    origin: "auto",
    status: "success",
    summaryOrigin: "host_provided",
  },
  {
    testid: "marker-auto-model_written-success",
    rowId: 616,
    origin: "auto",
    status: "success",
    summaryOrigin: "model_written",
  },
  // reactive：trigger=Reactive 在投影层折叠为 origin="auto"，UI 与 auto 完全一致。
  {
    testid: "marker-reactive-auto-runtime_generated-success",
    rowId: 617,
    origin: "auto",
    status: "success",
    summaryOrigin: "runtime_generated",
  },
  // 缺 summaryOrigin 的成功回退：auto→completedAuto，manual→completed。
  { testid: "marker-auto-fallback-success", rowId: 618, origin: "auto", status: "success" },
  { testid: "marker-manual-fallback-success", rowId: 619, origin: "manual", status: "success" },
  // 非 running/success 状态即使带 summaryOrigin 也走状态文案（来源被忽略）。
  {
    testid: "marker-manual-summaryOrigin-failed",
    rowId: 620,
    origin: "manual",
    status: "failed",
    summaryOrigin: "runtime_generated",
  },
  {
    testid: "marker-auto-summaryOrigin-cancelled",
    rowId: 621,
    origin: "auto",
    status: "cancelled",
    summaryOrigin: "host_provided",
  },
  {
    testid: "marker-manual-summaryOrigin-noop",
    rowId: 622,
    origin: "manual",
    status: "noop",
    summaryOrigin: "model_written",
  },
  // ---- office 模式（StoreContext mock interfaceMode="office"）----
  {
    testid: "marker-office-auto-model_written-running",
    rowId: 623,
    origin: "auto",
    status: "running",
    summaryOrigin: "model_written",
    office: true,
  },
  {
    testid: "marker-office-auto-runtime_generated-success",
    rowId: 624,
    origin: "auto",
    status: "success",
    summaryOrigin: "runtime_generated",
    office: true,
  },
  {
    testid: "marker-office-auto-host_provided-success",
    rowId: 625,
    origin: "auto",
    status: "success",
    summaryOrigin: "host_provided",
    office: true,
  },
  // office auto 缺省成功 = contextOptimization.completed（没有 completedAuto key）。
  {
    testid: "marker-office-auto-fallback-success",
    rowId: 626,
    origin: "auto",
    status: "success",
    office: true,
  },
  {
    testid: "marker-office-auto-fallback-failed",
    rowId: 627,
    origin: "auto",
    status: "failed",
    office: true,
  },
  // office 的 manual 仍用 compaction scope（manual 不属于「自动优化对话」）。
  {
    testid: "marker-office-manual-model_written-success",
    rowId: 628,
    origin: "manual",
    status: "success",
    summaryOrigin: "model_written",
    office: true,
  },
];

// 只实现 useZCodeStoreWithDefault 读取路径（state.interfaceMode）；引用保持稳定避免重复订阅。
const officeStore = {
  getState: () => ({ interfaceMode: "office" }),
  subscribe: () => () => {},
};

function markerRow(spec: MarkerCase) {
  return {
    rowId: spec.rowId,
    turnId: "turn-1",
    createdAt: 1,
    createdAtSeq: spec.rowId,
    kind: "timelineMarker",
    lane: "assistantWork",
    marker: {
      type: "compact",
      origin: spec.origin,
      status: spec.status,
      ...(spec.summaryOrigin ? { summaryOrigin: spec.summaryOrigin } : {}),
    },
  } as never;
}

function MarkerCaseSection({ spec }: { spec: MarkerCase }) {
  return (
    <section data-testid={spec.testid} data-case-mode={spec.office ? "office" : "coding"}>
      <ConversationRowView row={markerRow(spec)} context={{} as never} />
    </section>
  );
}

const codingCases = CASES.filter((spec) => !spec.office);
const officeCases = CASES.filter((spec) => spec.office);

createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider initialLocale={query.get("locale") === "en-US" ? "en-US" : "zh-CN"}>
    <TooltipProvider>
      <main className="space-y-4 bg-background p-4 text-foreground">
        <div data-mode="coding">
          {codingCases.map((spec) => (
            <MarkerCaseSection key={spec.testid} spec={spec} />
          ))}
        </div>
        <StoreContext.Provider value={officeStore as never}>
          <div data-mode="office">
            {officeCases.map((spec) => (
              <MarkerCaseSection key={spec.testid} spec={spec} />
            ))}
          </div>
        </StoreContext.Provider>
      </main>
    </TooltipProvider>
  </ZCodeIntlProvider>,
);
