# AgentTown 内测操作指引（30 分钟跑一个小项目）

> 给内测用户的实验流程。目标：让受访者在 30 分钟内亲身体验"真实领导 Agent + 员工分工"完成一个小项目，然后填写问卷。

---

## 前置条件

- Windows 电脑，已安装：
  - Node.js 22+、pnpm 11.9、Git
  - Codex CLI（`codex exec` 可联网运行）
- 已克隆仓库并安装依赖：
  ```powershell
  git clone https://github.com/S1nc-777/AgentTown.git
  cd AgentTown
  pnpm install
  ```

## 实验步骤

1. **准备一个空项目目录**（不要用 AgentTown 源码目录本身）：
   ```powershell
   mkdir C:\tmp\agenttown-demo && cd C:\tmp\agenttown-demo
   git init
   ```

2. **用 AgentTown 初始化公司并运行**（当前为 Fake 员工 + Codex 领导的实验版）：
   ```powershell
   agenttown init --template codex-lead-software
   agenttown run "用 Node.js 实现一个命令行待办应用，包含添加、完成、列表三个命令，并写测试"
   ```

3. **观察过程**（2-5 分钟）：
   ```powershell
   agenttown status      # 各员工状态
   agenttown tasks       # 任务拆分与依赖
   agenttown timeline    # 事件时间线
   agenttown deliver     # 交付摘要（合并建议）
   ```

4. **对照体验**（可选，5 分钟）：直接用 `codex exec` 单独完成同样的需求，感受对比。

5. **填写问卷**：`docs/requirement-experiment/questionnaire.md`

## 注意事项

- 这是实验版：员工是确定性 Fake Agent（写固定文件），**领导 Agent 是真实的 Codex**。请重点感受"领导拆任务 + 分工 + 审核"的协作模式，而不是员工写代码的智能程度。
- 会消耗少量 Codex Token（领导 Agent 的真实调用）。
- 遇到卡住或报错：记录下来，如实填写问卷即可——失败本身也是重要证据。
