$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

try {
  Add-Type -AssemblyName System.Security

  $requestText = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($requestText)) {
    throw "empty input"
  }

  $request = $requestText | ConvertFrom-Json
  if ($request.action -ne "protect" -and $request.action -ne "unprotect") {
    throw "invalid action"
  }
  if ($request.data -isnot [string] -or [string]::IsNullOrWhiteSpace($request.data)) {
    throw "invalid data"
  }

  $inputBytes = [Convert]::FromBase64String([string]$request.data)
  if ($request.action -eq "protect") {
    $outputBytes = [System.Security.Cryptography.ProtectedData]::Protect(
      $inputBytes,
      $null,
      [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
  } else {
    $outputBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
      $inputBytes,
      $null,
      [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
  }

  [Console]::Out.Write((@{ data = [Convert]::ToBase64String($outputBytes) } | ConvertTo-Json -Compress))
} catch {
  $detail = [string]$_.Exception.Message
  if ($detail -match 'ConstrainedLanguage|System\.Security|ProtectedData|MethodInvocation') {
    [Console]::Error.Write("DPAPI_UNAVAILABLE")
  } else {
    [Console]::Error.Write("DPAPI_HELPER_ERROR")
  }
  exit 1
}
