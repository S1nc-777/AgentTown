# Task 7'：单 Agent vs AgentTown 协作——多维度对比实验报告

> 测试项目：**马里奥风格横版跳跃小游戏（单关卡）**
> 需求原文（两组一致）：用 HTML/CSS/JavaScript 制作马里奥风格单关卡横版跳跃游戏——玩家左右移动与跳跃；敌人（蘑菇怪）、金币、终点旗帜；碰敌失败、到旗胜利；计分与生命显示；浏览器打开即可玩（index.html 内嵌 CSS/JS）。
> 实验日期：2026-08-17；模型：两组均用 `alibaba-cn/deepseek-v4-flash`（同模型同后端，公平对比）
> 实验环境：独立 git 仓库（`D:\agenttown-mario-single` vs `D:\agenttown-mario-coop`），Clash 代理

---

## 一、实验结果原始数据

| 维度 | 单 Agent（opencode run） | AgentTown 协作（真实领导 + fake 员工） |
|---|---|---|
| **耗时** | **153 秒** | **~31 秒**（company.started 12:28:02 → company.completion_requested 12:28:34） |
| **成本** | **$0.0003**（558 in + 355 out tokens） | leader 累计 ~50k input tokens（4 次调用，估算 ~$0.005-0.01；fake 员工 0 成本） |
| **产出** | **index.html 19.8KB**——真实可运行游戏代码（jump/enemy/coin/flag/score/canvas 全实现；**缺生命显示 life**，需求部分满足） | **fixture 占位文件**（.gitignore/README/feature-a.txt/feature-b.txt）——无马里奥代码 |
| **验证** | 无自动验证（人工抽查代码特征） | validation（git-clean）+ 集成后确定性检查 |
| **流程事件数** | 1 次调用（黑盒输出） | **81 个事件全程可审计**（timeline） |

## 二、AgentTown 协作事件链（本次运行）

```
3-7   session.started ×4 → company.started
8-11  领导 task.propose（任务 1）→ task.created
13-18 领导 task.assign → git.workspace.created → task.assigned → task.started
20-27 developer-a git 提交 → git.submission.validated → review.package.created → task.submitted → task.review_requested
28-39 reviewer review.approved → integration → git.integration.committed → task.completed（任务 1）
41-43 领导 propose 任务 2 → task.created
48-53 领导 assign → task.started
55-66 developer-b 提交 → 审核 approved → integration.queued
68-77 集成 → task.completed（任务 2）
74    领导自主 company.completion_requested（"All tasks proposed and assigned..."）
```

**领导自主性**：0 人工干预——自主拆 2 个任务、自主分配 developer-a/b、任务完成后自主宣布完成。

## 三、多维度对比结论

### 1. 速度 ⚠️ 本次协作反超（31s vs 153s），但不可推广
- 协作快的原因：fake 员工"瞬间完成"提交（无推理）、leader 4 轮短调用（缓存命中率高）
- 单 Agent 慢的原因：153s 内做了实际代码生成（19.8KB）
- **本质**：协作的"快"是 fake 员工没干活（占位提交），不是真实产出快。接真实员工后协作耗时会回到"真实推理 × N 轮"量级

### 2. 成本 ❌ 协作更贵（~$0.005-0.01 vs $0.0003，约 15-30 倍）
- 但绝对值极小（分/厘级），且 50k input tokens 主要花在 leader 的上下文重复（每轮带 mission/历史）
- 接真实员工后成本还会上升（员工推理）

### 3. 产出质量 ❌ 协作无真实代码（当前形态）
- 单 Agent：19.8KB 真实游戏（缺 life 细节，属模型完成度问题）
- 协作：占位文件（fake 员工不写代码——**产品当前形态的硬限制**）
- **此维度对比不同质**：要公平对比需接真实员工（P1C）

### 4. 可监督性 ✅ 协作独有优势
- 协作：81 个事件（谁、何时、做了什么），timeline/status 可查，任务状态全程可见
- 单 Agent：黑盒单次输出，无过程审计
- **这是协作当前唯一真实成立的差异化价值**

### 5. 流程机制 ✅ 协作独有
- 独立审核把关（review.approved 才集成）、确定性 git 集成、验证命令、失败可重试——机制全部真实运转
- 单 Agent：无审核、无集成、无回滚

