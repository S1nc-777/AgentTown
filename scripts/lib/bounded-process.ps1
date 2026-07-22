function Get-ProcessIdentity {
  param([int]$ProcessId)
  try {
    $fresh = Get-Process -Id $ProcessId -ErrorAction Stop
    [pscustomobject]@{
      Status = "present"
      Identity = [pscustomobject]@{
        ProcessId = $fresh.Id
        StartTimeUtcTicks = $fresh.StartTime.ToUniversalTime().Ticks
      }
    }
  } catch {
    if ($_.FullyQualifiedErrorId -like "NoProcessFoundForGivenId*") {
      return [pscustomobject]@{ Status = "absent"; Identity = $null }
    }
    return [pscustomobject]@{ Status = "query_error"; Identity = $null }
  }
}

function Test-SameProcessIdentity {
  param($Expected, $Actual)
  return $null -ne $Expected -and $null -ne $Actual `
    -and $Expected.ProcessId -eq $Actual.ProcessId `
    -and $Expected.StartTimeUtcTicks -eq $Actual.StartTimeUtcTicks
}

function Stop-VerifiedProcessTree {
  param(
    [Parameter(Mandatory = $true)]$Process,
    [Parameter(Mandatory = $true)]$ExpectedIdentity,
    [int]$WaitMs = 5000,
    [scriptblock]$IdentityReader = ${function:Get-ProcessIdentity},
    [scriptblock]$TaskkillRunner = {
      param([int]$ProcessId)
      & taskkill.exe /PID $ProcessId /T /F *> $null
      return $LASTEXITCODE
    },
    [scriptblock]$SecondWait = { param($Target, [int]$Milliseconds) $Target.WaitForExit($Milliseconds) }
  )
  $beforeKill = & $IdentityReader $ExpectedIdentity.ProcessId
  if ($null -eq $beforeKill -or $beforeKill.Status -eq "query_error") { return "termination_unverified" }
  if ($beforeKill.Status -eq "absent") { return $null }
  if ($beforeKill.Status -ne "present" -or -not (Test-SameProcessIdentity $ExpectedIdentity $beforeKill.Identity)) { return "termination_unverified" }

  $taskkillExit = & $TaskkillRunner $ExpectedIdentity.ProcessId
  if ($taskkillExit -ne 0) { return "termination_unverified" }
  if (-not (& $SecondWait $Process $WaitMs)) { return "termination_unverified" }

  $afterKill = & $IdentityReader $ExpectedIdentity.ProcessId
  if ($null -eq $afterKill -or $afterKill.Status -eq "query_error") { return "termination_unverified" }
  if ($afterKill.Status -eq "absent") { return $null }
  if ($afterKill.Status -eq "present" -and (Test-SameProcessIdentity $ExpectedIdentity $afterKill.Identity)) { return "orphan_process" }
  return "termination_unverified"
}

function Start-BoundedProcess {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][DateTime]$Deadline,
    [Parameter(Mandatory = $true)][string]$LogRoot
  )
  $remaining = [int][Math]::Floor(($Deadline - [DateTime]::UtcNow).TotalMilliseconds)
  if ($remaining -lt 1) {
    return [pscustomobject]@{ ExitCode = 124; Kind = "timeout"; Blockers = @("execution_timeout"); StdoutPath = $null }
  }
  $stdoutPath = Join-Path $LogRoot ($Label + "-stdout.log")
  $stderrPath = Join-Path $LogRoot ($Label + "-stderr.log")
  $process = $null
  $identity = $null
  try {
    $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -PassThru -WindowStyle Hidden `
      -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    $null = $process.Handle
    $identity = [pscustomobject]@{
      ProcessId = $process.Id
      StartTimeUtcTicks = $process.StartTime.ToUniversalTime().Ticks
    }
    if (-not $process.WaitForExit($remaining)) {
      $terminationBlocker = Stop-VerifiedProcessTree -Process $process -ExpectedIdentity $identity
      $blockers = @("execution_timeout")
      if ($null -ne $terminationBlocker) { $blockers += $terminationBlocker }
      return [pscustomobject]@{ ExitCode = 124; Kind = "timeout"; Blockers = @($blockers | Select-Object -Unique); StdoutPath = $stdoutPath }
    }
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
      return [pscustomobject]@{ ExitCode = $process.ExitCode; Kind = "nonzero"; Blockers = @("execution_exit_" + $process.ExitCode); StdoutPath = $stdoutPath }
    }
    return [pscustomobject]@{ ExitCode = 0; Kind = "success"; Blockers = @(); StdoutPath = $stdoutPath }
  } catch {
    $blockers = @("execution_exception:" + $_.Exception.GetType().Name)
    if ($null -ne $process -and $null -ne $identity) {
      $terminationBlocker = Stop-VerifiedProcessTree -Process $process -ExpectedIdentity $identity
      if ($null -ne $terminationBlocker) { $blockers += $terminationBlocker }
    } elseif ($null -ne $process) {
      $blockers += "termination_unverified"
    }
    return [pscustomobject]@{ ExitCode = 1; Kind = "exception"; Blockers = @($blockers | Select-Object -Unique); StdoutPath = $stdoutPath }
  }
}
