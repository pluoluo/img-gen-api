# 开发约定

- image-api 是唯一日常开发和发布仓库。Infinite 相关修改在本仓库 `infinite/` 内完成，不再修改仓库外的旧 infinite-canvas checkout 或要求同步另一个仓库。
- Infinite 前端位于 `infinite/web/`；可选 Agent、代理和节点插件分别位于 `infinite/canvas-agent/`、`infinite/canvas-proxy/`、`infinite/plugins/`。
- 在仓库根目录执行 `venv/bin/python scripts/build_infinite.py` 构建并发布前端。生成文件和依赖不入 Git；其他环境拉取本仓库后也需要构建。
- 保留 `infinite/LICENSE`、`infinite/UPSTREAM.md` 及 README 中的项目来源和鸣谢。
- 验证生图和图库功能时使用隔离测试服务及临时数据目录；浏览器 fixture 必须启用 `INFINITE_OFFLINE_VALIDATION=1`，不能调用真实付费生成。
- 不覆盖用户已有修改，不把密钥、图库、浏览器数据或 Agent 运行配置提交到 Git。