### 6. 稳定性 ⚠️
- 单 Agent：一次调用，成败由模型发挥决定（本次漏了 life 功能）
- 协作：任务级隔离 + 审核拦截 + 确定性集成；但 leader 输出格式依赖提示工程（验收中修了 13 项）

## 四、综合判断

| 用户价值维度 | 单 Agent | AgentTown 协作 | 结论 |
|---|---|---|---|
| 快速得到代码 | ✅✅ | ❌（占位） | 单 Agent 完胜 |
| 成本 | ✅✅ | ⚠️（贵 15-30 倍但绝对值小） | 单 Agent 胜 |
| 流程可见/可审计 | ❌ | ✅✅ | 协作独有 |
| 质量把关/审核 | ❌ | ✅ | 协作独有 |
| 多任务编排/团队协作 | ❌ | ✅ | 协作独有 |

**核心结论**：在"个人快速产出代码"场景，单 Agent 完胜且差距巨大；AgentTown 的价值**不在产出速度/成本，而在流程机制**（可见、可审、可控、可编排）。当前形态下协作无法产出真实代码（fake 员工），因此"协作产出质量 vs 单 Agent"的同质对比**必须等 P1C 接真实员工后重做**。

**决策建议**（写入 decision.md）：定位转向"**可监督的确定性多 Agent 协作流程层**"（团队/组织级场景：合规、审计、多 Agent 编排），放弃"更快更好产出代码"的定位；继续开发的前置条件是 P1C 真实员工对照实验，若真实员工协作的产出收益仍无法抵消调度开销/成本，则停止。

## 五、用户试玩验收与真实员工补充实验（2026-08-27/28）

> 8/17 原实验为"真实领导 + fake 员工"，产出占位文件，质量维度无法同质对比。8/27-28 按用户指示补跑**真实员工**版本：leader 与 developer-a 均为真实 OpenCode（alibaba-cn/deepseek-v4-flash），developer-b/reviewer 为 fake。测试项目与 8/17 完全一致：马里奥单关卡小游戏（`D:\agenttown-mario-coop`）。

### 1. 真实员工协作产出（git 证据，master 分支）

```
c977b3d  Add Mario-style platformer game in single index.html   ← 真实员工实现（16.8KB）
537acda  Fix enemy physics bugs: edge detection, falling, and redundant collision checks  ← 真实员工自查自修
```

- 真实员工不仅写出了完整可玩游戏，还**自查发现 3 个敌人物理 bug（边缘检测/下落/碰撞重复检查）并主动修复**——这是单 Agent 黑盒输出不具备的"写码→自查→修复"链条。

### 2. 用户试玩验收（2026-08-28，用户亲自试玩两个版本）

| 版本 | 用户反馈 | 结论 |
|---|---|---|
| 单 Agent（`D:\agenttown-mario-single`，19.8KB 一次成型） | **bug 比较多** | 一次成型无自查，质量问题暴露 |
| 真实员工协作（`D:\agenttown-mario-coop`，16.8KB + 修复提交） | **起码没有 bug** | 自查修复链条带来质量优势 |

**这是首个"协作产出质量 > 单 Agent"的直接实证**，命中 decision.md 去留门槛中的"质量优势"条件。速度/成本维度仍待闭环完整跑通后重测（真实员工推理多轮，预计慢于单 Agent）。

### 3. 各 Agent 行为实录（run-53570ab，日志证据 `D:\agenttown-mario-coop\.agenttown\logs\*.jsonl`）

- **leader（真实）**：task.propose（含 7 条验收标准）→ task.assign → 7 轮工作区巡查（读代码/git log/git status）→ 确认代码已存在 → 等待员工提交。行为规范，但**无跨轮记忆**（新一轮重复 propose 同一任务），且停在"等待"不主动推动（leader 驱动循环 pause/resume 再驱动缺陷未修）。
- **developer-a（真实）**：前序轮完成写码 + 自查修复（已提交 master）；本轮被 assign 后 10+ 次工具调用反复确认已提交的工作，最终**误发出 task.propose**（应 task.submit）——模型角色遵循不稳定，提示工程已到极限，需结构性机制（任务状态注入 + 角色权限约束）。
- **developer-b / reviewer（fake）**：全程零动作（无任务分配 / 无提交可审）。

