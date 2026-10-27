# Image Generation API

统一图片生成服务（FastAPI）：Web 界面 + REST API，底层聚合 open-hk、PackyAPI、Gemini、MiniMax。

本仓库当前部署在 NAS 上，对外端口是 **8080**（不是 8000；8000 是飞牛管理页）。局域网访问：`http://<NAS_IP>:8080`。

更完整的接入说明（异步轮询、字段、给 Codex 用的示例）见 [CODEX_INTEGRATION.md](CODEX_INTEGRATION.md)。

## 支持的模型

| 提供商 | `model` | `sub_model` | 参考图 | 备注 |
|--------|---------|-------------|--------|------|
| GPT 自动路由 | `auto`（默认） | `gpt-image-2.5-flare`（默认）/ `gpt-image-2.5-sunburst` / `gpt-image-2.5` | ✅ 多图 | 见下方路由规则 |
| open-hk | `openai` | 同上 | ✅ 多图 | 强制 openai-hk，失败不转 packy |
| PackyAPI | `packy` | `gpt-image-2.5-flare` / `gpt-image-2.5-sunburst` | ✅ 多图（`image[]`） | 强制 packy，按量计费 |
| Gemini | `gemini` | `gemini-3.1-flash-image-preview` / `-2k` / `-4k` | ✅ | 经 open-hk 兼容接口 |
| MiniMax | `minimax` | `image-01` | ✅ 单图 | `size` 映射为宽高比 |

- 前端 GPT 系列只展示模型名，请求里 `model` 固定为 `auto`。
- `gpt-image-2` 已下线，传入会映射到 `gpt-image-2.5-flare`。
- 2.5 只发**基础名**（不要自己拼 `-2k`/`-4k`）。服务商按 `size` 分流内部渠道；显式后缀在 openai-hk 上可能变成 `flare-4k-4k` 并 503。

## GPT `model=auto` 路由

当前默认 **`size_split`**（`GET /api/v1/gpt-route` 可查）：

| 请求长边 | 走哪 | 费用 |
|----------|------|------|
| ≤ 1920（约 1K） | openai-hk | 约 0.08 元/张 |
| `size=auto` 且无参考图 | openai-hk | 文生图，约 1024；返回略小也认 |
| > 1920（2K / 4K / 超宽） | Packy | 按量，贵 |

不要为了 2K/4K 走 openai-hk：它所谓 4K 是假象，实测约 **1.57MP**（例如 3808×1632 → 1916×821）。超宽图像素卡在 1.57MP 时，长边仍可能 **>1920**（例如 2272×752），所以监测不能只看长边。

可选模式 `openai_first`（**不是默认**，不要轻易开）：先 openai-hk，API 失败再同请求走 packy。若请求 >1K 但返回长边 ≤1920 **或** 像素 ≤1.7MP，连续 5 次会自动切回 `size_split`。

显式 `openai` / `packy` 仍强制该提供商，不做这套分流。

## 快速开始

### 1. 安装依赖

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

至少配置一个服务商。常用项：

```env
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai-hk.com/v1

PACKY_API_KEY=sk-...
# 实际 URL 以 .env 为准（packyapi.com / packyapi.ai / cf.api.fan 都识别为 Packy）
PACKY_BASE_URL=https://www.packyapi.com/v1
PACKY_PROXY=          # 可选

GEMINI_API_KEY=
MINIMAX_API_KEY=
MINIMAX_BASE_URL=https://api.minimaxi.com

PROMPT_PORTAL_URL=http://127.0.0.1:8768
```

`api.openai-hk.com` 与 Packy 国内中继 `cf.api.fan` 应直连，不要走代理链。

### 3. 启动

本仓库 systemd 用户服务（生产）：

```bash
systemctl --user restart image-api.service
systemctl --user status image-api.service
```

本地调试（必须 8080，且从仓库根目录启动）：

```bash
PYTHONPATH=. venv/bin/python -m uvicorn image_api.main:app --host 0.0.0.0 --port 8080
```

健康检查：`GET /health` → `{"status":"healthy"}`。

### 4. Web 界面

- `/` 生成页
- `/gallery` 图库
- `/logs` 日志
- `/docs` Swagger
- `/redoc` ReDoc

