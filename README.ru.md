# AsterMux

**Языки:** [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Português (Brasil)](README.pt-BR.md) · **Русский** · [Tiếng Việt](README.vi.md)

**Адаптивный, независимый от модели gateway для Cursor ACP.**

AsterMux предоставляет модели, доступные в аккаунте Cursor, через привычные HTTP-интерфейсы, совместимые с OpenAI и Anthropic, при этом поддерживая процессы Cursor Agent прогретыми, ограниченными по количеству и переиспользуемыми. Проект рассчитан как на высоконагруженные gateway-сценарии, так и на небольшие VPS: можно держать все workers прогретыми для минимальной задержки либо уменьшать их до настраиваемого warm floor для снижения потребления памяти в простое.

AsterMux — независимый open-source проект сообщества. Cursor является upstream runtime, а не продуктовой идентичностью AsterMux.

> Это краткая локализованная страница. Полная и актуальная техническая документация находится в [английском README](README.md).

## Основные возможности

- **Universal Model Pool** — ACP workers не привязаны к конкретной модели; Grok, GPT, Gemini, Claude, Composer и будущие модели Cursor используют одни и те же оптимизированные pools.
- **Совместимые API OpenAI и Anthropic** — OpenAI Chat Completions, OpenAI Responses и Anthropic Messages.
- **Streaming и tools** — потоковые ответы и преобразование OpenAI/Anthropic function tools во временные MCP-серверы.
- **Dual-lane scheduler** — разделяет интерактивный трафик и batch / structured-output нагрузки.
- **Эластичные ACP workers** — `*_POOL_SIZE` задаёт максимум, а `*_WARM_SIZE` определяет число workers, остающихся прогретыми в простое.
- **Batch и structured output** — постоянные асинхронные задания, проверка schema и ограниченный repair.
- **Наблюдаемость** — runtime status, Prometheus metrics, время ожидания в очереди, время выполнения, количество workers и локальный Dashboard.

## Модели и аккаунт Cursor

AsterMux не использует фиксированный whitelist моделей. `GET /v1/models` возвращает модели, которые реально видны настроенному аккаунту Cursor.

В зависимости от аккаунта и upstream-сервиса могут быть доступны семейства GPT, Claude, Gemini, Grok, Composer, Kimi и GLM, включая варианты reasoning / thinking / fast. Доступность моделей, квоты и ограничения определяются Cursor и upstream-провайдером.

Проверить модели, видимые Cursor Agent:

```bash
agent --list-models
```

## Быстрый запуск через Docker

Docker-образ уже содержит Cursor Agent, поэтому отдельная установка Agent на сервере не требуется.

Создайте приватный файл окружения:

```bash
cat > .env <<'EOF'
CURSOR_API_KEY=replace-with-your-cursor-key
ASTERMUX_API_KEY=replace-with-your-own-gateway-key
EOF
chmod 600 .env
```

Запустите AsterMux:

```bash
docker run -d \
  --name astermux \
  --restart unless-stopped \
  --env-file .env \
  -p 127.0.0.1:8787:8787 \
  ghcr.io/kiddy1911/astermux:latest
```

Проверка состояния:

```bash
curl http://127.0.0.1:8787/healthz
```

Для production рекомендуется закреплять конкретный release tag вместо постоянного использования `latest`.

## Первый запрос

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_ASTERMUX_KEY' \
  -d '{
    "model": "cursor-grok-4.6-high",
    "messages": [{"role":"user","content":"Reply exactly OK"}]
  }'
```

Если `ASTERMUX_API_KEY` не задан, header Authorization не требуется. Не публикуйте неаутентифицированный gateway в недоверенной сети.

## API

| Метод | Путь | Назначение |
|---|---|---|
| `GET` | `/healthz` | Лёгкая проверка здоровья |
| `GET` | `/v1/models` | Модели, видимые аккаунту Cursor |
| `POST` | `/v1/chat/completions` | Совместимость с OpenAI Chat Completions |
| `POST` | `/v1/responses` | Совместимость с OpenAI Responses |
| `POST` | `/v1/messages` | Совместимость с Anthropic Messages |
| `POST` | `/v1/batches` | Асинхронный batch |
| `GET` | `/v1/runtime/status` | Состояние scheduler / pools / Tools |
| `GET` | `/metrics` | Prometheus metrics |
| `GET` | `/` | Локальный Dashboard |
| `GET` | `/docs` | Отрендеренная эксплуатационная документация |

Адрес по умолчанию: `http://127.0.0.1:8787`.

## Другие способы запуска

AsterMux также поддерживает Docker Compose, запуск из исходников на Node.js 22.12+ и фоновый сервис / контроллер строки меню для macOS.

Полная документация:

- [Running AsterMux](docs/RUNNING.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Configuration](docs/CONFIGURATION.md)
- [Operations](docs/OPERATIONS.md)
- [Security](SECURITY.md)

## Безопасность

- По умолчанию привязывайте сервис только к `127.0.0.1`.
- Перед внешним доступом задайте `ASTERMUX_API_KEY`.
- Не коммитьте `CURSOR_API_KEY`, `.env`, каталоги аккаунта и архивы миграции в Git.
- Доступ к реальному workspace следует считать возможностью выполнения Agent и включать только явно.

## Лицензия

AsterMux распространяется как open source по [лицензии MIT](LICENSE).
