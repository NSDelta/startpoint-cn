@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================================
echo  StarPoint CN server  (worktree "reset-bringup" = dev + 忘记密码三步)
rem 这里原本写死本机局域网 IP；改成回环地址 + 提示（IP 是机器相关的，不入库）。
echo  game / phone URL : http://127.0.0.1:8001/  (phone: use this PC's LAN IP, see ipconfig)
echo  admin panel      : http://127.0.0.1:8001/admin/
echo  data dir         : D:/wfcnmod/server/cn-data   (your save)
echo  stop             : press Ctrl+C in this window
echo ------------------------------------------------------------
echo  为什么不是本目录的 tools\start_cn.cjs：
echo    本目录主树当前在分支 dev 上，且带着别人未提交的改动；
echo    /sp-auth/reset-request 与 /sp-auth/reset-confirm 只在
echo    D:\wfcnmod\wt\reset-srv （分支 reset-bringup = dev + 忘记密码三步）里。
echo    在主树启动会让「忘记密码」重新变成 404（客户端只显示「操作失败，请重试。」）。
echo    dev 分支把这两条路由并进来之后，把下面这行改回 tools\start_cn.cjs 即可。
echo ============================================================
node "D:\wfcnmod\wt\reset-srv\tools\start_cn.cjs"
echo.
echo [server exited] press any key to close
pause >nul
