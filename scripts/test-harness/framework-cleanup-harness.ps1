param([string]$SummaryPath)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "..\lib\framework-measurement.ps1")
$parent = Split-Path -Parent ([IO.Path]::GetFullPath($SummaryPath))
$logRoot = Join-Path $parent "locked-logs"
New-Item -ItemType Directory -Path $logRoot | Out-Null
$lockedPath = Join-Path $logRoot "active.log"
$stream = [IO.File]::Open($lockedPath, [IO.FileMode]::Create, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
  $blocker = Remove-FrameworkMeasurementLogs $logRoot
  $summary = [ordered]@{ blockers = @($blocker) }
  [IO.File]::WriteAllText([IO.Path]::GetFullPath($SummaryPath), (($summary | ConvertTo-Json) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
} finally {
  $stream.Dispose()
  if (Test-Path -LiteralPath $logRoot) { Remove-Item -LiteralPath $logRoot -Recurse -Force }
}
if ($null -ne $blocker) { exit 1 }
