# 方向 A：需求实验实施计划（P1B 收尾 + Codex 真实适配器 + 内测验证）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用最小成本验证 AgentTown 的核心需求假设——"异构多 Agent 协作（真实领导 Agent + 员工）是否比单 Agent 更好用"——完成 P1B Task 12 E2E 收尾、接入一个真实 Agent（Codex）跑通协作小项目、并收集 5-10 位内测用户的直白反馈，最终给出继续/转向/停止的结论。

**Architecture:** 复用 P1A/P1B 已完成的确定性调度内核（Core + Fake 员工 + Git worktree 协作）。先收尾 Task 11 审查发现的清理安全缺口并提交，再按已有 Task 12 计划完成 Git Fake Agent E2E；随后在 Core 中新增 `CodexAgentAdapter`（复用 P0 探针已验证的 `codex exec --json` 协议与 JSONL 解析），让 Codex 作为"领导 Agent"与 Fake 开发/审核员工组成公司，跑通一个真实小型项目；最后以问卷形式对 5-10 位内测用户收集证据。

**Tech Stack:** Node.js 22+ / TypeScript 7 / pnpm 11.9 / vitest 4 / SQLite（better-sqlite3 等价物）/ Windows Named Pipe / Git CLI / Codex CLI（真实验证时）。

## Global Constraints

- 全部开发在 worktree `D:\AgentTown\.worktrees\p1b-git-collaboration`（分支 `codex/p1b-git-collaboration`）进行；主仓库 `D:\AgentTown` 保持 `codex/p1b-git-design` 不动。
- 普通 CI 永不启动真实 Agent：测试必须设置 `AGENTTOWN_FORBID_REAL_PROBES=1`、`AGENTTOWN_REAL_CODEX=0`、`AGENTTOWN_REAL_CLAUDE=0`。
- 真实 Codex 验证只在手动验收步骤执行（需用户在场确认 Token 消耗）。
- TDD：每个修复/功能先写失败测试（RED）→ 最小实现（GREEN）→ 完整回归。
- 每个 Task 完成后独立复审（Spec + Code-quality），主控复验后才算完成；提交消息遵循现有风格（`fix:` / `feat:` / `test:` / `docs:`）。
- Windows 真实 Git 夹具的 EPERM/EBUSY 清理噪声：不改超时、不重试掩盖，如实报告。
- 不修改 P1A 兼容语义；新增能力必须 fail-closed（不确定即拒绝）。

---

## 环境基线（已完成，记录备查）

- worktree node_modules 已重装（`pnpm install`，pnpm v11.9.0，8.6s）。
- worktree 有 Task 11 未提交修复（`cleanup-service.ts` +798 行、`core-store.ts`、`index.ts`、测试 +461 行），定向测试 14 项中 12 通过、2 失败（见 Task 1）。
- Codex CLI 实测（2026-08-15）：`C:\Users\S1nc\AppData\Local\OpenAI\Codex\bin\697a646d3cf0f240\codex.exe`，版本 `codex-cli 0.148.0-alpha.9`；`codex exec --json --sandbox read-only --cd <dir> <prompt>` 已确认输出 `thread.started`（含 `thread_id`）。注意：WindowsApps 捆绑版不可直接调用（Access denied，与 P0 EPERM 一致）；exec 需要非交互 stdin（避免 "Reading additional input from stdin" 卡住）与网络就绪（models 刷新/MCP 可能超时，Task 6 手动验收时处理）。
- **网络已解决（2026-08-15 16:06）**：用户打开 Clash（监听 `127.0.0.1:7897`，系统代理 ProxyEnable=1）。**Codex CLI（Rust）不读 Windows 系统代理，必须显式设置环境变量**：`$env:HTTP_PROXY='http://127.0.0.1:7897'; $env:HTTPS_PROXY='http://127.0.0.1:7897'`。所有 Task 6 的 codex 调用均需带上；`login status` 确认 `Logged in using ChatGPT`。
- ❌ **额度阻塞（Task 6 前置，2026-08-15 16:07）**：`codex exec` 返回 `turn.failed: You've hit your usage limit... try again at Aug 22nd, 2026 5:18 PM`（ChatGPT 账号免费额度用尽，约 7 天后重置；`-m gpt-5-mini` 等模型 ChatGPT 账号不支持）。三个选项：① 用户升级 Pro/购买额度（立即）；② 等 8/22 重置（Task 6 挂起，先做其他任务）；③ 降级为 fake-agent 模拟验收（真实对照留待额度恢复后补做，结论注明不确定性）。
- 根验证基线命令（worktree 内执行）：
  ```powershell
  $env:AGENTTOWN_FORBID_REAL_PROBES='1'; $env:AGENTTOWN_REAL_CODEX='0'; $env:AGENTTOWN_REAL_CLAUDE='0'
  pnpm typecheck; pnpm test; pnpm probe:fake
  ```

