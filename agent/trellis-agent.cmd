@echo off
setlocal
if exist "%~dp0node.exe" (
  "%~dp0node.exe" "%~dp0cli.js" %*
) else (
  node "%~dp0cli.js" %*
)
exit /b %ERRORLEVEL%
