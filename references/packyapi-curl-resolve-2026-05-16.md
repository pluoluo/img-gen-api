# PackyAPI curl --resolve 绕过 Cloudflare CDN 超时 (2026-05-16)

## 变更背景

Boss 手动测试发现 PackyAPI 生图超时是 Cloudflare CDN 的 DNS 解析超时问题。
使用 `curl --resolve "api-slb.packyapi.com:443:89.208.240.138"` 可以绕过 CDN 直连后端 IP，成功生成。

## 关键发现

1. 用 `ping api-slb.packyapi.com` 获得 IP，该 IP 是真正的后端服务器（不再经过 Cloudflare CDN）
2. 因此 base_url 直接改成 `https://api-slb.packyapi.com/v1` 即可（域名解析到正确 IP）
3. 家庭宽带对 Cloudflare CDN 握手不稳定，但直连 IP 稳定

## 解决方案

### 1. config.py — 自动 IP 解析 + 每6小时后台刷新

- `packy_base_url` 默认值改为 `https://api-slb.packyapi.com/v1`
- 新增模块级 `_packy_ip_cache` 缓存字典 + `_IP_REFRESH_INTERVAL = 6*3600`
- `_resolve_packyapi_ip_impl()` — ping 解析核心逻辑
- `_refresh_packyapi_ip()` — 刷新缓存（IP + timestamp）
- `_get_cached_packyapi_ip()` — 未过期直接返回，过期则同步刷新
- `_background_refresher()` — daemon 线程，每 6 小时自动刷新
- 服务启动时同步执行一次解析；daemon 线程负责后续定时刷新
- 公开 `get_packyapi_ip()` 和 `resolve_packyapi_ip()` 供外部调用

### 2. openai_img.py

- `_is_packy(base_url)` — 判断是否 PackyAPI
- `_packy_curl_request()` — 用 curl subprocess 发起请求：
  - `--resolve "{host}:{port}:{ip}"` — 将域名 DNS 绑定到 ping 解析到的 IP
  - `-k` — 跳过 TLS 证书 CN 校验（证书是给域名签发的，IP 不同）
  - 文生图（generations）：curl -d JSON
  - 图生图（edits）：multipart/form-data，参考图写到临时文件用 `@path` 上传
  - 超时：timeout 参数透传给 asyncio.wait_for
- `generate_openai_image()` 两处 httpx 调用前均加入 PackyAPI curl 分支

### 3. index.html

- size 选择器 change 事件：解析 w×h
- 当 w × h > 5,785,600 时弹出 alert 警告

### 4. .env

- `PACKY_BASE_URL=https://api-slb.packyapi.com/v1`
- 无需手动指定 IP（自动解析）

## 手动触发 IP 刷新

```bash
curl -s http://localhost:8766/resolve_packyapi_ip
```

## 定时刷新机制

- 间隔：6 小时
- 启动时立即解析一次（同步）
- 后台 daemon 线程负责定时刷新
- 每次刷新输出：`[image-api] PackyAPI IP 已刷新: {ip}`

## 原理说明

```
www.packyapi.com DNS 解析
  → Cloudflare CDN IP（家庭宽周到 Cloudflare 不稳定，握手超时）
  → 请求挂死

api-slb.packyapi.com DNS 解析
  → 内部负载均衡器 IP（直连后端服务器，稳定）
  → TLS 握手成功
  → 正常通信
```

## 分辨率限制

- 总像素超过 5,785,600 时 PackyAPI 可能生成失败（Cloudflare 超时）
- Boss 确认是临时限制，尺寸选项保留但前端会弹出警告
- 不同比例的最大分辨率示例：
  - 16:9 → 最大 3840x2160 = 8,294,400 像素（超过限制）
  - 1:1 → 最大 2404x2404 ≈ 5,779,216 像素（OK）
  - 需要按比例计算，确保 w × h ≤ 5,785,600

## 待改进

- curl -k 跳过证书验证存在安全风险，未来可考虑将 IP 的证书指纹写入可信列表
- 分辨率上限 5,785,600 是当前实测最大值，未来如 PackyAPI 修复后可解除限制