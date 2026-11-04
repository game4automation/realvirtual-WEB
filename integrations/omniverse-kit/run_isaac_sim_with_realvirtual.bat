@echo off
rem SPDX-License-Identifier: AGPL-3.0-only
rem Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
rem
rem Starts NVIDIA Isaac Sim with the realvirtual Live Sync extension (plan-637 F11).
rem Looks for Isaac Sim in %ISAACSIM_PATH%, C:\isaacsim and %USERPROFILE%\isaacsim.
rem Extra arguments are passed through, e.g.  --/exts/realvirtual.livesync/port=8766

setlocal
set "EXT_FOLDER=%~dp0exts"
set "ISAAC="

if defined ISAACSIM_PATH if exist "%ISAACSIM_PATH%\isaac-sim.bat" set "ISAAC=%ISAACSIM_PATH%"
if not defined ISAAC if exist "C:\isaacsim\isaac-sim.bat" set "ISAAC=C:\isaacsim"
if not defined ISAAC if exist "%USERPROFILE%\isaacsim\isaac-sim.bat" set "ISAAC=%USERPROFILE%\isaacsim"

if not defined ISAAC (
  echo Isaac Sim was not found.
  echo Set ISAACSIM_PATH to the folder that contains isaac-sim.bat, or install it to C:\isaacsim.
  exit /b 1
)

echo Starting Isaac Sim from "%ISAAC%" with realvirtual Live Sync ...
call "%ISAAC%\isaac-sim.bat" --ext-folder "%EXT_FOLDER%" --enable realvirtual.livesync %*
endlocal
