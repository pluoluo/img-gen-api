# Codex 接入 image-api 服务引导

> 本文档供 Codex（或任何 AI 编码代理）接入本机 image-api 图像生成服务使用。
> 服务提供统一的图像生成 API（文生图 / 图生图），底层聚合多个供应商：
> open-hk（OpenAI 兼容）、PackyAPI（gpt-image-2 / 2.5）、Gemini、MiniMax。

> **运行环境说明：本服务部署在 NAS（fnOS / Debian）上，Codex 运行在局域网内的 Windows 电脑上。**
> 所有 API 调用请使用局域网地址 `http://10.40.92.99:8080`；
> `127.0.0.1` 只用于 NAS 本机调试。服务管理（重启、日志）需在 NAS 上操作（SSH 登录）。

---

## 1. 服务基本信息

| 项目 | 值 |
|---|---|
| 服务名 | image-api（FastAPI + uvicorn） |
| **访问地址（Windows 上 Codex 使用）** | `http://10.40.92.99:8080`（**注意端口是 8080，不是 8000**；8000 是飞牛 NAS 管理界面） |
| 健康检查 | `GET http://10.40.92.99:8080/health` → `{"status":"healthy"}`（已验证可达） |
| 认证 | **无鉴权**。任何内网客户端可直接调用，无 API Key 要求（供应商 Key 由服务端持有） |
| CORS | 全开（`allow_origins=["*"]`） |
| 代码路径（NAS 上） | `/home/sahn/image-api/` |
| 运行方式（NAS 上） | systemd 用户服务：`systemctl --user restart image-api.service` |
| 前端页面 | `http://10.40.92.99:8080/`（生成页）、`/gallery`（图库）、`/logs`（日志） |

**Windows 上验证连通性：**
```bat
curl http://10.40.92.99:8080/health
```
返回 `{"status":"healthy"}` 即连通正常。

**API 统一前缀：`/api/v1`**

核心交互模型是 **异步任务**：
1. `POST /api/v1/generate` 提交生成请求，服务端**立即返回 `task_id`**（后台异步生成）；
2. 客户端**轮询** `GET /api/v1/tasks/{task_id}` 直到 `status == "completed"` 或 `"failed"`；
3. 生成通常耗时 30 秒 ~ 数分钟（4K 大图可达 900 秒），轮询间隔建议 2~5 秒。

---

## 2. 快速开始（文生图，curl）

```bash
# ① 提交任务（立即返回 task_id）
curl -s http://10.40.92.99:8080/api/v1/generate \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "openai",
    "sub_model": "gpt-image-2.5-flare",
    "prompt": "一只戴着红色围巾的柴犬，毛茸茸的，冬日雪景，写实风格",
    "size": "1024x1024",
    "n": 1,
    "quality": "medium"
  }'
# → {"task_id":"3f9a2c1e","images":[]}

# ② 轮询任务状态（复制上面的 task_id）
curl -s http://10.40.92.99:8080/api/v1/tasks/3f9a2c1e
# → {"task_id":"3f9a2c1e","status":"running","progress":10,"images":[],"error":null,...}
#   完成后：{"status":"completed","progress":100,
#     "images":[{"url":null,"base64":"<base64图片数据>","adjusted_size":"1024x1024"}]}
```

> Windows 的 cmd / PowerShell / Git Bash 均自带或可直接使用 curl，语法同上。

---

## 3. 接口参考

### 3.1 提交生成任务

```
POST /api/v1/generate
Content-Type: application/json
```

**请求字段：**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `model` | string | 否 | 供应商：`openai`（默认）/ `packy` / `gemini` / `minimax` |
| `sub_model` | string | 否 | 具体模型，见下方「模型矩阵」，默认 `gpt-image-2`。**2.5 系列只传基础名**（`gpt-image-2.5-flare` / `gpt-image-2.5-sunburst`），服务端/供应商网关按 `size` 自动分档 |
| `prompt` | string | **是** | 提示词 |
| `image_url` | string | 否 | 单张参考图 URL（图生图） |
| `image_base64` | string | 否 | 单张参考图 base64（**不含 `data:` 前缀**，纯 base64 字符串） |
| `image_urls` | array\<string\> | 否 | 多张参考图 URL |
| `image_base64s` | array\<string\> | 否 | 多张参考图 base64 |
| `size` | string | 否 | 输出尺寸，格式 `宽x高`，如 `1024x1024`、`1792x1024`；`auto` 表示按参考图原始尺寸。默认 `1024x1024` |
| `n` | int | 否 | 生成数量，默认 1 |
| `quality` | string | 否 | 质量档位，仅 gpt-image-2 与 2.5 系列支持：`low` / `medium`（默认）/ `high` |

