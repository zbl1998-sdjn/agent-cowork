@echo off
chcp 65001 >nul
title Shared-Memory PoC (Agent Cowork x MASE)
echo Running Shared-Memory PoC... (Agent Cowork must be running)
echo.
pushd "%~dp0.."
"C:\Program Files\nodejs\node.exe" ".\scripts\run-host-node.mjs" ".\demos\shared-memory-poc.ts"
popd
echo.
pause
