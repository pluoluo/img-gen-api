# Image Generation API

统一图片生成服务（FastAPI）：Infinite 无限画布工作区 + REST API，底层聚合 open-hk、PackyAPI、Gemini、MiniMax。

Infinite 前端、可选 Canvas Agent、代理和节点插件源码已合并到本仓库的 [`infinite/`](infinite/)。后续只开发和同步 image-api，不再需要单独克隆或更新 infinite-canvas。项目来源与鸣谢见下方「Infinite 项目来源与鸣谢」。

下方启动示例使用 **8080**，实际访问端口以各环境的 Uvicorn 或服务配置为准。局域网访问示例：`http://<NAS_IP>:8080`。

更完整的接入说明（异步轮询、字段、给 Codex 用的示例）见 [CODEX_INTEGRATION.md](CODEX_INTEGRATION.md)。

## 支持的模型

| 提供商 | `model` | `sub_model` | 参考图 | 备注 |
|--------|---------|-------------|--------|------|
| GPT 自动路由 | `auto`（默认） | `gpt-image-2.6-flare`（默认）/ `gpt-image-2.6-sunburst` / `gpt-image-2.6`；仍可选 2.5 同名 | ✅ 多图 | 见下方路由规则 |
| open-hk | `openai` | 同上 | ✅ 多图 | 强制 openai-hk，失败不转 packy |
| PackyAPI | `packy` | `gpt-image-2.6-flare` / `gpt-image-2.6-sunburst`（2.5 同名仍可用） | ✅ 多图（`image[]`） | 强制 packy，按量计费 |
| Gemini | `gemini` | `gemini-3.1-flash-image-preview` / `-2k` / `-4k` | ✅ | 经 open-hk 兼容接口 |
| MiniMax | `minimax` | `image-01` | ✅ 单图 | `size` 映射为宽高比 |

- 前端 GPT 系列只展示模型名，请求里 `model` 固定为 `auto`。
- `gpt-image-2` 已下线，传入会映射到 `gpt-image-2.6-flare`。
- 2.5 / 2.6 只发**基础名**（不要自己拼 `-2k`/`-4k`）。服务商按 `size` 分流内部渠道；显式后缀在 openai-hk 上可能变成 `flare-4k-4k` 并 503。

## GPT `model=auto` 路由

当前默认 **`size_split`**（`GET /api/v1/gpt-route` 可查）：

| 请求总像素（宽×高） | 走哪 | 费用 |
|----------|------|------|
| ≤ 1,572,864（约 1.57MP，1K） | openai-hk | 约 0.08 元/张 |
| > 1,572,864 | Packy | 按量，贵 |

不要为了 2K/4K 走 openai-hk：它所谓 4K 是假象，实测约 **1.57MP**（例如 3808×1632 → 1916×821）。超宽图像素卡在 1.57MP 时，长边仍可能 **>1920**（例如 2272×752），所以路由与监测都按总像素判断，不以长边 1920 分流。`size=auto` 且无参考图的文生图固定走 openai-hk，不依赖 1024 回落。

可选模式 `openai_first`（**不是默认**，不要轻易开）：先 openai-hk，API 失败再同请求走 packy。若请求总像素 >1,572,864 但返回像素 ≤1.7MP（保留原监测容差），连续 5 次会自动切回 `size_split`。

显式 `openai` / `packy` 仍强制该提供商，不做这套分流。

1K 界面预设按约 157 万像素、16 像素对齐设置，常用尺寸：1:1 为 1248×1248，3:2 为 1536×1024，4:3 为 1440×1088，16:9 为 1664×944，21:9 为 1920×816；竖图对调宽高。比例因对齐有少量近似。2048×768（1,572,864 像素）长边超过 1920，仍走 openai-hk；1920×1080（2,073,600 像素）走 Packy。Infinite 仅本机 GPT 模型使用这套 1K 预设，其他渠道和 2K/4K 预设保留；已有节点和已保存的独立尺寸需重新选择 1K 才应用新值。

## 快速开始

### 1. 安装依赖

准备 Python、Node.js（22.12+）和 Bun。Bun 用于按锁文件安装及构建 Infinite 前端，Python 用于启动后端；生产运行网站不需要单独启动 Vite。

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