**响应：**

```json
{ "task_id": "3f9a2c1e", "images": [] }
```

> 注意：`images` 恒为空数组，结果必须通过轮询 `GET /api/v1/tasks/{task_id}` 获取。

**参考图传参规则：**
- 列表字段（`image_urls` / `image_base64s`）优先，单数字段（`image_url` / `image_base64`）作为回退；
- URL 参考图由服务端自动下载并转 base64，客户端无需处理；
- 多参考图时**第一张图决定输出尺寸**，其余仅做像素校验；
- MiniMax 与 Gemini（原生端点）仅取第一张参考图。

### 3.2 查询任务状态（轮询）

```
GET /api/v1/tasks/{task_id}
```

**响应字段：**

| 字段 | 类型 | 说明 |
|---|---|---|
| `task_id` | string | 任务 ID |
| `status` | string | `pending` / `running` / `completed` / `failed` |
| `progress` | int | 0~100 |
| `images` | array | 完成后的图片结果，见下 |
| `error` | string\|null | 失败时的错误摘要（含堆栈） |
| `raw_response` | string\|null | 失败时供应商原始响应 |

**图片结果对象（`images[]`）：**

| 字段 | 类型 | 说明 |
|---|---|---|
| `url` | string\|null | 图片 URL（供应商返回 URL 时存在） |
| `base64` | string\|null | **纯 base64 图片数据（无 `data:` 前缀）**，需自行加 `data:image/png;base64,` 前缀解码 |
| `adjusted_size` | string\|null | 服务端实际使用的输出尺寸（经过合规调整后，如 `1024x1024`） |

> 服务端会把供应商返回的 URL 下载后转成 base64，因此正常情况下 `base64` 字段非空；下载失败时降级为仅 `url`。

### 3.3 图库接口

生成成功的图片会自动保存到图库（SQLite + 本地文件）：

```
GET    /api/v1/gallery?limit=50&offset=0      # 列表（limit ≤ 200）
GET    /api/v1/gallery/{record_id}            # 单条详情
DELETE /api/v1/gallery/{record_id}            # 删除单条
POST   /api/v1/gallery/batch-delete           # 批量删除，body: {"ids": ["id1","id2"]}
```

图库文件访问（非 /api/v1 前缀，FastAPI 根路径直接服务）：
```
GET /gallery/{filename}        # 原图（PNG）
GET /gallery/thumb/{filename}  # 缩略图
```
存储目录：`/vol1/1000/note/memory/AI生成图片/`。

### 3.4 日志接口

```
GET  /api/v1/logs?limit=200&offset=0&level=INFO   # level: INFO/WARN/ERROR，最新在前
POST /api/v1/logs/clear                            # 清空日志
```

### 3.5 Prompt 优化代理（可选）

```
POST /api/v1/optimize-prompt   {"prompt": "..."}
→ {"optimized_prompt": "..."}   # 转发到本机 prompt-portal (127.0.0.1:8768)
```

---

## 4. 模型矩阵

| `model` | `sub_model` | 供应商/端点 | 备注 |
|---|---|---|---|
| `openai`（默认） | `gpt-image-2` | open-hk `api.openai-hk.com/v1`，OpenAI 兼容 | 旧版基础模型；前端只给 1K 档，2K/4K 建议用 2.5 系列 |
| `openai` | `gpt-image-2.5-flare` / `gpt-image-2.5-sunburst` | 同上 | **GPT 2.5 新模型**（flare / sunburst 两种风格）；按次收费，1K/2K/4K **大小同价**，能用 4K 就用 4K；传基础名即可，网关按 `size` 自动分档 |
| `packy` | `gpt-image-2` / `gpt-image-2.5-flare` / `gpt-image-2.5-sunburst` | PackyAPI `cf.api.fan/v1`（经 mihomo 直连） | 按量计费：**适合 1K 及以下小尺寸**，大尺寸费用高，建议换 OpenAI-HK |
| `gemini` | `gemini-3.1-flash-image-preview` / `-2k` / `-4k` | 经 open-hk OpenAI 兼容接口转发 | 标准 / 2K / 4K |
| `gemini` | `gemini-3.1-flash-lite-preview` | Gemini 原生端点（`generativelanguage.googleapis.com/v1beta`） | 走 `gemini_api_key`，单参考图 |
| `minimax` | `image-01`（服务端固定） | MiniMax `api.minimaxi.com/v1/image_generation` | 单参考图；`size` 映射为宽高比 |

