import { describe, expect, it } from "vitest";
import { startWizard, wizardSubmit } from "../src/tui/wizard.js";

const CANDIDATES = ["developer-a", "developer-b"];

describe("startWizard", () => {
  it("starts at the title step with hints applied", () => {
    const view = startWizard(CANDIDATES, { assignee: "developer-a", title: "登录页面" });
    expect(view.step).toBe("title");
    expect(view.preview.title).toBe("登录页面");
    expect(view.preview.assignee).toBe("developer-a");
    expect(view.error).toBeNull();
  });
});

describe("wizardSubmit", () => {
  it("requires a non-empty title", () => {
    const view = startWizard(CANDIDATES);
    const result = wizardSubmit(view, "   ");
    expect(result.kind).toBe("continue");
    if (result.kind === "continue") expect(result.view.error).toBe("标题不能为空");
  });

  it("walks through all steps and submits", () => {
    let view = startWizard(CANDIDATES);
    view = step(view, "登录页面");
    expect(view.step).toBe("objective");
    view = step(view, "用户可以登录");
    expect(view.step).toBe("assignee");
    view = step(view, "1");
    expect(view.step).toBe("acceptance");
    expect(view.preview.assignee).toBe("developer-a");
    view = step(view, "表单校验, 会话保持");
    expect(view.step).toBe("confirm");
    expect(view.preview.acceptanceCriteria).toEqual(["表单校验", "会话保持"]);
    const result = wizardSubmit(view, "");
    expect(result).toEqual({
      kind: "submit",
      draft: {
        title: "登录页面",
        objective: "用户可以登录",
        assignee: "developer-a",
        acceptanceCriteria: ["表单校验", "会话保持"]
      }
    });
  });

  it("accepts employee ids as assignee", () => {
    let view = startWizard(CANDIDATES);
    view = step(view, "标题");
    view = step(view, "目标");
    view = step(view, "developer-b");
    expect(view.preview.assignee).toBe("developer-b");
    view = step(view, ""); // acceptance → confirm
    const result = wizardSubmit(view, ""); // confirm → submit
    expect(result.kind).toBe("submit");
    if (result.kind === "submit") expect(result.draft.assignee).toBe("developer-b");
  });

  it("leaves assignee null when left empty", () => {
    let view = startWizard(CANDIDATES);
    view = step(view, "标题");
    view = step(view, "目标");
    view = step(view, "");
    expect(view.preview.assignee).toBeNull();
    view = step(view, ""); // acceptance → confirm
    const result = wizardSubmit(view, ""); // confirm → submit
    expect(result.kind).toBe("submit");
    if (result.kind === "submit") expect(result.draft.assignee).toBeNull();
  });

  it("rejects unknown assignees", () => {
    let view = startWizard(CANDIDATES);
    view = step(view, "标题");
    view = step(view, "目标");
    const result = wizardSubmit(view, "nobody");
    expect(result.kind).toBe("continue");
    if (result.kind === "continue") expect(result.view.error).toContain("未知负责人");
  });

  it("cancels on no at the confirm step", () => {
    let view = startWizard(CANDIDATES);
    view = step(view, "标题");
    view = step(view, "目标");
    view = step(view, "");
    view = step(view, "");
    const result = wizardSubmit(view, "no");
    expect(result.kind).toBe("cancel");
  });
});

function step(view: ReturnType<typeof startWizard>, line: string): ReturnType<typeof startWizard> {
  const result = wizardSubmit(view, line);
  if (result.kind !== "continue") throw new Error(`expected continue, got ${result.kind}`);
  return result.view;
}
