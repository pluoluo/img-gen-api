# Infinite Canvas 来源

本目录的源码已并入 image-api；后续开发和部署只维护 image-api 仓库。

- 原始项目：[basketikun/infinite-canvas](https://github.com/basketikun/infinite-canvas)
- 集成来源：[pluoluo/infinite-canvas](https://github.com/pluoluo/infinite-canvas)，`integration/image-api` 分支
- 导入提交：`7a89ff3e1f6beff6f759d85e18f9c0d407879f45`；原始上游基线为 `9cd3dea`。
- 许可证：[MIT](LICENSE)，保留原作者 `Copyright (c) 2026 basketikun`。

导入时保留前端、Agent、代理、插件、文档、版本记录和原项目说明；不导入旧仓库的 Git 数据、GitHub 工作流、开发技能包、本机依赖、构建产物或运行数据。旧版独立部署配置与 [原项目 README](README.md) 作为来源资料保留；image-api 的部署方式以 [主 README](../README.md) 为准。

日常修改直接提交到 image-api。需要参考上游更新时，在本仓库中审查并移植相应变更，无需维护另一个本地 checkout。`web/` 的构建仍读取本目录的 `VERSION` 和 `CHANGELOG.md`。

从 image-api 根目录执行：

```bash
venv/bin/python scripts/build_infinite.py
```

只运行网站不需要另外启动 Vite。Canvas Agent 和代理是可选独立进程，其配置与数据不随 Git 同步；源码已在本目录内。
