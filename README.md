# Image Generation API

统一图片生成 API 服务，支持多个服务商，提供 Web 界面和 REST API。

## 支持服务商

| 提供商 | 模型 | 默认模型 | 参考图 |
|--------|------|----------|--------|
| PackyAPI (OpenAI) | gpt-image-2 | ✅ 默认 | ✅ |
| Google Gemini | gemini-2.0-flash-preview, gemini-3.5-flash | ❌ | ❌ |
| MiniMax | image-01 | ❌ | ✅ |

## 快速开始

### 1. 安装依赖

```bash
pip install -r requirements.txt
```

### 2. 配置环境变量

复制 `.env.example` 为 `.env`，填入你的 API Key：

```bash
cp .env.example .env
```

编辑 `.env`，填入以下至少一个服务商密钥：

```env
# PackyAPI（默认推荐）
PACKY_API_KEY=your_packy_api_key
PACKY_BASE_URL=https://api.packy.workers.ai/v1

# Gemini
GEMINI_API_KEY=your_gemini_api_key

# MiniMax
MINIMAX_API_KEY=your_minimax_api_key
```

### 3. 启动服务

```bash
cd image_api
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

### 4. 打开 Web 界面

浏览器访问：http://localhost:8000

- `/` — 生成界面
- `/gallery` — 图片画廊
- `/logs` — 日志查看

## API 文档

启动后访问：
- Swagger UI: http://localhost:8000/docs
- ReDoc: http://localhost:8000/redoc

### 生成图片

```bash
curl -X POST http://localhost:8000/api/v1/generate \
  -H "Content-Type: application/json" \
  -d '{
    "model": "packy",
    "prompt": "一只可爱的猫咪",
    "size": "1024x1024",
    "n": 1
  }'
```

### 使用参考图（仅 packy）

```bash
curl -X POST http://localhost:8000/api/v1/generate \
  -H "Content-Type: application/json" \
  -d '{
    "model": "packy",
    "prompt": "换成一只狗",
    "image_url": "https://example.com/cat.jpg",
    "size": "1024x1024"
  }'
```

### 查询任务状态

```bash
curl http://localhost:8000/api/v1/task/{task_id}
```

### 删除图片

```bash
# 单个删除
curl -X DELETE http://localhost:8000/api/v1/images/{image_id}

# 批量删除
curl -X POST http://localhost:8000/api/v1/images/batch-delete \
  -H "Content-Type: application/json" \
  -d '{"image_ids": ["id1", "id2", "id3"]}'
```

## 项目结构

```
image-api/
├── image_api/
│   ├── main.py              # FastAPI 入口
│   ├── config.py            # 配置管理
│   └── api/
│       └── router.py        # API 路由
│   └── services/
│       ├── openai_img.py    # PackyAPI 图片生成
│       ├── gemini_img.py    # Gemini 图片生成
│       ├── minimax_img.py   # MiniMax 图片生成
│       ├── gallery.py       # 图片库持久化
│       ├── tasks.py         # 异步任务队列
│       └── log_helper.py    # 日志系统
├── frontend/
│   ├── index.html           # 生成界面
│   ├── gallery.html         # 画廊页面
│   └── logs.html            # 日志页面
├── test_refs/               # 测试参考图
└── requirements.txt
```

## 技术栈

- FastAPI + Uvicorn
- httpx（异步 HTTP 客户端）
- python-multipart（文件上传）
- python-dotenv（环境变量）