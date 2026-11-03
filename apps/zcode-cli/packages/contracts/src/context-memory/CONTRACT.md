# native-context-contracts

定义原生上下文记忆工具、摘要节点和存储查询端口，作为 Runtime 与 SQLite adapter 的共同边界。

- 摘要节点引用会话内持久化消息 id 和直接子边界 id；level 与 originalMessageCount 描述层级，不代替原文。
- read 返回页内正文、原文位置 segments 和 nextCursor；只有 nextCursor 缺省才代表本次选择已读完。
- cursor 与选择及分支绑定；每页字符预算可调整。状态和搜索同样支持分页，结果中的计量缺省表示未上报。
- 端口只读且可取消，不改变活跃上下文、会话历史或权限。SessionStorePort 可选挂载该能力，三个记忆读取工具要求它存在；原生 SQLite 始终提供。
