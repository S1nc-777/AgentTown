param(
  [string]$ArtifactRoot = (Join-Path $PSScriptRoot "..\artifacts\feasibility"),
  [string]$SummaryPath = (Join-Path $PSScriptRoot "..\artifacts\feasibility\framework-summary.json")
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib\bounded-process.ps1")
. (Join-Path $PSScriptRoot "lib\framework-measurement.ps1")
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$repositoryPrefix = $repositoryRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$rows = @()
[object[]]$agents = @()
$summaryBlockers = @()
$measurementLogRoot = $null

function Resolve-RepositoryPath([string]$RelativePath) {
  $resolved = [IO.Path]::GetFullPath((Join-Path $script:repositoryRoot $RelativePath))
  if (-not $resolved.StartsWith($script:repositoryPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "framework_measurement_path_outside_repository"
  }
  return $resolved
}

function New-FrameworkRow($Artifact) {
  $hardBlockers = @()
  if (-not $Artifact.ptyStable) { $hardBlockers += "pty_stability" }
  if (-not $Artifact.coreSurvivesUiExit) { $hardBlockers += "core_survival" }
  if (-not $Artifact.packageBuilds) { $hardBlockers += "packaging" }
  if (-not $Artifact.embeddedTerminalWorks) { $hardBlockers += "terminal_embedding" }
  $evidenceBlockers = @($Artifact.evidence.blockers | Where-Object { $_ })
  $measurementEligible = $hardBlockers.Count -eq 0 `
    -and $Artifact.evidence.measurementEligible -ne $false `
    -and $Artifact.evidence.installSizeMeasured -ne $false `
    -and $Artifact.evidence.coldStartMeasured -ne $false
  [ordered]@{
    name = $Artifact.name; eligible = $hardBlockers.Count -eq 0; measurementEligible = $measurementEligible
    installSize = "N/A"; coldStart = "N/A"; coldStartSamples = @(); weightedScore = "N/A"
    implementationMinutes = [double]$Artifact.implementationMinutes; rank = $null
    blockers = @($hardBlockers + $evidenceBlockers | Select-Object -Unique); benchmarkRuns = 0
  }
}

function New-FrameworkErrorRow([string]$Name, [string]$Blocker) {
  [ordered]@{
    name = $Name; eligible = $false; measurementEligible = $false
    installSize = "N/A"; coldStart = "N/A"; coldStartSamples = @(); weightedScore = "N/A"
    implementationMinutes = 0; rank = $null; blockers = @($Blocker); benchmarkRuns = 0
  }
}

function Get-FixedCandidateSpec([string]$Name) {
  if ($Name -eq "electron") {
    return [pscustomobject]@{
      Script = Resolve-RepositoryPath "spikes\electron\scripts\measure-cold-start.mjs"
      Executable = Resolve-RepositoryPath "spikes\electron\out\AgentTownElectronSpike-win32-x64\AgentTownElectronSpike.exe"
      PackageRoot = Resolve-RepositoryPath "spikes\electron\out\AgentTownElectronSpike-win32-x64"
    }
  }
  return [pscustomobject]@{
    Script = Resolve-RepositoryPath "spikes\tauri\scripts\measure-cold-start.mjs"
    Executable = Resolve-RepositoryPath "spikes\tauri\src-tauri\target\release\agenttown-tauri-spike.exe"
    PackageRoot = Resolve-RepositoryPath "spikes\tauri\src-tauri\target\release"
  }
}

function Add-FixedCandidateMissingBlocker($Row, $Spec) {
  foreach ($field in @("Script", "Executable", "PackageRoot")) {
    if (-not (Test-Path -LiteralPath $Spec.$field)) {
      $suffix = if ($field -eq "Script") { "measurement_script_missing" } elseif ($field -eq "Executable") { "package_executable_missing" } else { "package_root_missing" }
      $Row.measurementEligible = $false
      $Row.blockers = @($Row.blockers + ($Row.name + "_" + $suffix) | Select-Object -Unique)
      return $true
    }
  }
  return $false
}

function Invoke-FixedCandidateRun($Spec, [string]$Framework, [int]$Run) {
  if ($null -eq $script:measurementLogRoot) {
    $script:measurementLogRoot = Join-Path ([IO.Path]::GetTempPath()) ("agenttown-framework-measurement-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $script:measurementLogRoot | Out-Null
  }
  $label = $Framework + "-" + $Run
  $child = Start-BoundedProcess -FilePath "node.exe" `
    -Arguments @($Spec.Script, $Spec.Executable, "--runs", "1") `
    -Label $label -Deadline ([DateTime]::UtcNow.AddSeconds(45)) -LogRoot $script:measurementLogRoot
  if ($child.ExitCode -ne 0) {
    return [pscustomobject]@{ ExitCode = $child.ExitCode; Kind = $child.Kind; Blockers = $child.Blockers; Output = "" }
  }
  try {
    $events = @([IO.File]::ReadAllLines($child.StdoutPath) | ForEach-Object {
      try { $_ | ConvertFrom-Json } catch { $null }
    } | Where-Object { $null -ne $_ })
    $final = @($events | Where-Object { $_.runsMs -is [Array] -and $_.runsMs.Count -eq 1 })[-1]
    if ($null -eq $final -or $final.medianMs -isnot [ValueType]) { throw "invalid measurement output" }
    $bytes = (Get-ChildItem -LiteralPath $Spec.PackageRoot -Recurse -File | Measure-Object Length -Sum).Sum
    $installSizeMb = [Math]::Round([double]$bytes / 1MB, 2)
    $output = [ordered]@{ coldStartMs = [double]$final.medianMs; installSizeMb = $installSizeMb } | ConvertTo-Json -Compress
    return [pscustomobject]@{ ExitCode = 0; Kind = "success"; Blockers = @(); Output = $output }
  } catch {
    return [pscustomobject]@{ ExitCode = 0; Kind = "success"; Blockers = @(); Output = "invalid" }
  }
}

try {
  $resolvedRoot = [IO.Path]::GetFullPath($ArtifactRoot)
  foreach ($name in @("electron", "tauri")) {
    $artifactPath = Join-Path $resolvedRoot ("framework-" + $name + ".json")
    try {
      $artifact = Get-Content -LiteralPath $artifactPath -Raw | ConvertFrom-Json
      if ($null -eq $artifact -or $artifact.name -ne $name) { throw "invalid framework artifact" }
      $rows += New-FrameworkRow $artifact
    } catch {
      $rows += New-FrameworkErrorRow $name "framework_artifact_malformed"
    }
  }
  $realSummaryPath = Join-Path $resolvedRoot "real-probes-summary.json"
  if (Test-Path -LiteralPath $realSummaryPath) {
    try { $agents = @((Get-Content -LiteralPath $realSummaryPath -Raw | ConvertFrom-Json).agents) }
    catch { $summaryBlockers += "real_probe_summary_malformed" }
  }

  foreach ($row in $rows) {
    if (-not $row.eligible -or -not $row.measurementEligible) { continue }
    $spec = Get-FixedCandidateSpec $row.name
    if (Add-FixedCandidateMissingBlocker $row $spec) { continue }
    $callback = { param([string]$Framework, [int]$Run) Invoke-FixedCandidateRun $spec $Framework $Run }
    $null = Invoke-FrameworkMeasurement -Row $row -RunMeasurement $callback
  }
  $ranked = @($rows | Where-Object { $_.weightedScore -is [ValueType] } | Sort-Object weightedScore -Descending)
  for ($index = 0; $index -lt $ranked.Count; $index += 1) { $ranked[$index].rank = $index + 1 }
} catch {
  $summaryBlockers += "framework_benchmark_exception:" + $_.Exception.GetType().Name
} finally {
  if ($null -ne $measurementLogRoot -and (Test-Path -LiteralPath $measurementLogRoot)) {
    $resolvedMeasurementLogRoot = [IO.Path]::GetFullPath($measurementLogRoot)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if ($resolvedMeasurementLogRoot.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and $resolvedMeasurementLogRoot -ne $tempRoot) {
      Remove-Item -LiteralPath $resolvedMeasurementLogRoot -Recurse -Force
    } else {
      $summaryBlockers += "framework_temp_cleanup_unverified"
    }
  }
  $summary = [ordered]@{
    generatedBy = "run-framework-benchmark.ps1"; blockers = @($summaryBlockers | Select-Object -Unique)
    frameworks = $rows; agents = $agents
  }
  $summaryDirectory = Split-Path -Parent ([IO.Path]::GetFullPath($SummaryPath))
  if (-not (Test-Path -LiteralPath $summaryDirectory)) { New-Item -ItemType Directory -Path $summaryDirectory | Out-Null }
  [IO.File]::WriteAllText([IO.Path]::GetFullPath($SummaryPath), (($summary | ConvertTo-Json -Depth 8) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
}

if ($summaryBlockers.Count -gt 0 -or @($rows | Where-Object { -not $_.eligible -or -not $_.measurementEligible }).Count -gt 0) { exit 1 }
