import { useEffect, useState } from "react";
import type { WorkspaceController } from "./useWorkspace";
import type { ProjectInfo, RevisionInfo } from "./workspaceStorage";
export default function ProjectControls({
  workspace: w,
}: {
  workspace: WorkspaceController;
}) {
  const [open, setOpen] = useState(false),
    [tab, setTab] = useState<"versions" | "projects">("versions"),
    [projects, setProjects] = useState<ProjectInfo[]>([]),
    [versions, setVersions] = useState<RevisionInfo[]>([]),
    [total, setTotal] = useState(0),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  async function load(more = false) {
    setLoading(true);
    setError("");
    try {
      if (tab === "versions") {
        const result = await w.revisions(more ? versions.length : 0);
        setVersions((previous) =>
          more ? [...previous, ...result.items] : result.items,
        );
        setTotal(result.total);
      } else {
        const result = await w.projects(more ? projects.length : 0);
        setProjects((previous) =>
          more ? [...previous, ...result.items] : result.items,
        );
        setTotal(result.total);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (open) void load();
  }, [open, tab, w.projectId, w.revision]);
  return (
    <>
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        历史画布
      </button>
      {open && (
        <section className="history-browser" aria-label="历史画布">
          <div className="history-heading">
            <h2>画布与历史版本</h2>
            <button onClick={() => setOpen(false)}>关闭历史</button>
          </div>
          <label>
            画布名称
            <input
              aria-label="画布名称"
              value={w.title}
              maxLength={120}
              onChange={(e) => w.setTitle(e.target.value)}
              onBlur={() => {
                if (!w.title.trim()) w.setTitle("未命名画布");
              }}
            />
          </label>
          <p className="project-save-state" role="status">
            {w.status}
          </p>
          {w.error && <p role="alert">{w.error}</p>}
          <div className="history-actions">
            <button
              onClick={() =>
                void w
                  .save()
                  .then(() => load())
                  .catch(() => {})
              }
            >
              保存当前版本
            </button>
            <button onClick={() => void w.create().then(() => setOpen(false))}>
              新建画布
            </button>
            <button
              onClick={() => void w.create(true).then(() => setOpen(false))}
            >
              另存为新画布
            </button>
          </div>
          <div className="history-tabs" role="tablist" aria-label="历史范围">
            <button
              role="tab"
              aria-selected={tab === "versions"}
              onClick={() => setTab("versions")}
            >
              当前画布版本
            </button>
            <button
              role="tab"
              aria-selected={tab === "projects"}
              onClick={() => setTab("projects")}
            >
              已保存画布
            </button>
          </div>
          <p>打开旧版本后继续编辑会保存为新版本，后面的版本仍然保留。</p>
          {error && (
            <p role="alert">
              {error}
              <button onClick={() => void load()}>重试加载</button>
            </p>
          )}
          {loading && <p role="status">正在读取历史…</p>}
          <div className="history-items">
            {tab === "versions"
              ? versions.map((v) => (
                  <button
                    key={v.revision}
                    onClick={() =>
                      void w
                        .open(w.projectId, v.revision)
                        .then(() => setOpen(false))
                    }
                  >
                    <strong>
                      打开版本 {v.revision}
                      {v.revision === w.revision ? " · 当前保存点" : ""}
                    </strong>
                    <span>
                      {new Date(v.created_at).toLocaleString()} ·{" "}
                      {v.image_count} 张图片
                    </span>
                  </button>
                ))
              : projects.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => void w.open(p.id).then(() => setOpen(false))}
                  >
                    <strong>{p.title}</strong>
                    <span>
                      {new Date(p.updated_at).toLocaleString()} · 版本{" "}
                      {p.head_revision}
                    </span>
                  </button>
                ))}
          </div>
          {!loading &&
            !error &&
            (tab === "versions" ? versions.length : projects.length) === 0 && (
              <p>还没有保存记录。编辑后会自动保存，也可以保存当前版本。</p>
            )}
          {(tab === "versions" ? versions.length : projects.length) < total && (
            <button disabled={loading} onClick={() => void load(true)}>
              加载更多历史
            </button>
          )}
        </section>
      )}
    </>
  );
}