---

### Task 1: 收尾 Task 11——拒绝 run 命名空间内的外来 worktree 与外来 ref

**Files:**
- Modify: `packages/core/src/git/cleanup-service.ts`（`preview()` 方法，约 308 行起）
- Test: `packages/core/test/cleanup-service.test.ts`（已有 2 个失败测试，无需新增）

**Interfaces:**
- Consumes: `CleanupSelection`、`store.listGitWorkspaces(runId)`、`store.getGitRun(runId)`、`#git.run`。
- Produces: `preview()` 在发现"已注册 worktree/ref 之外、却位于 `agenttown/<run-id>/` 命名空间内"的任何 worktree 分支或 `refs/heads/agenttown/<run-id>/*` ref 时，抛出包含 `foreign` 的错误，且不删除任何内容。

- [ ] **Step 1: 确认 RED（两个失败测试当前状态）**

```powershell
pnpm --filter @agenttown/core test -- cleanup-service.test.ts
```
Expected: 2 failed——`refuses a foreign registered worktree inside the exact run namespace`、`refuses a foreign ref inside the exact run branch namespace`（promise 不应 resolve）。

- [ ] **Step 2: 实现"外来 worktree 拒绝"**

在 `preview()` 中，遍历 `registered`（`git worktree list --porcelain` 解析结果）时，除按已注册 workspace 匹配外，额外检查：任何 worktree 的路径位于 `resolve(run.projectRoot, ".agenttown", "worktrees", runId)` 之下、但其 branch 或 path 不在 `listGitWorkspaces(runId)` 清单中 → 抛 `Error("cleanup found foreign worktree in run namespace: <path>")`。

- [ ] **Step 3: 实现"外来 ref 拒绝"**

在 `preview()` 中执行：

```powershell
git for-each-ref --format=%(refname) refs/heads/agenttown/<runId>/
```

任何 ref 不在已注册 workspace 的 `branchRef` 集合内 → 抛 `Error("cleanup found foreign branch ref: <ref>")`。同时保留对 `git worktree list` 输出中 `branch` 的核对（已有逻辑）。

- [ ] **Step 4: 跑定向测试确认 GREEN**

```powershell
pnpm --filter @agenttown/core test -- cleanup-service.test.ts
```
Expected: 14/14 通过。

- [ ] **Step 5: 完整 Core 回归 + typecheck**

```powershell
pnpm --filter @agenttown/core test
pnpm typecheck
```
Expected: 全部通过（允许已知 Windows 夹具噪声，如实记录）。

- [ ] **Step 6: 提交 Task 11 修复**

```powershell
git add packages/core/src/git/cleanup-service.ts packages/core/src/git packages/core/src/storage/core-store.ts packages/core/src/index.ts packages/core/test/cleanup-service.test.ts
git commit -m "fix: refuse foreign worktrees and refs during P1B cleanup"
```

---

### Task 2: 执行 Task 12——确定性 Git Fake Agent 与完整 P1B E2E

