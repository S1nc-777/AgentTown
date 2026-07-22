param(
  [switch]$ValidateOnly,
  [switch]$SummarizeOnly,
  [switch]$CapabilitiesOnly,
  [string]$TempParent = [System.IO.Path]::GetTempPath(),
  [string]$ArtifactRoot = (Join-Path $PSScriptRoot "..\artifacts\feasibility"),
  [string]$SummaryPath = (Join-Path $PSScriptRoot "..\artifacts\feasibility\real-probes-summary.json"),
  [int]$TimeoutMs = 180000
)

$ErrorActionPreference = "Stop"
$modeCount = [int]$ValidateOnly.IsPresent + [int]$SummarizeOnly.IsPresent + [int]$CapabilitiesOnly.IsPresent
if ($modeCount -gt 1) {
  throw "ValidateOnly, SummarizeOnly, and CapabilitiesOnly are mutually exclusive"
}
if ($TimeoutMs -lt 1) {
  throw "TimeoutMs must be positive"
}
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$resolvedParent = [System.IO.Path]::GetFullPath($TempParent)
$tempPrefix = $tempRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if ($resolvedParent -ne $tempRoot -and -not $resolvedParent.StartsWith($tempPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "TempParent must remain below [System.IO.Path]::GetTempPath()"
}

$probeDirectory = Join-Path $resolvedParent ("agenttown-real-probes-" + [guid]::NewGuid().ToString("N"))
$probeDirectory = [System.IO.Path]::GetFullPath($probeDirectory)
$created = $false
$testExitCode = 0
$commandAvailability = [ordered]@{ codex = $false; claude = $false }

try {
  New-Item -ItemType Directory -Path $probeDirectory | Out-Null
  $created = $true
  & git init --quiet $probeDirectory
  if ($LASTEXITCODE -ne 0) { throw "temporary_repo_init_failed" }

  if (-not $ValidateOnly -and -not $SummarizeOnly) {
    if ($env:AGENTTOWN_FORBID_REAL_PROBES -eq "1") {
      throw "real_probe_execution_disabled"
    }
    $commandAvailability.codex = $null -ne (Get-Command codex -ErrorAction SilentlyContinue)
    $commandAvailability.claude = $null -ne (Get-Command claude -ErrorAction SilentlyContinue)

    if ($CapabilitiesOnly) {
      & pnpm --dir $repositoryRoot --filter "@agenttown/probe-runner" exec tsx src/run-real-capabilities.ts `
        --artifact-root ([System.IO.Path]::GetFullPath($ArtifactRoot)) --timeout-ms $TimeoutMs
      $testExitCode = $LASTEXITCODE
    } else {
      $previousCodexGate = $env:AGENTTOWN_REAL_CODEX
      $previousClaudeGate = $env:AGENTTOWN_REAL_CLAUDE
      $previousTimeout = $env:AGENTTOWN_REAL_TIMEOUT_MS
      try {
        $env:AGENTTOWN_REAL_CODEX = "1"
        $env:AGENTTOWN_REAL_CLAUDE = "1"
        $env:AGENTTOWN_REAL_TIMEOUT_MS = [string]$TimeoutMs
        & pnpm --dir $repositoryRoot --filter "@agenttown/probe-runner" exec vitest run test/codex-real.test.ts test/claude-real.test.ts
        $testExitCode = $LASTEXITCODE
      } finally {
        $env:AGENTTOWN_REAL_CODEX = $previousCodexGate
        $env:AGENTTOWN_REAL_CLAUDE = $previousClaudeGate
        $env:AGENTTOWN_REAL_TIMEOUT_MS = $previousTimeout
      }
      if ($testExitCode -eq 0) {
        & pnpm --dir $repositoryRoot --filter "@agenttown/probe-runner" exec tsx src/run-real-capabilities.ts `
          --artifact-root ([System.IO.Path]::GetFullPath($ArtifactRoot)) --timeout-ms $TimeoutMs
        $testExitCode = $LASTEXITCODE
      }
    }
  }
} finally {
  if ($created -and (Test-Path -LiteralPath $probeDirectory)) {
    $resolvedProbe = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $probeDirectory).Path)
    if (-not $resolvedProbe.StartsWith($tempPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or $resolvedProbe -eq $tempRoot) {
      throw "Refusing unsafe temporary cleanup target"
    }
    Remove-Item -LiteralPath $resolvedProbe -Recurse -Force
  }
}

