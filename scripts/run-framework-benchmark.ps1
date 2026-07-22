param(
  [string]$ArtifactRoot = (Join-Path $PSScriptRoot "..\artifacts\feasibility"),
  [string]$SummaryPath = (Join-Path $PSScriptRoot "..\artifacts\feasibility\framework-summary.json")
)

$ErrorActionPreference = "Stop"

function Get-FrameworkRow {
  param([Parameter(Mandatory = $true)]$Artifact)

  $hardBlockers = @()
  if (-not $Artifact.ptyStable) { $hardBlockers += "pty_stability" }
  if (-not $Artifact.coreSurvivesUiExit) { $hardBlockers += "core_survival" }
  if (-not $Artifact.packageBuilds) { $hardBlockers += "packaging" }
  if (-not $Artifact.embeddedTerminalWorks) { $hardBlockers += "terminal_embedding" }
  $evidenceBlockers = @($Artifact.evidence.blockers | Where-Object { $_ })
  $blockers = @($hardBlockers + $evidenceBlockers | Select-Object -Unique)
  $measured = $hardBlockers.Count -eq 0 `
    -and $Artifact.evidence.measurementEligible -ne $false `
    -and $Artifact.evidence.installSizeMeasured -ne $false `
    -and $Artifact.evidence.coldStartMeasured -ne $false

  [ordered]@{
    name = $Artifact.name
    eligible = $hardBlockers.Count -eq 0
    measurementEligible = $measured
    installSize = if ($measured) { $Artifact.installSizeMb } else { "N/A" }
    coldStart = if ($measured) { $Artifact.coldStartMs } else { "N/A" }
    weightedScore = "N/A"
    rank = $null
    blockers = $blockers
    benchmarkRuns = 0
  }
}

$resolvedRoot = [System.IO.Path]::GetFullPath($ArtifactRoot)
$electronPath = Join-Path $resolvedRoot "framework-electron.json"
$tauriPath = Join-Path $resolvedRoot "framework-tauri.json"
$electron = Get-Content -LiteralPath $electronPath -Raw | ConvertFrom-Json
$tauri = Get-Content -LiteralPath $tauriPath -Raw | ConvertFrom-Json
$rows = @((Get-FrameworkRow $electron), (Get-FrameworkRow $tauri))
$realSummaryPath = Join-Path $resolvedRoot "real-probes-summary.json"
[object[]]$agents = @()
if (Test-Path -LiteralPath $realSummaryPath) {
  $agents = @((Get-Content -LiteralPath $realSummaryPath -Raw | ConvertFrom-Json).agents)
}

# No current candidate is both hard-gate eligible and measurement-eligible. In particular,
# this branch never launches or rewrites Tauri and never replaces Electron's packaged blocker.
$summary = [ordered]@{
  generatedBy = "run-framework-benchmark.ps1"
  frameworks = $rows
  agents = $agents
}
$summaryDirectory = Split-Path -Parent ([System.IO.Path]::GetFullPath($SummaryPath))
if (-not (Test-Path -LiteralPath $summaryDirectory)) {
  New-Item -ItemType Directory -Path $summaryDirectory | Out-Null
}
[System.IO.File]::WriteAllText(
  [System.IO.Path]::GetFullPath($SummaryPath),
  (($summary | ConvertTo-Json -Depth 8) + [Environment]::NewLine),
  [System.Text.UTF8Encoding]::new($false)
)

if (@($rows | Where-Object { -not $_.eligible -or -not $_.measurementEligible }).Count -gt 0) {
  exit 1
}
