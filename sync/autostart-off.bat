@echo off
rem Double-click this to STOP the Whoop sync from starting by itself with Windows.
rem (Undoes autostart-on.bat. A sync window that is already open keeps running
rem until you close it.)
set "ENTRY=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Daily Planner Whoop sync.bat"
if exist "%ENTRY%" (
  del "%ENTRY%"
  echo Done. The Whoop sync no longer starts by itself.
  echo You can still start it by hand: double-click start-whoop-sync.bat.
) else (
  echo It wasn't set to start by itself, so there was nothing to remove.
)
echo.
pause
