export interface WizardDraft {
  title: string;
  objective: string;
  acceptanceCriteria: string[];
}

export type WizardStep = "title" | "objective" | "acceptance" | "confirm";

export interface WizardView {
  step: WizardStep;
  /** Single-line prompt shown above the input line. */
  prompt: string;
  preview: WizardDraft;
  error: string | null;
}

export type WizardResult =
  | { kind: "continue"; view: WizardView }
  | { kind: "submit"; draft: WizardDraft }
  | { kind: "cancel" };

/**
 * The wizard collects ONLY what the user must decide (title / objective /
 * acceptance criteria). Assignment is deliberately NOT asked: a task the
 * user drops on the company is handed to the leader, who picks the
 * developer (the leader drive nudges the leader to assign new tasks).
 */
export function startWizard(hint: Partial<WizardDraft> = {}): WizardView {
  return {
    step: "title",
    prompt: "任务标题（必填）：",
    preview: {
      title: hint.title ?? "",
      objective: hint.objective ?? "",
      acceptanceCriteria: []
    },
    error: null
  };
}

export function wizardSubmit(view: WizardView, line: string): WizardResult {
  const value = line.trim();
  switch (view.step) {
    case "title": {
      const title = value.length > 0 ? value : view.preview.title;
      if (title.length === 0) {
        return { kind: "continue", view: { ...view, error: "标题不能为空" } };
      }
      return {
        kind: "continue",
        view: {
          ...view,
          step: "objective",
          prompt: "任务目标（必填，一句话说明要达成的结果）：",
          preview: { ...view.preview, title },
          error: null
        }
      };
    }
    case "objective": {
      const objective = value.length > 0 ? value : view.preview.objective;
      if (objective.length === 0) {
        return { kind: "continue", view: { ...view, error: "目标不能为空" } };
      }
      return {
        kind: "continue",
        view: {
          ...view,
          step: "acceptance",
          prompt: "验收标准（逗号分隔，可留空）：",
          preview: { ...view.preview, objective },
          error: null
        }
      };
    }
    case "acceptance": {
      const criteria = value.length === 0
        ? []
        : value.split(/[,，]/u).map((part) => part.trim()).filter((part) => part.length > 0);
      return {
        kind: "continue",
        view: {
          ...view,
          step: "confirm",
          prompt: "回车确认创建任务（由 leader 分配开发），输入 no 取消：",
          preview: { ...view.preview, acceptanceCriteria: criteria },
          error: null
        }
      };
    }
    case "confirm": {
      if (value === "no" || value === "n" || value === "取消") {
        return { kind: "cancel" };
      }
      return { kind: "submit", draft: view.preview };
    }
  }
}
