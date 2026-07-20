# AgentTown Windows Agent Feasibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Windows 上用可重复探针证明 Codex CLI 与 Claude Code CLI 能被统一启动、监听、续聊、中断和并行管理，并用量化结果确定 Electron/TypeScript 或 Tauri/Rust 技术路线。

**Architecture:** 建立一个与桌面框架无关的 JSONL 探针协议。TypeScript 编排器先用脚本化假 Agent 验证协议，再分别驱动 Node `node-pty`/Electron 候选和 Rust `portable-pty`/Tauri 候选；真实 Agent 探针只复用用户已有登录态，不读取或复制凭据。所有结果写入 `artifacts/feasibility/`，最后由纯函数评分器生成 ADR。

**Tech Stack:** Windows 11；Node.js 22+；pnpm 10+；TypeScript；Vitest；Zod；`node-pty`；Electron；Rust stable；`portable-pty`；Tauri 2；PowerShell 7；GitHub Actions Windows runner。

## Global Constraints

- 首发平台是 Windows，最低 PTY 基线为支持 ConPTY 的 Windows 10 1809。
- 第一批真实适配器是 Codex CLI 与 Claude Code CLI；出现阻断性限制时才评估 OpenCode 替换。
- 不开发新的 Agent 推理循环，不接触或复制第三方 Agent 的认证文件。
- 后台核心、桌面 UI 与 CLI 必须保持进程边界；关闭桌面窗口不能被误判为停止公司。
- 所有探针默认使用只读权限和独立临时 Git 仓库；写入测试只能发生在该临时目录。
- 原始输出与解析事件必须同时保留，解析失败不能丢弃原始证据。
- 真实 Agent 测试不进入普通 CI，必须通过显式环境开关启动。
- 依赖版本以提交的 `pnpm-lock.yaml` 与 `Cargo.lock` 为唯一事实源。

## File Map

```text
package.json                              根脚本与 Node 版本约束
pnpm-workspace.yaml                       pnpm 工作区声明
tsconfig.base.json                        TypeScript 严格配置
.gitignore                                忽略探针产物、密钥和构建目录
.github/workflows/feasibility.yml          Windows 假 Agent CI
packages/probe-contract/src/events.ts      JSONL 事件和能力类型
packages/probe-contract/src/score.ts       框架评分纯函数
packages/probe-contract/src/index.ts       公共导出
packages/probe-contract/test/*.test.ts     契约与评分测试
packages/fake-agent/src/cli.ts             可控脚本化 Agent
packages/fake-agent/test/cli.test.ts       假 Agent 进程测试
packages/probe-runner/src/process.ts       普通子进程运行器
packages/probe-runner/src/pty.ts           Node/ConPTY 运行器
packages/probe-runner/src/jsonl.ts         增量 JSONL 解析器
packages/probe-runner/src/artifacts.ts     原始日志和结果写入
packages/probe-runner/src/adapters/*.ts    Codex 与 Claude 探针适配器
packages/probe-runner/src/cli.ts           探针命令入口
packages/probe-runner/test/*.test.ts       运行器与适配器测试
spikes/electron/                           Electron 独立后台进程实验
spikes/tauri/                              Tauri/Rust PTY 实验
scripts/run-real-probes.ps1                显式真实 Agent 探针入口
scripts/run-framework-benchmark.ps1        两候选框架对比入口
artifacts/feasibility/.gitkeep             本地产物目录占位
docs/adr/0001-desktop-and-core-runtime.md  技术选型记录
```

---

### Task 1: Repository and test foundation

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `artifacts/feasibility/.gitkeep`
- Create: `.github/workflows/feasibility.yml`

**Interfaces:**
- Consumes: Windows, Node.js 22+, pnpm 10+.
- Produces: `pnpm test`, `pnpm typecheck`, `pnpm probe:fake`, `pnpm probe:real` and workspace package discovery.

- [ ] **Step 1: Add the root workspace files**

```json
{
  "name": "agenttown",
  "private": true,
  "license": "AGPL-3.0-only",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "pnpm -r --if-present test",
    "typecheck": "pnpm -r --if-present typecheck",
    "probe:fake": "pnpm --filter @agenttown/probe-runner probe:fake",
    "probe:real": "powershell -NoProfile -File scripts/run-real-probes.ps1",
    "benchmark:frameworks": "powershell -NoProfile -File scripts/run-framework-benchmark.ps1"
  }
}
```

```yaml
packages:
  - packages/*
  - spikes/electron
```

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true
  }
}
```

`.gitignore` must contain exactly these project-specific entries in addition to editor defaults:

```gitignore
node_modules/
dist/
target/
artifacts/feasibility/**/raw.log
artifacts/feasibility/**/events.jsonl
*.log
.env
.env.*
!.env.example
```

- [ ] **Step 2: Add the Windows fake-Agent CI workflow**

```yaml
name: feasibility
on:
  push:
    branches: [main]
  pull_request:
