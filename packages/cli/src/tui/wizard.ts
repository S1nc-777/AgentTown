export interface WizardDraft {
  title: string;
  objective: string;
  assignee: string | null;
  acceptanceCriteria: string[];
}

export type WizardStep = "title" | "objective" | "assignee" | "acceptance" | "confirm";

export interface WizardView {
  step: WizardStep;
  /** Single-line prompt shown above the input line. */
  prompt: string;
  preview: WizardDraft;
  candidates: readonly string[];
  error: string | null;
}

export type WizardResult =
  | { kind: "continue"; view: WizardView }
  | { kind: "submit"; draft: WizardDraft }
  | { kind: "cancel" };

export function startWizard(
  candidates: readonly string[],
  hint: Partial<WizardDraft> = {}
): WizardView {
  return {
    step: "title",
    prompt: "任务标题（必填）：",
    preview: {
      title: hint.title ?? "",
      objective: hint.objective ?? "",
      assignee: hint.assignee ?? null,
      acceptanceCriteria: []
    },
    candidates,
    error: null
  };
}

export function wizardSubmit(view: WizardView, line: string): WizardResult {
  const value = line.trim();
  switch (view.step) {
    case "title": {
      if (value.length === 0) {
        return { kind: "continue", view: { ...view, error: "标题不能为空" } };
      }
      return {
        kind: "continue",
        view: {
          ...view,
          step: "objective",
          prompt: "任务目标（必填，一句话说明要达成的结果）：",
          preview: { ...view.preview, title: value },
          error: null
        }
      };
    }
    case "objective": {
      if (value.length === 0) {
        return { kind: "continue", view: { ...view, error: "目标不能为空" } };
      }
      return {
        kind: "continue",
        view: {
          ...view,
          step: "assignee",
          prompt: `负责人（输入编号或员工 id，留空不分配）：${view.candidates.map((candidate, index) => `${index + 1}. ${candidate}`).join(" ")}`,
          preview: { ...view.preview, objective: value },
          error: null
        }
      };
    }
    case "assignee": {
      let assignee: string | null = null;
      if (value.length > 0) {
        const number = Number(value);
        if (Number.isInteger(number) && number >= 1 && number <= view.candidates.length) {
          assignee = view.candidates[number - 1] ?? null;
        } else if (view.candidates.includes(value)) {
          assignee = value;
        } else {
          return {
            kind: "continue",
            view: { ...view, error: `未知负责人：${value}（输入编号或员工 id）` }
          };
        }
      }
      return {
        kind: "continue",
        view: {
          ...view,
          step: "acceptance",
          prompt: "验收标准（逗号分隔，可留空）：",
          preview: { ...view.preview, assignee },
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
          prompt: "回车确认创建任务，输入 no 取消：",
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
