import { describe, expect, it } from "vitest";
import {
  renderFrame,
  truncate,
  visualWidth,
  type TuiSnapshot
} from "../src/tui/layout.js";

function snapshot(overrides: Partial<TuiSnapshot> = {}): TuiSnapshot {
  return {
    status: "running",
    activeTaskCount: 2,
    pendingApprovalCount: 1,
    employeeCount: 3,
    view: "events",
    events: [],
    tasks: [],
    employees: [],
    approvals: [],
    result: null,
    input: "",
    inputCursor: 0,
    wizard: null,
    helpVisible: false,
    connected: true,
    ...overrides
  };
}

function event(sequence: number, type: string) {
  return {
    sequence,
    id: `e-${sequence}`,
    type,
    actorId: "leader",
    taskId: null,
    causationEventId: null,
    payload: {},
    occurredAt: "2026-08-31T12:34:56.000Z"
  };
}

describe("visualWidth", () => {
  it("counts CJK as 2", () => {
    expect(visualWidth("abc")).toBe(3);
    expect(visualWidth("中文")).toBe(4);
    expect(visualWidth("a中b")).toBe(4);
  });
});

describe("truncate", () => {
  it("truncates by visual width with an ellipsis", () => {
    expect(truncate("abcdef", 6)).toBe("abcdef");
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("中文测试", 5)).toBe("中文…");
  });
});

describe("renderFrame", () => {
  it("renders the status bar with company state", () => {
    const frame = renderFrame(snapshot(), 60, 10).frame;
    expect(frame).toContain("● running");
    expect(frame).toContain("任务 2");
    expect(frame).toContain("待审批 1");
    expect(frame).toContain("员工 3");
  });

  it("shows a disconnected dot when not connected", () => {
    const frame = renderFrame(snapshot({ connected: false }), 60, 10).frame;
    expect(frame).toContain("○");
  });

  it("renders events with Chinese descriptions", () => {
    const frame = renderFrame(snapshot({
      events: [event(1, "task.submitted"), event(2, "task.review_approved")]
    }), 60, 10).frame;
    expect(frame).toContain("任务已提交");
    expect(frame).toContain("审核通过");
  });

  it("renders the result area", () => {
    const frame = renderFrame(snapshot({
      result: { kind: "ok", text: "已暂停公司" }
    }), 60, 10).frame;
    expect(frame).toContain("✔ 已暂停公司");
  });

  it("renders the input line with a cursor column", () => {
    const frame = renderFrame(snapshot({ input: "暂停", inputCursor: 2 }), 60, 10);
    // "> " 前缀宽 2，加两个中文字符宽 4 → 光标列 = 1 + 2 + 4 = 7
    expect(frame.cursorCol).toBe(7);
    expect(frame.cursorRow).toBe(10);
    expect(frame.frame.split("\n")[9]).toBe("> 暂停");
  });

  it("pins the input line to the bottom row even for sparse views", () => {
    const frame = renderFrame(snapshot({ view: "tasks" }), 60, 10);
    const lines = frame.frame.split("\n");
    expect(lines[0]).toContain("● running");
    expect(lines[9]).toBe("> ");
    expect(frame.cursorRow).toBe(10);
  });

  it("renders wizard prompts instead of the result", () => {
    const frame = renderFrame(snapshot({
      wizard: {
        step: "title",
        prompt: "任务标题（必填）：",
        preview: { title: "", objective: "", assignee: null, acceptanceCriteria: [] },
        candidates: ["developer-a", "developer-b"],
        error: null
      }
    }), 60, 10).frame;
    expect(frame).toContain("任务标题（必填）");
  });

  it("shows help shortcuts when helpVisible", () => {
    const frame = renderFrame(snapshot({ helpVisible: true }), 60, 10).frame;
    expect(frame).toContain("Tab 切换视图");
  });

  it("fills the full height", () => {
    const frame = renderFrame(snapshot(), 60, 12).frame;
    expect(frame.split("\n")).toHaveLength(12);
  });
});
