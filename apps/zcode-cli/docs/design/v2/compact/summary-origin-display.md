# Compact 摘要来源（summaryOrigin）展示规则

目标：说明 timelineMarker 的 compact 分隔线如何展示「压缩触发方式（origin）」与「摘要来源
（summaryOrigin）」两类独立信息，固定 manual / auto / reactive 三条真实触发路径在 coding（编程）
与 office（办公）两种界面模式下的文案，并给出稳定的浏览器验收入口。

本文只描述**展示契约**，不改变压缩执行逻辑；执行器与投影的事实来源见文末代码引用。

## 1. 两类信息：origin 与 summaryOrigin

compact marker 行上有两个彼此独立的维度：

| 维度 | 行字段 | 取值 | 含义 | 写入方 |
| --- | --- | --- | --- | --- |
| 触发分组 | `marker.origin` | `manual` / `auto` | 用户主动点击压缩 vs 系统触发 | 投影层 `mapCompactMarkerOrigin(trigger)` |
| 摘要来源 | `marker.summaryOrigin`（可选） | `model_written` / `runtime_generated` / `host_provided` | 摘要文本由谁生成 | 执行器写事件 `reason = "summary_origin:<value>"`，投影层解析 |

约束（`packages/shared/src/zcode-protocol-v4/rows.ts:347-356`）：

- `origin` 枚举只有 `manual` / `auto`；`reactive` 不是行字段。
- `summaryOrigin` 可选；缺省时 UI 回退到纯状态文案（见 §4）。
- `status` 枚举：`running` / `success` / `failed` / `noop` / `cancelled`。

## 2. 投影链：trigger → origin，reason → summaryOrigin

1. 执行器在 Started / Completed 事件里写 `reason`：
   - `runtime/methods/compact-active.ts:321-329`（started）、`:772-787`（completed）：
     `reason = "summary_origin:" + (hostCompactionSummary !== undefined ? "host_provided" : "runtime_generated")`。
   - `runtime/methods/compact-active-ranges.ts:327-334`：host 提供 → `host_provided`；
     用户提交摘要且 `options.modelCompact` → `model_written`；
     其余 → `runtime_generated`；**用户提交摘要但未走 modelCompact 时不写该前缀**（summaryOrigin 缺省）。
2. 投影层解析前缀：`contracts/src/compact/index.ts:93-106`
   `compactSummaryOriginFromReason(reason)`，仅接受三个合法值。
3. 行投影：`product-projection.ts:5070-5075`
   `summaryOrigin = compactSummaryOriginFromReason(payload.reason) ?? prev?.summaryOrigin`，
   即 started 事件先写来源，completed 事件缺 reason 时沿用上一行值。
4. 触发分组：`projection-rows.ts:147-153` `mapCompactMarkerOrigin(trigger)`：
   `manual → "manual"`，**其余全部 → "auto"**（auto / partial / reactive / session_memory）。
   代码注释明确：UI 只区分「用户点击」与「系统触发」，不细分系统触发原因。
5. 冷恢复：`transcript-hydration.ts:320-322` `compactTriggerOfPart(part) = part.trigger ?? (part.auto ? Auto : Manual)`；
   `:324-402` 重放持久化 `reason`（timeline 与 legacy compaction part），因此 resume 后 `summary_origin` 前缀会重新投影，展示不丢。

## 3.三条真实触发路径

| 路径 | 触发点（代码） | CompactTrigger | 行 `origin` | 可能的 `summaryOrigin` |
| --- | --- | --- | --- | --- |
| manual（用户点压缩） | `core/src/runtime/methods/compact.ts:46`（`executeManualCompact`）；`compact-active.ts:157`、`compact-active-ranges.ts:155` 的 `options.trigger ?? Manual` | `Manual` | `manual` | `model_written` / `runtime_generated` / `host_provided`，也可能缺省（用户提交摘要但非 modelCompact） |
| auto（策略自动压缩） | `core/src/runtime/methods/compact.ts:272-293`、`turn-loop.ts:186` | `Auto` | `auto` | 同上；策略路径常见 `runtime_generated` / `host_provided` |
| reactive（provider overflow 后补救） | `core/src/runtime/methods/compact.ts:417-439`、`turn-model-step.ts:922` | `Reactive` | `auto`（投影折叠） | 同上 |

