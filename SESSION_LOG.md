══════════════════════════════════════════════
SESSION LOG - image-api 项目修复与部署
Time: 2026-04-24 15:31:19
══════════════════════════════════════════════

【问题描述】
- 项目路径：/home/sahn/image-api（FastAPI 图片生成网站，端口 8766）
- 使用 open-hk API 代理的 gpt-image-2 模型
- 问题：使用参考图时，size 参数传递不出去，输出图片为默认 1:1 比例
- 参考图示例：/vol1/1000/note/operation/E33.png (1920×1080, 16:9)
- 期望：输出图片保持参考图比例（16:9）

【问题根因】
OpenAI API 设计限制：当 /v1/images/generations 请求包含 image（参考图）参数时，
size 参数被完全忽略，输出固定为默认尺寸（1024×1024，1:1 比例）。

【解决方案】
预处理参考图：根据参考图比例自动选择 OpenAI 标准尺寸，将参考图缩放到
该尺寸后发送 API。API 按传入图片尺寸输出，从而保持比例。

【代码修改】
文件：image_api/services/openai_img.py

1. 添加系统 PIL 路径导入（解决 fnOS 环境下虚拟环境导入问题）
2. 新增函数：
   - _resize_with_letterbox(): Letterbox 填充缩放
   - preprocess_reference_image(): 根据比例自动选择尺寸 + letterbox 填充
3. 修改 generate_openai_image():
   - 调用预处理函数获取 (processed_bytes, actual_size)
   - 将 actual_size 传递给 API 的 size 参数
   - 修复 image_url 分支使用相同预处理逻辑
4. 修复响应处理：
   - API 返回 url 而非 b64_json
   - 下载 OSS 图片并转为 base64 返回前端

【尺寸映射表】
比例   → 标准尺寸
1:1    → 1024×1024
16:9   → 1536×864
9:16   → 864×1536
4:3    → 1024×768
3:4    → 768×1024
其他   → 1536×N（保持比例）

【测试结果】
参考图：1920×1080 (16:9, ratio 1.78)
预处理：1536×864 (16:9) ✅
API size: 1536x864 ✅
输出尺寸：1672×941 (16:9, ratio 1.78) ✅
比例匹配：完全一致 ✅

【部署】
创建 systemd 用户级守护进程：
- 配置：~/.config/systemd/user/image-api.service
- 启动：systemctl --user start image-api
- 状态：active (running), 端口 8766 监听
- 已启用开机自启（enabled）

管理命令：
- systemctl --user status image-api
- journalctl --user -u image-api.service -f
- systemctl --user restart image-api

【关键文件】
- 项目：/home/sahn/image-api/
- 服务配置：~/.config/systemd/user/image-api.service
- 依赖环境：~/.hermes/hermes-agent/venv/bin/python
- 环境变量：/home/sahn/image-api/.env
- 前端：/home/sahn/image-api/frontend/index.html
- API 路由：image_api/router.py
- 服务逻辑：image_api/services/openai_img.py

══════════════════════════════════════════════