jobs:
  fake-agent:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm probe:fake
```

- [ ] **Step 3: Install and lock the shared dependencies**

Run:

```powershell
pnpm add -Dw typescript vitest tsx @types/node
pnpm install
```

Expected: `pnpm-lock.yaml` is created and `pnpm test` exits successfully even before packages contain tests.

- [ ] **Step 4: Verify and commit the foundation**

Run:

```powershell
pnpm test
pnpm typecheck
git diff --check
```

Expected: all commands exit `0`.

```powershell
git add package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json .gitignore .github artifacts/feasibility/.gitkeep
git commit -m "chore: initialize feasibility workspace"
```

---

### Task 2: Probe event contract and deterministic scoring

**Files:**
- Create: `packages/probe-contract/package.json`
- Create: `packages/probe-contract/src/events.ts`
- Create: `packages/probe-contract/src/score.ts`
- Create: `packages/probe-contract/src/index.ts`
- Create: `packages/probe-contract/test/events.test.ts`
- Create: `packages/probe-contract/test/score.test.ts`

**Interfaces:**
- Consumes: no project packages.
- Produces: `ProbeEvent`, `CapabilityReport`, `FrameworkMetrics`, `parseProbeEvent(line)` and `scoreFramework(metrics)`.

- [ ] **Step 1: Write failing contract tests**

```ts
import { describe, expect, it } from "vitest";
import { parseProbeEvent } from "../src/index.js";

describe("parseProbeEvent", () => {
  it("accepts a session event", () => {
    expect(parseProbeEvent('{"type":"session","sessionId":"s-1"}')).toEqual({
      type: "session",
      sessionId: "s-1"
    });
  });

  it("returns an explicit parse error instead of dropping the line", () => {
    expect(parseProbeEvent("not-json")).toEqual({
      type: "parse_error",
      raw: "not-json",
      reason: "invalid_json"
    });
  });
});
```

```ts
import { describe, expect, it } from "vitest";
import { scoreFramework } from "../src/index.js";

describe("scoreFramework", () => {
  it("rejects a candidate that cannot keep the core alive", () => {
    const result = scoreFramework({
      name: "electron",
      ptyStable: true,
      coreSurvivesUiExit: false,
      packageBuilds: true,
      embeddedTerminalWorks: true,
      installSizeMb: 80,
      coldStartMs: 900,
      implementationMinutes: 40
    });
    expect(result.eligible).toBe(false);
    expect(result.blockers).toContain("core_survival");
  });
});
```

- [ ] **Step 2: Run the tests and confirm the missing-module failure**

Run: `pnpm --filter @agenttown/probe-contract test`

Expected: FAIL because `../src/index.js` does not exist.

- [ ] **Step 3: Implement the event types and parser**

```ts
export type ProbeEvent =
  | { type: "ready"; pid: number }
  | { type: "session"; sessionId: string }
  | { type: "output"; text: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; cachedInputTokens?: number }
  | { type: "completed"; exitCode: number }
  | { type: "interrupted" }
  | { type: "parse_error"; raw: string; reason: "invalid_json" | "unknown_shape" };

export function parseProbeEvent(line: string): ProbeEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { type: "parse_error", raw: line, reason: "invalid_json" };
  }
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return { type: "parse_error", raw: line, reason: "unknown_shape" };
  }
  const event = value as Record<string, unknown>;
  if (event.type === "ready" && typeof event.pid === "number") {
    return { type: "ready", pid: event.pid };
  }
  if (event.type === "session" && typeof event.sessionId === "string") {
    return { type: "session", sessionId: event.sessionId };
  }
  if (event.type === "output" && typeof event.text === "string") {
    return { type: "output", text: event.text };
  }
  if (event.type === "usage" && typeof event.inputTokens === "number" && typeof event.outputTokens === "number") {
    return typeof event.cachedInputTokens === "number"
      ? { type: "usage", inputTokens: event.inputTokens, outputTokens: event.outputTokens, cachedInputTokens: event.cachedInputTokens }
      : { type: "usage", inputTokens: event.inputTokens, outputTokens: event.outputTokens };
  }
  if (event.type === "completed" && typeof event.exitCode === "number") {
    return { type: "completed", exitCode: event.exitCode };
  }
  if (event.type === "interrupted") return { type: "interrupted" };
  return { type: "parse_error", raw: line, reason: "unknown_shape" };
}
```

Define `CapabilityReport` with these exact booleans: `launch`, `streamOutput`, `sessionId`, `resume`, `interrupt`, `tokenUsage`, `nonInteractive`, `interactivePty`, and `parallelThree`. It also contains `agent`, `version`, `command`, `durationMs`, `rawLogPath`, and `notes`.

- [ ] **Step 4: Implement hard gates and weighted scoring**

```ts
export interface FrameworkMetrics {
  name: "electron" | "tauri";
  ptyStable: boolean;
  coreSurvivesUiExit: boolean;
  packageBuilds: boolean;
  embeddedTerminalWorks: boolean;
  installSizeMb: number;
  coldStartMs: number;
  implementationMinutes: number;
}

