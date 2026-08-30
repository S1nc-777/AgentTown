# Task 6 手动验收观察记录

> 路径约定：`artifacts/requirement-experiment/run-<YYYY-MM-DD>/observations.md`（每次验收一个目录）
> 由主控在验收完成后填写，如实记录，不粉饰。

## 实验信息

- 日期/时间：______
- 领导 Agent：□ Claude Code（`claude-lead-software` 模板）□ OpenCode（`opencode-lead-software` 模板）
- 员工 Agent：Fake（全部）
- 小项目需求原文：______
- 代理环境：`HTTP_PROXY/HTTPS_PROXY=http://127.0.0.1:7897`（□ 已设置 □ 未设置）
- Opt-in 环境：`AGENTTOWN_FORBID_REAL_PROBES=0` + `AGENTTOWN_REAL_CLAUDE=1`（或 `AGENTTOWN_REAL_OPENCODE=1`，可加 `AGENTTOWN_OPENCODE_MODEL=<model>`）

## 探针（Step 1）

- 命令与输出摘要：______
- 探针通过：□ 是 □ 否（失败原因：______）

## 全流程（Step 2-3）

- 公司初始化：`agenttown init --template <模板>` → □ 成功 □ 失败（______）
- `agenttown run "<需求>"` → □ 成功 □ 失败（______）
- 事件序列（leader 拆解 → 员工提交 → 审核 → 集成，按 timeline 观察）：
  - leader 首次行动（action 类型/内容）：______
  - 任务拆分数量：______
  - developer 提交次数：______
  - reviewer 审核结论：______
  - 集成/交付结果：______
- 实际耗时：______
- Token 用量（`usage` / CLI 输出）：______
- 失败/卡点（如实记录）：______

## 对照实验（Step 4）

- 单 Agent 命令：`claude -p "<同一需求>"`（或 opencode run）
- 单 Agent 耗时：______ / Token：______ / 质量观感：______
- 主观对比（分工清晰度 / 进度可见性 / 成本 / 速度）：______

## 已知风险点核对

- Claude `stop_reason` 词表（end_turn 之外的值是否误报 adapter.error）：______
- send 时 `session.started` 事件是否被 SessionManager 误当会话重建：______
- `--permission-mode` 是否触发权限拦截（permission_denials）：______
- OpenCode 模型显式指定是否生效：______
- 其他：______

## 结论备注

- 本次验收是否达成"真实领导 + 员工完成真实小项目"：□ 达成 □ 部分（______） □ 未达成（______）
