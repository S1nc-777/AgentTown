param(
  [string]$ArtifactRoot = (Join-Path $PSScriptRoot "..\artifacts\feasibility"),
  [string]$SummaryPath = (Join-Path $PSScriptRoot "..\artifacts\feasibility\framework-summary.json"),
  [string]$MeasurementCommand
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
  $measurementEligible = $hardBlockers.Count -eq 0 `
    -and $Artifact.evidence.measurementEligible -ne $false `
    -and $Artifact.evidence.installSizeMeasured -ne $false `
    -and $Artifact.evidence.coldStartMeasured -ne $false

  [ordered]@{
    name = $Artifact.name
    eligible = $hardBlockers.Count -eq 0
    measurementEligible = $measurementEligible
    installSize = "N/A"
    coldStart = "N/A"
    coldStartSamples = @()
    weightedScore = "N/A"
    implementationMinutes = [double]$Artifact.implementationMinutes
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

foreach ($row in $rows) {
  if (-not $row.eligible -or -not $row.measurementEligible) { continue }
  if ([string]::IsNullOrWhiteSpace($MeasurementCommand)) {
    $row.measurementEligible = $false
    $row.blockers = @($row.blockers + "measurement_command_missing" | Select-Object -Unique)
    continue
  }
  $coldStarts = @()
  $installSizes = @()
  for ($run = 1; $run -le 3; $run += 1) {
    $output = & powershell.exe -NoProfile -File $MeasurementCommand -Framework $row.name -Run $run 2>&1
    $measurementExitCode = $LASTEXITCODE
    if ($measurementExitCode -ne 0) {
      $row.measurementEligible = $false
      $row.blockers = @($row.blockers + ("measurement_run_" + $run + "_exit_" + $measurementExitCode) | Select-Object -Unique)
      break
    }
    try {
      $measurement = ($output -join [Environment]::NewLine) | ConvertFrom-Json
      if ($null -eq $measurement -or $measurement.coldStartMs -isnot [ValueType] -or $measurement.installSizeMb -isnot [ValueType]) {
        throw "invalid measurement shape"
      }
      $coldStart = [double]$measurement.coldStartMs
      $installSize = [double]$measurement.installSizeMb
      if ($coldStart -lt 0 -or $installSize -lt 0) { throw "invalid measurement value" }
      $coldStarts += $coldStart
      $installSizes += $installSize
      $row.benchmarkRuns += 1
    } catch {
      $row.measurementEligible = $false
      $row.blockers = @($row.blockers + ("measurement_run_" + $run + "_invalid_output") | Select-Object -Unique)
      break
    }
  }
  if ($row.measurementEligible -and $row.benchmarkRuns -eq 3) {
    $uniqueSizes = @($installSizes | Select-Object -Unique)
    if ($uniqueSizes.Count -ne 1) {
      $row.measurementEligible = $false
      $row.blockers = @($row.blockers + "measurement_install_size_unstable" | Select-Object -Unique)
      continue
    }
    $sortedColdStarts = @($coldStarts | Sort-Object)
    $row.coldStartSamples = @($coldStarts)
    $row.coldStart = $sortedColdStarts[1]
    $row.installSize = $uniqueSizes[0]
    $score = [Math]::Max([double]0, [double](30 - $row.installSize / 10)) + `
      [Math]::Max([double]0, [double](30 - $row.coldStart / 100)) + `
      [Math]::Max([double]0, [double](40 - $row.implementationMinutes / 5))
    $row.weightedScore = [Math]::Round($score, 1)
  }
}

$ranked = @($rows | Where-Object { $_.weightedScore -is [ValueType] } | Sort-Object weightedScore -Descending)
for ($index = 0; $index -lt $ranked.Count; $index += 1) { $ranked[$index].rank = $index + 1 }

# Current source candidates remain ineligible, so the default branch launches no candidate.
# MeasurementCommand is an explicit offline fixture/eligible-candidate hook and never rewrites artifacts.
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
