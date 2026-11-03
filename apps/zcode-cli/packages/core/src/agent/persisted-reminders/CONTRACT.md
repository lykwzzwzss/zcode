# Persisted reminder hydration

本模块唯一拥有持久化 synthetic text 到 runtime metadata / reminder attachment 的纯解析。
沿用既有 metadata 校验、历史 source 别名、descriptor 和正文包装规则；无 I/O、无可变状态。

`syntheticSystemReminderAttachmentFromParts` 按 part id 去重并忽略 ignored text 后，只有一个
非空 synthetic text 且 descriptor 允许时才返回 attachment。混合正文或文件、真实用户输入、
background_task / subagent_message、real_user / tool_result 通道与未知身份不会获得附件豁免。
单 part 解析用于水合混合 user 内容；metadata 和包装解析供同一水合流程复用。

session 水合与 hierarchy 成员重放必须调用此同一合同；重放只对 user-role 消息使用附件豁免。
返回 undefined 不表示损坏，只表示仍需普通对话成员身份。缺失成员和未声明 child boundary 的
错误由 compact owner 决定并继续 fail-closed；本模块不提供恢复降级或持久化修复。
