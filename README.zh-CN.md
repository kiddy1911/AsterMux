# AsterMux

**语言：** [English](README.md) · **简体中文** · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Português (Brasil)](README.pt-BR.md) · [Русский](README.ru.md) · [Tiếng Việt](README.vi.md)

**面向 Cursor ACP 的自适应、模型无关网关。**

AsterMux 将 Cursor 账号可用的模型通过熟悉的 OpenAI 与 Anthropic HTTP 接口暴露出来，同时让高开销的 Cursor Agent 进程保持预热、受控并可复用。它既适合高吞吐网关，也适合小型 VPS：可以保持全部 worker 常驻以降低延迟，也可以只保留可配置的 warm floor 来减少空闲内存。

AsterMux 是独立的社区开源项目。Cursor 是上游运行时，不是本项目的产品身份。

> 这是精简的本地化介绍页。完整、最新的技术文档以 [English README](README.md) 为准。

## 核心能力

- **Universal Model Pool** — ACP worker 不绑定具体模型；Grok、GPT、Gemini、Claude、Composer 以及 Cursor 后续提供的模型可以共享同一组优化后的 worker pool。
- **OpenAI / Anthropic 兼容接口** — 支持 OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages。
- **Streaming 与工具调用** — 支持流式响应，并可将 OpenAI/Anthropic function tools 转换为临时 MCP 工具服务。
- **双通道调度** — 交互请求与 batch / structured-output 工作负载分离，减少互相干扰。
- **弹性 ACP worker** — `*_POOL_SIZE` 控制峰值 worker 数，`*_WARM_SIZE` 控制空闲时常驻数量。
- **Batch 与 structured output** — 支持持久化异步 batch、schema 校验和受控 repair。
- **可观测性** — 提供运行状态、Prometheus metrics、队列等待、执行时间、worker 数量和本地 Dashboard。

## 模型与 Cursor 账号

AsterMux 不维护固定的模型白名单。`GET /v1/models` 会返回当前配置的 Cursor 账号实际可见的模型。

实际模型可包括 GPT、Claude、Gemini、Grok、Composer、Kimi、GLM 等系列及其 reasoning / thinking / fast 等变体，具体可用模型、额度和限制由 Cursor 账号及上游服务决定。

验证 Cursor Agent 能看到模型：

```bash
agent --list-models
```

## 快速开始：Docker

Docker 镜像已包含 Cursor Agent，因此服务器无需额外安装本地 Agent。

创建私有环境变量文件：

```bash
cat > .env <<'EOF'
CURSOR_API_KEY=replace-with-your-cursor-key
ASTERMUX_API_KEY=replace-with-your-own-gateway-key
EOF
chmod 600 .env
```

启动：

```bash
docker run -d \
  --name astermux \
  --restart unless-stopped \
  --env-file .env \
  -p 127.0.0.1:8787:8787 \
  ghcr.io/kiddy1911/astermux:latest
```

健康检查：

```bash
curl http://127.0.0.1:8787/healthz
```

生产环境建议固定到具体 release tag，而不是长期使用 `latest`。

## 第一个请求

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_ASTERMUX_KEY' \
  -d '{
    "model": "cursor-grok-4.6-high",
    "messages": [{"role":"user","content":"Reply exactly OK"}]
  }'
```

如果未设置 `ASTERMUX_API_KEY`，则不要求 Authorization header。不要把未认证的网关暴露到不可信网络。

## API

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/healthz` | 轻量健康检查 |
| `GET` | `/v1/models` | 当前 Cursor 账号可见模型 |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions 兼容接口 |
| `POST` | `/v1/responses` | OpenAI Responses 兼容接口 |
| `POST` | `/v1/messages` | Anthropic Messages 兼容接口 |
| `POST` | `/v1/batches` | 异步 batch |
| `GET` | `/v1/runtime/status` | Scheduler / pool / Tool 状态 |
| `GET` | `/metrics` | Prometheus metrics |
| `GET` | `/` | 本地 Dashboard |
| `GET` | `/docs` | 渲染后的运维文档 |

默认地址：`http://127.0.0.1:8787`。

## 其他运行方式

AsterMux 还支持：

- Docker Compose
- Node.js 22.12+ 源码运行
- macOS 后台服务 / 菜单栏控制器

完整安装、升级、日志、远程绑定和故障排查请阅读：

- [Running AsterMux](docs/RUNNING.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Configuration](docs/CONFIGURATION.md)
- [Operations](docs/OPERATIONS.md)
- [Security](SECURITY.md)

## 安全建议

- 默认只绑定 `127.0.0.1`。
- 对外开放前设置 `ASTERMUX_API_KEY`。
- 不要将 `CURSOR_API_KEY`、`.env`、账号目录或迁移归档提交到 Git。
- 真实 workspace 访问应视为 Agent 执行能力，按需显式开启。

## License

AsterMux 使用 [MIT License](LICENSE) 开源。
