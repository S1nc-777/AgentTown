$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$metricsPath = Join-Path $repositoryRoot "artifacts\feasibility\framework-tauri.json"
$environmentPath = Join-Path $repositoryRoot "artifacts\feasibility\environment.json"
$planPath = Join-Path $repositoryRoot "docs\superpowers\plans\2026-07-20-agenttown-windows-agent-feasibility.md"

$metrics = Get-Content -LiteralPath $metricsPath -Raw | ConvertFrom-Json
$environment = Get-Content -LiteralPath $environmentPath -Raw | ConvertFrom-Json
$plan = Get-Content -LiteralPath $planPath -Raw

$requiredMetricFields = @(
  "name",
  "ptyStable",
  "coreSurvivesUiExit",
  "packageBuilds",
  "embeddedTerminalWorks",
  "installSizeMb",
  "coldStartMs",
  "implementationMinutes"
)

foreach ($field in $requiredMetricFields) {
  if ($null -eq $metrics.PSObject.Properties[$field]) {
    throw "framework-tauri.json is missing required FrameworkMetrics field: $field"
  }
}

if ($metrics.evidence.blockers -notcontains "rust_toolchain_download_stalled") {
  throw "Tauri evidence must preserve the rust_toolchain_download_stalled blocker"
}
if ($metrics.evidence.installSizeMeasured -ne $false -or $metrics.evidence.coldStartMeasured -ne $false) {
  throw "Unmeasured package size and cold start must be explicitly marked false"
}
if ($metrics.evidence.measurementEligible -ne $false) {
  throw "The blocked Tauri candidate must not be measurement-eligible"
}
if ($metrics.evidence.implementationMeasurement -ne "prerequisite_audit_only") {
  throw "Implementation time must be identified as prerequisite audit only"
}
if ($metrics.evidence.runtimeImplemented -ne $false -or $metrics.evidence.packageImplemented -ne $false -or $metrics.evidence.coreImplemented -ne $false) {
  throw "Runtime, package, and core implementation flags must remain false"
}
if ($metrics.evidence.numericZeroSemantics -ne "schema_placeholders_not_comparable") {
  throw "Numeric zero placeholders must be declared non-comparable"
}

$installerEvidence = $environment.rustupInstallerEvidence
if ($installerEvidence.installerUrl -ne "https://win.rustup.rs/x86_64") {
  throw "Official installer URL evidence is missing"
}
if ($installerEvidence.checksumUrl -ne "https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe.sha256") {
  throw "Official checksum URL evidence is missing"
}
if ($installerEvidence.installerBytes -ne 12814336 -or $installerEvidence.authenticodeStatus -ne "NotSigned") {
  throw "Installer size or Authenticode evidence differs from the observed local file"
}
if ($installerEvidence.expectedSha256 -ne "86478e53f769379d7f0ebfa7c9aa97cb76ca92233f79aa2cc0dbee2efaac73c7" -or
    $installerEvidence.observedSha256 -ne "86478e53f769379d7f0ebfa7c9aa97cb76ca92233f79aa2cc0dbee2efaac73c7" -or
    $installerEvidence.checksumMatched -ne $true) {
  throw "Installer checksum evidence is incomplete or inconsistent"
}

$requiredPlanRules = @(
  "measurementEligible",
  "installSizeMeasured",
  "coldStartMeasured",
  "N/A",
  "must not be ranked",
  "must not display the scoreFramework numeric result as a candidate score"
)
foreach ($rule in $requiredPlanRules) {
  if (-not $plan.Contains($rule)) {
    throw "Feasibility plan is missing evidence-suppression rule: $rule"
  }
}

Write-Output "FEASIBILITY_EVIDENCE_VALID"
