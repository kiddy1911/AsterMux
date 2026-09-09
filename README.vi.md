# AsterMux

**Ngôn ngữ:** [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Português (Brasil)](README.pt-BR.md) · [Русский](README.ru.md) · **Tiếng Việt**

**Gateway thích ứng, không phụ thuộc mô hình cho Cursor ACP.**

AsterMux cung cấp các mô hình khả dụng trong tài khoản Cursor thông qua các giao diện HTTP quen thuộc tương thích với OpenAI và Anthropic, đồng thời giữ các tiến trình Cursor Agent ở trạng thái warm, có giới hạn và có thể tái sử dụng. Dự án phù hợp cả với gateway thông lượng cao lẫn VPS nhỏ: có thể giữ toàn bộ worker luôn sẵn sàng để giảm độ trễ, hoặc thu hẹp xuống warm floor có thể cấu hình để giảm bộ nhớ khi nhàn rỗi.

AsterMux là một dự án cộng đồng mã nguồn mở độc lập. Cursor là runtime upstream, không phải danh tính sản phẩm của AsterMux.

> Đây là trang giới thiệu tiếng Việt rút gọn. Tài liệu kỹ thuật đầy đủ và cập nhật nhất nằm trong [README tiếng Anh](README.md).

## Tính năng chính

- **Universal Model Pool** — ACP worker không bị gắn cố định với một mô hình; Grok, GPT, Gemini, Claude, Composer và các mô hình Cursor trong tương lai dùng chung các pool đã được tối ưu.
- **API tương thích OpenAI / Anthropic** — hỗ trợ OpenAI Chat Completions, OpenAI Responses và Anthropic Messages.
- **Streaming và Tool Calling** — hỗ trợ phản hồi streaming và chuyển function tools của OpenAI/Anthropic thành MCP server tạm thời.
- **Dual-lane scheduler** — tách lưu lượng tương tác khỏi workload batch / structured output.
- **ACP worker co giãn** — `*_POOL_SIZE` xác định mức tối đa, còn `*_WARM_SIZE` điều khiển số worker được giữ thường trú khi rảnh.
- **Batch và structured output** — hỗ trợ job bất đồng bộ bền vững, kiểm tra schema và repair có giới hạn.
- **Khả năng quan sát** — runtime status, Prometheus metrics, thời gian chờ queue, thời gian thực thi, số worker và Dashboard cục bộ.

## Mô hình và tài khoản Cursor

AsterMux không duy trì whitelist mô hình cố định. `GET /v1/models` trả về các mô hình thực sự hiển thị cho tài khoản Cursor đã cấu hình.

Tùy theo tài khoản và dịch vụ upstream, có thể có các họ GPT, Claude, Gemini, Grok, Composer, Kimi và GLM cùng các biến thể reasoning / thinking / fast. Tính khả dụng, quota và giới hạn do Cursor và nhà cung cấp upstream quyết định.

Kiểm tra các mô hình mà Cursor Agent nhìn thấy:

```bash
agent --list-models
```

## Bắt đầu nhanh với Docker

Docker image đã bao gồm Cursor Agent, vì vậy không cần cài Agent riêng trên máy chủ.

Tạo file môi trường riêng tư:

```bash
cat > .env <<'EOF'
CURSOR_API_KEY=replace-with-your-cursor-key
ASTERMUX_API_KEY=replace-with-your-own-gateway-key
EOF
chmod 600 .env
```

Khởi động AsterMux:

```bash
docker run -d \
  --name astermux \
  --restart unless-stopped \
  --env-file .env \
  -p 127.0.0.1:8787:8787 \
  ghcr.io/kiddy1911/astermux:latest
```

Kiểm tra health:

```bash
curl http://127.0.0.1:8787/healthz
```

Trong production, nên cố định một release tag cụ thể thay vì dùng `latest` lâu dài.

## Yêu cầu đầu tiên

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_ASTERMUX_KEY' \
  -d '{
    "model": "cursor-grok-4.6-high",
    "messages": [{"role":"user","content":"Reply exactly OK"}]
  }'
```

Nếu chưa đặt `ASTERMUX_API_KEY`, header Authorization không bắt buộc. Không nên đưa một gateway không có xác thực ra mạng không đáng tin cậy.

## API

| Phương thức | Đường dẫn | Mục đích |
|---|---|---|
| `GET` | `/healthz` | Kiểm tra sức khỏe nhẹ |
| `GET` | `/v1/models` | Các mô hình hiển thị cho tài khoản Cursor |
| `POST` | `/v1/chat/completions` | Tương thích OpenAI Chat Completions |
| `POST` | `/v1/responses` | Tương thích OpenAI Responses |
| `POST` | `/v1/messages` | Tương thích Anthropic Messages |
| `POST` | `/v1/batches` | Batch bất đồng bộ |
| `GET` | `/v1/runtime/status` | Trạng thái scheduler / pool / Tool |
| `GET` | `/metrics` | Prometheus metrics |
| `GET` | `/` | Dashboard cục bộ |
| `GET` | `/docs` | Hướng dẫn vận hành đã render |

Endpoint mặc định: `http://127.0.0.1:8787`.

## Các cách chạy khác

AsterMux cũng hỗ trợ Docker Compose, chạy từ mã nguồn với Node.js 22.12+ và dịch vụ nền / bộ điều khiển menu bar cho macOS.

Tài liệu đầy đủ:

- [Running AsterMux](docs/RUNNING.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Configuration](docs/CONFIGURATION.md)
- [Operations](docs/OPERATIONS.md)
- [Security](SECURITY.md)

## Bảo mật

- Mặc định chỉ bind vào `127.0.0.1` trừ khi bạn chủ động cần truy cập từ xa.
- Đặt `ASTERMUX_API_KEY` trước khi mở API ra ngoài host.
- Không commit `CURSOR_API_KEY`, `.env`, thư mục tài khoản hoặc archive migration lên Git.
- Truy cập workspace thật cần được xem như quyền thực thi của Agent và chỉ bật khi thực sự cần.

## Giấy phép

AsterMux là mã nguồn mở theo [MIT License](LICENSE).
