# @agenttown/cli

AgentTown 的命令行工具：初始化项目、启动公司、查看状态与事件流、管理审批与清理。

## 构建与调用

```sh
pnpm --filter @agenttown/cli build          # 编译到 dist/
node packages/cli/dist/main.js --help      # 直接调用（或 pnpm --filter @agenttown/cli start -- --help）
```

安装 bin 后可直接使用 `agenttown` 命令。

## 快速开始

```sh
# 1. 初始化公司配置（生成 .agenttown/company.yaml）
agenttown init

# 2. 启动公司（前台：流式打印事件；Ctrl+C 退出但公司保持运行）
agenttown start

# 或后台启动（Core 日志写入 .agenttown/core.log，随后台 watcher 维持会话）
agenttown start --detach

# 3. 查看状态与任务
agenttown status
agenttown tasks
agenttown timeline
agenttown watch          # 实时终端看板（公司/任务/员工/最新事件，每秒刷新，q 退出）

# 4. 暂停 / 恢复 / 停止
agenttown pause
agenttown resume
agenttown stop --yes
```

## 命令

| 命令 | 说明 |
|---|---|
| `doctor` | 检查环境（node/git/项目可写性） |
| `init [--template minimal\|software-company]` | 初始化 `company.yaml`（不覆盖已有文件） |
| `start [--detach]` | 启动公司；前台流式输出事件，`--detach` 后台运行立即返回 |
| `status` | 公司状态 + 员工状态（角色/状态/当前任务/用量） |
| `tasks` | 任务列表（ID/状态/负责人/标题） |
| `timeline` | 事件时间线（全量分页） |
| `pause` | 暂停公司（checkpoint） |
| `resume` | 从最近 checkpoint 恢复 |
| `stop [--yes]` | 停止公司（`--yes` 跳过确认） |
| `workspaces` | git 工作区列表 |
| `evidence <task-id> [--revision N]` | 任务证据（review package） |
| `deliver` | 交付视图（集成状态） |
| `approvals` | 待审批列表 |
| `approve <id> --reason "..."` / `reject <id> --reason "..."` | 审批决策 |
| `cleanup <run-id> [--yes] [--branches] [--evidence]` | 清理 run 的 worktrees/分支/证据 |
| `watch` | 实时终端看板：公司/任务/员工/最新事件，每秒刷新，按 q 退出（非 TTY 打印单次快照） |
| `help` | 帮助 |

## 环境变量

- `AGENTTOWN_FORBID_REAL_PROBES=0` + `AGENTTOWN_REAL_OPENCODE=1`（或 `AGENTTOWN_REAL_CLAUDE=1`）：启用真实 Agent 员工
- `AGENTTOWN_OPENCODE_MODEL`：opencode 模型（如 `alibaba-cn/deepseek-v4-flash`）
- `AGENTTOWN_CLAUDE_EXECUTABLE` / `AGENTTOWN_CLAUDE_MODEL` / `AGENTTOWN_CLAUDE_EFFORT`：claude 后端配置
- 代理：真实 CLI 需要外网时设置 `HTTP_PROXY`/`HTTPS_PROXY`；DeepSeek 端点需 `NO_PROXY=api.deepseek.com,deepseek.com`

## 状态文件

- `.agenttown/company.yaml`：公司定义（员工/任务/验证配置）
- `.agenttown/agenttown.sqlite`：事实库（事件/任务/提交/审批，全部可审计）
- `.agenttown/core.log`：Core 日志（`start --detach` 时）
- `.agenttown/logs/<employee>.jsonl`：每个员工的会话日志
