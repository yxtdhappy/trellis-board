$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9223'
$exe = 'C:\Users\yuhaojie\AppData\Local\Temp\trellis-v0415-e2e-20261114-153300\portable\TrellisBoard_0.4.15_x64-portable\trellis-board-client.exe'
$process = Start-Process -FilePath $exe -PassThru
Start-Sleep -Seconds 4
Write-Output "PID=$($process.Id)"
try {
  Invoke-RestMethod 'http://127.0.0.1:9223/json' |
    Select-Object id, title, url, type, webSocketDebuggerUrl |
    Format-List
} catch {
  Write-Output "DEBUG_ENDPOINT_ERROR=$($_.Exception.Message)"
}
