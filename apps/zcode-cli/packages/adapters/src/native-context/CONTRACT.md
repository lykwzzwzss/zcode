# native-context-adapters

实现 ContextArchivePort 的 SQLite 查询与插件系统提示词文件读取。

- 会话消息和 part 是唯一持久化原文；查询不删除或重写历史，不维护第二份 transcript。
- 搜索、分层状态与解压在库内选取，仅把有界结果送回 Runtime；解压分页按 UTF-16 位置续读并保留完整代理对。
- 游标固定会话、分支、选择条件和行水位，排除进行中的工具消息。普通追加不改变续页，撤销或改变选择必须重新开始。
- 插件提示词读取受现有插件配置、工作区信任和文件边界约束；拼接由 Runtime 的系统提示词路径统一负责。

SqliteSessionStore 在打开数据库后暴露只读 contextArchive；工具执行器负责取消、权限与结果持久化。
