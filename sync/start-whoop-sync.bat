@echo off
rem Double-click this file to start the Whoop sync for the planner app.
rem Leave the window open (minimised is fine). Close it to stop the sync.
title Whoop sync for Daily Planner
cd /d "%~dp0.."
python sync\whoop_sync.py serve
echo.
pause
