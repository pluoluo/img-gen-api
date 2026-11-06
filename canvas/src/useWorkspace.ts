import { useEffect, useRef, useState } from "react";
import { id } from "./document";
import {
  backup,
  getProject,
  getProjects,
  getRevisions,
  readActive,
  restoreAssets,
  saveProject,
  signature,
  uploadAssets,
} from "./workspaceStorage";
import type { WorkspaceSnapshot, Checkpoint } from "./workspaceStorage";
export function useWorkspace(
  snapshot: WorkspaceSnapshot,
  onRestore: (value: WorkspaceSnapshot) => void,
) {
  const [ready, setReady] = useState(false),
    [epoch, setEpoch] = useState(0),
    [projectId, setProjectId] = useState(() => id()),
    [title, setTitle] = useState("未命名画布"),
    [revision, setRevision] = useState(0),
    [status, setStatus] = useState("正在恢复画布…"),
    [error, setError] = useState("");
  const apply = useRef(onRestore);
  apply.current = onRestore;
  const current = useRef({ snapshot, projectId, title });
  current.current = { snapshot, projectId, title };
  const revisionRef = useRef(0),
    savedSignature = useRef(""),
    safeSignature = useRef(""),
    localQueue = useRef(Promise.resolve()),
    inFlight = useRef<Promise<void> | null>(null),
    booted = useRef(false),
    localUnsafe = useRef(false),
    serverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const serialized = signature(snapshot, title);
  if (ready && serialized !== safeSignature.current) localUnsafe.current = true;
  const localWrite = (checkpoint: Checkpoint) => {
    const expected = signature(checkpoint.snapshot, checkpoint.title);
    localUnsafe.current = true;
    const promise = localQueue.current
      .catch(() => {})
      .then(() => backup(checkpoint));
    localQueue.current = promise;
    promise
      .then(() => {
        safeSignature.current = expected;
        localUnsafe.current =
          safeSignature.current !==
          signature(current.current.snapshot, current.current.title);
      })
      .catch((e) => {
        setError("本地备份失败：" + String(e));
      });
    return promise;
  };
  async function flush() {
    if (inFlight.current) {
      await inFlight.current;
      if (
        signature(current.current.snapshot, current.current.title) !==
        savedSignature.current
      )
        return flush();
      return;
    }
    const task = (async () => {
      while (true) {
        const work = current.current,
          expected = signature(work.snapshot, work.title);
        if (savedSignature.current === expected) return;
        setStatus("正在保存到服务器…");
        setError("");
        await localWrite({
          ...work,
          revision: revisionRef.current,
          dirty: true,
        });
        const durable = await uploadAssets(work.snapshot);
        const result = await saveProject(
          work.projectId,
          work.title,
          durable,
          revisionRef.current,
        );
        revisionRef.current = result.revision;
        setRevision(result.revision);
        savedSignature.current = expected;
        await localWrite({
          ...current.current,
          revision: result.revision,
          dirty:
            signature(current.current.snapshot, current.current.title) !==
            expected,
        });
        setStatus("已保存 · 版本 " + result.revision);
        if (
          signature(current.current.snapshot, current.current.title) ===
          expected
        )
          return;
      }
    })();
    inFlight.current = task;
    try {
      await task;
    } catch (e) {
      setError(String(e));
      setStatus("服务器保存失败 · 本地备份保留");
      throw e;
    } finally {
      inFlight.current = null;
    }
  }
  async function install(checkpoint: Checkpoint, restored: boolean) {
    const resolved = await restoreAssets(checkpoint.snapshot);
    revisionRef.current = checkpoint.revision;
    setProjectId(checkpoint.projectId);
    setTitle(checkpoint.title);
    setRevision(checkpoint.revision);
    savedSignature.current = checkpoint.dirty
      ? ""
      : signature(resolved, checkpoint.title);
    safeSignature.current = signature(resolved, checkpoint.title);
    current.current = {
      snapshot: resolved,
      title: checkpoint.title,
      projectId: checkpoint.projectId,
    };
    apply.current(resolved);
    setEpoch((value) => value + 1);
    setReady(true);
    setError("");
    setStatus(
      restored
        ? "已恢复历史版本 · 后续编辑将保存为新版本"
        : checkpoint.dirty
          ? "已恢复本地备份 · 等待同步"
          : "已恢复 · 版本 " + checkpoint.revision,
    );
  }
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    let alive = true;
    (async () => {
      try {
        const local = await readActive();
        if (!alive) return;
        if (local) {
          let chosen = local;
          if (!local.dirty && local.revision) {
            try {
              const remote = await getProject(local.projectId);
              chosen = {
                projectId: remote.id,
                title: remote.title,
                revision: remote.head_revision,
                dirty: false,
                snapshot: remote.snapshot,
              };
            } catch {
              /* The complete local backup remains usable offline. */
            }
          }
          if (alive) await install(chosen, false);
        } else {
          setReady(true);
          setStatus("新画布 · 自动保存已开启");
        }
      } catch (e) {
        setError("恢复失败：" + String(e));
        setStatus("历史画布未被覆盖，请重试恢复");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (!ready) return;
    const work = current.current,
      expected = signature(work.snapshot, work.title);
    if (expected === savedSignature.current) return;
    setStatus("本地备份中…");
    localUnsafe.current = true;
    const localTimer = setTimeout(() => {
      void localWrite({ ...work, revision: revisionRef.current, dirty: true })
        .then(() => {
          if (
            expected !== savedSignature.current &&
            expected ===
            signature(current.current.snapshot, current.current.title)
          )
            setStatus("已备份到本机 · 等待服务器保存");
        })
        .catch(() => {});
    }, 80);
    serverTimer.current = setTimeout(() => {
      void flush().catch(() => {});
    }, 1000);
    return () => {
      clearTimeout(localTimer);
      clearTimeout(serverTimer.current);
    };
  }, [serialized, ready, projectId]);
  useEffect(() => {
    if (!ready) return;
    const timer = setInterval(() => { void flush().catch(() => {}); }, 5000);
    return () => clearInterval(timer);
  }, [ready, projectId]);
  useEffect(() => {
    const before = (event: BeforeUnloadEvent) => {
      if (localUnsafe.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, []);
  async function open(project: string, version?: number) {
    setReady(false);
    clearTimeout(serverTimer.current);
    try {
      await flush();
      const result = await getProject(project, version);
      await install(
        {
          projectId: project,
          title: result.title,
          revision: result.head_revision,
          snapshot: result.snapshot,
          dirty: !!version && version !== result.head_revision,
        },
        !!version && version !== result.head_revision,
      );
    } catch (e) {
      setReady(true);
      setError(String(e));
    }
  }
  async function create(copy = false) {
    setReady(false);
    clearTimeout(serverTimer.current);
    try {
      if (copy)
        await localWrite({
          ...current.current,
          revision: revisionRef.current,
          dirty: true,
        });
      else await flush();
      const work = current.current;
      const empty: WorkspaceSnapshot = {
        ...work.snapshot,
        document: { schemaVersion: 1, images: [] },
        assets: {},
        view: { x: 40, y: 40, scale: 0.7 },
        history: { past: [], future: [] },
        selection: [],
        generator: {
          ...work.snapshot.generator,
          prompt: "",
          refs: [],
          jobs: [],
          masked: false,
        },
      };
      await install(
        {
          projectId: id(),
          title: copy ? work.title.slice(0, 115) + " · 副本" : "未命名画布",
          revision: 0,
          dirty: true,
          snapshot: copy ? work.snapshot : empty,
        },
        false,
      );
    } catch (e) {
      setReady(true);
      setError(String(e));
    }
  }
  return {
    ready,
    epoch,
    projectId,
    title,
    setTitle,
    revision,
    status,
    error,
    save: () => flush(),
    open,
    create,
    projects: getProjects,
    revisions: (offset = 0) => getRevisions(projectId, offset),
    retryRestore: async () => {
      try {
        const local = await readActive();
        if (local) await install(local, false);
        else {
          setError("");
          setReady(true);
        }
      } catch (e) {
        setError(String(e));
      }
    },
  };
}
export type WorkspaceController = ReturnType<typeof useWorkspace>;
