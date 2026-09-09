# AsterMux

**言語:** [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · **日本語** · [한국어](README.ko.md) · [Português (Brasil)](README.pt-BR.md) · [Русский](README.ru.md) · [Tiếng Việt](README.vi.md)

**Cursor ACP 向けの適応型・モデル非依存ゲートウェイ。**

AsterMux は、Cursor アカウントで利用可能なモデルを OpenAI / Anthropic 互換の HTTP API として公開しながら、コストの高い Cursor Agent プロセスを warm 状態で維持し、上限付きで再利用します。高スループットのゲートウェイから小規模 VPS まで対応し、低遅延を優先して worker を常時 warm にする構成と、アイドル時メモリを抑えるため warm floor まで縮退する構成の両方を利用できます。

AsterMux は独立したコミュニティ主導のオープンソースプロジェクトです。Cursor は上流ランタイムであり、AsterMux 自体の製品アイデンティティではありません。

> これは簡潔な日本語紹介ページです。完全かつ最新の技術ドキュメントは [英語版 README](README.md) を参照してください。

## 主な機能

- **Universal Model Pool** — ACP worker は特定モデルに固定されません。Grok、GPT、Gemini、Claude、Composer、および今後 Cursor が提供するモデルを同じ最適化済み pool で共有できます。
- **OpenAI / Anthropic 互換 API** — OpenAI Chat Completions、OpenAI Responses、Anthropic Messages に対応。
- **Streaming と Tool Calling** — ストリーミング応答に加え、OpenAI/Anthropic の function tools を一時 MCP サーバーへ変換できます。
- **Dual-lane scheduler** — 対話系トラフィックと batch / structured-output ワークロードを分離します。
- **Elastic ACP workers** — `*_POOL_SIZE` が最大 worker 数、`*_WARM_SIZE` がアイドル時に常駐する worker 数を制御します。
- **Batch / Structured Output** — 永続的な非同期 batch、schema 検証、上限付き repair に対応。
- **可観測性** — runtime status、Prometheus metrics、queue wait、execution time、worker 数、ローカル Dashboard を提供します。

## モデルと Cursor アカウント

AsterMux は固定のモデル whitelist を持ちません。`GET /v1/models` は、設定された Cursor アカウントから実際に見えるモデルを返します。

アカウントや上流サービスによって、GPT、Claude、Gemini、Grok、Composer、Kimi、GLM 系列や reasoning / thinking / fast バリアントが利用できます。利用可能モデル、クォータ、制限は Cursor および上流プロバイダーに依存します。

Cursor Agent から見えるモデルを確認するには:

```bash
agent --list-models
```

## Docker でクイックスタート

Docker イメージには Cursor Agent が含まれているため、サーバー側で追加インストールする必要はありません。

秘密情報を入れる環境ファイルを作成します:

```bash
cat > .env <<'EOF'
CURSOR_API_KEY=replace-with-your-cursor-key
ASTERMUX_API_KEY=replace-with-your-own-gateway-key
EOF
chmod 600 .env
```

AsterMux を起動します:

```bash
docker run -d \
  --name astermux \
  --restart unless-stopped \
  --env-file .env \
  -p 127.0.0.1:8787:8787 \
  ghcr.io/kiddy1911/astermux:latest
```

ヘルスチェック:

```bash
curl http://127.0.0.1:8787/healthz
```

本番環境では `latest` を固定利用するのではなく、特定の release tag を指定することを推奨します。

## 最初のリクエスト

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_ASTERMUX_KEY' \
  -d '{
    "model": "cursor-grok-4.6-high",
    "messages": [{"role":"user","content":"Reply exactly OK"}]
  }'
```

`ASTERMUX_API_KEY` が未設定の場合、Authorization header は必須ではありません。認証なしのゲートウェイを信頼できないネットワークへ公開しないでください。

## API

| メソッド | パス | 用途 |
|---|---|---|
| `GET` | `/healthz` | 軽量ヘルスチェック |
| `GET` | `/v1/models` | Cursor アカウントから見えるモデル一覧 |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions 互換 |
| `POST` | `/v1/responses` | OpenAI Responses 互換 |
| `POST` | `/v1/messages` | Anthropic Messages 互換 |
| `POST` | `/v1/batches` | 非同期 batch |
| `GET` | `/v1/runtime/status` | Scheduler / pool / Tool の状態 |
| `GET` | `/metrics` | Prometheus metrics |
| `GET` | `/` | ローカル Dashboard |
| `GET` | `/docs` | レンダリング済み運用ガイド |

デフォルト endpoint: `http://127.0.0.1:8787`

## その他の実行方法

AsterMux は Docker Compose、Node.js 22.12+ でのソース実行、macOS バックグラウンドサービス / メニューバーコントローラーにも対応しています。

完全なドキュメント:

- [Running AsterMux](docs/RUNNING.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Configuration](docs/CONFIGURATION.md)
- [Operations](docs/OPERATIONS.md)
- [Security](SECURITY.md)

## セキュリティ

- 意図的に外部公開する場合を除き、`127.0.0.1` に bind してください。
- ホスト外から API を利用する前に `ASTERMUX_API_KEY` を設定してください。
- `CURSOR_API_KEY`、`.env`、アカウントディレクトリ、移行アーカイブを Git にコミットしないでください。
- 実 workspace へのアクセスは Agent の実行権限として扱い、必要な場合のみ明示的に有効化してください。

## License

AsterMux は [MIT License](LICENSE) の下で公開されています。
