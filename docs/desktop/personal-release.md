# 个人 Windows 发行规则

桌面版本采用 `上游稳定版本-北京时间构建日期`，例如 `3.17.1-20261103`。
基础版本以根 `package.json` 为准；合并上游更新后沿用上游的新基础版本，不另外递增个人
minor/patch。`pnpm version:personal` 只更新根 manifest，重复运行不叠加日期；内部 CLI 与各
workspace 包仍保留各自的版本体系。该日期后缀符合 SemVer 的 prerelease 语法，但个人 GitHub
Release 显式发布为正式 Latest，不使用上游自动更新源。

流程：完成源码与测试 → `pnpm version:personal` → 提交源码 → Windows x64 完整构建与安装包
验证 → 本机安装并核对版本和内核 → 推送个人仓库 → 创建 `v版本号` Release。
`--date YYYYMMDD` 仅用于复现指定构建日期。已发布的同名 tag/Release 不覆盖；一天多次正式
发布时先决定新版本规则，不能伪造日期。

源码、tag 和安装包 metadata 指向同一提交。Release 附件仅为 Windows `.exe` 安装包，
SHA-256 写入发布说明；不上传 unpacked、blockmap、更新清单或依赖缓存。上游 remote 保留，
个人仓库使用独立 remote；历史不相连时保留两边父提交，将已审查的当前完整源码作为合并结果，
不以 force push 删除旧历史。

验证包括原生上下文专题回归、浏览器工具展示场景、类型/Lint/架构门禁，以及安装包自身的
依赖闭包校验。用户配置、API 密钥、会话数据库和外部研究原文均不进入源码或安装包。
