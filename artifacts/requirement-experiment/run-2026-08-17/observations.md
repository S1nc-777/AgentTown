# Task 6 手动验收观察记录（2026-08-17 凌晨）

> 运行目录：`D:\agenttown-task6`（独立 git 仓库，初始提交 4b99a81）
> 由主控在验收完成后填写，如实记录，不粉饰。

## 实验信息

- 日期：2026-08-17 01:50 ~ 02:30（多轮迭代，最终成功轮约 10 分钟）
- 领导 Agent：**OpenCode**（`alibaba-cn/deepseek-v4-flash`，阿里云百炼端点，$0.002/轮级）
- 员工 Agent：Fake（git fixture：git-developer-a/b + git-review-approve）
- 需求原文（company.yaml mission）：用 Node.js 实现一个命令行待办应用（CLI todo app，支持 add/list/complete/delete 四个子命令，JSON 文件持久化），并编写单元测试证明其行为（每个子命令至少一个测试用例）
- 代理环境：HTTP_PROXY/HTTPS_PROXY=http://127.0.0.1:7897（Clash，用户授权自行启动）
- Opt-in：AGENTTOWN_FORBID_REAL_PROBES=0 + AGENTTOWN_REAL_OPENCODE=1 + AGENTTOWN_OPENCODE_SCRIPT（node 脚本入口）+ AGENTTOWN_OPENCODE_MODEL

## 探针（Step 1）

- `opencode run --format json --model alibaba-cn/deepseek-v4-flash --dir <dir> "..."` → step_start/text/step_finish JSONL 事件流 ✅
- `claude -p --output-format json` → 单对象 JSON（session_id/usage）✅ 但模型后端（deepseek-v4-flash[1m]）行为不稳定：首轮 148s~300s+ 波动、成本 $0.13~1.56/轮（越界探索环境）→ **主验收改用 OpenCode**（稳定 30-45s/轮、$0.002/轮）

## 全流程（Step 2-3）——最终成功轮事件链

```
3-6  session.started ×4（leader + developer-a/b + reviewer）
7    company.started
8-11 leader 被驱动（驱动循环）→ task.propose → task.created
13-18 leader task.assign → git.workspace.created → task.assigned → task.started
20-27 developer-a git 提交 → git.submission.validated → review.package.created → task.submitted → task.review_requested
28-31 reviewer review.approved → task.review_approved → integration.queued
33-43 集成准备 → git.integration.committed → task.completed（任务 1）
48-54 leader propose 任务 2 → assign → task.started
55-66 developer-b 提交 → 审核 → review.approved → integration.queued
68-77 集成 → task.completed（任务 2）
```

- 耗时：约 10 分钟（两次 leader 推理轮 + 两次员工 fixture 提交 + 审核 + 集成）
- Token/成本：leader 累计 ~13,264 input / 122 output tokens（约 $0.05）；fake 员工零成本
- 交付：集成 ref `agenttown/run-*/integration` 含 fixture 文件（feature-a.txt/b、README）——**协作机制闭环验证，非真实代码**（fake 员工按确定性脚本提交占位文件，产品设计如此）

## 失败/卡点（如实记录，均为真实接入暴露的问题，已逐项修复）

1. **npm shim 无法 spawn**：`claude`/`opencode` 是 npm 全局 shim（.cmd/.ps1），Node spawn ENOENT → 适配器新增 `executable` env（`AGENTTOWN_CLAUDE_EXECUTABLE` 指向 claude.exe、`AGENTTOWN_OPENCODE_SCRIPT` 走 node 包装）
2. **claude 不认 `--cd`**（从 codex 骨架照搬的错误选项）→ 改为 spawn cwd=projectRoot
3. **opencode 卡 stdin**：spawn 后 stdin pipe 打开时 opencode 等待输入（30s+ 零输出）→ spawn 后立即 `child.stdin.end()`
4. **ACTION 类型不匹配**：模型输出 `proposeTask`，合法类型是 `task.propose` → FORMAT_INSTRUCTION 列枚举
5. **payload 缺字段**：propose 缺 objective/acceptanceCriteria → 提示结构
6. **taskId null**：模型 propose 输出 taskId:null 被拒 → 提示必须生成非空 id
7. **assignee 字段名**：模型用 `assigneeId`，policy 要求 `assignee` → 提示字段名
8. **dependencies 格式**：模型输出字符串/对象，要求 string[] → 强化提示
9. **employee.message 误用**：propose 被拒后模型改用 employee.message 询问用户（缺 recipient 被拒）→ 提示"你是领导，直接行动，不要询问"
10. **架构缺口（核心）**：`company.started` 后没有任何机制驱动 leader → **Task 6a 实现 leader 驱动循环**（启动后自动 propose → assign → 跟踪至完成，fake 场景 + 测试 + E2E 兼容）
11. **非 E2E git 公司员工场景错误**：developer 用 "complete"（非 git）提交失败 → coreStartupScenarios 在含真实 agent 公司分配 git-developer-a/b + git-review-approve
12. **CLI env 覆盖缺陷（产品缺陷）**：`core-process.ts` 硬编码 `AGENTTOWN_FORBID_REAL_PROBES: "1"` 覆盖用户设置 → 真实 Agent 用户无法通过 CLI 启动（本次绕开 CLI 直跑 core；需后续修复）
13. **lease TTL 5s 自动暂停**：core 启动后无客户端连接 5s 即 pause → 验收用 300s TTL

## 对照实验（Step 4）

- 单 Agent：`opencode run --format json --model alibaba-cn/deepseek-v4-flash --dir D:\agenttown-task6 "<同一需求>"`
- 结果：**45 秒、$0.0002、真实代码**——todo.js（2.6KB）+ todo.test.js（2KB）+ package.json，`node --test` 7/7 通过
- 主观对比：
  - **速度/成本**：单 Agent 完胜（45s/$0.0002 vs 协作 ~10min/leader $0.05）
  - **代码产出**：单 Agent 产出真实可用代码；协作当前只产出 fixture 占位文件（fake 员工不写代码——P1C 需真实员工）
  - **可监督性/流程**：协作胜——任务拆分、分配、提交、审核、集成全程事件可查（timeline/status），确定性闭环
  - **领导自主性**：协作中领导自主拆任务（2 个任务）+ 自主分配（developer-a/b），无需人工注入——方向 A 核心验证点 ✅

## 结论备注

- 达成度：**部分达成**——"真实 Agent 领导自主拆任务/派工/驱动完整协作闭环"✅；"完成小型真实项目"❌（fake 员工只提交占位文件，代码产物需真实员工/半真实员工）
- 核心证据：异构协作的**机制价值**（流程可见、审核把关、确定性集成）成立；**代码产出优势尚未验证**（当前对比中单 Agent 完胜，但两者产出不同质——占位 vs 真实）
- 后续：接真实员工（OpenCode 员工）后再做同质对比；CLI env 覆盖缺陷需修复；leader 驱动循环的 pause/resume 再驱动待补
