@echo off
set "ANDROID_HOME=C:\Users\76215\AppData\Local\Android\Sdk"
set "PATH=%ANDROID_HOME%\platform-tools;%PATH%"
cd /d "%~dp0"
call npm run android
