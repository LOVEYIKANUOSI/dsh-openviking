#!/usr/bin/env bash
# dsh-openviking 一键安装脚本（Linux / macOS / WSL）。
# 与官方 OpenViking 插件（OpenCode/Codex）的一键安装器体验对齐：
# 所有步骤幂等，可安全重复执行。
#
# 用法:
#   bash <(curl -fsSL https://raw.githubusercontent.com/LOVEYIKANUOSI/dsh-openviking/main/install.sh)
#   bash install.sh --profile headless
#
# 选项:
#   --profile <name>      目标 DSH profile（默认 web）
#   --install-dir <path>  插件源码目录（默认 ~/.dsh/plugins/dsh-openviking）
#   --branch <name>       克隆分支（默认 main）

set -euo pipefail

PROFILE="web"
INSTALL_DIR="${HOME}/.dsh/plugins/dsh-openviking"
BRANCH="main"
REPO_URL="https://github.com/LOVEYIKANUOSI/dsh-openviking.git"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="${2:-web}"; shift 2 ;;
    --install-dir) INSTALL_DIR="${2:?--install-dir 需要一个路径}"; shift 2 ;;
    --branch) BRANCH="${2:-main}"; shift 2 ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "未知参数: $1（-h 查看帮助）" >&2; exit 2 ;;
  esac
done

step()  { printf '\n\033[36m==> %s\033[0m\n' "$1"; }
ok()    { printf '    \033[32mOK  %s\033[0m\n' "$1"; }
warn()  { printf '    \033[33m!!  %s\033[0m\n' "$1"; }
fail()  { printf '\n\033[31m[ERROR] %s\033[0m\n' "$1" >&2; exit 1; }

echo "dsh-openviking 一键安装"
echo "  repo   : ${REPO_URL}"
echo "  profile: ${PROFILE}"
echo "  branch : ${BRANCH}"

# 1. 前置检查
step "检查 dsh CLI"
command -v dsh >/dev/null 2>&1 || fail "未找到 dsh 命令。请先安装 DeepSeek Harness CLI：npm install -g @deepseek-ai/dsh"
ok "dsh 已找到"

step "检查 git"
command -v git >/dev/null 2>&1 || fail "未找到 git 命令，请先安装 git"
ok "git 已找到"

step "检查 Node.js"
command -v node >/dev/null 2>&1 || fail "未找到 node 命令，请先安装 Node.js 18+"
NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
[ "${NODE_MAJOR}" -ge 18 ] || fail "Node.js 版本过低（$(node -v)），需要 18+"
ok "node $(node -v)"

step "检查 pnpm"
if ! command -v pnpm >/dev/null 2>&1; then
  warn "未找到 pnpm（dsh plugin 需要它），尝试 npm install -g pnpm ..."
  npm install -g pnpm || fail "pnpm 安装失败，请手动执行：npm install -g pnpm"
fi
ok "pnpm 已就绪"

# 2. 获取源码
step "获取插件源码 -> ${INSTALL_DIR}"
if [ -d "${INSTALL_DIR}/.git" ]; then
  echo "    已有 git 仓库，拉取更新 ..."
  (cd "${INSTALL_DIR}" && git checkout "${BRANCH}" >/dev/null 2>&1 || true && git pull --ff-only origin "${BRANCH}") \
    || warn "git pull 失败（本地可能有未提交改动），继续使用现有源码"
  ok "源码已更新"
elif [ -e "${INSTALL_DIR}" ]; then
  fail "${INSTALL_DIR} 已存在但不是 git 仓库。请移走该目录后重试。"
else
  mkdir -p "$(dirname "${INSTALL_DIR}")"
  git clone --depth 1 --branch "${BRANCH}" "${REPO_URL}" "${INSTALL_DIR}" || fail "git clone 失败，请检查网络后重试。"
  ok "源码已克隆"
fi

# 3. 安装依赖（link 安装不会把依赖装进源码目录，需自行安装）
step "安装插件依赖（pnpm install）"
(cd "${INSTALL_DIR}" && pnpm install --prefer-offline) || fail "pnpm install 失败"
ok "依赖已安装"

# 4. 注册进 profile
step "注册插件到 DSH profile [${PROFILE}]"
dsh plugin --profile "${PROFILE}" add "${INSTALL_DIR}" || fail "dsh plugin add 失败"
ok "已加入 ${PROFILE} 的 bundle 列表"

# 5. 校验配置组合
step "校验配置组合"
if dsh --profile "${PROFILE}" --dump-config 2>&1 | grep -q "dsh-openviking"; then
  ok "组合树包含 openviking 条目"
else
  warn "dump-config 未看到 openviking 条目，请运行：dsh --profile ${PROFILE} --dump-config"
fi

# 6. 凭据提示
step "检查 OpenViking 凭据"
OVCLI="${HOME}/.openviking/ovcli.conf"
if [ -f "${OVCLI}" ] || [ -n "${OPENVIKING_API_KEY:-}" ] || [ -n "${OPENVIKING_BEARER_TOKEN:-}" ]; then
  ok "检测到凭据配置（ovcli.conf 或 OPENVIKING_* 环境变量）"
else
  warn "未检测到凭据。任选其一："
  echo "    1) 写入 ${OVCLI} ："
  echo '       {"url":"http://<host>:1933","api_key":"<user key>","account":"<账号>","user":"<用户>"}'
  echo "    2) 或设置环境变量 OPENVIKING_URL / OPENVIKING_API_KEY"
fi

# 7. 完成
printf '\n\033[32m安装完成！\033[0m\n'
echo "  重启生效 : 关闭并重新运行 dsh ${PROFILE}"
echo "  验证     : 新会话问“我的语言偏好是什么”，或检查"
echo "             ~/.openviking/dsh-plugin/openviking-memory.log 是否出现 plugin active"
echo "  卸载     : dsh plugin --profile ${PROFILE} remove dsh-openviking"
