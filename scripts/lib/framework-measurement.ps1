function Invoke-FrameworkMeasurement {
  param(
    [Parameter(Mandatory = $true)]$Row,
    [Parameter(Mandatory = $true)][scriptblock]$RunMeasurement
  )
  $coldStarts = @()
  $installSizes = @()
  for ($run = 1; $run -le 3; $run += 1) {
    try {
      $result = & $RunMeasurement $Row.name $run
    } catch {
      $Row.measurementEligible = $false
      $Row.blockers = @($Row.blockers + ("measurement_run_" + $run + "_start_error") | Select-Object -Unique)
      break
    }
    if ($result.Kind -eq "start_error") {
      $Row.measurementEligible = $false
      $Row.blockers = @($Row.blockers + ("measurement_run_" + $run + "_start_error") | Select-Object -Unique)
      break
    }
    if ($result.ExitCode -ne 0) {
      $Row.measurementEligible = $false
      $primary = if ($result.Kind -eq "timeout") {
        "measurement_run_" + $run + "_execution_timeout"
      } else {
        "measurement_run_" + $run + "_exit_" + $result.ExitCode
      }
      $Row.blockers = @($Row.blockers + $primary + @($result.Blockers | Where-Object { $_ -in @("termination_unverified", "orphan_process") }) | Select-Object -Unique)
      break
    }
    try {
      $measurement = $result.Output | ConvertFrom-Json
      if ($null -eq $measurement -or $measurement.coldStartMs -isnot [ValueType] -or $measurement.installSizeMb -isnot [ValueType]) {
        throw "invalid measurement shape"
      }
      $coldStart = [double]$measurement.coldStartMs
      $installSize = [double]$measurement.installSizeMb
      if ($coldStart -lt 0 -or $installSize -lt 0) { throw "invalid measurement value" }
      $coldStarts += $coldStart
      $installSizes += $installSize
      $Row.benchmarkRuns += 1
    } catch {
      $Row.measurementEligible = $false
      $Row.blockers = @($Row.blockers + ("measurement_run_" + $run + "_invalid_output") | Select-Object -Unique)
      break
    }
  }
  if (-not $Row.measurementEligible -or $Row.benchmarkRuns -ne 3) { return $Row }
  $uniqueSizes = @($installSizes | Select-Object -Unique)
  if ($uniqueSizes.Count -ne 1) {
    $Row.measurementEligible = $false
    $Row.blockers = @($Row.blockers + "measurement_install_size_unstable" | Select-Object -Unique)
    return $Row
  }
  $sortedColdStarts = @($coldStarts | Sort-Object)
  $Row.coldStartSamples = @($coldStarts)
  $Row.coldStart = $sortedColdStarts[1]
  $Row.installSize = $uniqueSizes[0]
  $score = [Math]::Max([double]0, [double](30 - $Row.installSize / 10)) + `
    [Math]::Max([double]0, [double](30 - $Row.coldStart / 100)) + `
    [Math]::Max([double]0, [double](40 - $Row.implementationMinutes / 5))
  $Row.weightedScore = [Math]::Round($score, 1)
  $Row.rank = 1
  return $Row
}