**Files:** 见既有计划 `docs/superpowers/plans/2026-07-29-agenttown-p1b-git-collaboration.md` 的 **Task 12**（步骤 1-9，含全部代码），本任务按该计划逐条执行：
- Create: `packages/fake-agent/src/git-fixture.ts`、`packages/fake-agent/test/git-fixture.test.ts`、`packages/e2e/test/git-company.test.ts`
- Modify: `packages/fake-agent/src/company-cli.ts`、`packages/core/src/agents/fake-adapter.ts`、`packages/core/src/main.ts`、`packages/cli/src/templates.ts`、`packages/cli/test/templates.test.ts`、`package.json`、`README.md`

**Interfaces:** 产生确定性场景 `git-developer-a`、`git-developer-b`、`git-review-approve`、`git-review-reject`、`git-conflict`、`git-conflict-resolve`，以及根脚本 `test:p1b`。

- [ ] **Step 1-3:** 按既有计划写 Fake Agent Git fixture 安全测试（RED）→ 实现确定性场景表 → 定向测试 GREEN。
- [ ] **Step 4:** 按既有计划写 parallel/restart/delivery E2E（RED）。
- [ ] **Step 5:** 接线 P1B 默认模板与 Core 启动（preflight → run 对账 → GitTaskWorkflow → sessions）。
- [ ] **Step 6:** 按既有计划添加 conflict E2E 并跑通。
- [ ] **Step 7:** 添加 `test:p1b` 根脚本并更新 README 文档。
- [ ] **Step 8:** 全量验证：`pnpm typecheck`、`pnpm test`、`pnpm test:p1b`、`pnpm probe:fake`。
- [ ] **Step 9:** 仓库安全证据核对（用户 worktree 干净、main 保持基线、无自动 push）。
- [ ] **Step 10:** 独立复审（Spec + Code-quality）→ 主控复验 → 提交（按既有计划的提交粒度）并推送 `codex/p1b-git-collaboration`。

---

### Task 3: Codex 适配器——复用 P0 探针协议的解析器移植

**Files:**
- Create: `packages/core/src/agents/codex-parse.ts`
- Create: `packages/core/test/codex-parse.test.ts`
- Modify: `packages/core/package.json`（无新依赖，纯移植）

