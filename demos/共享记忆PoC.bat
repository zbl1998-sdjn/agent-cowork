@echo off
chcp 65001 >nul
title Shared-Memory PoC (Agent Cowork x MASE)
echo Running Shared-Memory PoC... (Agent Cowork must be running)
echo.
"C:\Program Files\nodejs\node.exe" "%~dp0shared-memory-poc.mjs"
echo.
pause