**关键结论：`origin` 表示触发分组，不能推断摘要来源，反之亦然。** manual 也可能显示
`model_written`（模型写摘要）或 `runtime_generated`；auto / reactive 也可能显示
`model_written`（如果走 ranges + modelCompact）。UI 不做「manual ⇒ 模型写」之类推断。

`reactive` 在投影层与 auto 合并后，UI 收到的行与 auto 完全相同（`origin="auto"`），
因此**没有 reactive 专属文案分支**；验收时以「origin=auto 的行正确渲染」证明该路径覆盖。

## 4. 展示判定（优先级从高到低）

UI 判定位于 `packages/ui/src/v4/ConversationRowView.tsx:2000-2030`（`TimelineMarkerRowView` 的
`case "compact"`）。伪代码：

```ts
const running = marker.status === "running";
const automaticOptimization = isOfficeMode && marker.origin === "auto";
const scope = automaticOptimization ? "chat.contextOptimization" : "chat.contextCompaction";

if (marker.summaryOrigin && (running || marker.status === "success")) {
  // 1) 来源文案：只有 running / success 展示来源
  id = `${scope}.${marker.summaryOrigin}.${running ? "started" : "completed"}`;
} else {
  // 2) 状态文案回退
  const action = running
    ? "started"
    : marker.status === "noop"
      ? "skipped"
      : marker.status === "cancelled"
        ? "interrupted"
        : marker.status === "failed"
          ? "failed"
          : marker.origin === "auto" && !automaticOptimization
            ? "completedAuto"
            : "completed";
  id = `${scope}.${action}`;
}
```

由此得到两条容易踩错的语义：

- `failed` / `noop` / `cancelled` **即使带 summaryOrigin 也不展示来源**，走失败/跳过/中断文案。
- 只有 `success` 且缺 summaryOrigin 时才进入 completed / completedAuto 分支；
  `failed` 不会落到 completed。
- `scope` 由 `isOfficeMode && marker.origin === "auto"` 决定，与 summaryOrigin 无关：
  office 的 manual 压缩仍用 `chat.contextCompaction`。

## 5. 文案矩阵

`scope` 由 office 模式 + origin 共同决定：`coding` 一律 `chat.contextCompaction`；
`office && origin=auto` 用 `chat.contextOptimization`；`office && origin=manual` 仍用
`chat.contextCompaction`。

### 5.1 `chat.contextCompaction`（coding 全部；office 的 manual）

| summaryOrigin | status | i18n id 后缀 | zh-CN | en-US |
| --- | --- | --- | --- | --- |
| `model_written` | running | `.model_written.started` | 模型摘要已提交，正在保存 | Model summary submitted, saving |
| `model_written` | success | `.model_written.completed` | 模型摘要已完成 | Model summary completed |
| `runtime_generated` | running | `.runtime_generated.started` | 正在生成运行时摘要 | Generating runtime summary |
| `runtime_generated` | success | `.runtime_generated.completed` | 运行时摘要已完成 | Runtime summary completed |
| `host_provided` | running | `.host_provided.started` | 宿主摘要已提交，正在保存 | Host summary submitted, saving |
| `host_provided` | success | `.host_provided.completed` | 宿主摘要已完成 | Host summary completed |

### 5.2 `chat.contextOptimization`（office && origin=auto）

| summaryOrigin | status | i18n id 后缀 | zh-CN | en-US |
| --- | --- | --- | --- | --- |
| `model_written` | running | `.model_written.started` | 模型优化摘要已提交，正在保存 | Model optimization summary submitted, saving |
| `model_written` | success | `.model_written.completed` | 模型优化摘要已完成 | Model optimization summary completed |
| `runtime_generated` | running | `.runtime_generated.started` | 正在生成上下文优化摘要 | Generating context optimization summary |
| `runtime_generated` | success | `.runtime_generated.completed` | 上下文优化摘要已完成 | Context optimization summary completed |
| `host_provided` | running | `.host_provided.started` | 宿主优化摘要已提交，正在保存 | Host optimization summary submitted, saving |
| `host_provided` | success | `.host_provided.completed` | 宿主优化摘要已完成 | Host optimization summary completed |