### 3. 构建画布前端

在仓库根目录执行：

```bash
venv/bin/python scripts/build_infinite.py
```

脚本从本仓库 `infinite/web/` 安装锁定的依赖、检查类型并构建，将静态文件发布到 `frontend/infinite`。首次部署以及前端更新后都需要执行；仅 `git pull` 不会自动更新已部署页面。构建产物不提交到 Git，其他环境可直接从同一仓库重建，无需相邻的 infinite-canvas 目录。

构建还会下载并校验智能蒙版使用的固定版本 SAM 2.1 Tiny ONNX 权重，缓存到已忽略的 `infinite/web/public/smart-mask/`，并复制浏览器推理文件。首次构建需要访问 Hugging Face；内网构建可预先复制同一版本的缓存目录，并通过内网源安装锁定依赖，再执行构建。使用时模型由当前站点提供，不需要访问外部模型网站、安装 Python 推理环境或提供分割 API Key。HTTPS 下有可用 WebGPU 时使用 GPU，普通局域网 HTTP 使用 CPU；GPU 初始化失败会切换 CPU。智能选区按需加载，GPU 支持半精度时权重约 78 MB，否则约 156 MB，CPU 量化权重约 62 MB（均不含推理运行库）；首次图片分析速度取决于设备。下载显示真实百分比，初始化、分析和选区计算显示阶段及耗时；支持补点排队、撤销点、候选切换及手动切换 CPU。

### 4. 启动

Linux 本机可选 HTTPS 入口由 `scripts/setup_image_api_https.py` 配置，需要 nginx、systemd 用户服务及浏览器信任的域名证书。运行 `venv/bin/python scripts/setup_image_api_https.py --help` 查看参数；代理空闲超时必须显式提供经确认的秒数。脚本默认只准备和校验配置，附加 `--enable` 才启动独立入口；已有 HTTP 服务保留，证书文件更新后自动校验并重载代理，不负责申请证书。配置与日志保存在当前用户目录，私钥不复制进仓库。HTTP/HTTPS 或端口变化会形成不同的浏览器存储空间，切换前应备份画布、素材与配置。

本仓库 systemd 用户服务（生产）：

```bash
systemctl --user restart image-api.service
systemctl --user status image-api.service
```

本地调试（从仓库根目录启动，按需调整端口）：

```bash
PYTHONPATH=. venv/bin/python -m uvicorn image_api.main:app --host 0.0.0.0 --port 8080
```

健康检查：`GET /health` → `{"status":"healthy"}`。

### 5. Web 界面

- `/` 默认跳转到 `/infinite/canvas`
- `/infinite/canvas` Infinite 画布工作区
- `/legacy` 旧版生成页
- `/gallery` 图库
- `/logs` 日志
- `/docs` Swagger
- `/redoc` ReDoc

前端费用栏 `#hintBar` 以 `GET /api/v1/gpt-route` 为准，不要写死「大小同价」或「1K 以上 0.18」。

改布局请先在 `sketches/`（本机 8099）做原型，再动正式页。

### 6. 其他环境更新

当前完整集成版本位于 `integration/infinite` 分支，其他环境也应切换到这个分支再更新：

```bash
git fetch origin
git switch integration/infinite
git pull --ff-only
venv/bin/python -m pip install -r requirements.txt
venv/bin/python scripts/build_infinite.py
# 使用 systemd 的环境，再重启自己配置的 image-api 服务
systemctl --user restart image-api.service
```

首次部署先完成上面的虚拟环境和 `.env` 配置。前端与后端代码都来自本仓库；`.env`、图库、`data/`、浏览器画布/素材及 Agent 运行配置不会随 Git 同步，需要各环境单独配置或迁移。旧 Prompt Portal 的本机模板和案例仍是可选外部数据，可通过 `PROMPT_PORTAL_DATA_DIR` 指定；缺少时不包含这些本机条目，不影响画布主体和在线来源。

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

# 轮询（pending → running → completed / failed / cancelled）
curl -s http://127.0.0.1:8080/api/v1/tasks/<task_id>
# 取消（中断上游 HTTP，避免继续计费）
curl -s -X POST http://127.0.0.1:8080/api/v1/tasks/<task_id>/cancel
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
| POST | `/api/v1/tasks/{id}/cancel` | 取消运行中任务并断开上游连接 |
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

