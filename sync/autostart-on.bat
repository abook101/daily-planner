@echo off
rem Double-click this ONCE to make the Whoop sync start by itself when you log in
rem to Windows. It adds one small file to your Windows "Startup" folder.
rem To undo: double-click autostart-off.bat (in this same folder).
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "ENTRY=%STARTUP%\Daily Planner Whoop sync.bat"
(
  echo @echo off
  echo rem Starts the Whoop sync for the Daily Planner, minimised. Made by autostart-on.bat.
  echo rem To stop this: double-click Dashboard\sync\autostart-off.bat, or delete this file.
  echo start "Whoop sync for Daily Planner" /min "%~dp0start-whoop-sync.bat"
) > "%ENTRY%"
if exist "%ENTRY%" (
  echo Done. The Whoop sync will now start by itself, minimised, each time you log in.
  echo It added this file:  %ENTRY%
  echo To undo, double-click autostart-off.bat.
) else (
  echo Something went wrong: the Startup file wasn't made. Nothing was changed.
)
echo.
pause
