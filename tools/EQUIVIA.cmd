@echo off
setlocal DisableDelayedExpansion
set "EQUIVIA_STATUS=1"
if not exist "%~dp0runtime\node.exe" goto missing_runtime
set "NODE_OPTIONS="
set "NODE_PATH="
set "NODE_EXTRA_CA_CERTS="
set "NEBIUS_API_KEY="
set "NEBIUS_MODEL="
set "NEBIUS_BASE_URL="
"%~dp0runtime\node.exe" "%~dp0launcher.mjs" %*
set "EQUIVIA_STATUS=%ERRORLEVEL%"
goto finished
:missing_runtime
echo The bundled runtime is missing. Extract the complete EQUIVIA folder before starting.
:finished
if "%EQUIVIA_STATUS%"=="0" exit /b 0
if "%EQUIVIA_STATUS%"=="130" exit /b 130
if "%~1"=="" pause
exit /b %EQUIVIA_STATUS%
