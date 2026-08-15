#Requires -Version 5.1
<#
.SYNOPSIS
  dsh-openviking 一键安装脚本（Windows PowerShell 5.1+）。
  拉取插件源码 -> 安装依赖 -> 注册进 DSH profile -> 校验配置组合。

.DESCRIPTION
  与官方 OpenViking 插件（OpenCode/Codex）的一键安装器体验对齐：
  所有步骤幂等，可安全重复执行。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1

.EXAMPLE
  # 云端一键（仓库公开）：
  powershell -NoProfile -ExecutionPolicy Bypass -Command "iex (New-Object Net.WebClient).DownloadString('https://raw.githubusercontent.com/LOVEYIKANUOSI/dsh-openviking/main/install.ps1')"

.PARAMETER Profile
  目标 DSH profile 名，默认 web。
.PARAMETER InstallDir
  插件源码目录，默认 %USERPROFILE%\.dsh\plugins\dsh-openviking。
.PARAMETER Branch
  克隆的分支，默认 main。
#>
[CmdletBinding()]
param(
    [string]$Profile = "web",
    [string]$InstallDir = "",
    [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"
$RepoUrl = "https://github.com/LOVEYIKANUOSI/dsh-openviking.git"

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}
function Write-Ok([string]$Message) {
    Write-Host "    OK  $Message" -ForegroundColor Green
}
function Write-WarnLine([string]$Message) {
    Write-Host "    !!  $Message" -ForegroundColor Yellow
}
function Write-Fail([string]$Message) {
    Write-Host ""
    Write-Host "[ERROR] $Message" -ForegroundColor Red
    exit 1
}

# PowerShell 5.1 在 $ErrorActionPreference=Stop 时会把 native 命令的 stderr
# 输出当成终止错误（NativeCommandError）。native 调用统一走这里：局部降级，
# 返回退出码，stderr 原样显示（进度输出可见但不致命）。
function Invoke-Native {
    param([scriptblock]$Command)
    $saved = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $Command | Out-Host
        return $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $saved
    }
}

Write-Host "dsh-openviking 一键安装" -ForegroundColor White
Write-Host "  repo   : $RepoUrl"
Write-Host "  profile: $Profile"
Write-Host "  branch : $Branch"

if (-not $InstallDir) {
    $InstallDir = Join-Path $env:USERPROFILE ".dsh\plugins\dsh-openviking"
}

# 1. 前置检查：dsh
Write-Step "检查 dsh CLI"
if (-not (Get-Command dsh -ErrorAction SilentlyContinue)) {
    Write-Fail "未找到 dsh 命令。请先安装 DeepSeek Harness CLI：npm install -g @deepseek-ai/dsh"
}
Write-Ok "dsh 已找到"

# 2. 前置检查：git
Write-Step "检查 git"
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Fail "未找到 git 命令。请先安装 Git（https://git-scm.com/downloads）"
}
Write-Ok "git 已找到"

# 3. 前置检查：node >= 18
Write-Step "检查 Node.js"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Fail "未找到 node 命令。请先安装 Node.js 18+（https://nodejs.org）"
}
$nodeVersion = (& node -v) -replace "^v", ""
if ([int]($nodeVersion.Split(".")[0]) -lt 18) {
    Write-Fail "Node.js 版本过低（$nodeVersion），需要 18+。请升级后重试。"
}
Write-Ok "node $nodeVersion"

# 4. 前置检查：pnpm（dsh plugin 的转发目标）
Write-Step "检查 pnpm"
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-WarnLine "未找到 pnpm（dsh plugin 需要它），尝试 npm install -g pnpm ..."
    $exit = Invoke-Native { npm install -g pnpm }
    if ($exit -ne 0) {
        Write-Fail "pnpm 安装失败，请手动执行：npm install -g pnpm"
    }
}
Write-Ok "pnpm 已就绪"

# 5. 获取源码
Write-Step "获取插件源码 -> $InstallDir"
if (Test-Path (Join-Path $InstallDir ".git")) {
    Write-Host "    已有 git 仓库，拉取更新 ..."
    $null = Invoke-Native { git -C $InstallDir checkout $Branch *> $null }
    $exit = Invoke-Native { git -C $InstallDir pull --ff-only origin $Branch *> $null }
    if ($exit -ne 0) {
        Write-WarnLine "git pull 失败（本地可能有未提交改动），继续使用现有源码"
    } else {
        Write-Ok "源码已更新"
    }
} elseif (Test-Path $InstallDir) {
    Write-Fail "$InstallDir 已存在但不是 git 仓库。请移走该目录后重试。"
} else {
    New-Item -ItemType Directory -Path (Split-Path $InstallDir -Parent) -Force | Out-Null
    $exit = Invoke-Native { git clone --depth 1 --branch $Branch $RepoUrl $InstallDir }
    if ($exit -ne 0) {
        Write-Fail "git clone 失败，请检查网络后重试。"
    }
    Write-Ok "源码已克隆"
}

# 6. 安装依赖（link 安装不会把依赖装进源码目录，需自行安装）
Write-Step "安装插件依赖（pnpm install）"
Push-Location $InstallDir
try {
    $exit = Invoke-Native { pnpm install --prefer-offline }
} finally {
    Pop-Location
}
if ($exit -ne 0) {
    Write-Fail "pnpm install 失败（exit $exit）"
}
Write-Ok "依赖已安装"

# 7. 注册进 profile
Write-Step "注册插件到 DSH profile [$Profile]"
$exit = Invoke-Native { dsh plugin --profile $Profile add $InstallDir }
if ($exit -ne 0) {
    Write-Fail "dsh plugin add 失败（exit $exit）"
}
Write-Ok "已加入 $Profile 的 bundle 列表"

# 8. 校验配置组合
Write-Step "校验配置组合"
$dump = (& dsh --profile $Profile --dump-config 2>&1 | Out-String)
if ($dump -match "dsh-openviking") {
    Write-Ok "组合树包含 openviking 条目"
} else {
    Write-WarnLine "dump-config 未看到 openviking 条目，请运行：dsh --profile $Profile --dump-config"
}

# 9. 凭据提示
Write-Step "检查 OpenViking 凭据"
$ovcli = Join-Path $env:USERPROFILE ".openviking\ovcli.conf"
$hasCred = (Test-Path $ovcli) -or $env:OPENVIKING_API_KEY -or $env:OPENVIKING_BEARER_TOKEN
if ($hasCred) {
    Write-Ok "检测到凭据配置（ovcli.conf 或 OPENVIKING_* 环境变量）"
} else {
    Write-WarnLine "未检测到凭据。任选其一："
    Write-Host "    1) 写入 $ovcli ："
    Write-Host '       {"url":"http://<host>:1933","api_key":"<user key>","account":"<账号>","user":"<用户>"}'
    Write-Host "    2) 或设置环境变量 OPENVIKING_URL / OPENVIKING_API_KEY"
}

# 10. 完成
Write-Host ""
Write-Host "安装完成！" -ForegroundColor Green
Write-Host "  重启生效 : 关闭并重新运行 dsh $Profile"
Write-Host "  验证     : 新会话问“我的语言偏好是什么”，或检查"
Write-Host "             ~\.openviking\dsh-plugin\openviking-memory.log 是否出现 plugin active"
Write-Host "  卸载     : dsh plugin --profile $Profile remove dsh-openviking"
