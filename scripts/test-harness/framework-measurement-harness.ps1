param(
  [ValidateSet("success", "run-failure", "hang", "start-error", "malformed-output")]
  [string]$Scenario,
  [string]$SummaryPath
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "..\lib\framework-measurement.ps1")
$row = [ordered]@{
  name = "electron"; eligible = $true; measurementEligible = $true
  installSize = "N/A"; coldStart = "N/A"; coldStartSamples = @()
  weightedScore = "N/A"; implementationMinutes = 60; rank = $null
  blockers = @(); benchmarkRuns = 0
}
$callback = {
  param([string]$Framework, [int]$Run)
  if ($Scenario -eq "start-error") { throw "synthetic start failure" }
  if ($Scenario -eq "hang") {
    return [pscustomobject]@{ ExitCode = 124; Kind = "timeout"; Blockers = @("execution_timeout"); Output = "" }
  }
  if ($Scenario -eq "run-failure" -and $Run -eq 2) {
    return [pscustomobject]@{ ExitCode = 7; Kind = "nonzero"; Blockers = @("execution_exit_7"); Output = "" }
  }
  if ($Scenario -eq "malformed-output") {
    return [pscustomobject]@{ ExitCode = 0; Kind = "success"; Blockers = @(); Output = "not json" }
  }
  $samples = @(30, 10, 20)
  $output = [ordered]@{ coldStartMs = $samples[$Run - 1]; installSizeMb = 42 } | ConvertTo-Json -Compress
  return [pscustomobject]@{ ExitCode = 0; Kind = "success"; Blockers = @(); Output = $output }
}
$result = Invoke-FrameworkMeasurement -Row $row -RunMeasurement $callback
$directory = Split-Path -Parent ([IO.Path]::GetFullPath($SummaryPath))
if (-not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory | Out-Null }
[IO.File]::WriteAllText([IO.Path]::GetFullPath($SummaryPath), (($result | ConvertTo-Json -Depth 8) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
if ($result.blockers.Count -gt 0) { exit 1 }