## 6. 回退矩阵（缺 summaryOrigin 或 status 非 running/success）

| 条件 | scope（coding） | scope（office && auto） | zh-CN | en-US |
| --- | --- | --- | --- | --- |
| status=`running` | `.started` | `.started` | 正在压缩上下文 / 正在优化对话 | Compressing context / Optimizing conversation |
| origin=`auto`，status=`success`，无 summaryOrigin | `.completedAuto` | `.completed` | 上下文已自动压缩 / 已优化对话 | Context automatically compressed / Conversation optimized |
| origin=`manual`，status=`success`，无 summaryOrigin | `.completed` | `.completed` | 上下文已压缩 | Context compressed |
| status=`noop` | `.skipped` | `.skipped` | 上下文已是最新，无需压缩 / 无需优化对话 | Context is up to date; no compression needed / No conversation optimization needed |
| status=`cancelled` | `.interrupted` | `.interrupted` | 上下文压缩已中断 / 已停止优化对话 | Context compression interrupted / Conversation optimization stopped |
| status=`failed` | `.failed` | `.failed` | 上下文压缩失败 / 优化对话失败 | Context compression failed / Conversation optimization failed |

说明：

- `chat.contextOptimization.completedAuto` **不存在也不需要**：office + auto 的缺省成功文案是
  `chat.contextOptimization.completed`（"已优化对话"），因为「已优化」本身已隐含自动。
- `chat.contextCompaction.completedAuto` 只用于 **coding + auto + 无 summaryOrigin + success**；
  manual 缺省成功仍用 `.completed`。
- 所有文案 key 都在 `scope` 下，因此 office auto 的来源文案是「优化」措辞，manual 未出现在
  office 优化 scope 里。

## 7. 稳定浏览器验收入口

用例路径（稳定目录，不在 `manual-review/pending/`）：

- `packages/ui/test/browser/summary-origin/summary-origin-display.test.mjs`
- fixture：`packages/ui/test/browser/summary-origin/summary-origin-display.fixture.tsx`

执行（仓库根目录）：

```bash
node --test packages/ui/test/browser/summary-origin/summary-origin-display.test.mjs
# 需要指定 Chrome 时：
CHROME_EXECUTABLE_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe" \
  node --test packages/ui/test/browser/summary-origin/summary-origin-display.test.mjs
```

覆盖：`width ∈ {390, 1200}` × `theme ∈ {light, dark}` × `locale ∈ {zh-CN, en-US}` 共 8 组，
每组断言 §7.1 的用例矩阵；另断言每条 marker 行的 `data-origin` / `data-status`、
reactive 模拟行 `data-origin="auto"`、页面无 `pageerror`、无横向溢出。

### 7.1 用例矩阵

