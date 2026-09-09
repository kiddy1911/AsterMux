# AsterMux

**Idiomas:** [English](README.md) · [简体中文](README.zh-CN.md) · **Español** · [Français](README.fr.md) · [Deutsch](README.de.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Português (Brasil)](README.pt-BR.md) · [Русский](README.ru.md) · [Tiếng Việt](README.vi.md)

**Gateway adaptativo y agnóstico del modelo para Cursor ACP.**

AsterMux expone los modelos disponibles en una cuenta de Cursor mediante interfaces HTTP compatibles con OpenAI y Anthropic, manteniendo los procesos de Cursor Agent calientes, acotados y reutilizables. Está diseñado tanto para gateways de alto rendimiento como para VPS pequeños: puede mantener todos los workers preparados para minimizar la latencia o reducirlos a un nivel mínimo configurable para ahorrar memoria en reposo.

AsterMux es un proyecto comunitario independiente y de código abierto. Cursor es el runtime upstream, no la identidad del producto.

> Esta es una introducción localizada y resumida. Para la documentación técnica completa y actualizada, consulta el [README en inglés](README.md).

## Funciones principales

- **Universal Model Pool** — los workers ACP no están vinculados a un modelo concreto; Grok, GPT, Gemini, Claude, Composer y futuros modelos de Cursor comparten los mismos pools optimizados.
- **APIs compatibles con OpenAI y Anthropic** — OpenAI Chat Completions, OpenAI Responses y Anthropic Messages.
- **Streaming y herramientas** — respuestas en streaming y traducción de function tools de OpenAI/Anthropic a servidores MCP temporales.
- **Planificador de dos carriles** — separa el tráfico interactivo de batch / structured output.
- **Workers ACP elásticos** — `*_POOL_SIZE` define el máximo y `*_WARM_SIZE` controla cuántos workers permanecen residentes en reposo.
- **Batch y structured output** — trabajos asíncronos persistentes, validación de esquema y reparación controlada.
- **Observabilidad** — estado del runtime, métricas Prometheus, tiempos de cola y ejecución, número de workers y dashboard local.

## Modelos y cuenta de Cursor

AsterMux no mantiene una lista fija de modelos. `GET /v1/models` devuelve los modelos que la cuenta de Cursor configurada puede ver realmente.

Según la cuenta y el servicio upstream, pueden aparecer familias GPT, Claude, Gemini, Grok, Composer, Kimi y GLM, incluidas variantes de reasoning / thinking / fast. La disponibilidad, las cuotas y los límites dependen de Cursor y del proveedor upstream.

Comprueba los modelos visibles desde Cursor Agent:

```bash
agent --list-models
```

## Inicio rápido con Docker

La imagen Docker incluye Cursor Agent, por lo que no necesitas instalarlo por separado en el servidor.

Crea un archivo de entorno privado:

```bash
cat > .env <<'EOF'
CURSOR_API_KEY=replace-with-your-cursor-key
ASTERMUX_API_KEY=replace-with-your-own-gateway-key
EOF
chmod 600 .env
```

Inicia AsterMux:

```bash
docker run -d \
  --name astermux \
  --restart unless-stopped \
  --env-file .env \
  -p 127.0.0.1:8787:8787 \
  ghcr.io/kiddy1911/astermux:latest
```

Comprueba la salud:

```bash
curl http://127.0.0.1:8787/healthz
```

En producción, se recomienda fijar una versión concreta en lugar de usar `latest` permanentemente.

## Primera solicitud

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_ASTERMUX_KEY' \
  -d '{
    "model": "cursor-grok-4.6-high",
    "messages": [{"role":"user","content":"Reply exactly OK"}]
  }'
```

Si `ASTERMUX_API_KEY` no está definido, el header Authorization no es obligatorio. No expongas un gateway sin autenticación a una red no confiable.

## API

| Método | Ruta | Uso |
|---|---|---|
| `GET` | `/healthz` | Comprobación ligera de salud |
| `GET` | `/v1/models` | Modelos visibles para la cuenta de Cursor |
| `POST` | `/v1/chat/completions` | Compatibilidad con OpenAI Chat Completions |
| `POST` | `/v1/responses` | Compatibilidad con OpenAI Responses |
| `POST` | `/v1/messages` | Compatibilidad con Anthropic Messages |
| `POST` | `/v1/batches` | Batch asíncrono |
| `GET` | `/v1/runtime/status` | Estado de scheduler / pools / Tools |
| `GET` | `/metrics` | Métricas Prometheus |
| `GET` | `/` | Dashboard local |
| `GET` | `/docs` | Guía de operaciones renderizada |

Endpoint predeterminado: `http://127.0.0.1:8787`.

## Otras formas de ejecución

AsterMux también admite Docker Compose, ejecución desde código fuente con Node.js 22.12+ y servicio en segundo plano / controlador de barra de menús para macOS.

Documentación completa:

- [Running AsterMux](docs/RUNNING.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Configuration](docs/CONFIGURATION.md)
- [Operations](docs/OPERATIONS.md)
- [Security](SECURITY.md)

## Seguridad

- Mantén el bind en `127.0.0.1` salvo que necesites acceso remoto.
- Configura `ASTERMUX_API_KEY` antes de exponer la API fuera del host.
- No subas `CURSOR_API_KEY`, `.env`, directorios de cuenta ni archivos de migración a Git.
- El acceso a un workspace real debe tratarse como capacidad de ejecución del Agent y habilitarse explícitamente.

## Licencia

AsterMux es código abierto bajo la [licencia MIT](LICENSE).
