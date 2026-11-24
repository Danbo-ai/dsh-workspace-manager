# dsh-workspace-manager

DeepSeek Harness（DSH）插件：多层工作区结构 + 会话标题。

## 能力

- **多层工作区**：在侧栏里把工作区组成父子层级，每深一级缩进一格；提供 `/mkws <名字> [父目录]` 与工具 `workspace_child_create`，建目录 + 注册工作区 + 生成 `AGENTS.md` 与 `.dsh/memory.md` 骨架一次完成（不建 `.git`，层级标记留给顶层仓）。
- **会话搬家**：`workspace_move_session` 把会话连日志一起挪到另一个工作区，改写日志 cwd、同步投影缓存，搬前自动备份。
- **工作区清理**：`workspace_list` / `workspace_remove` / `workspace_reconcile`，登记与磁盘目录对不上时把会话交给最近的父工作区。
- **会话标题**：`/titles` 与 `session_titles_collect` / `session_titles_apply` / `set_session_titles`，按「语义项目/对应的事情」批量整理侧栏标题并即时写回。

## 安装

在 DSH 里用插件安装入口，粘贴 Git 地址或本地目录：

```
github:Danbo-ai/dsh-workspace-manager
```

要求 DSH `>=0.2.2-rc.1`。零依赖，纯 JS，不需要构建。

## 说明

- 侧栏树按「磁盘父工作区」排布：父工作区目录必须包含子工作区目录。
- 一个层级只保留顶层一个 `.git`；子目录建 `.git` 会切断 `AGENTS.md` 祖先链与项目内 skills 的发现。
- `state/`、`.tmp/` 是本地产物，不随仓库分发。

## 许可

MIT
