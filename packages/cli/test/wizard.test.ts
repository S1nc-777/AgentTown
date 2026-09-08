import { describe, expect, it } from "vitest";
import { startWizard, wizardSubmit } from "../src/tui/wizard.js";

describe("startWizard", () => {
  it("starts at the title step with hints applied", () => {
    const view = startWizard({ title: "登录页面", objective: "用户可以登录" });
    expect(view.step).toBe("title");
    expect(view.preview.title).toBe("登录页面");
    expect(view.preview.objective).toBe("用户可以登录");
    expect(view.error).toBeNull();
  });
});

describe("wizardSubmit", () => {
  it("requires a non-empty title", () => {
    const view = startWizard();
    const result = wizardSubmit(view, "   ");
    expect(result.kind).toBe("continue");
    if (result.kind === "continue") expect(result.view.error).toBe("标题不能为空");
  });

  it("walks through all steps and submits", () => {
    let view = startWizard();
    view = step(view, "登录页面");
    expect(view.step).toBe("objective");
    view = step(view, "用户可以登录");
    expect(view.step).toBe("acceptance");
    view = step(view, "表单校验, 会话保持");
    expect(view.step).toBe("confirm");
    expect(view.preview.acceptanceCriteria).toEqual(["表单校验", "会话保持"]);
    const result = wizardSubmit(view, "");
    expect(result).toEqual({
      kind: "submit",
      draft: {
        title: "登录页面",
        objective: "用户可以登录",
        acceptanceCriteria: ["表单校验", "会话保持"]
      }
    });
  });

  it("accepts empty acceptance criteria", () => {
    let view = startWizard();
    view = step(view, "标题");
    view = step(view, "目标");
    view = step(view, "");
    expect(view.preview.acceptanceCriteria).toEqual([]);
    const result = wizardSubmit(view, "");
    expect(result.kind).toBe("submit");
    if (result.kind === "submit") {
      expect(result.draft.acceptanceCriteria).toEqual([]);
    }
  });

  it("cancels on no at the confirm step", () => {
    let view = startWizard();
    view = step(view, "标题");
    view = step(view, "目标");
    view = step(view, "");
    const result = wizardSubmit(view, "no");
    expect(result.kind).toBe("cancel");
  });

  it("falls back to hint values on blank input", () => {
    let view = startWizard({ title: "登录页面", objective: "写一个登录页面" });
    view = step(view, ""); // title falls back to hint
    expect(view.preview.title).toBe("登录页面");
    view = step(view, ""); // objective falls back to hint
    expect(view.preview.objective).toBe("写一个登录页面");
    view = step(view, "");
    const result = wizardSubmit(view, "");
    expect(result.kind).toBe("submit");
    if (result.kind === "submit") {
      expect(result.draft.title).toBe("登录页面");
      expect(result.draft.objective).toBe("写一个登录页面");
    }
  });
});

function step(view: ReturnType<typeof startWizard>, line: string): ReturnType<typeof startWizard> {
  const result = wizardSubmit(view, line);
  if (result.kind !== "continue") throw new Error(`expected continue, got ${result.kind}`);
  return result.view;
}