前端费用栏 `#hintBar` 以 `GET /api/v1/gpt-route` 为准，不要写死「大小同价」或「1K 以上 0.18」。

改布局请先在 `sketches/`（本机 8099）做原型，再动正式页。

## API 要点

统一前缀 `/api/v1`。**异步任务**：`POST /generate` 立刻返回 `task_id`（`images` 恒为空），结果靠轮询 `GET /tasks/{task_id}`。

```bash
# 提交
curl -s http://127.0.0.1:8080/api/v1/generate \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "auto",
    "sub_model": "gpt-image-2.5-flare",
    "prompt": "一只戴着红色围巾的柴犬，冬日雪景",
    "size": "1024x1024",
    "n": 1,
    "quality": "medium"
  }'
# → {"task_id":"...","images":[]}

# 轮询（pending → running → completed / failed）
curl -s http://127.0.0.1:8080/api/v1/tasks/<task_id>
```

图生图（参考图 base64 **不要**带 `data:` 前缀）：

```bash
curl -s http://127.0.0.1:8080/api/v1/generate \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "auto",
    "sub_model": "gpt-image-2.5-flare",
    "prompt": "换成一只狗",
    "image_base64": "<纯base64>",
    "size": "1024x1024"
  }'
```

其它接口：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/gpt-route` | 当前 GPT 路由模式与费用文案 |
| GET | `/api/v1/gallery` | 图库列表（`limit`≤200） |
| GET/DELETE | `/api/v1/gallery/{id}` | 单条 |
| POST | `/api/v1/gallery/batch-delete` | `{"ids":["..."]}` |
| GET | `/api/v1/logs` | 应用日志 |
| POST | `/api/v1/logs/clear` | 清空日志 |
| POST | `/api/v1/optimize-prompt` | 转发 prompt-portal |
| GET | `/gallery/{filename}` | 原图 |
| GET | `/gallery/thumb/{filename}` | 缩略图 |

内网无鉴权。返回的 `base64` 是纯数据，写文件前自行 `b64decode`。

## 尺寸与参考图

服务端会自动把尺寸收进合规范围，客户端可传任意 `宽x高` 或 `auto`（按参考图）：

- 长边 512–3840；两边为 16 的倍数
- 总像素 655,360–8,294,400
- 长宽比 ≤ 3:1
- 图生图：保持参考图宽高比，按请求 `size` 的**宽度**等比缩放
- 多参考图时第一张决定输出尺寸；MiniMax / Gemini 原生端点只用第一张
- 图生图走 `/v1/images/edits`；Packy 2.5 与 open-hk 多参考图字段都是 `image[]`（不要重复 `image=`）

`quality` 仅 GPT 2.5：`low` / `medium`（默认）/ `high`。

## 项目结构

```
image-api/
├── image_api/
│   ├── main.py                 # FastAPI 入口（页面 + /health）
│   ├── config.py               # .env
│   ├── api/router.py           # /api/v1
│   └── services/
│       ├── openai_img.py       # open-hk / Packy 兼容客户端
│       ├── gpt_route.py        # auto 分流 + 不足 1K 监测
│       ├── gemini_img.py
│       ├── minimax_img.py
│       ├── gallery.py
│       ├── tasks.py
│       └── log_helper.py
├── frontend/                   # index / gallery / logs
├── tests/test_gpt_route.py
├── sketches/                   # 布局原型，不进正式页
├── CODEX_INTEGRATION.md
└── requirements.txt
```

图库目录：`/vol1/1000/note/memory/AI生成图片/`。路由状态：`data/gpt_route_state.json`（已 gitignore）。

## 运维

```bash
systemctl --user restart image-api.service
tail -30 /tmp/image-api.log          # 结构化 JSON；不要用 journalctl
```

大图可能要数分钟（上限约 900 秒）。失败时看任务的 `error` / `raw_response`。

常见误判：

- TLS EOF / 连接被关 → 域名被代理链带走，应直连
- HTTP 502/504 → 请求已到达对端，是上游超时/挂了
- 403 `This token has no access to model X` → openai-hk 的 `/v1/models` 会列出未授权模型，去控制台给 key 勾选

## 技术栈

FastAPI + Uvicorn、httpx、Pillow、python-multipart、pydantic-settings。
