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
. (Join-Path $PSScriptRoot "lib\bounded-process.ps1")

$modeCount = [int]$ValidateOnly.IsPresent + [int]$SummarizeOnly.IsPresent + [int]$CapabilitiesOnly.IsPresent
if ($modeCount -gt 1) { throw "ValidateOnly, SummarizeOnly, and CapabilitiesOnly are mutually exclusive" }
if ($TimeoutMs -lt 1) { throw "TimeoutMs must be positive" }

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$resolvedParent = [System.IO.Path]::GetFullPath($TempParent)
$tempPrefix = $tempRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if ($resolvedParent -ne $tempRoot -and -not $resolvedParent.StartsWith($tempPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "TempParent must remain below [System.IO.Path]::GetTempPath()"
}

$deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
$probeDirectory = [System.IO.Path]::GetFullPath((Join-Path $resolvedParent ("agenttown-real-probes-" + [guid]::NewGuid().ToString("N"))))
$created = $false
$gitInitialized = $false
$testExitCode = 0
$observedExitKind = "not_run"
$executionBlockers = @()
$commandAvailability = [ordered]@{ codex = $false; claude = $false }

function Add-ExecutionBlocker([string]$Blocker) {
  if ($script:executionBlockers -notcontains $Blocker) { $script:executionBlockers += $Blocker }
}

function Invoke-FixedChild([string]$FilePath, [string[]]$Arguments, [string]$Label) {
  Start-BoundedProcess -FilePath $FilePath -Arguments $Arguments -Label $Label -Deadline $script:deadline -LogRoot $script:probeDirectory
}

function Record-ChildBlockers($Child) {
  foreach ($blocker in @($Child.Blockers)) { Add-ExecutionBlocker $blocker }
}

try {
  New-Item -ItemType Directory -Path $probeDirectory | Out-Null
  $created = $true
  $gitResult = Invoke-FixedChild "git.exe" @("init", "--quiet", $probeDirectory) "git-init"
  if ($gitResult.ExitCode -eq 0) {
    $gitInitialized = $true
  } else {
    $testExitCode = $gitResult.ExitCode
    $observedExitKind = $gitResult.Kind
    Record-ChildBlockers $gitResult
    Add-ExecutionBlocker "temporary_repo_init_failed"
  }

  if ($gitInitialized -and -not $ValidateOnly -and -not $SummarizeOnly) {
    if ($env:AGENTTOWN_FORBID_REAL_PROBES -eq "1") {
      $testExitCode = 1
      $observedExitKind = "forbidden"
      Add-ExecutionBlocker "real_probe_execution_disabled"
      Write-Output "real_probe_execution_disabled"
    } else {
      $commandAvailability.codex = $null -ne (Get-Command codex -ErrorAction SilentlyContinue)
      $commandAvailability.claude = $null -ne (Get-Command claude -ErrorAction SilentlyContinue)
      if ($CapabilitiesOnly) {
        $child = Invoke-FixedChild "pnpm.cmd" @(
          "--dir", $repositoryRoot, "--filter", "@agenttown/probe-runner", "exec", "tsx", "src/run-real-capabilities.ts",
          "--artifact-root", [System.IO.Path]::GetFullPath($ArtifactRoot), "--timeout-ms", [string]$TimeoutMs
        ) "capabilities"
        $testExitCode = $child.ExitCode
        $observedExitKind = $child.Kind
        Record-ChildBlockers $child
      } else {
        $previousCodexGate = $env:AGENTTOWN_REAL_CODEX
        $previousClaudeGate = $env:AGENTTOWN_REAL_CLAUDE
        $previousTimeout = $env:AGENTTOWN_REAL_TIMEOUT_MS
        try {
          $env:AGENTTOWN_REAL_CODEX = "1"
          $env:AGENTTOWN_REAL_CLAUDE = "1"
          $env:AGENTTOWN_REAL_TIMEOUT_MS = [string]$TimeoutMs
          $child = Invoke-FixedChild "pnpm.cmd" @(
            "--dir", $repositoryRoot, "--filter", "@agenttown/probe-runner", "exec", "vitest", "run",
            "test/codex-real.test.ts", "test/claude-real.test.ts"
          ) "real-tests"
        } finally {
          $env:AGENTTOWN_REAL_CODEX = $previousCodexGate
          $env:AGENTTOWN_REAL_CLAUDE = $previousClaudeGate
          $env:AGENTTOWN_REAL_TIMEOUT_MS = $previousTimeout
        }
        $testExitCode = $child.ExitCode
        $observedExitKind = $child.Kind
        Record-ChildBlockers $child
        if ($testExitCode -eq 0) {
          $child = Invoke-FixedChild "pnpm.cmd" @(
            "--dir", $repositoryRoot, "--filter", "@agenttown/probe-runner", "exec", "tsx", "src/run-real-capabilities.ts",
            "--artifact-root", [System.IO.Path]::GetFullPath($ArtifactRoot), "--timeout-ms", [string]$TimeoutMs
          ) "remaining-capabilities"
          $testExitCode = $child.ExitCode
          $observedExitKind = $child.Kind
          Record-ChildBlockers $child
        }
      }
    }
  }
} catch {
  $testExitCode = 1
  $observedExitKind = "exception"
  Add-ExecutionBlocker ("execution_exception:" + $_.Exception.GetType().Name)
} finally {
  if ($created -and (Test-Path -LiteralPath $probeDirectory)) {
    try {
      $resolvedProbe = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $probeDirectory).Path)
      if (-not $resolvedProbe.StartsWith($tempPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or $resolvedProbe -eq $tempRoot) {
        throw "Refusing unsafe temporary cleanup target"
      }
      Remove-Item -LiteralPath $resolvedProbe -Recurse -Force
    } catch {
      $testExitCode = 1
      Add-ExecutionBlocker "temporary_cleanup_failed"
    }
  }
}