| 用例 testid | marker 输入（origin/status/summaryOrigin） | 期望 scope | 期望文案（zh-CN） |
| --- | --- | --- | --- |
| `marker-manual-model_written-running` | manual / running / model_written | compaction | 模型摘要已提交，正在保存 |
| `marker-manual-model_written-success` | manual / success / model_written | compaction | 模型摘要已完成 |
| `marker-manual-runtime_generated-success` | manual / success / runtime_generated | compaction | 运行时摘要已完成 |
| `marker-auto-runtime_generated-running` | auto / running / runtime_generated | compaction | 正在生成运行时摘要 |
| `marker-auto-runtime_generated-success` | auto / success / runtime_generated | compaction | 运行时摘要已完成 |
| `marker-auto-host_provided-success` | auto / success / host_provided | compaction | 宿主摘要已完成 |
| `marker-auto-model_written-success` | auto / success / model_written | compaction | 模型摘要已完成 |
| `marker-reactive-auto-runtime_generated-success` | auto（reactive 投影）/ success / runtime_generated | compaction | 运行时摘要已完成（并断言 data-origin=auto） |
| `marker-auto-fallback-success` | auto / success / 缺省 | compaction | 上下文已自动压缩 |
| `marker-manual-fallback-success` | manual / success / 缺省 | compaction | 上下文已压缩 |
| `marker-manual-summaryOrigin-failed` | manual / failed / runtime_generated | compaction | 上下文压缩失败（来源被忽略） |
| `marker-auto-summaryOrigin-cancelled` | auto / cancelled / host_provided | compaction | 上下文压缩已中断（来源被忽略） |
| `marker-manual-summaryOrigin-noop` | manual / noop / model_written | compaction | 上下文已是最新，无需压缩 |
| `marker-office-auto-model_written-running` | auto / running / model_written | optimization | 模型优化摘要已提交，正在保存 |
| `marker-office-auto-runtime_generated-success` | auto / success / runtime_generated | optimization | 上下文优化摘要已完成 |
| `marker-office-auto-host_provided-success` | auto / success / host_provided | optimization | 宿主优化摘要已完成 |
| `marker-office-auto-fallback-success` | auto / success / 缺省 | optimization | 已优化对话 |
| `marker-office-auto-fallback-failed` | auto / failed / 缺省 | optimization | 优化对话失败 |
| `marker-office-manual-model_written-success` | manual / success / model_written | compaction | 模型摘要已完成（office 的 manual 不走优化 scope） |

该用例为人工开发应用回归：node:test 起 vite dev server + playwright-core 驱动 Chrome，
依赖本机 Chrome；不自动晋升 CI。

### 7.2 运行状态记录（2026-11-03）

复查发现该入口从 `manual-review/pending` 移动后仍向上六层定位 Vite root，实际指向仓库外，
fixture 请求返回 404。修正为当前目录深度后，已在本机执行 §7 的 Node/Chrome 用例：
8 组全部通过，0 失败，耗时约 28 秒。覆盖的是实际 React 行组件及 §7.1 矩阵，
不等同于安装版桌面端到端验收，也未自动晋升 CI。

## 8. 静态核对结论（2026-11-03）

- 投影：`mapCompactMarkerOrigin` 将 reactive 折叠为 auto，符合 §3；manual 折叠为 manual。
- 展示：`ConversationRowView.tsx:2000-2030` 的 scope 选择、summaryOrigin 优先级与 §4/§5 一致；
  fallback 分支顺序（running → noop → cancelled → failed → completedAuto/completed）一致。
- i18n：`packages/ui/src/i18n/locales/{zh-CN,en-US}.ts` 中 6 个来源 key × 2 locale、
  状态 key、以及 `chat.contextOptimization` 全套 key 均存在且文案与 §5/§6 表格一致；
  `chat.contextOptimization.completedAuto` 不存在（符合不可达）。
- 冷恢复：`transcript-hydration.ts` 重放 `reason`，resume 后来源展示不丢。
- 未发现产品行为与本 spec 冲突。

## 9. 相关代码与测试

- 行 schema：`packages/shared/src/zcode-protocol-v4/rows.ts:345-433`
- 投影：`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts:5070-5075`、
  `projection-rows.ts:147-153`
- 来源常量/解析：`apps/zcode-cli/packages/contracts/src/compact/index.ts:93-106`
- 来源写入：`apps/zcode-cli/packages/core/src/runtime/methods/compact-active.ts:321-329,772-787`、
  `compact-active-ranges.ts:327-334,346,671`
- 水合：`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/transcript-hydration.ts:320-402`
- UI：`packages/ui/src/v4/ConversationRowView.tsx:1998-2030`（`MarkerDividerRow` 在 `:1903-1975`，
  输出 `data-row-kind`/`data-status`/`data-origin` 与 `v4-row-<rowId>` testid）
- 既有投影/水合单测：`bootstrap/tests/product-projection.test.ts:5321-5428`、
  `bootstrap/tests/transcript-hydration.test.ts:1119-1131`
