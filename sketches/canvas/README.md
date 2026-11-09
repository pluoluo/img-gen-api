# Konva 画布交互原型

启动下方开发服务后，可以直接打开本目录 `index.html` 原型入口，或访问 `http://127.0.0.1:8099/canvas/`。原型与正式工作区共享 `canvas/src`，避免重复维护坐标、导出与交互两套实现。

```bash
cd canvas
npm ci
npm run dev
# http://127.0.0.1:8099/canvas/
npm run build
npm test
```

布局：左侧工具、中央画布、右侧上方的上下文工具参数、右侧下方的生成输入区。使用与原界面一致的深色、紫色强调色和系统中文字体。

坐标／文档／导出约定见 `canvas/ARCHITECTURE.md`。验证截图、PNG 及测试报告输出到 `canvas/test-results/`，生产入口验证产物位于 `canvas/production-test-results/`。