旧版生图的图库目录：`/vol1/1000/note/memory/AI生成图片/`。Infinite 内置画布生图及生图工作台的新结果保存到当前浏览器，不再自动进入服务器图库；浏览器完成本地保存后确认释放服务器的临时结果。旧版入口和直接返回图片数据、尚无持久化领取流程的插件调用继续归档。路由状态：`data/gpt_route_state.json`（已 gitignore）。

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

## Infinite 无限画布

主画布基于 Infinite Canvas 完整工作台，源码已从集成 fork 导入本仓库。目录分工：

| 目录 | 用途 |
|------|------|
| `infinite/web/` | React / TypeScript / Vite 画布及工作台前端 |
| `infinite/canvas-agent/` | 可选 Canvas Agent，连接本机 Codex / Claude Code |
| `infinite/canvas-proxy/` | 可选本地转发代理 |
| `infinite/plugins/` | 画布节点插件、SDK 及 Agent 插件源码 |
| `infinite/docs/` | 原项目功能、操作及开发文档 |
| `image_api/` | 图片 API、任务、图库及 Infinite 同源适配接口 |

在本仓库根目录构建：

```bash
venv/bin/python scripts/build_infinite.py
```

构建检查通过后静态资源以原子链接方式发布到 `frontend/infinite`。FastAPI 需要重启一次以加载新增后端路由；之后纯前端构建无需重启。入口 HTML、构建信息和运行配置禁止缓存；旧版内嵌 Infinite 的地址及工作区脚本带构建提交号，避免更新后仍加载旧入口。首页 `/` 默认跳转至 Infinite 画布工作区 `/infinite/canvas`，原生成界面保留在 `/legacy`，旧 Konva 工作区保留在 `/canvas/`。画布顶部提供「旧版生成」和「日志」入口，旧图库沿用画布内的「旧图库」入口。

Canvas Agent 和本地代理按需单独运行。使用仓库内的 Agent 版本时，从仓库根目录执行 `cd infinite/canvas-agent && npm ci && npm run build && npm start`，连接与配置说明见 [Canvas Agent README](infinite/canvas-agent/README.md)。已有独立安装的 Agent 可继续运行；合并源码不会自动替换本机服务或迁移 `~/.infinite-canvas/` 配置与对话数据。

Infinite 自动加载本服务的图片模型并调用原异步任务接口；GPT 图片请求继续使用已有 openai-hk/Packy 双来源自动路由，浏览器只显示一个「本机生图服务」，无需填写默认渠道或复制供应商密钥。当前没有配置文本、音频或视频服务，不会自动注册这些模型和渠道；如需使用，应自行配置具备对应权限的渠道。画布停止生成或中止轮询会 `POST /api/v1/tasks/{id}/cancel`，取消 asyncio worker 并关闭上游 HTTP 连接，避免继续计费；cancelled 任务不写图库。read 超时按长边分级：≤2048 → 360s，>2048 → 600s，超时后 `model=auto` 可回切 Packy。

Infinite 图片节点和生图工作台会在提交前保存请求标识，刷新后取回原任务；提交响应丢失时先按标识查回任务，不自动重提。工作台批量结果恢复到同一条历史记录，查询中断后的重试取回原结果；本地结果缓存丢失时也可从原任务修复。任务结果和提交去重记录保存在 `data/tasks/tasks.sqlite3`，可用 `TASK_DATA_DIR` 调整目录；服务按单个 Uvicorn worker 部署。已完成结果重启后可查；重启中断的任务会显示明确失败，不会自动再付费生成。

在 **我的资产 → 从旧图库导入** 中可搜索、翻页并导入现有图库原图；资产选择器也提供 **旧图库** 页签，可直接插入画布或作为工作台参考图。导入会保存本地副本，旧图库原图保留。旧版生成入口继续保存图库记录及原始参考图，文件位于图库的 `references/`，关联保存在 `.gallery.db`；Infinite 的新生成任务由浏览器保存图片、参考输入和编辑关系。待领取结果暂存在 `data/tasks/results/`（随 `TASK_DATA_DIR` 调整），浏览器保存图片和画布／任务记录后确认删除临时结果；领取确认失败会在后续生成或重新打开应用时重试，未确认前保留结果。任务数据库只保存这类任务的状态与提交身份，不保存大图。清除浏览器站点数据前请导出或同步备份；手动同步到本机服务仍会产生用户选择的服务器备份。旧图库中没有输入关联的记录明确显示「旧记录未保存参考图」，无法从生成结果反推出历史输入。

