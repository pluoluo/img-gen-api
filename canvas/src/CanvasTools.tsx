import { useLayoutEffect, useRef, useState } from "react";
import type { Asset, Picture } from "./document";
import { worldPoint } from "./document";

export type Tool =
  | "select"
  | "pan"
  | "pen"
  | "arrow"
  | "text"
  | "crop"
  | "lasso"
  | "brush"
  | "erase";
export const tools: [Tool, string][] = [
  ["select", "选择"],
  ["pan", "平移"],
  ["pen", "画笔标记"],
  ["arrow", "箭头"],
  ["text", "文字"],
  ["crop", "裁剪"],
  ["lasso", "圈选区域"],
  ["brush", "涂抹区域"],
  ["erase", "擦除区域"],
];
type IconName = Tool | "reference" | "copy" | "download" | "focus";
const paths: Record<IconName, string> = {
  select: "m5 3 14 9-7 1-3 7Z",
  pan: "M8 12V6a2 2 0 0 1 4 0v6m0-2V4a2 2 0 0 1 4 0v8m0-3a2 2 0 0 1 4 0v6c0 4-3 7-7 7-3 0-5-2-7-5l-3-5a2 2 0 0 1 3-2l2 2",
  pen: "m4 16 11-11 4 4L8 20H4Zm9-9 4 4M4 20l4-1",
  arrow: "M5 19 19 5M7 5h12v12",
  text: "M4 6V4h16v2M12 4v16m-4 0h8",
  crop: "M7 3v14h14M3 7h14v14",
  lasso:
    "M8 18c-4-1-6-4-5-8 1-5 11-7 16-3 5 4 1 10-5 11-5 1-7-1-6-3 1-2 5 0 4 3-1 2-3 4-6 4",
  brush: "m13 4 7 7M6 11l9-9 7 7-9 9-7-7Zm0 0-3 9 10-2M5 15l4 4",
  erase:
    "m3 14 9-10a2 2 0 0 1 3 0l6 6a2 2 0 0 1 0 3l-7 7H9l-6-6Zm4-4 10 10M9 20h13",
  reference:
    "M13 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-8M3 16l5-5 5 5 3-3 5 5M18 2v6m-3-3h6M8 7h.01",
  copy: "M9 9h12v12H9ZM15 9V3H3v12h6",
  download: "M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5",
  focus: "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M8 8h8v8H8Z",
};
export function ToolIcon({ name }: { name: IconName }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
type ToolSettings = {
  color: string;
  width: number;
  fontFamily: string;
  fontSize: number;
  text: string;
};
export function ToolDock({
  tool,
  onTool,
  settings,
  onSettings,
  editing,
  onApply,
  cropped,
  onRestoreCrop,
  hasRegions,
  onClearRegions,
}: {
  tool: Tool;
  onTool: (tool: Tool) => void;
  settings: ToolSettings;
  onSettings: (settings: Partial<ToolSettings>) => void;
  editing: boolean;
  onApply: () => void;
  cropped: boolean;
  onRestoreCrop: () => void;
  hasRegions: boolean;
  onClearRegions: () => void;
}) {
  const annotation = tool === "text" || tool === "pen" || tool === "arrow";
  const stroke =
    tool === "pen" || tool === "arrow" || tool === "brush" || tool === "erase";
  const region = tool === "lasso" || tool === "brush" || tool === "erase";
  const numeric = (value: string, min: number, max: number) =>
    Math.max(min, Math.min(max, Number(value) || min));
  return (
    <nav className="canvas-dock" aria-label="画布工具">
      {(annotation || region || tool === "crop") && (
        <section
          className="dock-parameters"
          aria-label="工具快捷参数"
          data-tool={tool}
        >
          <div className="dock-parameter-row">
            {annotation && (
              <label className="dock-color">
                颜色
                <input
                  aria-label="标注颜色"
                  type="color"
                  value={settings.color}
                  onChange={(e) => onSettings({ color: e.target.value })}
                />
              </label>
            )}
            {tool === "text" && (
              <>
                <label className="dock-font">
                  字体
                  <select
                    aria-label="字体"
                    value={settings.fontFamily}
                    onChange={(e) => onSettings({ fontFamily: e.target.value })}
                  >
                    <option value="sans-serif">黑体 / 无衬线</option>
                    <option value="serif">宋体 / 衬线</option>
                    <option value="monospace">等宽</option>
                  </select>
                </label>
                <label className="dock-size">
                  字号
                  <input
                    type="number"
                    aria-label="字号"
                    min="8"
                    max="300"
                    value={settings.fontSize}
                    onChange={(e) =>
                      onSettings({ fontSize: numeric(e.target.value, 8, 300) })
                    }
                  />
                </label>
              </>
            )}
            {stroke && (
              <label className="dock-stroke">
                笔宽 <span>px</span>
                <input
                  aria-label="画笔宽度（原图像素）"
                  type="number"
                  min="1"
                  max="500"
                  value={settings.width}
                  onChange={(e) =>
                    onSettings({ width: numeric(e.target.value, 1, 500) })
                  }
                />
              </label>
            )}
            {tool === "crop" && (
              <>
                <span className="dock-instruction">拖动图片，框选裁剪范围</span>
                <button
                  className="dock-action"
                  disabled={!cropped}
                  onClick={onRestoreCrop}
                >
                  恢复裁剪
                </button>
              </>
            )}
            {region && (
              <>
                <span className="dock-instruction">
                  {tool === "lasso"
                    ? "描绘需要修改的区域"
                    : tool === "erase"
                      ? "擦除已选区域"
                      : "涂抹需要修改的区域"}
                </span>
                <button
                  className="dock-action"
                  disabled={!hasRegions}
                  onClick={onClearRegions}
                >
                  清空修改区域
                </button>
              </>
            )}
          </div>
          {tool === "text" && (
            <label className="dock-text">
              文字内容
              <input
                aria-label="文字内容"
                value={settings.text}
                onChange={(e) => onSettings({ text: e.target.value })}
                placeholder="输入文字，再点击图片放置"
              />
            </label>
          )}
          {editing && (
            <div className="dock-editing">
              <span>正在编辑已有标注</span>
              <button className="dock-action" onClick={onApply}>
                应用属性到标注
              </button>
            </div>
          )}
        </section>
      )}
      <div className="dock-tools">
        {tools.map(([key, label], index) => (
          <button
            key={key}
            className={index === 2 || index === 5 ? "tool-group-start" : ""}
            aria-label={label}
            title={label}
            aria-pressed={tool === key}
            onClick={() => onTool(key)}
          >
            <ToolIcon name={key} />
            <span className="tool-tooltip" aria-hidden="true">
              {label}
            </span>
          </button>
        ))}
      </div>
    </nav>
  );
}
export function ImageToolbar({
  pictures,
  assets,
  view,
  size,
  hidden,
  onTool,
  onReference,
  onCopy,
  onExport,
  onFocus,
}: {
  pictures: Picture[];
  assets: Record<string, Asset>;
  view: { x: number; y: number; scale: number };
  size: { width: number; height: number };
  hidden: boolean;
  onTool: (tool: Tool) => void;
  onReference: () => void;
  onCopy: () => void;
  onExport: () => void;
  onFocus: () => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 560, height: 48 });
  useLayoutEffect(() => {
    if (!element.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setDimensions({
        width: entry.target.clientWidth,
        height: entry.target.clientHeight,
      }),
    );
    observer.observe(element.current);
    return () => observer.disconnect();
  }, []);
  const corners = pictures.flatMap((p) => {
    const a = assets[p.assetId];
    if (!a) return [];
    const c = p.crop || { x: 0, y: 0, width: a.width, height: a.height };
    return [
      { x: c.x, y: c.y },
      { x: c.x + c.width, y: c.y },
      { x: c.x, y: c.y + c.height },
      { x: c.x + c.width, y: c.y + c.height },
    ].map((point) => {
      const w = worldPoint(point, p);
      return { x: w.x * view.scale + view.x, y: w.y * view.scale + view.y };
    });
  });
  const left = Math.min(...corners.map((p) => p.x)),
    right = Math.max(...corners.map((p) => p.x));
  const top = Math.min(...corners.map((p) => p.y)),
    bottom = Math.max(...corners.map((p) => p.y));
  const visible =
    corners.length > 0 &&
    right > 0 &&
    left < size.width &&
    bottom > 0 &&
    top < size.height;
  const x = Math.max(
    12,
    Math.min(
      (left + right - dimensions.width) / 2,
      size.width - dimensions.width - 12,
    ),
  );
  const y =
    top >= dimensions.height + 20
      ? top - dimensions.height - 16
      : bottom + dimensions.height + 100 < size.height
        ? bottom + 16
        : 12;
  const actions: [IconName, string, string, () => void][] = [
    ["reference", "设为参考", "将选中图片设为生成参考", onReference],
    ["crop", "裁剪", "裁剪图片", () => onTool("crop")],
    ["pen", "标注", "标注图片", () => onTool("pen")],
    ["lasso", "圈选", "圈选修改区域", () => onTool("lasso")],
    ["focus", "聚焦", "聚焦选中图片", onFocus],
    ["copy", "复制", "复制选中图片", onCopy],
    ["download", "导出", "导出含标注图片", onExport],
  ];
  return (
    <div
      ref={element}
      className="image-toolbar"
      role="toolbar"
      aria-label="选中图片操作"
      hidden={hidden || !visible}
      style={{
        left: x,
        top: Math.min(y, Math.max(12, size.height - dimensions.height - 100)),
      }}
    >
      {pictures.length > 1 && (
        <span className="selection-count">{pictures.length} 张</span>
      )}
      {actions.map(([icon, label, name, action]) => (
        <button key={name} aria-label={name} title={name} onClick={action}>
          <ToolIcon name={icon} />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}