$tempCleanupVerified = -not (Test-Path -LiteralPath $probeDirectory)
if ($ValidateOnly) {
  $summary = [ordered]@{
    validation = [ordered]@{
      tempCleanupVerified = $tempCleanupVerified
      childGatesScoped = $true
      gitInitialized = $true
    }
  }
} else {
  $reports = @()
  foreach ($agent in @("codex", "claude")) {
    $reportPath = Join-Path ([System.IO.Path]::GetFullPath($ArtifactRoot)) "$agent-real\report.json"
    if (Test-Path -LiteralPath $reportPath) {
      $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
      $entry = [ordered]@{
        agent = $report.agent
        version = $report.version
        notes = @($report.notes)
        launch = [bool]$report.launch
        streamOutput = [bool]$report.streamOutput
        sessionId = [bool]$report.sessionId
        resume = [bool]$report.resume
        interrupt = [bool]$report.interrupt
        tokenUsage = [bool]$report.tokenUsage
        nonInteractive = [bool]$report.nonInteractive
        interactivePty = [bool]$report.interactivePty
        parallelThree = [bool]$report.parallelThree
      }
    } else {
      $entry = [ordered]@{
        agent = $agent
        version = "unknown"
        notes = @("blocker:report_missing")
        launch = $false
        streamOutput = $false
        sessionId = $false
        resume = $false
        interrupt = $false
        tokenUsage = $false
        nonInteractive = $false
        interactivePty = $false
        parallelThree = $false
      }
    }
    $blockers = @($entry.notes | Where-Object { $_ -is [string] -and $_.StartsWith("blocker:") } | ForEach-Object { $_.Substring(8) })
    if (-not $entry.launch -and $blockers -notcontains "launch_failed" -and $blockers -notcontains "executable_not_found" -and $blockers -notcontains "report_missing") { $blockers += "launch_not_verified" }
    if (-not $entry.streamOutput) { $blockers += "stream_output_not_verified" }
    if (-not $entry.sessionId) { $blockers += "session_id_not_verified" }
    if (-not $entry.resume) { $blockers += "resume_not_verified" }
    if (-not $entry.interrupt) { $blockers += "interrupt_not_verified" }
    if (-not $entry.tokenUsage) { $blockers += "token_usage_not_verified" }
    if (-not $entry.nonInteractive) { $blockers += "non_interactive_not_verified" }
    if (-not $entry.parallelThree) { $blockers += "parallel_three_not_verified" }
    $entry.steps = [ordered]@{
      firstTurn = $entry.launch -and $entry.streamOutput -and $entry.sessionId -and $entry.tokenUsage -and $entry.nonInteractive
      resume = $entry.resume
      interrupt = $entry.interrupt
      parallelThree = $entry.parallelThree
    }
    $entry.blockers = @($blockers | Select-Object -Unique)
    $reports += $entry
  }
  $summary = [ordered]@{
    commandAvailability = $commandAvailability
    execution = if ($SummarizeOnly) { "summarize_only" } elseif ($CapabilitiesOnly) { "capabilities_only" } else { "real_once" }
    probeTestExitCode = $testExitCode
    validation = [ordered]@{ tempCleanupVerified = $tempCleanupVerified; childGatesScoped = $true }
    agents = $reports
  }
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

if (-not $ValidateOnly) {
  $requiredFailure = $testExitCode -ne 0 -or @($reports | Where-Object { $_.blockers.Count -gt 0 }).Count -gt 0
  if ($requiredFailure) { exit 1 }
}
