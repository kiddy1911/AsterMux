# AsterMux

**Idiomas:** [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · **Português (Brasil)** · [Русский](README.ru.md) · [Tiếng Việt](README.vi.md)

**Gateway adaptativo e independente de modelo para Cursor ACP.**

AsterMux expõe os modelos disponíveis em uma conta Cursor por meio de interfaces HTTP compatíveis com OpenAI e Anthropic, mantendo os processos do Cursor Agent aquecidos, limitados e reutilizáveis. Ele foi projetado tanto para gateways de alto throughput quanto para VPS pequenos: você pode manter todos os workers prontos para reduzir a latência ou diminuir até um warm floor configurável para economizar memória em repouso.

AsterMux é um projeto comunitário independente e open source. Cursor é o runtime upstream, não a identidade do produto.

> Esta é uma introdução localizada e resumida. Para a documentação técnica completa e atualizada, consulte o [README em inglês](README.md).

## Principais recursos

- **Universal Model Pool** — os workers ACP não ficam presos a um modelo específico; Grok, GPT, Gemini, Claude, Composer e futuros modelos do Cursor compartilham os mesmos pools otimizados.
- **APIs compatíveis com OpenAI e Anthropic** — OpenAI Chat Completions, OpenAI Responses e Anthropic Messages.
- **Streaming e ferramentas** — respostas em streaming e conversão de function tools OpenAI/Anthropic em servidores MCP temporários.
- **Dual-lane scheduler** — separa tráfego interativo de workloads batch / structured output.
- **Workers ACP elásticos** — `*_POOL_SIZE` define o teto e `*_WARM_SIZE` controla quantos workers permanecem residentes quando ociosos.
- **Batch e structured output** — jobs assíncronos persistentes, validação de schema e repair controlado.
- **Observabilidade** — status do runtime, métricas Prometheus, tempo de fila, tempo de execução, contagem de workers e dashboard local.

## Modelos e conta Cursor

AsterMux não mantém uma whitelist fixa de modelos. `GET /v1/models` retorna os modelos realmente visíveis para a conta Cursor configurada.

Dependendo da conta e do serviço upstream, podem aparecer famílias GPT, Claude, Gemini, Grok, Composer, Kimi e GLM, incluindo variantes reasoning / thinking / fast. Disponibilidade, cotas e limites são determinados pelo Cursor e pelo provedor upstream.

Verifique os modelos visíveis no Cursor Agent:

```bash
agent --list-models
```

## Início rápido com Docker

A imagem Docker já inclui o Cursor Agent, portanto não é necessário instalá-lo separadamente no servidor.

Crie um arquivo de ambiente privado:

```bash
cat > .env <<'EOF'
CURSOR_API_KEY=replace-with-your-cursor-key
ASTERMUX_API_KEY=replace-with-your-own-gateway-key
EOF
chmod 600 .env
```

Inicie o AsterMux:

```bash
docker run -d \
  --name astermux \
  --restart unless-stopped \
  --env-file .env \
  -p 127.0.0.1:8787:8787 \
  ghcr.io/kiddy1911/astermux:latest
```

Verifique a saúde:

```bash
curl http://127.0.0.1:8787/healthz
```

Em produção, prefira fixar uma tag de release específica em vez de usar `latest` permanentemente.

## Primeira requisição

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_ASTERMUX_KEY' \
  -d '{
    "model": "cursor-grok-4.6-high",
    "messages": [{"role":"user","content":"Reply exactly OK"}]
  }'
```

Se `ASTERMUX_API_KEY` não estiver definido, o header Authorization não é obrigatório. Não exponha um gateway sem autenticação a uma rede não confiável.

## API

| Método | Caminho | Uso |
|---|---|---|
| `GET` | `/healthz` | Verificação leve de saúde |
| `GET` | `/v1/models` | Modelos visíveis para a conta Cursor |
| `POST` | `/v1/chat/completions` | Compatibilidade com OpenAI Chat Completions |
| `POST` | `/v1/responses` | Compatibilidade com OpenAI Responses |
| `POST` | `/v1/messages` | Compatibilidade com Anthropic Messages |
| `POST` | `/v1/batches` | Batch assíncrono |
| `GET` | `/v1/runtime/status` | Estado de scheduler / pools / Tools |
| `GET` | `/metrics` | Métricas Prometheus |
| `GET` | `/` | Dashboard local |
| `GET` | `/docs` | Guia de operações renderizado |

Endpoint padrão: `http://127.0.0.1:8787`.

## Outras formas de execução

AsterMux também suporta Docker Compose, execução a partir do código-fonte com Node.js 22.12+ e serviço em segundo plano / controlador de barra de menus no macOS.

Documentação completa:

- [Running AsterMux](docs/RUNNING.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Configuration](docs/CONFIGURATION.md)
- [Operations](docs/OPERATIONS.md)
- [Security](SECURITY.md)

## Segurança

- Mantenha o bind em `127.0.0.1` a menos que o acesso remoto seja intencional.
- Configure `ASTERMUX_API_KEY` antes de expor a API fora do host.
- Não envie `CURSOR_API_KEY`, `.env`, diretórios de conta ou arquivos de migração para o Git.
- O acesso a um workspace real deve ser tratado como capacidade de execução do Agent e habilitado explicitamente.

## Licença

AsterMux é open source sob a [licença MIT](LICENSE).
