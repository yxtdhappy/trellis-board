param(
  [Parameter(Mandatory = $true)]
  [int]$RootProcessId,
  [int]$Seconds = 30
)

$all = Get-CimInstance Win32_Process
$ids = [System.Collections.Generic.List[int]]::new()

function Add-ProcessTree([int]$processId) {
  if ($ids.Contains($processId)) {
    return
  }
  $ids.Add($processId)
  foreach ($child in $all | Where-Object ParentProcessId -eq $processId) {
    Add-ProcessTree ([int]$child.ProcessId)
  }
}

Add-ProcessTree $RootProcessId
$started = Get-Date
$samples = [System.Collections.Generic.List[double]]::new()
$workingSets = [System.Collections.Generic.List[long]]::new()
$previousTicks = @{}
$cpuTicksByProcess = @{}
$processNames = @{}

foreach ($process in $all) {
  $processNames[[int]$process.ProcessId] = $process.Name
}

foreach ($processId in $ids) {
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($process) {
    $process.Refresh()
    $previousTicks[[int]$processId] = $process.TotalProcessorTime.Ticks
    $cpuTicksByProcess[[int]$processId] = 0L
  }
}

for ($tick = 0; $tick -lt $Seconds; $tick++) {
  Start-Sleep -Seconds 1
  $cpuTicks = 0L
  $workingSet = 0L
  foreach ($processId in $ids) {
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if (-not $process) {
      continue
    }
    $process.Refresh()
    $ticks = $process.TotalProcessorTime.Ticks
    if ($previousTicks.ContainsKey([int]$processId)) {
      $delta = [Math]::Max(0, $ticks - $previousTicks[[int]$processId])
      $cpuTicks += $delta
      $cpuTicksByProcess[[int]$processId] += $delta
    }
    $previousTicks[[int]$processId] = $ticks
    $workingSet += $process.WorkingSet64
  }
  $samples.Add(($cpuTicks / [TimeSpan]::TicksPerSecond) * 100)
  $workingSets.Add($workingSet)
}

$sorted = @($samples | Sort-Object)
$p95Index = [Math]::Min($sorted.Count - 1, [Math]::Ceiling($sorted.Count * 0.95) - 1)
$result = [pscustomobject]@{
  rootProcessId = $RootProcessId
  processIds = @($ids)
  startedAt = $started.ToString('o')
  seconds = $Seconds
  cpuSeconds = ($samples | Measure-Object -Sum).Sum / 100
  averageSingleCorePercent = ($samples | Measure-Object -Average).Average
  p95SingleCorePercent = $sorted[$p95Index]
  peakSingleCorePercent = ($samples | Measure-Object -Maximum).Maximum
  workingSetBytes = $workingSets[$workingSets.Count - 1]
  processes = @(
    foreach ($processId in $ids) {
      [pscustomobject]@{
        processId = $processId
        name = $processNames[[int]$processId]
        cpuSeconds = $cpuTicksByProcess[[int]$processId] / [TimeSpan]::TicksPerSecond
      }
    }
  )
  samples = @($samples)
}
$result | ConvertTo-Json -Depth 4
