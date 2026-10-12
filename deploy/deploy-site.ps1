# 官网部署打包脚本：冒烟全绿后打包 apps/site 为 zip（零第三方依赖，仅 PowerShell + .NET）。
# 用法：
#   powershell -File deploy\deploy-site.ps1              # 打包到 deploy\out\site-<date>.zip
#   powershell -File deploy\deploy-site.ps1 -SkipTests   # 跳过冒烟（仅限已验证场景）
param(
  [string]$OutDir = (Join-Path $PSScriptRoot "out"),
  [switch]$SkipTests
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$site = Join-Path $root "apps\site"

Write-Host "== 官网部署打包 ==" -ForegroundColor Cyan

if (-not $SkipTests) {
  Write-Host "[1/3] 冒烟测试…"
  & node (Join-Path $site "test\smoke.mjs")
  if ($LASTEXITCODE -ne 0) { throw "冒烟未全绿，已中止打包" }
} else {
  Write-Host "[1/3] 跳过冒烟（-SkipTests）" -ForegroundColor Yellow
}

Write-Host "[2/3] 重新生成岗位快照…"
$py = "C:\Users\19560\.workbuddy-ai\binaries\python\envs\default\Scripts\python.exe"
if (Test-Path $py) {
  & $py (Join-Path $site "scripts\build-jobs.py")
} else {
  Write-Host "  未找到受管 Python，跳过快照重建（沿用现有 jobs-snapshot.json）" -ForegroundColor Yellow
}

Write-Host "[3/3] 打包…"
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$zip = Join-Path $OutDir "site-$stamp.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
# 全量打包（含 test/ 与 scripts/，体积可忽略；若需剔除可改临时目录法）
Compress-Archive -Path (Join-Path $site "*") -DestinationPath $zip -CompressionLevel Optimal
$size = [math]::Round((Get-Item $zip).Length / 1KB, 1)
Write-Host "完成：$zip（${size} KB）" -ForegroundColor Green
Write-Host "部署提示：解压到 Nginx root 指向目录即可；构建机建议 crontab 每日跑 build-jobs.py 后执行本脚本。"
