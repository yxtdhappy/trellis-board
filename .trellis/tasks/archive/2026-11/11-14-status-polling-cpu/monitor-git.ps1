param(
  [Parameter(Mandatory = $true)]
  [int]$RootProcessId,
  [int]$Seconds = 30,
  [int]$PollMilliseconds = 50
)

$all = Get-CimInstance Win32_Process
$tree = [System.Collections.Generic.HashSet[int]]::new()

function Add-Tree([int]$processId) {
  if (-not $tree.Add($processId)) {
    return
  }
  foreach ($child in $all | Where-Object ParentProcessId -eq $processId) {
    Add-Tree ([int]$child.ProcessId)
  }
}

Add-Tree $RootProcessId
$seen = @{}
$started = Get-Date
$deadline = $started.AddSeconds($Seconds)

while ((Get-Date) -lt $deadline) {
  Get-CimInstance Win32_Process -Filter "Name='git.exe'" |
    Where-Object ParentProcessId -in $tree |
    ForEach-Object {
      $seen[[int]$_.ProcessId] = [pscustomobject]@{
        processId = [int]$_.ProcessId
        parentProcessId = [int]$_.ParentProcessId
        creationDate = $_.CreationDate
        commandLine = $_.CommandLine
      }
    }
  Start-Sleep -Milliseconds $PollMilliseconds
}

[pscustomobject]@{
  rootProcessId = $RootProcessId
  startedAt = $started.ToString('o')
  seconds = $Seconds
  count = $seen.Count
  processes = @($seen.Values)
} | ConvertTo-Json -Depth 4