**Interfaces:**
- Consumes: `AgentEvent`、`AgentCapabilities`、`SessionHandle`、`UsageSnapshot`（`@agenttown/runtime-contract`）。
- Produces:
  - `export function parseCodexJsonl(line: string): AgentEvent[]`（等价移植 `probe-runner/src/adapters/codex.ts` 的 `parseCodexLine` 事件映射：`thread.started`→`session.started`、`item.completed(agent_message)`→`output.completed`、`turn.completed`→`usage.updated`、`turn.failed/error`→`adapter.error`）
  - `export function extractStructuredAction(text: string): ActionProposal | null`（从 Codex 回复中提取 ```json 代码块或 `ACTION:` 标记，字段校验失败返回 null）

- [ ] **Step 1: 写解析器失败测试（RED）**

```ts
it("maps thread.started to session.started", () => {
  const events = parseCodexJsonl(
    JSON.stringify({ type: "thread.started", thread_id: "t-1" })
  );
  expect(events[0]).toMatchObject({ type: "session.started" });
});
```
（其余用例：agent_message → output.completed；turn.completed usage → usage.updated；turn.failed → adapter.error；非法 JSON → 空数组。）

- [ ] **Step 2: 运行确认失败** → `pnpm --filter @agenttown/core test -- codex-parse.test.ts`。
- [ ] **Step 3: 移植解析器实现**（从 `packages/probe-runner/src/adapters/codex.ts` 移植 `parseCodexLine` 逻辑，事件类型映射到 runtime-contract 的 `AgentEvent`）。
- [ ] **Step 4: 实现 `extractStructuredAction`**：先提取 ```json ... ``` 块；不存在则尝试 `ACTION: {…}` 行；`JSON.parse` 后按 `ActionProposal` schema（schemaVersion/actionId/type/actorEmployeeId/taskId/payload/reason/causationEventId）逐字段校验，任一缺失返回 null。
- [ ] **Step 5: GREEN + 完整 core 测试 + typecheck** → 提交 `feat: parse Codex CLI events for adapter use`。

---

### Task 4: CodexAgentAdapter 实现（fake-exec 可测模式）

**Files:**
- Create: `packages/core/src/agents/codex-adapter.ts`
- Create: `packages/core/test/codex-adapter.test.ts`

**Interfaces:**
- Consumes: `AgentAdapter`、`StartSessionInput`、`ResumeSessionInput`、`AgentMessage`、`SessionHandle`（runtime-contract）；`parseCodexJsonl`、`extractStructuredAction`（本计划 Task 3）；`spawn` 子进程工具（参考 `fake-adapter.ts` 的生命周期管理：超时、孤儿进程回收、日志脱敏）。
- Produces: `CodexAgentAdapter implements AgentAdapter`，构造参数 `{ executable?: string; packageRoot?: string; forbidRealProbes?: boolean }`；`capabilities()` 返回 `{ nativeResume: "supported", structuredOutput: "unsupported", nonInteractive: "supported", interrupt: "supported", parallelSessions: "unsupported", tokenUsage: "supported", contextUsage: "unknown", interactiveTakeover: "unsupported" }`。

**实现策略（与 Fake 不同的点）**：Codex CLI 是非交互式一次性 exec 模型——`codex exec --json --sandbox read-only --cd <workspace> <prompt>` 输出 JSONL 后退出。因此：
- `start(input)`：spawn `codex exec --json --sandbox read-only --cd <projectRoot> <rolePrompt>`；从 `thread.started` 取 `nativeSessionId`；保存最近输出作为会话上下文。
- `send(session, message)`：对同一会话再次 spawn `codex exec resume <nativeSessionId> --json --cd <projectRoot> <prompt>`（P0 探针已验证 `codex exec resume <id> --json` 可用），流式转发 `output.completed` / `usage.updated` / `action.proposed`（通过注入的汇报格式让 Codex 输出结构化动作）。
- `interrupt/stop`：kill 进程树并等待退出（复用 fake-adapter 的 deadline 模式）。
- `usage(session)`：返回最近一次 `turn.completed` 记录的 input/output token（无则 null）。
- 能力降级：structuredOutput unsupported → 在 prompt 中注入"每轮必须以 ```json ACTION …``` 汇报"的格式要求；交互接管 unsupported → 用户接管时标记不可用。
- **测试不触发真实 Codex**：`forbidRealProbes` 为 true 时（默认），`start` 若发现 executable 缺失抛 `adapter.error`；测试用注入的 `spawn` 替身（类似 probe-runner 的 `runProcess` 注入）模拟 JSONL 输出。

- [ ] **Step 1:** 写失败测试：capabilities 形状、start 解析 thread.started、send 用 resume 命令、interrupt 杀死进程树、usage 返回 token、forbid 模式拒绝真实启动。
- [ ] **Step 2:** RED 确认。
- [ ] **Step 3:** 实现 adapter（复用 fake-adapter 的进程/队列/超时工具模式）。
- [ ] **Step 4:** GREEN + core 全量回归 + typecheck。
- [ ] **Step 5:** 独立复审 → 提交 `feat: add Codex agent adapter with structured action extraction`。

---

### Task 5: 公司模板与 Core 启动接线（codex 领导 + fake 员工）

**Files:**
- Modify: `packages/core/src/main.ts`（`adapterFor` 工厂：`agent === "codex"` 时返回 `CodexAgentAdapter`；放宽 `P1A Core accepts only the fake adapter` 的硬限制为"fake-only 公司走 P1A 路径，含 codex 员工走 Git 路径"）
- Modify: `packages/cli/src/templates.ts`（新增模板 `codex-lead-software`：leader 用 `agent: codex`，developer-a/b 与 reviewer 用 `agent: fake`）
- Modify: `packages/cli/test/templates.test.ts`
- Modify: `packages/core/test/main.test.ts`（codex-lead 公司可构造、E2E 模式仍拒绝真实启动）

**Interfaces:** `adapterFor(employee.agent)` 返回对应 adapter；模板 YAML 中 `agent: codex` 被 Core 识别。

- [ ] **Step 1:** 写失败测试：main 构造含 codex 员工的公司时能启动（fake-only 限制仅对 E2E 场景生效）；templates 新增 `codex-lead-software` 模板可解析且员工 agent 字段正确。
- [ ] **Step 2:** RED。
- [ ] **Step 3:** 实现 main.ts 接线与模板。
- [ ] **Step 4:** GREEN + 回归 + typecheck。
- [ ] **Step 5:** 提交 `feat: support Codex leader with fake employees in company templates`。

---

### Task 5b: ClaudeAgentAdapter（Claude Code 真实适配器）

> 背景（2026-08-15 16:0x）：Codex 账号额度用尽（8/22 重置），用户拍板改用 Claude Code + OpenCode。已验证：`claude --version` = 2.1.233；`claude -p "<p>" --output-format json` 输出单对象 JSON（含 `result`、`session_id`、`usage{input_tokens,output_tokens}`、`total_cost_usd`、`is_error`）；续会话 `--resume <session_id>`。注意 claude 的 stdin 需要立即 EOF（探测用 `$null |`），spawn 后需 `child.stdin.end()`。

**Files:**
- Create: `packages/core/src/agents/claude-parse.ts`（`parseClaudeResult(stdout): AgentEvent[]`——从单对象 JSON 提取 `session.started`/`output.completed`/`usage.updated`/`adapter.error`；复用 `extractStructuredAction` 提取 ACTION 块）
- Create: `packages/core/src/agents/claude-adapter.ts`（`ClaudeAgentAdapter`，结构对齐 `CodexAgentAdapter`：`detect/capabilities/start/send/interrupt/resume/stop/forceStop/usage`；首轮 `claude -p <prompt> --output-format json`，续轮 `claude -p <prompt> --output-format json --resume <threadId>`；`--cd <projectRoot>`；构造参数 `{ executable?, packageRoot?, forbidRealProbes? (默认 true), spawnProcess?, writeDiagnostic?, permissionMode? }`；capabilities 声明 `structuredOutput: "unsupported"`、`nativeResume: "supported"`、`tokenUsage: "supported"`）
- Create: `packages/core/test/agents/claude-adapter.test.ts`（stub spawnProcess，覆盖：start 提取 session_id、send resume 参数、ACTION 解析→action.proposed、usage 映射、busy/no_native_session、interrupt、forbid 拒绝真实 spawn、exit-before-event、start 失败清理）

- [x] **Step 1:** 失败测试先行（stub spawnProcess 模拟 claude JSON 输出）。
- [x] **Step 2:** RED。
- [x] **Step 3:** 实现 claude-parse.ts + claude-adapter.ts。
- [x] **Step 4:** GREEN + 回归 + typecheck。
- [x] **Step 5:** 提交 `feat: add ClaudeAgentAdapter driving the Claude Code CLI`。

> ✅ Task 5b 完成（`b998c1f`，review Approved + fix `decaa30`：interrupt `&&`→`||` 双适配器修复）。

### Task 5c: OpenCodeAgentAdapter（OpenCode 真实适配器）

> 背景：`opencode run --format json --model <provider/model> --dir <dir> "<p>"` 输出 JSONL 事件流：`step_start`（含 `sessionID`）、`text`（`part.text`）、`step_finish`（`part.reason: stop|error`、`part.cost`、`part.tokens{input,output,reasoning}`）；续会话 `-s <session_id>`。⚠️ 默认模型 `mimo-v2.5-free`（opencode.ai 免费端点）被限流 429，必须显式 `--model`（已验证 `alibaba-cn/deepseek-v4-flash` 可用，$0.0018/次）。

**Files:**
- Create: `packages/core/src/agents/opencode-parse.ts`（`parseOpenCodeJsonl(line): AgentEvent[]`——从事件流提取 `session.started`（sessionID）/`output.completed`（text 累积）/`usage.updated`（step_finish tokens）/`adapter.error`（reason: error 或非零退出）；复用 `extractStructuredAction`）
- Create: `packages/core/src/agents/opencode-adapter.ts`（`OpenCodeAgentAdapter`，结构对齐 codex；首轮 `opencode run --format json --dir <projectRoot> [--model <model>] "<prompt>"`，续轮加 `-s <threadId>`；构造参数 `{ executable?, packageRoot?, model?, forbidRealProbes? (默认 true), spawnProcess?, writeDiagnostic? }`）
- Create: `packages/core/test/agents/opencode-adapter.test.ts`（stub spawn，覆盖同上 + model 未配置时不含 --model）

- [ ] **Step 1:** 失败测试先行。
- [ ] **Step 2:** RED。
- [ ] **Step 3:** 实现。
- [ ] **Step 4:** GREEN + 回归 + typecheck。
- [ ] **Step 5:** 提交 `feat: add OpenCodeAgentAdapter driving the OpenCode CLI`。

### Task 5d: 三适配器接线与双新模板

**Files:**
- Modify: `packages/core/src/main.ts`——员工 `agent` 类型放宽为 `"fake" | "codex" | "claude" | "opencode"`；`buildAdapterMap` 按公司员工类型构造 Codex/Claude/OpenCode 适配器；opt-in 环境变量：`AGENTTOWN_REAL_CLAUDE === "1"`（且 `AGENTTOWN_FORBID_REAL_PROBES !== "1"`）、`AGENTTOWN_REAL_OPENCODE === "1"`、可选 `AGENTTOWN_OPENCODE_MODEL`；场景选择 `agent !== "fake"` 用领导 prompt；`gitEnabled` 改为"含任意真实 Agent 员工即启用"（`hasCodexEmployees` → `hasRealAgents` 语义调整，注意测试引用）
- Modify: `packages/cli/src/templates.ts`（新增 `claude-lead-software`、`opencode-lead-software`：leader 分别用 `agent: claude` / `agent: opencode`，员工 fake；TEMPLATE_NAMES 追加）
- Modify: `packages/cli/test/templates.test.ts`、`packages/core/test/main.test.ts`（三适配器构造 + opt-in 策略 + E2E 仍拒绝真实启动）

- [ ] **Step 1:** 失败测试先行。
- [ ] **Step 2:** RED。
- [ ] **Step 3:** 实现接线与模板。
- [ ] **Step 4:** GREEN + 回归 + typecheck（cli 44 + core main + 新适配器测试全绿；全量 core 噪声分类不变）。
- [ ] **Step 5:** 提交 `feat: wire claude/opencode adapters into core and add lead-software templates`。

---

### Task 6: 手动验收——真实领导（Claude Code / OpenCode）+ Fake 员工完成真实小项目

> 本任务需要用户在电脑前确认（消耗真实 Token）。遵循"不接真实 Agent 不冒进"纪律：先单次探针验证 CLI 可用，再全流程。
> **Codex 额度 8/22 前不可用**：主验收用 Claude Code（`claude`，已验证）；对照组可用 OpenCode（`opencode run -m alibaba-cn/deepseek-v4-flash`，已验证）。Codex 对照实验标记为"待额度恢复后补做"。
> **运行环境（所有真实调用必须带）**：`$env:HTTP_PROXY='http://127.0.0.1:7897'; $env:HTTPS_PROXY='http://127.0.0.1:7897'; $env:AGENTTOWN_FORBID_REAL_PROBES='0'; $env:AGENTTOWN_REAL_CLAUDE='1'`（OpenCode 用 `$env:AGENTTOWN_REAL_OPENCODE='1'` + 可选 `$env:AGENTTOWN_OPENCODE_MODEL`）。

- [ ] **Step 1:** 确认 CLI 可用（探针）：`claude -p "Reply with exactly OK" --output-format json`（或 `opencode run --format json -m <model>`），输出含 `AGENTTOWN` 可解析 JSON。
- [ ] **Step 2:** 在临时 Git 仓库创建公司：`agenttown init --template claude-lead-software`（对照组 `opencode-lead-software`）；`agenttown run "用 Node.js 实现一个命令行待办应用，带测试"`。
- [ ] **Step 3:** 观察：真实领导拆任务 → Fake 开发员工在独立 worktree 提交 → Fake 审核员工只读审核 → Core 确定性集成。全程 CLI 查看 `status` / `tasks` / `timeline` / `deliver`。
- [ ] **Step 4:** 对照实验：同一个小项目直接 `claude -p` 单 Agent 完成；记录两者耗时、Token、质量观感。
- [ ] **Step 5:** 记录观察日志到 `artifacts/requirement-experiment/`（含截图/输出摘要），如实记录失败点。

> 观察记录模板（Task 6 完成后由主控填写）：
> `artifacts/requirement-experiment/run-<日期>/observations.md`——记录：需求原文、公司配置（模板）、实际耗时、Token 用量（如有）、各阶段事件序列（leader 拆解 → 员工提交 → 审核 → 集成）、失败/卡点、与单 Agent 对照的主观对比。
> 已知风险：Claude 的 `-p` 权限模式（默认可能拒绝写类工具，领导只读场景可接受；如遇权限拦截记入观察并考虑 `--permission-mode` 选项）；Claude stdin 需 EOF（适配器已处理 `child.stdin.end()`）；OpenCode 免费模型限流需显式 `--model`。Codex 对照待 8/22 额度恢复后补做。

---

### Task 7: 内测问卷设计与发放

**Files:**
- Create: `docs/requirement-experiment/questionnaire.md`（问卷正文）
- Create: `docs/requirement-experiment/experiment-guide.md`（给内测用户的操作指引：30 分钟跑一个小项目）

- [ ] **Step 1:** 编写问卷（基于 07/18 对话中的产品假设），核心问题：
  1. 你平时怎么用多 Agent？（单开？并行开几个？）
  2. 试用 AgentTown 后：异构协作相比你惯用方式，**更好用在哪 / 更难用在哪**？
  3. 与直接用 Codex/Claude Code 相比，你愿意为它多付的成本（配置时间、Token）是多少？
  4. 一句话：你会在真实项目里留下它吗？为什么？
  5. 最劝退你的一个点是？（多选：配置复杂 / 不稳定 / 价值不明显 / 界面缺失 / 其他）
- [ ] **Step 2:** 用户负责把指引发给 5-10 位内测用户（对话中已确认用户认识 5-10 位内测人选），收集回答。
- [ ] **Step 3:** 汇总证据（定性归纳 + 关键数字），写入 `docs/requirement-experiment/findings.md`。

---

### Task 8: 结论报告

- [ ] **Step 1:** 综合 Task 6 对照实验与 Task 7 问卷，回答三个问题：
  1. 异构协作是否真的比单 Agent 好？（质量/速度/成本/可监督性）
  2. 目标用户（AI 编程重度用户）是否愿意为它付成本？
  3. 项目继续的价值主张是否成立？
- [ ] **Step 2:** 写入 `docs/requirement-experiment/decision.md`：继续（给理由与下一步）/ 转向（给新定位）/ 停止（收尾清单），并同步更新 README 与开发进度文档。
- [ ] **Step 3:** 向用户当面汇报结论，由用户拍板。

---

## Self-Review

- **Spec 覆盖**：需求实验四要素（E2E 收尾 ✅ Task 2、真实适配器 ✅ Task 3-5、真实协作演示 ✅ Task 6、用户证据 ✅ Task 7、决策 ✅ Task 8）；Task 11 安全缺口 ✅ Task 1。
- **Placeholder 检查**：无 TBD；Task 2 引用既有完整计划（含全部代码），Task 3-5 给出接口与实现策略，测试代码在对应 Step 中给出。
- **类型一致性**：`parseCodexJsonl` / `extractStructuredAction` / `CodexAgentAdapter` / `adapterFor` / `codex-lead-software` 在各 Task 间名称一致；AgentEvent/ActionProposal/SessionHandle 均来自 runtime-contract。
