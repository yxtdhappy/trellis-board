param(
  [Parameter(Mandatory = $true)]
  [int]$ProcessId,
  [int]$Seconds = 15
)

$process = Get-Process -Id $ProcessId -ErrorAction Stop
$previous = @{}

foreach ($thread in $process.Threads) {
  try {
    $previous[[int]$thread.Id] = $thread.TotalProcessorTime.Ticks
  } catch {
  }
}

Start-Sleep -Seconds $Seconds
$process.Refresh()

$result = foreach ($thread in $process.Threads) {
  try {
    $current = $thread.TotalProcessorTime.Ticks
    $before = $previous[[int]$thread.Id]
    if ($null -ne $before) {
      [pscustomobject]@{
        threadId = [int]$thread.Id
        cpuSeconds = ($current - $before) / [TimeSpan]::TicksPerSecond
        state = $thread.ThreadState.ToString()
        waitReason = $thread.WaitReason.ToString()
      }
    }
  } catch {
  }
}

$result |
  Sort-Object cpuSeconds -Descending |
  Select-Object -First 20 |
  ConvertTo-Json -Depth 3