export function scoreFramework(metrics: FrameworkMetrics) {
  const blockers = [
    !metrics.ptyStable && "pty_stability",
    !metrics.coreSurvivesUiExit && "core_survival",
    !metrics.packageBuilds && "packaging",
    !metrics.embeddedTerminalWorks && "terminal_embedding"
  ].filter((value): value is string => Boolean(value));
  const score =
    Math.max(0, 30 - metrics.installSizeMb / 10) +
    Math.max(0, 30 - metrics.coldStartMs / 100) +
    Math.max(0, 40 - metrics.implementationMinutes / 5);
  return { eligible: blockers.length === 0, blockers, score: Math.round(score * 10) / 10 };
}
```

- [ ] **Step 5: Run tests, typecheck, and commit**

Run:

```powershell
pnpm --filter @agenttown/probe-contract test
pnpm --filter @agenttown/probe-contract typecheck
```

Expected: all tests PASS and typecheck exits `0`.

```powershell
git add packages/probe-contract pnpm-lock.yaml
git commit -m "feat: define feasibility probe contract"
```

---

### Task 3: Scripted fake Agent and incremental JSONL reader

**Files:**
- Create: `packages/fake-agent/package.json`
- Create: `packages/fake-agent/src/cli.ts`
- Create: `packages/fake-agent/test/cli.test.ts`
- Create: `packages/probe-runner/package.json`
- Create: `packages/probe-runner/src/jsonl.ts`
- Create: `packages/probe-runner/test/jsonl.test.ts`

**Interfaces:**
- Consumes: `ProbeEvent` from `@agenttown/probe-contract`.
- Produces: executable fake Agent modes `normal`, `malformed`, `silent`, `approval`, `crash`, `slow`; `JsonlReader.push(chunk)` and `JsonlReader.end()`.

- [ ] **Step 1: Write failing JSONL chunk-boundary tests**

```ts
import { describe, expect, it } from "vitest";
import { JsonlReader } from "../src/jsonl.js";

