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