**费用策略（2026-09 实测）：**
- **1K 及以下** → 用 `packy`（按量计费，小尺寸便宜）；
- **1K 以上（2K/4K）** → 用 `openai`（按次收费，与 1K 大小同价，越大越划算）；
- openai-hk 网关按 `size` 自动路由内部 -2k/-4k 渠道（响应 `model` 字段可见），**无需自己拼后缀**；显式传 `gpt-image-2.5-flare-4k` 这类带后缀名字给本服务也会被后端 `_normalize_model25()` 归一到基础名再发送。

**尺寸合规约束（服务端自动调整，客户端传任意 WxH 即可）：**
- 长边范围：512 ~ 3840 px；
- 两条边必须是 16 的倍数；
- 总像素：655,360 ~ 8,294,400；
- 长宽比（长边:短边）≤ 3:1；
- **图生图**：保持参考图宽高比，按请求 `size` 的**宽度**等比缩放（`size` 的高度会被忽略）；
- MiniMax 的 `size` 会被映射为宽高比：`1024x1024`→1:1、`1024x1792`→9:16、`1792x1024`→16:9、`1536x1536`→1:1、`1024x1536`→2:3、`1536x1024`→3:2（其余回退 1:1）。

> 已知现象：openai-hk 的 -2k 渠道长边上限约 2048——请求 `2560x1440` 实际可能输出 `2048x1152`（等比缩档）；-4k 渠道对 `3840x2160` 足额输出。若在意精确尺寸需实测确认。

**图生图内部实现（供排查问题参考，客户端无需关心）：**
- 服务端调用 `/v1/images/edits`（multipart/form-data）；
- PackyAPI 的 multipart 字段名是 `image`（单数），open-hk 是 `image[]`（数组）——服务端已按域名自动区分（PackyAPI 判定含 `packyapi.com` / `packyapi.ai` / `api.fan`）；
- 参考图会先被预处理（缩放/16 对齐/像素合规），再以 PNG 上传。

---

## 5. 集成示例（Python）

```python
import base64, time, urllib.request, json

BASE = "http://10.40.92.99:8080"   # NAS 局域网地址，注意端口 8080

def generate_image(prompt: str, model="openai", sub_model="gpt-image-2",
                   size="1024x1024", ref_base64=None, quality=None):
    body = {
        "model": model,
        "sub_model": sub_model,
        "prompt": prompt,
        "size": size,
        "n": 1,
    }
    if ref_base64:
        body["image_base64"] = ref_base64   # 纯 base64，不带 data: 前缀
    if quality:
        body["quality"] = quality

    req = urllib.request.Request(f"{BASE}/api/v1/generate",
        data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    task_id = json.load(urllib.request.urlopen(req))["task_id"]

    # 轮询
    while True:
        resp = json.load(urllib.request.urlopen(f"{BASE}/api/v1/tasks/{task_id}"))
        if resp["status"] in ("completed", "failed"):
            break
        time.sleep(3)

    if resp["status"] == "failed":
        raise RuntimeError(resp["error"])

    # 保存图片
    for i, img in enumerate(resp["images"]):
        data = img["base64"]
        if data:
            raw = base64.b64decode(data)
            with open(f"output_{task_id}_{i}.png", "wb") as f:
                f.write(raw)
            print(f"已保存 output_{task_id}_{i}.png (实际尺寸 {img['adjusted_size']})")
        elif img["url"]:
            print("仅拿到 URL：", img["url"])

    return resp["images"]
```

---

## 6. 给 Codex 的集成要点（注意事项）