本机 GPT Image 的局部编辑使用真实 RGBA PNG mask，透明区域可修改，不透明区域由服务端合成保留原图像素；支持“立刻生成”与先导出到画布再生成。其他渠道沿用 Infinite 的蓝色标注参考图方式，不承诺像素级保留。

画布和素材首先保存在浏览器。配置中的 WebDAV 地址默认指向本服务，点击同步可把画布、素材和图片/视频工作台记录同步到服务器，默认目录为 `data/infinite`，可通过 `INFINITE_DATA_DIR` 调整。已通过新浏览器同步恢复验收；当前没有自动服务器备份，也不能把本地保存当成已同步。

完整接入范围、验证结果与剩余事项见 [INFINITE_PROGRESS.md](INFINITE_PROGRESS.md)。

浏览器模拟验收必须使用独立测试服务，设置 `INFINITE_OFFLINE_VALIDATION=1` 并通过 `INFINITE_FRONTEND_DIR` 指向本仓库已构建的 `frontend/infinite`，或已按集成参数构建的 `infinite/web/dist`。写入图库的测试还须设置 `GALLERY_DATA_DIR` 指向独立测试目录，默认生产路径仍为 `/vol1/1000/note/memory/AI生成图片/`。测试服务拒绝创建生成任务及供应商 POST；脚本启动前会检查隔离标记，并生成本地 PNG fixture。生产服务不应启用该标记。可运行 `node scripts/verify_infinite_workbench.cjs`、`node scripts/verify_infinite_gallery.cjs` 等脚本查看验收产物，输出位于 `data/infinite-validation/`。

### Infinite 项目来源与鸣谢

