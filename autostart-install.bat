@echo off
rem Starts the RedNote bot at login. Delete this file to stop that.
rem NO_BROWSER keeps it from opening a tab on every boot.
set "NO_BROWSER=1"
cd /d "C:\rednote\rednote-downloader"
start "RedNote Downloader" /min cmd /c start.bat