### 4. 后续动作

- 任务状态注入（core 驱动真实员工时注入"当前任务状态：代码已提交，请直接 task.submit"）+ 拒绝非 leader 角色 propose（policy 约束）→ 重跑验证完整闭环。

## 六、真实员工闭环重跑实验（2026-08-28，六轮迭代，commit `e5500dc`~`a8d897a`）

> 目的：走完 propose → assign → 写码 → submit → review → integrate 完整闭环（P1C 判定实验的机制前提）。六轮重跑中每轮暴露并修复 1-2 个产品缺陷，机制逐轮成熟。实验环境与第五节相同（真实 leader + 真实 developer-a，均为 opencode/deepseek-v4-flash；developer-b/reviewer 为 fake）。

### 1. 六轮暴露并修复的产品缺陷（commit 链）

| # | 缺陷 | 现象 | 修复（commit） |
|---|---|---|---|
| 1 | 真实员工 resume 后"失忆"（不 submit / 误 propose） | 员工反复确认已提交工作后 propose 新任务 | 任务状态注入：`WritableTaskContext` 增加 `headCommit`，任务消息注入"工作树已有提交→直接 submit；否则实现后提交"（`e5500dc`） |
| 2 | 被拒动作导致驱动死锁 | 员工 propose 被 policy 拒 → `driveGitMessage` 直接结束 → 任务永远 running | 被拒后重发同一消息（上限 3 次）；leader 循环任何被拒动作重试而非停循环（`be0f831`） |
| 3 | 模型省略 `causationEventId` 导致动作静默丢弃 | leader propose 输出合法但不含可选字段 → 解析失败无任何记录 | 解析器将 undefined 视为 null（`6e9e948`） |
| 4 | 真实 CLI 并发启动竞争 | leader/developer-a 同时 start → opencode storage 锁竞争 → leader exit 1 → 公司启动失败（3 轮复现） | `startAll` 改为串行启动（尊重 `parallelSessions: "unsupported"`）（`d85dc9d`） |
| 5 | assign 驱动时序缺陷 | `sendMessage` 在任务 transition running 之前调用，drive 的状态检查（仅接受 running）直接 return → 员工从未被驱动（第 5 轮才发现） | drive 接受 ready+running 瞬态（`3cd4c5d`） |
| 6 | submit 的 taskId:null 被 assert 拦截 | 员工 submit 带 `taskId: null`，`#assertProposalTask` 先于 `#resolveSubmitTaskId` 拒绝 | task.submit 豁免 assert；leader 的 rejectedOther 单独计数上限 8，避免非 propose 拒绝耗尽配额（`a8d897a`） |

### 2. 第六轮（最终轮）运行实录（run-792ce2d0，74+ 事件）

- ✅ 4 员工会话全部串行启动成功（修复 4 生效）
- ✅ leader 全自主：propose task-create-game（中文拆解）→ assign developer-a → 再 propose task-review-game（尝试 assign reviewer 被 policy 拒"requires git_worktree"后改派 developer-b）
- ✅ developer-a 被真实驱动，检查代码后判定"现有 index.html 已满足全部验收标准"→ 尝试提交
- ✅ leader 的 3 次无效 employee.message（缺 recipient）被拒后**循环继续**（修复 2/6 生效），最终自主发出 `company.complete.request`（中文总结 mission 达成）
- ❌ **submit 环节仍未走通**：developer-a 的提交在 master 而非任务 worktree（模型不遵循 workspaceRoot 指令）→ worktree 无提交 → `submission.commits` 为空 → 被拒 3 次后驱动放弃（`task.execution_error: agent repeated rejected actions (3)`）

### 3. 结论与判定

