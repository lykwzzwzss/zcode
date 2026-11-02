# ZCode（个人定制构建）

基于 ZCode CLI 的个人构建，在保留原有工具面与协议的前提下，补上了三块能力：

1. **原生 billion-context** —— 模型自己决定何时压缩、压缩后可检索、可解压；
2. **插件系统提示词注入** —— 插件可以通过清单声明 system 段，宿主按信任边界追加；
3. **压缩生命周期钩子** —— `PreCompact` / `PostCompact`，可观察也可接管折叠。

> 本仓库是**定制源码**。上游桌面端 UI 不在此仓库内；仓库只包含可构建出 CLI 的部分。

---

## 相对上游新增的能力

### 1. 原生 billion-context（四个常驻工具）

| 工具 | 作用 |
| --- | --- |
| `CompactStatus` | 列出全部压缩边界：折了多少条、token 从多少到多少、什么时候、什么触发 |
| `SearchContext` | 在**持久化 transcript** 里检索，包括已经被折叠掉的原文；命中标注 `(folded)` |
| `DecompressContext` | 把某个折叠区间（或指定 message id）原样放回上下文 |
| `CompactNow` | 模型自决压缩：可带 `instructions` 指定必须保留的文件、决策、精确字符串 |

关键设计：

- **压缩只替换内存历史，SQLite 里的原文一条不删** —— 所以检索与解压永远有源可查；
- **增量折叠**：最近 4 层摘要作为「索引」保留，不再参与下一次摘要请求；更早的层会并入
  下一次摘要，不会出现既不摘要也不保留的覆盖空洞。保留层只存摘要正文（剥掉续写前言），
  按 `compactRetainedMessageIds` 落盘，重启后仍在；
- **检索与解压只看当前分支**：rewind 之后的旧分支不会被翻出来，也不会被解压回上下文；
- **解压不再静默裁剪**：工具输出保留到 20k，单次默认 60k 字符；任何一级裁剪都会把
  `truncated` 置真，同时受 116KB 字节上限约束；
- **自决落地在安全点**：`CompactNow` 只排队，真正的折叠发生在「工具批次结束、下一次模型请求之前」；
- **增长提醒对齐 billion-context 的两层设计**：增长层至少 50k 一步（大窗口按自动阈值的 10%
  放大）、gate 为步长的 45%；压力层以自动折叠阈值为基准，75% 起提醒、95% 起换紧急措辞；
- **工具按需暴露**：四个工具走宿主的延迟工具机制（`shouldDefer`）——schema 不进每轮请求，
  `DeferredToolCall` 按名字即可直调；某个会话里搜过一次后，下一轮它转为直连工具。

### 2. 插件 system 段注入

插件清单可声明 `systemPrompt` / `systemPromptPath` / `systemPrompts[]`：

- 路径必须相对插件根，绝对路径、`..` 越界、符号链接逃逸一律拒绝；
- 单段 32 KiB、全部启用插件合计 64 KiB，按 trim 后字节记账；
- 注入为 `injectionTarget: "system"`、`cacheHint: "stable"`，并用
  `<plugin_system_prompt name="…" plugin="…">` 包裹，标明这是第三方内容；
- 显式设置 `customSystemPrompt` 时整段跳过；子代理与 workflow actor 不注入。

### 3. 压缩钩子

`PreCompact` 钩子可以只观察，也可以直接返回 `compactionSummary` 让宿主跳过模型摘要；
待折叠历史渲染成 JSONL 写进钩子的 `transcript_path`，不进 stdin（避免大历史堵住管道）。
`PostCompact` 只观察：折叠前后 token、省下多少、摘要长度。

---

## 目录结构

```
apps/zcode-cli/           # CLI 主体（自带 workspace）
  packages/contracts/     #   工具与协议的 schema
  packages/core/          #   runtime、context builder、工具实现
  packages/adapters/      #   模型/存储/插件的适配层
  packages/bootstrap/     #   应用装配
  packages/cli/           #   入口与打包（dist/zcode.cjs、SEA 可执行文件）
packages/shared/          # 协议 v4 的行 schema 与共享类型
```

## 构建

需要 Node 20+ 与 pnpm 9+。

```bash
cd apps/zcode-cli
pnpm install
pnpm --filter @zcode/contracts build
pnpm --filter @zcode/adapters build
pnpm --filter @zcode/core build
pnpm --filter @zcode/bootstrap build
pnpm --filter @zcode/cli build      # 产出 packages/cli/dist/zcode.cjs
```

把 `packages/cli/dist/zcode.cjs` 放到 ZCode 的 `resources/glm/zcode.cjs` 即可生效
（Windows 上需要重启客户端）。

### 单文件可执行文件

Release 里提供 `zcode-windows-x64.exe`（Node SEA 打包），无需安装 Node：

```bash
zcode-windows-x64.exe --help
```

## 配套插件

无限幻境：起源（ZCode 版）：
[lykwzzwzss/zcode-infinite-fantasy-origins](https://github.com/lykwzzwzss/zcode-infinite-fantasy-origins)

```bash
zcode plugins marketplace add lykwzzwzss/zcode-infinite-fantasy-origins
zcode plugins install infinite-fantasy-origins@zcode-infinite-fantasy
```

上游不识别插件清单里的 `systemPrompts` 字段，所以该插件只在本构建上生效。

## 已知限制

- 插件 system 段是本构建的能力，换回官方客户端会静默失效；
- `runtime-compact` 的部分用例在 Windows 上失败（测试用 `/tmp/...` 路径），与功能无关。

## 许可

沿用上游许可，见 [LICENSE](./LICENSE)；第三方声明见 [NOTICE.md](./NOTICE.md)、
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)。
