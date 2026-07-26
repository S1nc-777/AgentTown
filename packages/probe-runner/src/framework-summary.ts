import { scoreFramework, type FrameworkMetrics } from "@agenttown/probe-contract";

export interface FrameworkEvidence {
  blockers?: string[];
  measurementEligible?: boolean;
  installSizeMeasured?: boolean;
  coldStartMeasured?: boolean;
  [key: string]: unknown;
}

export interface FrameworkArtifact extends FrameworkMetrics {
  evidence?: FrameworkEvidence;
}

export interface FrameworkSummaryRow {
  name: FrameworkMetrics["name"];
  eligible: boolean;
  measurementEligible: boolean;
  installSize: number | "N/A";
  coldStart: number | "N/A";
  weightedScore: number | "N/A";
  implementationMinutes: number;
  rank: number | null;
  blockers: string[];
}

export function summarizeFrameworks(artifacts: FrameworkArtifact[]): FrameworkSummaryRow[] {
  const rows = artifacts.map((artifact): FrameworkSummaryRow => {
    const scored = scoreFramework(artifact);
    const evidence = artifact.evidence;
    const measurementsUsable = scored.eligible
      && evidence?.measurementEligible !== false
      && evidence?.installSizeMeasured !== false
      && evidence?.coldStartMeasured !== false;
    const blockers = [...new Set([
      ...scored.blockers,
      ...(evidence?.blockers ?? [])
    ])];
    return {
      name: artifact.name,
      eligible: scored.eligible,
      measurementEligible: measurementsUsable,
      installSize: measurementsUsable ? artifact.installSizeMb : "N/A",
      coldStart: measurementsUsable ? artifact.coldStartMs : "N/A",
      weightedScore: measurementsUsable ? scored.score : "N/A",
      implementationMinutes: artifact.implementationMinutes,
      rank: null,
      blockers
    };
  });

  const ranked = rows
    .filter((row): row is FrameworkSummaryRow & { weightedScore: number } => typeof row.weightedScore === "number")
    .sort((left, right) => right.weightedScore - left.weightedScore);
  ranked.forEach((row, index) => { row.rank = index + 1; });
  return rows;
}

export function renderFrameworkTable(rows: FrameworkSummaryRow[]): string {
  const header = [
    "| Framework | Eligible | Install MiB | Cold start ms | Weighted score | Implementation minutes | Rank | Blockers |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |"
  ];
  const body = rows.map((row) => [
    "|",
    row.name,
    "|",
    row.eligible && row.measurementEligible ? "yes" : "no",
    "|",
    row.installSize,
    "|",
    row.coldStart,
    "|",
    row.weightedScore,
    "|",
    row.implementationMinutes,
    "|",
    row.rank ?? "-",
    "|",
    row.blockers.join(", ") || "none",
    "|"
  ].join(" "));
  return [...header, ...body].join("\n");
}