describe("JsonlReader", () => {
  it("reassembles lines split across chunks", () => {
    const reader = new JsonlReader();
    expect(reader.push('{"type":"ready",')).toEqual([]);
    expect(reader.push('"pid":7}\n')).toEqual(['{"type":"ready","pid":7}']);
  });

  it("flushes the final line without a newline", () => {
    const reader = new JsonlReader();
    reader.push("tail");
    expect(reader.end()).toEqual(["tail"]);
  });
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm --filter @agenttown/probe-runner test -- jsonl.test.ts`

Expected: FAIL because `JsonlReader` is missing.

- [ ] **Step 3: Implement `JsonlReader`**

```ts
export class JsonlReader {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    const parts = this.buffer.split(/\r?\n/);
    this.buffer = parts.pop() ?? "";
    return parts;
  }

  end(): string[] {
    if (this.buffer.length === 0) return [];
    const tail = this.buffer;
    this.buffer = "";
    return [tail];
  }
}
```

- [ ] **Step 4: Write the fake-Agent process test**

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("fake-agent", () => {
  it("emits a resumable session and usage", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      "--import", "tsx", "src/cli.ts", "--mode", "normal", "--prompt", "first"
    ], { cwd: process.cwd() });
    const events = stdout.trim().split(/\r?\n/).map(JSON.parse);
    expect(events.map((event) => event.type)).toEqual([
      "ready", "session", "output", "usage", "completed"
    ]);
  });
});
```

- [ ] **Step 5: Implement deterministic fake-Agent modes**

```ts
import { randomUUID } from "node:crypto";

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index] ?? "", process.argv[index + 1] ?? "");
}
const mode = args.get("--mode") ?? "normal";
const sessionId = args.get("--resume") ?? randomUUID();
const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

emit({ type: "ready", pid: process.pid });
emit({ type: "session", sessionId });

if (mode === "malformed") process.stdout.write("not-json\n");
if (mode === "crash") process.exit(23);
if (mode === "silent") setTimeout(() => process.exit(0), 30_000);
if (mode === "approval") emit({ type: "output", text: "APPROVAL_REQUIRED" });

if (!new Set(["crash", "silent"]).has(mode)) {
  emit({ type: "output", text: `completed:${args.get("--prompt") ?? ""}` });
  emit({ type: "usage", inputTokens: 10, outputTokens: 5 });
  emit({ type: "completed", exitCode: 0 });
}
```

Register `SIGINT` and emit `{ "type": "interrupted" }` before exiting with code `130`. In `slow` mode, emit one output every 500 ms for ten iterations.

- [ ] **Step 6: Verify all fake-Agent modes and commit**

Run:

```powershell
pnpm --filter @agenttown/fake-agent test
pnpm --filter @agenttown/probe-runner test
pnpm typecheck
```

Expected: PASS, with no process left running after the tests.

```powershell
git add packages/fake-agent packages/probe-runner pnpm-lock.yaml
git commit -m "test: add deterministic fake agent"
```

---

### Task 4: Node ConPTY runner and artifact recording

**Files:**
- Create: `packages/probe-runner/src/pty.ts`
- Create: `packages/probe-runner/src/process.ts`
- Create: `packages/probe-runner/src/artifacts.ts`
- Create: `packages/probe-runner/test/pty.windows.test.ts`
- Create: `packages/probe-runner/test/artifacts.test.ts`

**Interfaces:**
- Consumes: executable path, arguments, cwd, environment allowlist and timeout.
- Produces: `runPty(options): ProbeHandle`, `runProcess(options): Promise<RunResult>`, and `writeProbeArtifacts(result)`.

- [ ] **Step 1: Write the Windows PTY lifecycle test**

```ts
import { afterEach, describe, expect, it } from "vitest";
import { runPty } from "../src/pty.js";

const handles: Array<{ kill(): void }> = [];
afterEach(() => handles.splice(0).forEach((handle) => handle.kill()));

describe.runIf(process.platform === "win32")("runPty", () => {
  it("streams output, accepts resize, and interrupts", async () => {
    const handle = runPty({
      file: process.execPath,
      args: ["--import", "tsx", "../fake-agent/src/cli.ts", "--mode", "slow"],
      cwd: process.cwd(),
      timeoutMs: 10_000
    });
    handles.push(handle);
    await handle.waitFor((text) => text.includes('"type":"ready"'));
    handle.resize(120, 40);
    handle.interrupt();
    const result = await handle.completed;
    expect(result.rawOutput).toContain('"type":"interrupted"');
    expect(Number.isInteger(result.exitCode)).toBe(true);
    expect(result.timedOut).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails before `node-pty` exists**

Run: `pnpm --filter @agenttown/probe-runner test -- pty.windows.test.ts`

Expected: FAIL due to missing `runPty` or `node-pty`.

- [ ] **Step 3: Install `node-pty` and implement `ProbeHandle`**

Run: `pnpm --filter @agenttown/probe-runner add node-pty`

The exported interface must be:

```ts
export interface PtyOptions {
  file: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutMs: number;
}

export interface RunResult {
  command: string[];
  startedAt: string;
  durationMs: number;
  exitCode: number;
  rawOutput: string;
  timedOut: boolean;
}

export interface ProbeHandle {
  pid: number;
  completed: Promise<RunResult>;
  write(text: string): void;
  resize(cols: number, rows: number): void;
  interrupt(): void;
  kill(): void;
  waitFor(predicate: (text: string) => boolean): Promise<string>;
}
```

Implement with `node-pty.spawn`. `interrupt()` writes `\x03`; timeout first interrupts, waits two seconds, then kills. Copy only the current process environment and explicit overrides; never print environment values.

- [ ] **Step 4: Write and implement artifact redaction tests**

```ts
import { expect, it } from "vitest";
import { redactOutput } from "../src/artifacts.js";

it("redacts common secret assignments", () => {
  expect(redactOutput("OPENAI_API_KEY=secret-value\nhello")).toBe(
    "OPENAI_API_KEY=[REDACTED]\nhello"
  );
});
```

`writeProbeArtifacts` must create `<run-id>/raw.log`, `<run-id>/events.jsonl`, and `<run-id>/report.json` with UTF-8 encoding and must pass all output through `redactOutput`.

- [ ] **Step 5: Run the focused and package tests, then commit**

Run:

```powershell
pnpm --filter @agenttown/probe-runner test
pnpm --filter @agenttown/probe-runner typecheck
```

Expected: PASS; Task Manager and `Get-Process node` show no fake-Agent process created by the test after completion.

```powershell
git add packages/probe-runner pnpm-lock.yaml
git commit -m "feat: add Windows PTY probe runner"
```

---

### Task 5: Codex CLI capability probe

**Files:**
- Create: `packages/probe-runner/src/adapters/codex.ts`
- Create: `packages/probe-runner/test/codex-parser.test.ts`
- Create: `packages/probe-runner/test/codex-real.test.ts`
- Create: `packages/probe-runner/test/fixtures/codex-success.jsonl`

**Interfaces:**
- Consumes: `runProcess`, Codex JSONL stdout and a temporary Git repository.
- Produces: `probeCodex(options): Promise<CapabilityReport>` and `parseCodexLine(line): ProbeEvent[]`.

- [ ] **Step 1: Add a sanitized Codex JSONL fixture and failing parser test**

```jsonl
{"type":"thread.started","thread_id":"codex-session-1"}
{"type":"item.completed","item":{"type":"agent_message","text":"AGENTTOWN_PROBE_OK"}}
{"type":"turn.completed","usage":{"input_tokens":120,"cached_input_tokens":80,"output_tokens":9}}
```

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCodexLine } from "../src/adapters/codex.js";

describe("parseCodexLine", () => {
  it("extracts session, output, and token usage", () => {
    const lines = readFileSync("test/fixtures/codex-success.jsonl", "utf8").trim().split(/\r?\n/);
    const events = lines.flatMap(parseCodexLine);
    expect(events).toContainEqual({ type: "session", sessionId: "codex-session-1" });
    expect(events).toContainEqual({ type: "output", text: "AGENTTOWN_PROBE_OK" });
    expect(events).toContainEqual({
      type: "usage", inputTokens: 120, cachedInputTokens: 80, outputTokens: 9
    });
  });
});
```

- [ ] **Step 2: Run the parser test and verify failure**

Run: `pnpm --filter @agenttown/probe-runner test -- codex-parser.test.ts`

Expected: FAIL because `parseCodexLine` is missing.

- [ ] **Step 3: Implement Codex command construction and parsing**

The first-turn command must be equivalent to:

```powershell
codex exec --json --sandbox read-only --cd <temp-repo> "Reply with exactly AGENTTOWN_PROBE_OK"
```

The resume command must be equivalent to:

```powershell
codex exec resume <session-id> --json "Reply with exactly AGENTTOWN_RESUME_OK"
```

`parseCodexLine` maps `thread.started`, completed `agent_message`, `turn.completed.usage`, `turn.failed`, and `error`; unknown valid events remain in raw logs and do not become parse errors.

- [ ] **Step 4: Add an opt-in real Codex test**

```ts
import { describe, expect, it } from "vitest";
import { probeCodex } from "../src/adapters/codex.js";

describe.runIf(process.env.AGENTTOWN_REAL_CODEX === "1")("Codex real probe", () => {
  it("starts, reports usage, and resumes by session ID", async () => {
    const report = await probeCodex({ timeoutMs: 180_000 });
    expect(report.launch).toBe(true);
    expect(report.sessionId).toBe(true);
    expect(report.resume).toBe(true);
    expect(report.tokenUsage).toBe(true);
  }, 240_000);
});
```

- [ ] **Step 5: Run offline tests, then the explicit real probe, and commit**

Run:

```powershell
pnpm --filter @agenttown/probe-runner test -- codex-parser.test.ts
$env:AGENTTOWN_REAL_CODEX='1'
pnpm --filter @agenttown/probe-runner test -- codex-real.test.ts
Remove-Item Env:AGENTTOWN_REAL_CODEX
```

Expected: parser PASS; real probe either PASS or produces a complete capability report with an explicit blocker such as `authentication`, `executable_not_found`, `resume_failed`, or `timeout`. A blocker is evidence, not a skipped result.

```powershell
git add packages/probe-runner artifacts/feasibility
git commit -m "feat: probe Codex CLI capabilities"
```

---

### Task 6: Claude Code capability probe

**Files:**
- Create: `packages/probe-runner/src/adapters/claude.ts`
- Create: `packages/probe-runner/test/claude-parser.test.ts`
- Create: `packages/probe-runner/test/fixtures/claude-success.jsonl`
- Create: `packages/probe-runner/test/claude-real.test.ts`

**Interfaces:**
- Consumes: `runProcess`, Claude Code `stream-json`, and a temporary Git repository.
- Produces: `probeClaude(options): Promise<CapabilityReport>` and `parseClaudeLine(line): ProbeEvent[]`.

- [ ] **Step 1: Add a sanitized fixture and failing parser test**

Use this sanitized fixture:

```jsonl
{"type":"system","subtype":"init","session_id":"claude-session-1"}
{"type":"assistant","session_id":"claude-session-1","message":{"content":[{"type":"text","text":"AGENTTOWN_PROBE_OK"}]}}
{"type":"result","subtype":"success","session_id":"claude-session-1","usage":{"input_tokens":90,"output_tokens":8}}
```

The test asserts the normalized events, not Anthropic-specific objects:

```ts
const events = fixtureLines.flatMap(parseClaudeLine);
expect(events.some((event) => event.type === "session")).toBe(true);
expect(events).toContainEqual({ type: "output", text: "AGENTTOWN_PROBE_OK" });
expect(events.some((event) => event.type === "usage")).toBe(true);
```

- [ ] **Step 2: Run the parser test and verify failure**

Run: `pnpm --filter @agenttown/probe-runner test -- claude-parser.test.ts`

Expected: FAIL because `parseClaudeLine` is missing.

- [ ] **Step 3: Implement Claude command construction and parsing**

The first-turn command must be equivalent to:

```powershell
claude -p "Reply with exactly AGENTTOWN_PROBE_OK" --output-format stream-json --verbose --permission-mode plan
```

The resume command must be equivalent to:

```powershell
claude -p "Reply with exactly AGENTTOWN_RESUME_OK" --resume <session-id> --output-format stream-json --verbose --permission-mode plan
```

Do not use `--dangerously-skip-permissions`. The parser extracts `session_id`, assistant text, result usage and errors while preserving every original line.

- [ ] **Step 4: Add and run an opt-in real Claude test**

```ts
describe.runIf(process.env.AGENTTOWN_REAL_CLAUDE === "1")("Claude real probe", () => {
  it("starts, reports usage, and resumes by session ID", async () => {
    const report = await probeClaude({ timeoutMs: 180_000 });
    expect(report.launch).toBe(true);
    expect(report.sessionId).toBe(true);
    expect(report.resume).toBe(true);
  }, 240_000);
});
```

Run:

```powershell
pnpm --filter @agenttown/probe-runner test -- claude-parser.test.ts
$env:AGENTTOWN_REAL_CLAUDE='1'
pnpm --filter @agenttown/probe-runner test -- claude-real.test.ts
Remove-Item Env:AGENTTOWN_REAL_CLAUDE
```

Expected: the same explicit-result rule as Codex; no silent skip after the environment flag is enabled.

- [ ] **Step 5: Commit the Claude probe**

```powershell
git add packages/probe-runner artifacts/feasibility
git commit -m "feat: probe Claude Code capabilities"
```

---

### Task 7: Electron independent-core spike

**Files:**
- Create: `spikes/electron/package.json`
- Create: `spikes/electron/src/core.ts`
- Create: `spikes/electron/src/main.ts`
- Create: `spikes/electron/src/preload.ts`
- Create: `spikes/electron/src/renderer.ts`
- Create: `spikes/electron/test/core-survival.test.ts`

**Interfaces:**
- Consumes: `runPty` and fake-Agent executable.
- Produces: a desktop window that displays streamed terminal text and a standalone named-pipe core that remains alive when the window closes.

- [ ] **Step 1: Write the failing survival test**

The test starts `core.ts` with pipe name `agenttown-probe-<uuid>`, waits for `{type:"core_ready"}`, starts and closes Electron, reconnects to the pipe, and asserts `{type:"health", status:"ok"}`. It finally sends `{type:"shutdown"}` and asserts the core exits `0`.

- [ ] **Step 2: Run the survival test and confirm failure**

Run: `pnpm --filter @agenttown/electron-spike test -- core-survival.test.ts`

Expected: FAIL because the named-pipe core does not exist.

- [ ] **Step 3: Implement the standalone core**

Use `node:net.createServer` on `\\.\pipe\<pipe-name>`. Supported messages are exactly:

```ts
type CoreRequest =
  | { type: "health" }
  | { type: "start_fake"; mode: "normal" | "slow" }
  | { type: "input"; text: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "shutdown" };
```

Reject unknown messages with `{type:"error", code:"unknown_request"}`. The Electron main process may launch the core detached only when the pipe is absent; it must never own Agent processes itself.

- [ ] **Step 4: Add the minimal embedded terminal view**

The preload exposes only `health`, `startFake`, `sendInput`, `resize`, and `subscribeOutput`. The renderer appends output using `textContent`; it must not use `innerHTML`. Close the window after receiving the first fake-Agent output during the benchmark.

- [ ] **Step 5: Package, measure, verify survival, and write metrics**

Run:

```powershell
pnpm --filter @agenttown/electron-spike test
pnpm --filter @agenttown/electron-spike build
pnpm --filter @agenttown/electron-spike package
```

Record installer/unpacked size, cold-start time, implementation minutes, PTY result, embedded-terminal result and core-survival result in `artifacts/feasibility/framework-electron.json` using `FrameworkMetrics`.

- [ ] **Step 6: Commit the Electron spike**

```powershell
git add spikes/electron packages/probe-runner artifacts/feasibility/framework-electron.json pnpm-lock.yaml
git commit -m "spike: evaluate Electron runtime"
```

---

### Task 8: Tauri/Rust independent-core spike

**Files:**
- Create: `spikes/tauri/package.json`
- Create: `spikes/tauri/src/index.html`
- Create: `spikes/tauri/src/main.ts`
- Create: `spikes/tauri/src-tauri/Cargo.toml`
- Create: `spikes/tauri/src-tauri/tauri.conf.json`
- Create: `spikes/tauri/src-tauri/src/lib.rs`
- Create: `spikes/tauri/core/Cargo.toml`
- Create: `spikes/tauri/core/src/main.rs`
- Create: `spikes/tauri/core/src/lib.rs`
- Create: `spikes/tauri/core/tests/core_survival.rs`

**Interfaces:**
- Consumes: fake-Agent executable and the same JSONL/named-pipe message shapes used by Task 7.
- Produces: a Tauri window plus standalone Rust core using `portable-pty`, with metrics matching `FrameworkMetrics`.

- [ ] **Step 1: Install Rust only if the environment audit reports it missing**

Run:

```powershell
rustc --version
cargo --version
```

If missing, install stable Rust using the official rustup Windows installer, reopen the terminal, and rerun both commands. Record exact versions in `artifacts/feasibility/environment.json`.

- [ ] **Step 2: Write the failing Rust survival test**

```rust
#[test]
fn core_responds_after_ui_client_disconnects() {
    let mut core = agenttown_probe_core::TestCore::start();
    let first = core.connect();
    drop(first);
    let mut second = core.connect();
    assert_eq!(second.request(r#"{"type":"health"}"#), r#"{"type":"health","status":"ok"}"#);
    core.shutdown();
}
```

- [ ] **Step 3: Run the Rust test and verify failure**

Run: `cargo test --manifest-path spikes/tauri/core/Cargo.toml`

Expected: FAIL because `TestCore` and the named-pipe server are missing.

- [ ] **Step 4: Implement the Rust core and PTY bridge**

Use `portable-pty` for spawn/read/write/resize and a Windows named-pipe crate for IPC. Implement the same request union and response shapes from Task 7. Unknown requests return `unknown_request`; disconnecting the UI drops only that client connection, never the core or PTY child.

- [ ] **Step 5: Implement the minimal Tauri client**

The Tauri process connects to the already-running core or launches the core sidecar and reconnects. The frontend renders raw text safely, resizes the PTY on container resize, and closes after receiving output during the benchmark.

- [ ] **Step 6: Build, test, package, and record metrics**

Run:

```powershell
cargo test --manifest-path spikes/tauri/core/Cargo.toml
pnpm --dir spikes/tauri tauri build
```

Expected: Rust tests PASS, Windows package builds, and reconnecting after UI exit receives a healthy response. Record the same seven metrics in `artifacts/feasibility/framework-tauri.json`.

- [ ] **Step 7: Commit the Tauri spike**

```powershell
git add spikes/tauri artifacts/feasibility/framework-tauri.json Cargo.lock pnpm-lock.yaml
git commit -m "spike: evaluate Tauri runtime"
```

---

### Task 9: Parallel, interruption, and recovery benchmark

**Files:**
- Create: `packages/probe-runner/src/benchmark.ts`
- Create: `packages/probe-runner/test/benchmark.test.ts`
- Create: `scripts/run-real-probes.ps1`
- Create: `scripts/run-framework-benchmark.ps1`

**Interfaces:**
- Consumes: fake, Codex and Claude probe adapters plus both framework metric files.
- Produces: `runParallelProbe(specs, concurrency)`, `feasibility-summary.json`, and a nonzero exit code when a hard gate fails.

- [ ] **Step 1: Write the failing three-session benchmark test**

```ts
it("runs three fake sessions concurrently and preserves identity", async () => {
  const result = await runParallelProbe([
    { id: "leader", adapter: "fake", prompt: "lead" },
    { id: "developer", adapter: "fake", prompt: "build" },
    { id: "reviewer", adapter: "fake", prompt: "review" }
  ], 3);
  expect(result.completed).toEqual(["leader", "developer", "reviewer"]);
  expect(new Set(result.sessionIds).size).toBe(3);
  expect(result.orphanPids).toEqual([]);
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `pnpm --filter @agenttown/probe-runner test -- benchmark.test.ts`

Expected: FAIL because `runParallelProbe` is missing.

- [ ] **Step 3: Implement bounded parallel execution**

Implement a queue with explicit concurrency, per-session log paths and a `finally` block that interrupts then kills all unfinished handles. Never use one shared mutable `sessionId`. The summary must include elapsed time, peak core memory, completed IDs, failed IDs and orphan PIDs.

- [ ] **Step 4: Implement explicit PowerShell entry points**

`run-real-probes.ps1` must:

1. Check `codex` and `claude` with `Get-Command`.
2. Create a unique temporary directory using `New-Item` and initialize Git.
3. Set `AGENTTOWN_REAL_CODEX=1` and `AGENTTOWN_REAL_CLAUDE=1` only for child test commands.
4. Run first-turn, resume, interrupt and three-session probes.
5. Remove the temporary directory only after resolving and verifying it is below `[System.IO.Path]::GetTempPath()`.
6. Exit nonzero if a required capability is false.

`run-framework-benchmark.ps1` runs both packaged candidates three times and writes median cold-start and stable install size to their metric files.

Add this exact script to `packages/probe-runner/package.json`:

```json
{
  "scripts": {
    "score-frameworks": "tsx src/score-frameworks.ts"
  }
}
```

- [ ] **Step 5: Verify fake benchmark and execute the real benchmark manually**

Run:

```powershell
pnpm probe:fake
powershell -NoProfile -File scripts/run-real-probes.ps1
powershell -NoProfile -File scripts/run-framework-benchmark.ps1
```

Expected: fake benchmark always PASS. Real runs either satisfy every required capability or identify the exact failed capability and preserve logs; no generic `unknown failure` result is allowed.

- [ ] **Step 6: Commit benchmark tooling and sanitized summary**

```powershell
git add packages/probe-runner scripts artifacts/feasibility/feasibility-summary.json
git commit -m "test: benchmark parallel agent sessions"
```

---

### Task 10: Select the runtime and record the ADR

**Files:**
- Create: `docs/adr/0001-desktop-and-core-runtime.md`
- Modify: `docs/superpowers/plans/2026-07-20-agenttown-implementation-roadmap.md`

**Interfaces:**
- Consumes: `framework-electron.json`, `framework-tauri.json`, both Agent capability reports and `scoreFramework`.
- Produces: one accepted runtime, one rejected alternative, explicit blockers, and constraints inherited by P1.

- [ ] **Step 1: Generate the score table from artifacts**

Run: `pnpm --filter @agenttown/probe-runner score-frameworks`

Expected: Markdown table containing hard-gate status, weighted score, install size, cold start, implementation time and observed failures for both candidates.

- [ ] **Step 2: Write the ADR with a mechanically checkable decision rule**

Use this exact decision order:

1. Reject any candidate failing PTY stability, core survival, packaging or embedded terminal.
2. If one candidate remains, select it.
3. If both remain and weighted scores differ by at least 10 points, select the higher score.
4. If both remain within 10 points, select the candidate with fewer implementation minutes because AgentTown prioritizes practical delivery.
5. If neither remains, stop P1 and evaluate OpenCode only if the failure belongs to an Agent adapter; framework failures require a revised P0 plan.

The ADR includes Context, Evidence, Decision, Consequences, Rejected Alternative and P1 Constraints. It references artifact paths and exact command versions.

- [ ] **Step 3: Update the roadmap with the selected stack**

Add the selected runtime to P1 in the roadmap and copy these facts from the ADR: core language, UI framework, PTY library, IPC transport, package format and minimum Windows version.

- [ ] **Step 4: Run final P0 verification**

Run:

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm probe:fake
git diff --check
git status --short
```

Expected: all automated commands exit `0`; only intended ADR/roadmap/artifact changes are present; real-Agent reports show launch, stream output, session ID, resume, interrupt and three-session parallel results for both Agent products.

- [ ] **Step 5: Commit the decision**

```powershell
git add docs/adr docs/superpowers/plans artifacts/feasibility
git commit -m "docs: select AgentTown desktop runtime"
```

## P0 Exit Criteria

- Codex and Claude capability reports contain explicit results for all nine capability fields.
- Session resume is verified with a specific session ID, not only “continue latest”.
- Ctrl+C/interrupt has bounded escalation and leaves no probe-owned orphan process.
- Three sessions run concurrently with separate identity, logs and lifecycle.
- Electron and Tauri both have measured evidence or an explicit build blocker.
- The selected runtime passes all four hard gates.
- The ADR is committed before P1 implementation planning begins.

## Reference Evidence

- Codex non-interactive mode documents JSONL events, token usage and `codex exec resume <SESSION_ID>`: <https://learn.chatgpt.com/docs/non-interactive-mode>
- Claude Code CLI documents `stream-json`, `--resume` and non-interactive print mode: <https://code.claude.com/docs/en/cli-usage>
- `node-pty` documents Windows ConPTY support and its process/resize APIs: <https://github.com/microsoft/node-pty>
- Electron documents independent utility-process messaging, stdout and lifecycle primitives: <https://www.electronjs.org/docs/latest/api/utility-process>
- Tauri documents sidecar execution and permission configuration: <https://v2.tauri.app/develop/sidecar/>
