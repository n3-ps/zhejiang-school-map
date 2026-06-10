 @echo off
 chcp 65001 >nul
 title 浙江民办校作战地图服务器
 echo ========================================
 echo   正在启动浙江民办校作战地图服务器...
 echo ========================================
 echo.
 "D:\node.exe" "%~dp0server.js"
 pause
