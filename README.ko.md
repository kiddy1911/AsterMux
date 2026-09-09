# AsterMux

**언어:** [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [日本語](README.ja.md) · **한국어** · [Português (Brasil)](README.pt-BR.md) · [Русский](README.ru.md) · [Tiếng Việt](README.vi.md)

**Cursor ACP를 위한 적응형·모델 비종속 게이트웨이.**

AsterMux는 Cursor 계정에서 사용할 수 있는 모델을 OpenAI 및 Anthropic 호환 HTTP 인터페이스로 제공하면서, 비용이 큰 Cursor Agent 프로세스를 warm 상태로 유지하고 제한된 수로 재사용합니다. 고처리량 게이트웨이와 소형 VPS 모두를 위해 설계되었으며, 지연 시간을 최소화하려면 모든 worker를 warm 상태로 유지하고, 유휴 메모리를 줄이려면 설정 가능한 warm floor까지 축소할 수 있습니다.

AsterMux는 독립적인 커뮤니티 오픈소스 프로젝트입니다. Cursor는 상위 런타임이며 AsterMux 자체의 제품 정체성이 아닙니다.

> 이 문서는 간결한 한국어 소개 페이지입니다. 전체 최신 기술 문서는 [영문 README](README.md)를 기준으로 합니다.

## 주요 기능

- **Universal Model Pool** — ACP worker는 특정 모델에 고정되지 않습니다. Grok, GPT, Gemini, Claude, Composer 및 향후 Cursor 모델이 동일한 최적화 pool을 공유합니다.
- **OpenAI / Anthropic 호환 API** — OpenAI Chat Completions, OpenAI Responses, Anthropic Messages 지원.
- **Streaming 및 Tool Calling** — 스트리밍 응답과 OpenAI/Anthropic function tools를 임시 MCP 서버로 변환하는 기능을 제공합니다.
- **Dual-lane scheduler** — 대화형 트래픽과 batch / structured-output 작업을 분리합니다.
- **Elastic ACP workers** — `*_POOL_SIZE`는 최대 worker 수를, `*_WARM_SIZE`는 유휴 상태에서 유지할 worker 수를 제어합니다.
- **Batch / Structured Output** — 영속 비동기 batch, schema 검증, 제한된 repair를 지원합니다.
- **관측 가능성** — runtime status, Prometheus metrics, queue wait, execution time, worker 수, 로컬 Dashboard를 제공합니다.

## 모델과 Cursor 계정

AsterMux는 고정된 모델 whitelist를 유지하지 않습니다. `GET /v1/models`는 설정된 Cursor 계정에서 실제로 보이는 모델을 반환합니다.

계정과 상위 서비스에 따라 GPT, Claude, Gemini, Grok, Composer, Kimi, GLM 계열과 reasoning / thinking / fast 변형이 제공될 수 있습니다. 실제 사용 가능 모델, 쿼터 및 제한은 Cursor와 상위 제공자에 따라 달라집니다.

Cursor Agent에서 보이는 모델 확인:

```bash
agent --list-models
```

## Docker 빠른 시작

Docker 이미지에는 Cursor Agent가 포함되어 있으므로 서버에 별도로 설치할 필요가 없습니다.

비공개 환경 변수 파일을 만듭니다:

```bash
cat > .env <<'EOF'
CURSOR_API_KEY=replace-with-your-cursor-key
ASTERMUX_API_KEY=replace-with-your-own-gateway-key
EOF
chmod 600 .env
```

AsterMux 시작:

```bash
docker run -d \
  --name astermux \
  --restart unless-stopped \
  --env-file .env \
  -p 127.0.0.1:8787:8787 \
  ghcr.io/kiddy1911/astermux:latest
```

상태 확인:

```bash
curl http://127.0.0.1:8787/healthz
```

프로덕션에서는 `latest`를 계속 사용하는 대신 특정 release tag를 고정하는 것을 권장합니다.

## 첫 번째 요청

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_ASTERMUX_KEY' \
  -d '{
    "model": "cursor-grok-4.6-high",
    "messages": [{"role":"user","content":"Reply exactly OK"}]
  }'
```

`ASTERMUX_API_KEY`가 설정되지 않은 경우 Authorization header는 필수가 아닙니다. 인증되지 않은 게이트웨이를 신뢰할 수 없는 네트워크에 노출하지 마세요.

## API

| 메서드 | 경로 | 용도 |
|---|---|---|
| `GET` | `/healthz` | 가벼운 상태 확인 |
| `GET` | `/v1/models` | Cursor 계정에서 보이는 모델 |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions 호환 |
| `POST` | `/v1/responses` | OpenAI Responses 호환 |
| `POST` | `/v1/messages` | Anthropic Messages 호환 |
| `POST` | `/v1/batches` | 비동기 batch |
| `GET` | `/v1/runtime/status` | Scheduler / pool / Tool 상태 |
| `GET` | `/metrics` | Prometheus metrics |
| `GET` | `/` | 로컬 Dashboard |
| `GET` | `/docs` | 렌더링된 운영 가이드 |

기본 endpoint: `http://127.0.0.1:8787`

## 기타 실행 방식

AsterMux는 Docker Compose, Node.js 22.12+ 소스 실행, macOS 백그라운드 서비스 / 메뉴바 컨트롤러도 지원합니다.

전체 문서:

- [Running AsterMux](docs/RUNNING.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Configuration](docs/CONFIGURATION.md)
- [Operations](docs/OPERATIONS.md)
- [Security](SECURITY.md)

## 보안

- 원격 접근이 의도된 경우가 아니라면 `127.0.0.1`에만 bind 하세요.
- 호스트 외부에 API를 공개하기 전에 `ASTERMUX_API_KEY`를 설정하세요.
- `CURSOR_API_KEY`, `.env`, 계정 디렉터리, 마이그레이션 아카이브를 Git에 커밋하지 마세요.
- 실제 workspace 접근은 Agent 실행 권한으로 간주하고 필요한 경우에만 명시적으로 활성화하세요.

## License

AsterMux는 [MIT License](LICENSE)로 공개된 오픈소스 프로젝트입니다.
