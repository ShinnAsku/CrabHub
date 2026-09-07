@echo off
call "%~1\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 exit /b 1
cd /d "%~2"
if errorlevel 1 exit /b 1
if exist makefile goto build
"%PERL%" Configure VC-WIN64A no-shared no-module no-tests no-asm "--prefix=%~3" "--openssldir=%~3\ssl" --libdir=lib
if errorlevel 1 exit /b 1
:build
nmake /nologo /S
if errorlevel 1 exit /b 1
nmake /nologo /S install_sw
exit /b %errorlevel%