1. **端口是 8080**，不是 8000（8000 是飞牛 NAS 管理页，误连会拿到 HTML 而非 JSON）。
2. **地址用局域网 IP**：Codex 在 Windows 上，调用地址是 `http://10.40.92.99:8080`；`127.0.0.1:8080` 只在 NAS 本机有效，Windows 上访问会失败。
3. **必须异步轮询**：`POST /generate` 只返回 `task_id`，图片结果只能从 `GET /tasks/{task_id}` 获取；不要把 `/generate` 当同步接口用。
4. **base64 无前缀**：返回的 `base64` 字段是纯 base64，写文件前先 `base64.b64decode()`；如需 data URL 自己加 `data:image/png;base64,`。
5. **无鉴权**：接口未做认证，仅在可信内网使用；不要把供应商 Key 放进客户端代码（Key 在服务端 .env）。
6. **prompt 是中文友好**：各供应商对中文提示词支持良好，可直接使用中文。
7. **失败排查**：任务 `failed` 时看 `error`（含堆栈；API 类错误现已解析出供应商原始 message，如 `This token has no access to model ...`）和 `raw_response`（供应商原始返回）；服务端 JSON 结构化日志在 NAS 的 `/tmp/image-api.log`（NAS 上执行 `tail -30 /tmp/image-api.log`，每行一条 JSON）。
8. **生成长耗时**：单任务最长 900 秒；多任务并发建议控制在 2~3 个以内（供应商限流）。
9. **图生图要求**：参考图 base64 必须是 PNG/JPEG 解码后的原始 base64；尺寸合规由服务端自动处理，客户端传 `auto` 或期望宽度即可。
10. **运维操作在 NAS 上做**：改代码后重启服务用 `systemctl --user restart image-api.service`；看日志用 `tail -30 /tmp/image-api.log`（不是 journalctl）——这些都需要 SSH 登录 NAS 执行，Windows 客户端只需调 API。
11. **Windows 上验证连通**：`curl http://10.40.92.99:8080/health` 返回 `{"status":"healthy"}` 即正常。
12. **2.5 模型只传基础名**：`sub_model` 用 `gpt-image-2.5-flare` / `gpt-image-2.5-sunburst`（不带 `-2k/-4k` 后缀），服务端与供应商网关会按 `size` 自动分档；`size` 直接传想要的像素（如 `3840x2160` 出 4K）。
13. **费用策略**：小图（≤1K）用 `packy`，大图（2K/4K）用 `openai`（2.5 系列按次大小同价）。

---

## 7. 常见问题（FAQ）

- **Q: 调用 /generate 返回 404？** A: 确认 URL 带 `/api/v1` 前缀、端口为 8080，且使用的是局域网地址 `10.40.92.99` 而不是 `127.0.0.1`（后者在 Windows 上指向本机）。
- **Q: Windows 上连接超时/拒绝？** A: 先 `curl http://10.40.92.99:8080/health`；不通则检查 NAS 是否开机、服务是否在跑（NAS 上 `systemctl --user status image-api.service`）、Windows 与 NAS 是否同一网段。
- **Q: 任务长时间停在 running？** A: 大图（2K/4K）生成慢，最长可等 15 分钟；先看 `/tmp/image-api.log` 是否在推进。
- **Q: 任务 failed，error 提到 SSL/TLS？** A: 供应商域名直连问题（与本机代理配置有关），重试或稍后再试；HTTP 5xx 类错误则说明请求已到达供应商，属上游问题。
- **Q: 怎么知道实际生成尺寸？** A: 结果里 `adjusted_size` 字段是服务端合规调整后的真实尺寸。
- **Q: 任务 failed，error 提示 `This token has no access to model ...`？** A: openai-hk 的 `/v1/models` 会列出全部模型，但实际按 **key 的模型白名单** 拦截（403，~0.1s 快速返回）。去 openai-hk 控制台给该 key 勾选对应模型即可。
- **Q: 任务 failed，error 提示 `无可用渠道 ...-4k-4k`？** A: 只在**绕过本服务直连供应商**且传了带 `-2k/-4k` 后缀的 2.5 模型名时出现（openai-hk 网关对 4K 档尺寸会重复加后缀）。走本服务不会发生——后端会把显式变体名归一为基础名。
- **Q: 请求 `2560x1440`（2K）但返回的图只有 2048 左右长边？** A: openai-hk 的 -2k 内部渠道长边上限约 2048，超出的 2K 尺寸会被等比缩档（如 2560x1440 → 2048x1152）；4K（3840x2160）足额输出。