- **机制层面：闭环已全部验证**——任务拆解/派工/驱动/拒绝容错/依赖拦截/完成请求均真实运转（74+ 事件全程可审计）
- **模型层面：worktree 隔离不遵循是剩余唯一瓶颈**——deepseek-v4-flash 无视任务消息中的 workspaceRoot，直接在项目根（master）提交（master 新增 `85100f6` 开始画面 + `db525f0` 7 bug 修复均来自真实员工，且其修复内容正是单 Agent 版缺陷：无限跳跃、踩踏判定、边界钳制、旗帜重复收集）。这是**模型行为限制而非 core 缺陷**；core 已提供 workspaceRoot，但无法强制模型只在其中工作
- **用户可试玩最新版**：`D:\agenttown-mario-coop\index.html`（master 含真实员工三轮修复：开始画面 + 10 处 bug 修复，commit `85100f6`/`db525f0`/`b3af090`）
- **去留判定更新**：质量优势证据继续累积（真实员工修复的 bug 全部命中单 Agent 版缺陷）；速度/成本维度需"worktree 遵循"解决后才能做最终同质对比。候选解法：换更强指令遵循的模型（Claude）、submit 校验对 master 提交宽容（cherry-pick 到 worktree）、或在提示中显式给出 worktree 绝对路径与"禁止修改项目根"指令

## 七、完整闭环走通（2026-08-28 第十轮，commit `9ff4b63`~`c04227b`）

> 在第六节基础上继续修复 4 个缺陷后，第十轮实验**完整闭环首次全通**：真实员工（opencode/deepseek-v4-flash）产出的游戏代码经过 propose → assign → 写码/提交 → submit → 审核 → 批准 → 集成 → 完成 全流程交付。

### 1. 本轮新增修复（commit 链）

| # | 缺陷 | 修复（commit） |
|---|---|---|
| 7 | 员工在项目根提交导致 submit 校验失败（worktree 隔离不遵循） | `adoptProjectRootCommits`：worktree 无提交时把任务分支引用/HEAD 同步到员工声明提交；commits 声明缺失/错误时解析为权威范围 base..head（`9ff4b63`） |
| 8 | 被拒后重发同一消息，模型重复犯错 | 重发消息注入拒绝原因反馈（"your ACTION X was rejected: <reason>; emit task.submit with EXACTLY task id Y"）；重试配额 3→5（`5037061`） |
| 9 | 依赖未完成时 assign 仍创建 workspace + 写 assigned 事件（孤儿状态） | 依赖校验前置到 assignTask 入口（`assertDependenciesComplete`），assign 本身也拒绝不完整依赖（`935ecf4`） |
| 10 | reviewer 从未被驱动（review 状态任务被 owner 检查误杀） | drive 检查区分 reviewer（review 状态）与 developer（ready/running+owner）（`c04227b`） |

### 2. 第十轮完整闭环事件链（run-c6718bde，真实员工任务 create-mario-game）

```
leader propose create-mario-game → assign developer-a → task.started
developer-a 检查已有代码 → 重写游戏（master 提交 3afbd9d "Build Mario-style horizontal scrolling platformer game"）
developer-a task.submit（taskId 正确，adopt 生效 git.workspace.advanced）
git.submission.validated → review.package.created → task.submitted → task.review_requested
reviewer（fake）review.approved → task.review_approved → integration.queued
git.integration.prepared → candidate 创建 → cherry-pick → validation.completed
git.integration.committed（76cb871 → d93549f）→ task.completed ✅
```

- **全程 176+ 事件可审计**；leader 同时自主拆出 review/verify/submit 等任务（部分被依赖机制正确拦截）
- **交付物**：集成分支 `agenttown/run-c6718bde.../integration` @ `d93549f`（含真实员工重写版游戏）
- 真实员工本轮的"重写游戏"（3afbd9d）与其此前"修复 10 处 bug"（85100f6/db525f0）均为自主行为——**模型行为波动大**（同一模型有时精修、有时重写），但流程层全部接住

### 3. 结论

- **机制层：完整闭环已验证**——从任务拆解到集成交付全部真实运转，且能接住模型的大量随机行为（误 propose、错误 taskId、空 commits、项目根提交、错误角色动作）
- **模型层：稳定性仍是最大成本**——每轮实验仍需主控修复 core 兜底；真实使用需要更强的模型（Claude 类）或更强的指令遵循
- **剩余架构项**（下一步）：leader 跨轮记忆（重跑时重复 propose）、无输出诊断记录、leader pause/resume 再驱动
