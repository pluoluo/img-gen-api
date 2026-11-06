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

## Infinite 无限画布

主画布改用 [pluoluo/infinite-canvas](https://github.com/pluoluo/infinite-canvas) 的完整工作台。克隆 fork 后切换到 `integration/image-api` 分支，在本仓库执行：

```bash
venv/bin/python scripts/build_infinite.py --source /home/sahn/infinite-canvas
```

构建检查通过后静态资源以原子链接方式发布到 `frontend/infinite`。FastAPI 需要重启一次以加载新增后端路由；之后纯前端构建无需重启。首页 `/` 默认打开原生成界面，`/legacy` 也保留同一入口；Infinite 供审查使用，独立入口为 `/infinite/canvas`，旧 Konva 工作区保留在 `/canvas/`。只有用户明确审查通过并同意后，才可切换默认首页。

Infinite 自动加载本服务可用的图片模型并调用原异步任务接口；文本与音频使用同源供应商代理，供应商密钥不会写入浏览器配置。视频和其他外部渠道仍可在 Infinite 配置中设置。取消前端查询不会取消已提交的付费上游任务。

Infinite 图片节点和生图工作台会在提交前保存请求标识，刷新后取回原任务；提交响应丢失时先按标识查回任务，不自动重提。工作台批量结果恢复到同一条历史记录，查询中断后的重试取回原结果；本地结果缓存丢失时也可从原任务修复。任务结果和提交去重记录保存在 `data/tasks/tasks.sqlite3`，可用 `TASK_DATA_DIR` 调整目录；服务按单个 Uvicorn worker 部署。已完成结果重启后可查；重启中断的任务会显示明确失败，不会自动再付费生成。

在 **我的资产 → 从旧图库导入** 中可搜索、翻页并导入现有图库原图；资产选择器也提供 **旧图库** 页签，可直接插入画布或作为工作台参考图。导入会保存本地副本，旧图库原图保留。新生成记录会在供应商调用前保存原始参考图、顺序、蒙版及区域外保留所需原图，文件位于图库的 `references/`，关联保存在 `.gallery.db`；Infinite 中点击「参考图 N 张」可下载和再次引用，旧版 `/gallery` 详情也有原图入口。旧记录没有参考图关联时明确显示「旧记录未保存参考图」，无法从生成结果反推出历史输入。

本机 GPT Image 的局部编辑使用真实 RGBA PNG mask，透明区域可修改，不透明区域由服务端合成保留原图像素；支持“立刻生成”与先导出到画布再生成。其他渠道沿用 Infinite 的蓝色标注参考图方式，不承诺像素级保留。

画布和素材首先保存在浏览器。配置中的 WebDAV 地址默认指向本服务，点击同步可把画布、素材和图片/视频工作台记录同步到服务器，默认目录为 `data/infinite`，可通过 `INFINITE_DATA_DIR` 调整。已通过新浏览器同步恢复验收；当前没有自动服务器备份，也不能把本地保存当成已同步。

完整接入范围、验证结果与剩余事项见 [INFINITE_PROGRESS.md](INFINITE_PROGRESS.md)。

浏览器模拟验收必须使用独立测试服务，设置 `INFINITE_OFFLINE_VALIDATION=1` 并通过 `INFINITE_FRONTEND_DIR` 指向 fork 的 `web/dist`。写入图库的测试还须设置 `GALLERY_DATA_DIR` 指向独立测试目录，默认生产路径仍为 `/vol1/1000/note/memory/AI生成图片/`。测试服务拒绝创建生成任务及供应商 POST；脚本启动前会检查隔离标记，并生成本地 PNG fixture。生产服务不应启用该标记。可运行 `node scripts/verify_infinite_workbench.cjs`、`node scripts/verify_infinite_gallery.cjs` 等脚本查看验收产物，输出位于 `data/infinite-validation/`。

## 原 Konva 画布工作区（M0—M3 预览）

首页 `/` 和 `/legacy` 均打开原有生成界面。顶栏右侧、Prompt 左边的「画布工作区 · 预览」加载 Infinite，首次进入才加载资源，切回原界面保留原表单和结果。Infinite 顶栏「旧版生成」在嵌入工作区内切回原表单，在独立访问时返回默认首页。原界面结果的「插入画布」会将图片保存到一个新的 Infinite 画布。旧 Konva `/canvas/` 仅保留已有资源，不再开发。

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