$tempCleanupVerified = -not (Test-Path -LiteralPath $probeDirectory)
$reports = @()
function New-FailedAgentEntry([string]$Agent, [string]$Blocker) {
  [ordered]@{
    agent = $Agent; version = "unknown"; notes = @("blocker:" + $Blocker)
    launch = $false; streamOutput = $false; sessionId = $false; resume = $false
    interrupt = $false; tokenUsage = $false; nonInteractive = $false
    interactivePty = $false; parallelThree = $false
  }
}
if (-not $ValidateOnly) {
  foreach ($agent in @("codex", "claude")) {
    $reportPath = Join-Path ([System.IO.Path]::GetFullPath($ArtifactRoot)) "$agent-real\report.json"
    if (Test-Path -LiteralPath $reportPath) {
      try {
        $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
        if ($null -eq $report -or $report.agent -ne $agent) { throw "invalid report shape" }
        $entry = [ordered]@{
          agent = $report.agent; version = $report.version; notes = @($report.notes)
          launch = [bool]$report.launch; streamOutput = [bool]$report.streamOutput
          sessionId = [bool]$report.sessionId; resume = [bool]$report.resume
          interrupt = [bool]$report.interrupt; tokenUsage = [bool]$report.tokenUsage
          nonInteractive = [bool]$report.nonInteractive; interactivePty = [bool]$report.interactivePty
          parallelThree = [bool]$report.parallelThree
        }
      } catch {
        $entry = New-FailedAgentEntry $agent "report_malformed"
      }
    } else {
      $entry = New-FailedAgentEntry $agent "report_missing"
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
      resume = $entry.resume; interrupt = $entry.interrupt; parallelThree = $entry.parallelThree
    }
    $entry.blockers = @($blockers | Select-Object -Unique)
    $reports += $entry
  }
}

$execution = if ($ValidateOnly) { "validate_only" } elseif ($SummarizeOnly) { "summarize_only" } elseif ($CapabilitiesOnly) { "capabilities_only" } else { "real_once" }
$summary = [ordered]@{
  commandAvailability = $commandAvailability
  execution = $execution
  observedExitKind = $observedExitKind
  executionBlockers = @($executionBlockers)
  probeTestExitCode = $testExitCode
  validation = [ordered]@{ tempCleanupVerified = $tempCleanupVerified; childGatesScoped = $true; gitInitialized = $gitInitialized }
  agents = $reports
}

$summaryDirectory = Split-Path -Parent ([System.IO.Path]::GetFullPath($SummaryPath))
if (-not (Test-Path -LiteralPath $summaryDirectory)) { New-Item -ItemType Directory -Path $summaryDirectory | Out-Null }
[System.IO.File]::WriteAllText(
  [System.IO.Path]::GetFullPath($SummaryPath),
  (($summary | ConvertTo-Json -Depth 8) + [Environment]::NewLine),
  [System.Text.UTF8Encoding]::new($false)
)

$reportFailure = -not $ValidateOnly -and @($reports | Where-Object { $_.blockers.Count -gt 0 }).Count -gt 0
if ($testExitCode -ne 0 -or $executionBlockers.Count -gt 0 -or $reportFailure) { exit 1 }
