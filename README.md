# dsh-openviking

DeepSeek Harness（DSH）的 [OpenViking](https://github.com/volcengine/OpenViking) 记忆插件。
参考官方 [OpenCode 插件](https://github.com/volcengine/OpenViking/tree/main/examples/opencode-plugin)
与 [Codex 插件](https://github.com/volcengine/OpenViking/tree/main/examples/codex-memory-plugin)
实现，一次安装即可获得同款能力：**每次 prompt 前自动召回记忆、每轮对话增量捕获、
compaction 前提交抽取，以及模型可直接调用的 OpenViking MCP 工具**。

## 能力对照

| 能力 | 官方 OpenCode/Codex 插件 | dsh-openviking |
|---|---|---|
| 自动召回（prompt 前） | `chat.message` / `UserPromptSubmit` 钩子 | `agent/pre-step`（每 turn 第一步，注入 synthetic user 上下文） |
| 增量捕获 | `message.updated` 事件 / `Stop` 钩子 | `session/event` 火线（`user/message`、`assistant/message`、`tool/result`） |
| compaction 前 commit | `experimental.session.compacting` / `PreCompact` | `session/event` 的 `compaction/start` |
| 会话启动映射 + 离线队列重放 | `session.created` / `SessionStart` | `agent/session-start` |
| 退出时 flush + commit | `dispose` | `dispose` |
| MCP 工具（find/search/recall/remember…） | OpenViking stdio MCP proxy | 同一套 stdio MCP proxy（`servers/mcp-proxy.mjs`） |
| 会话 id 映射 | `oc-<session>` / `cx-<session>` | `ds-<session>` |
| 凭据解析链 | ovcli.conf → env → ov.conf | 完全相同（复用官方 shared 模块） |
| 落盘离线队列 | `~/.openviking/pending/` | 完全相同（复用官方 shared 模块） |

工具名形如 `mcp__openviking__find`、`mcp__openviking__search`、
`mcp__openviking__recall`、`mcp__openviking__remember`（与 harness 内置
`dsh-mcp-client` 的命名契约一致）。

## 要求

- Node.js 18+（DSH 本身的要求）
- OpenViking HTTP 服务器（`openviking-server`），未运行时捕获会进落盘队列，
  MCP 工具连接失败会自动重试
- 如服务器要求鉴权：`~/.openviking/ovcli.conf` 或 `OPENVIKING_*` 环境变量

## 安装

### 一键安装（推荐，与官方 OpenViking 插件同款体验）

Windows（PowerShell 5.1+）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "iex (New-Object Net.WebClient).DownloadString('https://raw.githubusercontent.com/LOVEYIKANUOSI/dsh-openviking/main/install.ps1')"
```

Linux / macOS / WSL：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/LOVEYIKANUOSI/dsh-openviking/main/install.sh)
```

脚本会依次：检查 dsh/git/node/pnpm → 克隆源码到 `~/.dsh/plugins/dsh-openviking`
→ 安装依赖 → `dsh plugin --profile web add` → 校验配置组合 → 提示凭据配置。
全部步骤幂等，可安全重复执行。可选参数：`--profile`（默认 `web`）、
`--install-dir`、`--branch`。

### 手动安装

GitHub 克隆：

```powershell
git clone https://github.com/LOVEYIKANUOSI/dsh-openviking.git
cd dsh-openviking
pnpm install          # 安装 MCP SDK 依赖（link 安装不会自动装依赖到源码目录）
cd ..
dsh plugin --profile web add .\dsh-openviking
```

本地已有源码目录（开发/试用，链接式安装，改完重启即生效）：

```powershell
cd <dsh-openviking 的父目录>
dsh plugin --profile web add .\dsh-openviking
```

`dsh plugin` 会把该包以本地路径依赖装进 `%USERPROFILE%\.dsh\profiles\web`
并追加进 `dsh.profile.bundles`。验证组合结果（不启动服务）：

```powershell
dsh web --dump-config | Select-String -Context 2 "openviking"
```

重启 `dsh web` 进程生效（bundle 层在启动时读取）。

## 配置

行为旋钮与官方插件一致，优先级：环境变量 > 配置文件 > 默认值。
配置文件查找顺序（后者优先）：

1. 插件目录内 `openviking-config.json`
2. `~/.openviking/dsh-config.json`
3. `%DSH_HOME%\openviking-config.json`（默认 `~/.dsh/openviking-config.json`）
4. `OPENVIKING_PLUGIN_CONFIG` 指名的 JSON 文件

示例 `~/.openviking/dsh-config.json`：

```json
{
  "enabled": true,
  "timeoutMs": 30000,
  "autoRecall": {
    "enabled": true,
    "limit": 6,
    "scoreThreshold": 0.35,
    "maxContentChars": 500,
    "preferAbstract": true,
    "tokenBudget": 2000,
    "minQueryLength": 3
  },
  "autoCapture": true,
  "captureMaxLength": 24000,
  "captureAssistantTurns": true,
  "captureToolMaxChars": 2000,
  "commitTokenThreshold": 20000,
  "commitKeepRecentCount": 10,
  "bypassSessionPatterns": [],
  "debug": false,
  "mcp": { "enabled": true, "serverName": "openviking", "toolCallTimeoutMs": 15000 }
}
```

常用环境变量（与官方插件同名）：`OPENVIKING_AUTO_RECALL`、
`OPENVIKING_RECALL_LIMIT`、`OPENVIKING_AUTO_CAPTURE`、
`OPENVIKING_COMMIT_TOKEN_THRESHOLD`、`OPENVIKING_COMMIT_KEEP_RECENT_COUNT`、
`OPENVIKING_RECALL_PEER_SCOPE`（`actor` 隔离模式 / `all` 默认）、
`OPENVIKING_DEBUG`（写日志到 `~/.openviking/logs/dsh-plugin.log`）等。

也可以在 profile 的 `cordis.patch.yml` 里按 id 覆盖条目 config（例如关闭 MCP）：

```yaml
- id: openviking
  config:
    mcp: { enabled: false }
```

## 运行时文件

- 会话状态：`~/.openviking/dsh-plugin/openviking-session-state.json`
- 插件日志：`~/.openviking/dsh-plugin/openviking-memory.log`
- 离线队列：`~/.openviking/pending/`（OpenViking 不可达时暂存，下次会话启动重放）

## 说明

- 召回注入的上下文是带 `source.kind = "plugin"` 标记的 synthetic user 消息，
  不会被回捕（capture）进 OpenViking；
- 每个 DSH 会话派生一个 OpenViking 会话（`ds-<session-id>`），DSH 会话恢复
  （resume）时沿用同一映射；
- 卸载：`dsh plugin --profile web remove dsh-openviking`，移除后重启 `dsh web`。

## 目录结构

```text
dsh-openviking/
├── package.json          # dsh.bundle.patch 声明
├── cordis.patch.yml      # bundle 层：insert `openviking` 条目
├── install.ps1           # Windows 一键安装脚本（PowerShell 5.1+）
├── install.sh            # Linux/macOS/WSL 一键安装脚本
├── lib/
│   ├── index.js          # 主 Cordis 插件：事件钩子 + MCP 桥
│   ├── config.js         # 配置加载（DSH 路径）
│   ├── utils.js          # fetchJSON / 日志
│   ├── memory-session.js # 捕获 / commit / 离线队列
│   ├── memory-recall.js  # 召回（agent/pre-step 注入）
│   ├── mcp-bridge.js     # MCP 工具注册（ctx.tools）
│   └── shared/           # 官方插件共享模块（原样复用）
├── servers/
│   └── mcp-proxy.mjs     # OpenViking stdio MCP proxy
└── tests/
    └── verify-e2e.mjs    # 端到端验证脚本
```

端到端验证（需 OpenViking 服务器可达）：`node tests/verify-e2e.mjs`（驱动捕获 /
commit / 召回的真实 HTTP 路径，会在 OpenViking 中创建一个
`ds-verify-e2e-session` 测试会话）。
