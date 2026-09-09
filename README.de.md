# AsterMux

**Sprachen:** [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [Français](README.fr.md) · **Deutsch** · [日本語](README.ja.md) · [한국어](README.ko.md) · [Português (Brasil)](README.pt-BR.md) · [Русский](README.ru.md) · [Tiếng Việt](README.vi.md)

**Adaptives, modellunabhängiges Gateway für Cursor ACP.**

AsterMux stellt die für ein Cursor-Konto verfügbaren Modelle über vertraute OpenAI- und Anthropic-kompatible HTTP-Schnittstellen bereit und hält dabei die aufwendigen Cursor-Agent-Prozesse warm, begrenzt und wiederverwendbar. Es eignet sich sowohl für Gateways mit hohem Durchsatz als auch für kleine VPS: Worker können vollständig warm gehalten werden, um die Latenz zu minimieren, oder auf ein konfigurierbares Warm-Minimum schrumpfen, um Leerlaufspeicher zu sparen.

AsterMux ist ein unabhängiges Community- und Open-Source-Projekt. Cursor ist die vorgelagerte Runtime, nicht die Produktidentität.

> Dies ist eine kompakte lokalisierte Einführung. Die vollständige und aktuelle technische Dokumentation befindet sich im [englischen README](README.md).

## Hauptfunktionen

- **Universal Model Pool** — ACP-Worker sind nicht an ein bestimmtes Modell gebunden; Grok, GPT, Gemini, Claude, Composer und zukünftige Cursor-Modelle teilen dieselben optimierten Pools.
- **OpenAI-/Anthropic-kompatible APIs** — OpenAI Chat Completions, OpenAI Responses und Anthropic Messages.
- **Streaming und Tools** — Streaming-Antworten sowie Übersetzung von OpenAI/Anthropic Function Tools in temporäre MCP-Server.
- **Dual-Lane-Scheduler** — trennt interaktiven Traffic von Batch- und Structured-Output-Workloads.
- **Elastische ACP-Worker** — `*_POOL_SIZE` definiert das Maximum, `*_WARM_SIZE` die Anzahl dauerhaft warmer Worker.
- **Batch und Structured Output** — persistente asynchrone Jobs, Schema-Validierung und begrenzte Reparatur.
- **Observability** — Runtime-Status, Prometheus-Metriken, Queue-Wartezeit, Ausführungszeit, Worker-Zahlen und lokales Dashboard.

## Modelle und Cursor-Konto

AsterMux verwendet keine fest codierte Modell-Whitelist. `GET /v1/models` liefert die Modelle, die für das konfigurierte Cursor-Konto tatsächlich sichtbar sind.

Je nach Konto und Upstream können GPT-, Claude-, Gemini-, Grok-, Composer-, Kimi- und GLM-Familien sowie reasoning / thinking / fast-Varianten verfügbar sein. Verfügbarkeit, Kontingente und Limits werden von Cursor und dem jeweiligen Upstream bestimmt.

Sichtbare Modelle im Cursor Agent prüfen:

```bash
agent --list-models
```

## Schnellstart mit Docker

Das Docker-Image enthält den Cursor Agent bereits; auf dem Server ist keine zusätzliche lokale Agent-Installation nötig.

Private Umgebungsdatei erstellen:

```bash
cat > .env <<'EOF'
CURSOR_API_KEY=replace-with-your-cursor-key
ASTERMUX_API_KEY=replace-with-your-own-gateway-key
EOF
chmod 600 .env
```

AsterMux starten:

```bash
docker run -d \
  --name astermux \
  --restart unless-stopped \
  --env-file .env \
  -p 127.0.0.1:8787:8787 \
  ghcr.io/kiddy1911/astermux:latest
```

Health Check:

```bash
curl http://127.0.0.1:8787/healthz
```

Für Produktion sollte ein konkretes Release-Tag statt dauerhaft `latest` verwendet werden.

## Erste Anfrage

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_ASTERMUX_KEY' \
  -d '{
    "model": "cursor-grok-4.6-high",
    "messages": [{"role":"user","content":"Reply exactly OK"}]
  }'
```

Wenn `ASTERMUX_API_KEY` nicht gesetzt ist, ist der Authorization-Header nicht erforderlich. Ein nicht authentifiziertes Gateway sollte niemals einem nicht vertrauenswürdigen Netzwerk ausgesetzt werden.

## API

| Methode | Pfad | Zweck |
|---|---|---|
| `GET` | `/healthz` | Leichter Health Check |
| `GET` | `/v1/models` | Für das Cursor-Konto sichtbare Modelle |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions kompatibel |
| `POST` | `/v1/responses` | OpenAI Responses kompatibel |
| `POST` | `/v1/messages` | Anthropic Messages kompatibel |
| `POST` | `/v1/batches` | Asynchrone Batch-Jobs |
| `GET` | `/v1/runtime/status` | Scheduler-/Pool-/Tool-Status |
| `GET` | `/metrics` | Prometheus-Metriken |
| `GET` | `/` | Lokales Dashboard |
| `GET` | `/docs` | Gerenderte Betriebsdokumentation |

Standard-Endpunkt: `http://127.0.0.1:8787`.

## Weitere Betriebsarten

AsterMux unterstützt außerdem Docker Compose, den Betrieb aus dem Quellcode mit Node.js 22.12+ sowie einen macOS-Hintergrunddienst / Menüleisten-Controller.

Vollständige Dokumentation:

- [Running AsterMux](docs/RUNNING.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Configuration](docs/CONFIGURATION.md)
- [Operations](docs/OPERATIONS.md)
- [Security](SECURITY.md)

## Sicherheit

- Standardmäßig nur an `127.0.0.1` binden.
- Vor externem Zugriff `ASTERMUX_API_KEY` setzen.
- `CURSOR_API_KEY`, `.env`, Account-Verzeichnisse und Migrationsarchive niemals in Git einchecken.
- Zugriff auf echte Workspaces sollte als Agent-Ausführungsfähigkeit behandelt und bewusst aktiviert werden.

## Lizenz

AsterMux ist unter der [MIT-Lizenz](LICENSE) Open Source.
