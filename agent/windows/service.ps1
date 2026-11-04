param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('install', 'uninstall', 'status')]
  [string]$Action,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9._-]{1,128}$')]
  [string]$TaskName,

  [string]$NodePath,
  [string]$EntryPath,
  [string]$WorkingDirectory,
  [string]$AgentRoot
)

$ErrorActionPreference = 'Stop'

function Write-Result {
  param([hashtable]$Value)
  $Value | ConvertTo-Json -Compress
}

function Quote-PowerShellLiteral {
  param([string]$Value)
  return "'" + $Value.Replace("'", "''") + "'"
}

try {
  switch ($Action) {
    'install' {
      if (-not $NodePath -or -not [IO.Path]::IsPathRooted($NodePath)) {
        throw 'NodePath must be an absolute path'
      }
      if (-not $EntryPath -or -not [IO.Path]::IsPathRooted($EntryPath)) {
        throw 'EntryPath must be an absolute path'
      }
      if (-not $WorkingDirectory -or -not [IO.Path]::IsPathRooted($WorkingDirectory)) {
        throw 'WorkingDirectory must be an absolute path'
      }

      $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
      $script = ''
      if ($AgentRoot) {
        $script += '$env:TRELLIS_AGENT_ROOT = ' + (Quote-PowerShellLiteral $AgentRoot) + "`r`n"
      }
      $script += '& ' + (Quote-PowerShellLiteral $NodePath) + ' ' +
        (Quote-PowerShellLiteral $EntryPath) + ' run'
      $encoded = [Convert]::ToBase64String(
        [Text.Encoding]::Unicode.GetBytes($script)
      )
      $powerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
      $action = New-ScheduledTaskAction `
        -Execute $powerShellPath `
        -Argument ('-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand ' + $encoded) `
        -WorkingDirectory $WorkingDirectory
      $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
      $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -RestartCount 999 `
        -RestartInterval (New-TimeSpan -Minutes 1)
      $principal = New-ScheduledTaskPrincipal `
        -UserId $identity `
        -LogonType Interactive `
        -RunLevel Limited
      Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Principal $principal `
        -Description 'Trellis Board current-user Git sync agent' `
        -Force | Out-Null
      Start-ScheduledTask -TaskName $TaskName
      Write-Result @{ action = 'install'; ok = $true; taskName = $TaskName; state = 'started' }
    }
    'uninstall' {
      $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
      if ($existing) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
      }
      Write-Result @{ action = 'uninstall'; ok = $true; taskName = $TaskName; removed = [bool]$existing }
    }
    'status' {
      $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
      if (-not $task) {
        Write-Result @{ action = 'status'; ok = $true; taskName = $TaskName; installed = $false; state = 'not-installed' }
        break
      }
      $info = Get-ScheduledTaskInfo -TaskName $TaskName
      Write-Result @{
        action = 'status'
        ok = $true
        taskName = $TaskName
        installed = $true
        state = [string]$task.State
        lastRunTime = if ($info.LastRunTime) { $info.LastRunTime.ToString('o') } else { $null }
        lastTaskResult = $info.LastTaskResult
      }
    }
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
