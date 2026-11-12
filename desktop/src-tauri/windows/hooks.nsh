!macro TrellisStopRunningProcesses
  Push $0
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM "trellis-board-client.exe"'
  Pop $0
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM "trellis-agent.exe"'
  Pop $0
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro TrellisStopRunningProcesses
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro TrellisStopRunningProcesses
!macroend
