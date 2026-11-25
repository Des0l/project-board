@echo off
setlocal
set "boardNode=%~dp0runtime\node.exe"
if exist "%boardNode%" goto launch
where node.exe >nul 2>nul
if not errorlevel 1 goto systemNode
echo Node.js was not found. Extract the complete Windows portable bundle.
pause
exit /b 1
:systemNode
set "boardNode=node.exe"
:launch
"%boardNode%" "%~dp0open-board.mjs" %*
if not errorlevel 1 exit /b 0
pause
exit /b 1

