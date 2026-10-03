# build-and-test-matcher.ps1 —— 在 Windows 本机编译并运行 core/auto_match.c 的对照测试。
#
# 为什么不直接调 cl：MSVC 需要 vcvars 环境（INCLUDE/LIB/PATH）。这里用 cmd /c 先调 vcvars64.bat
# 再调 cl，避免污染当前 PowerShell 会话。
#
# 用法（在 ios/auto 目录下）：
#     pwsh -File tools/build-and-test-matcher.ps1
#     pwsh -File tools/build-and-test-matcher.ps1 -Golden matcher_golden
#
# 退出码：0 = 全部通过；非 0 = 编译失败或有 FAIL。
param(
    [string]$Golden = "matcher_golden",
    [string]$OutDir = "tests/build"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot      # ios/auto
Set-Location $root

$vcvars = "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
if (-not (Test-Path $vcvars)) {
    Write-Error "找不到 vcvars64.bat：$vcvars（本机没有 MSVC 时请改用 macOS/clang，或走 CI）"
    exit 2
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$outExe = Join-Path $root "$OutDir/test_matcher.exe"

# cl 的 /I 用来找 golden_cases.h（它由 make_matcher_golden.py 生成在 <Golden>/ 下）
$cmd = "call `"$vcvars`" >nul && cl /nologo /W4 /O2 /std:c11 /Fe:`"$outExe`" /Fo:`"$OutDir\`" /I `"$Golden`" " +
       "tests\test_matcher.c core\auto_match.c"
Write-Host "== compile ==" -ForegroundColor Cyan
cmd /c $cmd
if ($LASTEXITCODE -ne 0) { Write-Error "编译失败"; exit 1 }

Write-Host "== run ==" -ForegroundColor Cyan
& $outExe $Golden
$code = $LASTEXITCODE
Write-Host "exit=$code"
exit $code