感谢 [basketikun](https://github.com/basketikun) 及 [Infinite Canvas](https://github.com/basketikun/infinite-canvas) 项目的所有贡献者，提供无限画布、多模态创作工作台、节点插件和本地 Agent 连接等基础能力。本项目在此基础上接入 image-api 的模型路由、异步任务恢复、旧图库与统一提示词库，并继续在本仓库维护。

合并来源为 [pluoluo/infinite-canvas](https://github.com/pluoluo/infinite-canvas) 的 `integration/image-api` 分支，导入提交为 `7a89ff3e1f6beff6f759d85e18f9c0d407879f45`。Infinite Canvas 采用 MIT 许可证，原作者版权声明和完整许可保留于 [`infinite/LICENSE`](infinite/LICENSE)，发布的前端也附带许可文件。详细来源记录见 [`infinite/UPSTREAM.md`](infinite/UPSTREAM.md)。

## 统一提示词库

Infinite 的提示词中心、画布侧栏和工作台选择器共用检索与去重。按创作用途分类，公开来源的风格统一为 20 个中文标签；作者、来源和合并出处保留在详情，个人提示词的自定义标签仍可检索。相同正文忽略空白与全半角差异后合并，已有中文版本通过原始正文及 Prompt Portal 的稳定模板 ID 关联；同名但正文不同的内容保留独立记录。中英文版本可切换，复制和插入使用当前明确选择的正文。

本机 Prompt Portal 从相邻仓库 `../prompt/backend` 只读整合 `prompts_data.json`、`data/gallery_data.json`、`data/gallery_translations.json` 和本地案例图；保留的原始模板快照用于核对中英文版本，不修改旧应用的数据或编辑功能。可用 `PROMPT_PORTAL_DATA_DIR` 指定该 backend 目录。七个公开来源通过同源接口读取，下载快照及按需缓存的图片、中文译文存放于 `data/prompt-library`，可用 `PROMPT_LIBRARY_DATA_DIR` 修改；备份时一并保留该目录及原 Prompt 应用数据。

图片优先复用本地文件，其他图片通过目录中登记的图片 ID 获取并缓存；浏览器无需直连图床。来源更新失败保留旧缓存。没有中文版本的条目可按需翻译，优先使用画布当前选中的可用文本模型；未设置时使用原 Prompt 服务。译文按正文保存并复用，保留原文；不批量调用模型，不在请求失败后自动改用另一渠道。当前原 Prompt 服务的 MiniMax 账号实测返回余额不足，需设置可用文本模型或恢复该服务余额。

本次快照将 2,575 条原始收录/中英文版本整合为 1,389 条，1,059 条有中文正文、1,361 条带示例图地址。图床失效仍会显示不可用状态并保留原始出处，不能据此承诺全部远程图片永久有效。

隔离验收：启动启用 `INFINITE_OFFLINE_VALIDATION=1` 的测试服务，另设 `PROMPT_LIBRARY_DATA_DIR` 指向测试目录并复制来源快照，然后运行 `INFINITE_TEST_URL=http://127.0.0.1:8772 node scripts/verify_infinite_prompt_library.cjs`。脚本仅模拟当前文本模型请求，检查去重、图片、中文与原文复制、译文保存、个人标签、画布插入、工作台选择和移动端筛选；不会调用真实生图服务。

在线或本机整合案例的详情中可点击「修改分类与标签」，手动校正用途和标签、添加自定义标签，或恢复自动分类。校正保存在当前浏览器 IndexedDB 的 `prompt_classifications`，独立于来源缓存，来源更新不会覆盖；按去重正文及已知中文版本关联。提示词中心、侧栏及选择器共同使用校正结果，目前不跨浏览器同步。个人新增记录的标签仍通过原有铅笔入口编辑。

独立 Prompt Portal 的 `prompt-portal.service`（8768）与 `prompt-nginx.service`（8769）已停止并禁用开机自启。整合库继续只读使用保留的 `../prompt/backend` 数据和案例图；不要直接删除该目录。旧版生成页的「✨ 优化」仍调用原独立服务，停用后不可用；画布提示词库和当前文本模型功能不依赖该服务。

## 原 Konva 画布工作区（M0—M3 预览）

首页 `/` 默认进入 Infinite；`/legacy` 保留原有生成界面，其顶栏「画布工作区」加载 Infinite，首次进入才加载资源，隐藏外层顶栏。Infinite 顶栏「旧版生成」在嵌入工作区内切回原表单并恢复顶栏，在独立访问时进入 `/legacy`。原界面结果的「插入画布」会将图片保存到一个新的 Infinite 画布。旧 Konva `/canvas/` 仅保留已有资源，不再开发。

开发／构建（Node 22.12+ 或 24；生产不需要常驻 Node）：

```bash
cd canvas
npm ci
npx playwright install chromium   # 首次浏览器测试需要
npm run dev                      # 127.0.0.1:8099/canvas/，API 代理至 8080
npm run build                    # 输出 frontend/canvas，由 FastAPI 同源提供
npm test                         # 坐标、导入、编辑、任务流程；自动启动本地测试服务
npm run test:production          # 在生产静态构建下验证双 UI 与原界面回归
```

Python 测试仍在仓库根目录执行：`venv/bin/python -m unittest discover -s tests -v`。生产部署先构建静态资源，再按已有部署流程启动 FastAPI；构建产物已忽略，不要只复制源码后直接访问画布。

画布操作：导入支持文件选择、拖放、剪贴板和图库；滚轮围绕鼠标缩放，空格拖动视口，Shift 点击多选，Ctrl/Cmd+A 全选，Ctrl/Cmd+D 复制，Delete 删除，Ctrl/Cmd+Z 撤销，Ctrl/Cmd+Shift+Z 重做。右侧“当前图片”也可用键盘选择对象。文字输入期间不触发这些画布快捷键。

画布右栏上方按当前工具显示参数：画笔／箭头显示颜色与宽度，文字显示内容／颜色／字号，区域画笔与擦除显示宽度，裁剪显示恢复操作。可收起工具参数给生成输入留出空间。右栏下方集中放置参考图、可纵向拉高的长提示词输入框，以及其下的模型／尺寸／质量下拉菜单；生成按钮保持在面板下方。窄屏通过顶栏“生成与工具”打开侧栏。

选中目标图片后，可使用画笔、箭头、中文文字、非破坏裁剪、圈选、区域画笔和擦除；标注附属原图，裁剪外的内容隐藏。右侧可选择已有标注并编辑文字、颜色、宽度、字号和局部位置。原图／裁剪图、含标注参考图和独立 PNG mask 分别导出，不含选中框与界面工具。

生成时先点击“选中图片作为参考”，通过“前移”确定第一张主参考图与其他参考图顺序，或选择“纯文本生成”。局部编辑勾选“使用主参考图 PNG mask”，默认启用“区域外保持原图”。模型、尺寸、质量来自与旧界面共用的 `frontend/model-config.json`，费用实时读取 `/api/v1/gpt-route`。

每个任务固定提交时的图片、标注、裁剪、区域和设置快照，并有独立占位。结果创建新图片，保留来源任务和参考图 ID，不覆盖之后对原图的编辑。提交未确认时的“重试提交”沿用同一请求 ID；查询中断可继续查询；已失败任务的“重新生成”会创建新的上游任务。服务重启后任务不存在会显示明确错误。

PNG mask API 新增可选字段（旧请求不受影响）：

- `mask_base64`：纯 base64，带 alpha 的 PNG；透明为修改区域，不透明为保护区域；尺寸等于第一张主参考图。
- `mask_reference_index`：目前为 `0`；调整参考图顺序可更换主图。
- `preserve_outside_mask`：精确保留模式。返回图按原图分辨率合成；完全不透明 mask 区域保留原图 RGBA 像素，半透明边缘按 alpha 混合，生成图尺寸不同则先 LANCZOS 缩放。上游预处理的 mask 使用相同最终尺寸、NEAREST 缩放，保留 alpha。
- `preserve_source_base64`：可选未标注原图，尺寸与主参考图一致，避免将指导标注保留在输出上。
- `client_request_id`：同 ID 同输入返回同一任务，输入不同返回 409。任务与去重记录持久化到 SQLite，重启后仍保留。

局部编辑支持 GPT 的 auto/openai/packy 路径；Gemini/MiniMax 带 mask 会明确报错。真实验证记录见 `CANVAS_PROGRESS.md`。画布支持自动保存、刷新恢复和历史版本继续编辑。完整触控编辑和多张大图长期内存压力验证仍待完善。


### 画布保存与历史恢复

画布会在编辑后自动备份到浏览器 IndexedDB，并在短暂停顿后保存到服务器；持续编辑时也会定时同步。底部状态栏显示备份、保存版本或失败原因。重要节点可以点击顶栏 **历史画布 → 保存当前版本**，并为画布命名。

- **当前画布版本**：打开保存过的完整编辑状态，包含图片、位置/旋转/裁剪、标注、蒙版、视角、选择、最多 80 步撤销/重做，以及提示词、参考图、生成参数和任务关联。打开旧版本后编辑会追加新版本，后续版本仍然保留。
- **已保存画布**：打开其他项目；可新建画布或另存为新画布。刷新或关闭后再次进入同一浏览器、同一地址会恢复最近工作区。
- 本地备份可在服务器保存失败时恢复；连接恢复后可重试保存。多窗口保存冲突会明确提示，可另存副本以保留各自编辑。
- 图片按内容哈希单独保存，版本只存资源引用，不把大图 Base64 重复写入历史。

服务器数据默认位于 `data/canvas/projects.sqlite3` 和 `data/canvas/assets/`，可用环境变量 `CANVAS_DATA_DIR` 修改。备份/迁移时需同时保留数据库和图片目录。版本目前不自动清理，磁盘占用会随工作量增长。

刷新后会继续查询已提交的生成任务，不会自动重新付费提交。新提交的任务结果和去重记录已持久化，重启后已完成结果仍可查询；重启中断的任务明确标记失败，需要先确认供应商是否已有结果再决定重新生成。持久化上线前已丢失的任务和临时画布无法追溯恢复。

旧图库支持按生成日期范围筛选、查看数量和逐张选择，也可按一个月、三个月、半年或指定日期清理作品，预览数量后确认删除；入口为图库页「按时间清理」或画布旧图库「管理图库」。
