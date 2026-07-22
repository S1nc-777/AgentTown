param(
  [ValidateSet("taskkill-nonzero", "process-survives", "identity-mismatch", "identity-query-error")]
  [string]$Scenario,
  [string]$SummaryPath
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "..\lib\bounded-process.ps1")
$expected = [pscustomobject]@{ ProcessId = 4242; StartTimeUtcTicks = 100 }
$script:identityReads = 0
$script:taskkillCalled = $false
$identityReader = {
  param([int]$ProcessId)
  $script:identityReads += 1
  if ($Scenario -eq "identity-query-error") {
    return [pscustomobject]@{ Status = "query_error"; Identity = $null }
  }
  if ($Scenario -eq "identity-mismatch") {
    return [pscustomobject]@{ Status = "present"; Identity = [pscustomobject]@{ ProcessId = $ProcessId; StartTimeUtcTicks = 101 } }
  }
  return [pscustomobject]@{ Status = "present"; Identity = $expected }
}
$taskkill = {
  param([int]$ProcessId)
  $script:taskkillCalled = $true
  if ($Scenario -eq "taskkill-nonzero") { return 5 }
  return 0
}
$secondWait = { param($Target, [int]$Milliseconds) return $true }
$blocker = Stop-VerifiedProcessTree -Process ([pscustomobject]@{}) -ExpectedIdentity $expected `
  -IdentityReader $identityReader -TaskkillRunner $taskkill -SecondWait $secondWait
$summary = [ordered]@{ blocker = $blocker; taskkillCalled = $script:taskkillCalled }
$directory = Split-Path -Parent ([IO.Path]::GetFullPath($SummaryPath))
if (-not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory | Out-Null }
[IO.File]::WriteAllText([IO.Path]::GetFullPath($SummaryPath), (($summary | ConvertTo-Json) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
if ($null -ne $blocker) { exit 1 }
