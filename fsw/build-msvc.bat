@echo off
REM ===========================================================================
REM  Icarus OBC - build with the Microsoft C compiler
REM ===========================================================================
REM  Run this from a "Developer Command Prompt for VS" (or x64 Native Tools
REM  Command Prompt) so that cl.exe is on PATH.
REM
REM  If you do not have Visual Studio, the easiest alternative on Windows is
REM  MSYS2 + mingw-w64, which gives you gcc and make:
REM      https://www.msys2.org/
REM      pacman -S mingw-w64-ucrt-x86_64-gcc make
REM      make            (from the MSYS2 UCRT64 shell, in this directory)
REM
REM  And remember: you do NOT need the C OBC to run the digital twin. The
REM  browser simulator implements the same telemetry contract.
REM ===========================================================================

where cl.exe >nul 2>nul
if errorlevel 1 (
  echo.
  echo   cl.exe was not found on PATH.
  echo   Open a "Developer Command Prompt for VS" and run this script again,
  echo   or install MSYS2/mingw-w64 and use the Makefile instead.
  echo.
  exit /b 1
)

if not exist build mkdir build

cl.exe /nologo /W4 /O2 /std:c11 /Fe:icarus.exe /Fo:build\ ^
  src\main.c src\icarus.c src\power.c src\thermal.c src\vibration.c ^
  src\adcs.c src\anomaly.c src\telemetry.c src\commands.c ^
  ws2_32.lib

if errorlevel 1 (
  echo Build FAILED.
  exit /b 1
)

echo.
echo Built icarus.exe
echo Run it with:  icarus.exe
