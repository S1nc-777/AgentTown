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
