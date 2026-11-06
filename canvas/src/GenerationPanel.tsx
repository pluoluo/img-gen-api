import { useEffect, useRef, useState } from "react";
import type { Asset, Picture, Point } from "./document";
import { id, worldPoint } from "./document";
import { exportPicture } from "./export";
import {
  getModelConfig,
  getRoute,
  getTask,
  getSubmission,
  submitGeneration,
} from "./api";
import type { GenerateInput, ImageResult, ModelConfig } from "./api";
export type Job = {
  id: string;
  taskId?: string;
  status: string;
  message: string;
  anchor: Point;
  sourceIds: string[];
  snapshot: {
    pictures: Picture[];
    prompt: string;
    model: string;
    size: string;
    quality: string;
    createdAt: string;
    kind: string;
    masked: boolean;
    preserve: boolean;
  };
  retryOf?: string;
};
export type GenerationState = {
  prompt: string;
  model: string;
  size: string;
  quality: string;
  refs: string[];
  masked: boolean;
  preserve: boolean;
  jobs: Job[];
};
export const EMPTY_GENERATION: GenerationState = {
  prompt: "",
  model: "gpt-image-2.5-flare",
  size: "auto",
  quality: "medium",
  refs: [],
  masked: false,
  preserve: true,
  jobs: [],
};
type Props = {
  initialState: GenerationState;
  onState: (state: GenerationState) => void;
  pictures: Picture[];
  assets: Record<string, Asset>;
  selected: string[];
  referenceRequest?: string[] | null;
  onJobs: (jobs: Job[]) => void;
  onResult: (job: Job, images: ImageResult[]) => Promise<void>;
};
export default function GenerationPanel(props: Props) {
  const [config, setConfig] = useState<ModelConfig>(),
    [configError, setConfigError] = useState(""),
    [fee, setFee] = useState("正在读取动态费用…");
  const [prompt, setPrompt] = useState(props.initialState.prompt),
    [model, setModel] = useState(props.initialState.model),
    [size, setSize] = useState(props.initialState.size),
    [quality, setQuality] = useState(props.initialState.quality),
    [refs, setRefs] = useState<string[]>(props.initialState.refs),
    [masked, setMasked] = useState(props.initialState.masked),
    [preserve, setPreserve] = useState(props.initialState.preserve),
    [jobs, setJobs] = useState<Job[]>(props.initialState.jobs),
    [preparing, setPreparing] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (props.referenceRequest) setRefs([...props.referenceRequest]);
  }, [props.referenceRequest]);
  const payloads = useRef(new Map<string, GenerateInput>()),
    results = useRef(new Map<string, ImageResult[]>()),
    busy = useRef(new Set<string>()),
    alive = useRef(true),
    latest = useRef(props);
  latest.current = props;
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  const update = (jobId: string, patch: Partial<Job>) =>
    setJobs((previous) =>
      previous.map((job) => (job.id === jobId ? { ...job, ...patch } : job)),
    );
  async function loadConfig() {
    try {
      setConfig(await getModelConfig());
      setConfigError("");
    } catch (e) {
      setConfigError(String(e));
    }
  }
  async function loadFee() {
    try {
      const data = await getRoute();
      const html = new DOMParser().parseFromString(data.hint, "text/html");
      setFee(html.body.textContent || "费用信息暂不可用");
    } catch {
      setFee("动态费用读取失败，请刷新费用后再确认。");
    }
  }
  useEffect(() => {
    alive.current = true;
    void loadConfig();
    void loadFee();
    const timer = setInterval(() => void loadFee(), 60000);
    return () => {
      clearInterval(timer);
      alive.current = false;
    };
  }, []);
  useEffect(() => props.onJobs(jobs), [jobs]);
  useEffect(
    () =>
      props.onState({
        prompt,
        model,
        size,
        quality,
        refs,
        masked,
        preserve,
        jobs,
      }),
    [prompt, model, size, quality, refs, masked, preserve, jobs],
  );
  useEffect(() => {
    for (const job of props.initialState.jobs) {
      if (
        ["pending", "running", "submitting", "fill_error"].includes(job.status)
      ) {
        if (job.taskId) void poll(job);
        else void recoverSubmission(job);
      }
    }
  }, []);
  const kind = config?.MODELS.find((m) => m.value === model)?.kind || "gpt";
  const options =
    kind === "gpt"
      ? [
          { value: "auto", label: "自动（参考图比例）" },
          ...(config?.SIZES.flatMap((s) =>
            Object.values(s.d).flatMap((d) =>
              d
                ? [
                    { value: d.join("x"), label: s.name + " · " + d.join("×") },
                    {
                      value: [d[1], d[0]].join("x"),
                      label: s.name + " 竖幅 · " + [d[1], d[0]].join("×"),
                    },
                  ]
                : [],
            ),
          ) || []),
        ]
      : config?.SIZE_OVERRIDES[model]?.values.map((v) => ({
          value: v,
          label: v,
        })) || [];
  const sizes = options.filter(
    (o, i, all) => all.findIndex((v) => v.value === o.value) === i,
  );
  async function fill(job: Job, images: ImageResult[]) {
    try {
      if (!images.length) throw new Error("任务未返回图片");
      if (!alive.current) return;
      await latest.current.onResult(job, images);
      results.current.delete(job.id);
      update(job.id, {
        status: "completed",
        message: "生成结果已作为新图片回填",
      });
    } catch (e) {
      results.current.set(job.id, images);
      update(job.id, {
        status: "fill_error",
        message: "结果回填失败：" + String(e),
      });
    }
  }
  async function poll(job: Job) {
    if (!job.taskId || busy.current.has(job.id)) return;
    busy.current.add(job.id);
    update(job.id, { status: "running", message: "正在查询任务" });
    try {
      while (alive.current) {
        let result;
        try {
          result = await getTask(job.taskId);
        } catch (e) {
          const message = String(e);
          update(job.id, {
            status: "query_error",
            message:
              message.includes("404") || message.includes("Task not found")
                ? "任务不存在，服务可能已重启。可手动创建新任务。"
                : "查询中断：" + message,
          });
          return;
        }
        if (!alive.current) return;
        if (result.status === "completed") {
          await fill(job, result.images);
          return;
        }
        if (result.status === "failed") {
          update(job.id, {
            status: "failed",
            message: result.error?.split("\n")[0] || "生成失败",
          });
          return;
        }
        update(job.id, {
          status: result.status,
          message: `${result.status === "pending" ? "排队中" : "生成中"} · ${result.progress}%`,
        });
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    } finally {
      busy.current.delete(job.id);
    }
  }
  async function buildInput(job: Job): Promise<GenerateInput> {
    const saved = job.snapshot;
    const input: GenerateInput = {
      model: saved.kind === "gpt" ? "auto" : saved.kind,
      sub_model: saved.model,
      prompt: saved.prompt.trim(),
      size: saved.size,
      n: 1,
      client_request_id: job.id,
    };
    if (saved.kind === "gpt") input.quality = saved.quality;
    if (saved.pictures.length) {
      input.image_base64s = [];
      for (const picture of saved.pictures) {
        const asset = latest.current.assets[picture.assetId];
        if (!asset) throw new Error("历史参考图资源缺失，请重新打开画布");
        input.image_base64s.push(
          (await exportPicture(asset, picture, "reference"))
            .toDataURL()
            .split(",")[1],
        );
      }
    }
    if (saved.masked) {
      const picture = saved.pictures[0],
        asset = latest.current.assets[picture.assetId];
      if (!picture?.regions.length) throw new Error("请先圈选或涂抹修改区域");
      input.mask_base64 = (await exportPicture(asset, picture, "mask"))
        .toDataURL()
        .split(",")[1];
      input.mask_reference_index = 0;
      input.preserve_outside_mask = saved.preserve;
      if (saved.preserve)
        input.preserve_source_base64 = (
          await exportPicture(asset, picture, "original")
        )
          .toDataURL()
          .split(",")[1];
    }
    return input;
  }
  async function recoverSubmission(job: Job) {
    try {
      const result = await getSubmission(job.id);
      if (!alive.current) return;
      update(job.id, { taskId: result.task_id });
      void poll({ ...job, taskId: result.task_id });
    } catch {
      if (alive.current)
        update(job.id, {
          status: "submit_error",
          message: "提交结果未能确认。不会自动重新生成，可手动重试同一请求。",
        });
    }
  }
  async function send(job: Job) {
    if (busy.current.has(job.id)) return;
    busy.current.add(job.id);
    let submitted: Job | undefined;
    update(job.id, { status: "submitting", message: "正在提交，请勿重复操作" });
    try {
      const payload = payloads.current.get(job.id) || (await buildInput(job));
      payloads.current.set(job.id, payload);
      if (!alive.current) return;
      const response = await submitGeneration(payload);
      submitted = { ...job, taskId: response.task_id };
      update(job.id, {
        taskId: response.task_id,
        status: "pending",
        message: "已提交，等待生成",
      });
    } catch (e) {
      update(job.id, {
        status: "submit_error",
        message: "提交未确认：" + String(e) + "。重试将沿用同一提交 ID。",
      });
    } finally {
      busy.current.delete(job.id);
    }
    if (submitted) void poll(submitted);
  }
  async function prepare() {
    if (preparing) return;
    setPreparing(true);
    setError("");
    const current = latest.current,
      pictures = refs.map((ref) => current.pictures.find((p) => p.id === ref));
    try {
      if (!prompt.trim()) throw new Error("请输入生成描述");
      if (pictures.some((p) => !p)) throw new Error("参考图已删除，请重新选择");
      if (masked && (kind !== "gpt" || !pictures.length))
        throw new Error("PNG mask 需要 GPT 模型和第一张主参考图");
      const snapshot = structuredClone(pictures as Picture[]),
        jobId = id();
      const right = current.pictures.flatMap((p) => {
        const a = current.assets[p.assetId],
          c = p.crop || { x: 0, y: 0, width: a.width, height: a.height };
        return [
          { x: c.x, y: c.y },
          { x: c.x + c.width, y: c.y },
          { x: c.x, y: c.y + c.height },
          { x: c.x + c.width, y: c.y + c.height },
        ].map((q) => worldPoint(q, p).x);
      });
      const anchor = {
        x:
          Math.max(
            0,
            ...right,
            ...jobsRef.current.map((j) => j.anchor.x + 600),
          ) + 80,
        y: 0,
      };
      const job: Job = {
        id: jobId,
        status: "submitting",
        message: "准备输入",
        anchor,
        sourceIds: snapshot.map((p) => p.id),
        snapshot: {
          pictures: snapshot,
          prompt,
          model,
          size,
          quality,
          createdAt: new Date().toISOString(),
          kind,
          masked,
          preserve,
        },
      };
      const input = await buildInput(job);
      if (!alive.current) return;
      payloads.current.set(jobId, input);
      setJobs((previous) => [...previous, job]);
      void send(job);
    } catch (e) {
      setError(String(e));
    } finally {
      setPreparing(false);
    }
  }
  function regenerate(job: Job) {
    const original = payloads.current.get(job.id);
    const jobId = id(),
      next = {
        ...job,
        id: jobId,
        taskId: undefined,
        status: "submitting",
        message: "重新提交",
        anchor: {
          x: Math.max(...jobsRef.current.map((j) => j.anchor.x + 600)) + 80,
          y: job.anchor.y,
        },
        retryOf: job.id,
      };
    if (original)
      payloads.current.set(jobId, { ...original, client_request_id: jobId });
    setJobs((previous) => [...previous, next]);
    void send(next);
  }
  return (
    <section className="generation-panel" aria-label="图片生成">
      <div className="composer-heading">
        <h2>图片生成</h2>
        <span>{refs.length ? `${refs.length} 张参考图` : "文生图"}</span>
      </div>
      <div className="composer-scroll">
        <div className="generation-inputs" aria-label="生成参考图">
          <div className="pair">
            <button onClick={() => setRefs([...props.selected])}>
              选中图片作为参考
            </button>
            <button onClick={() => setRefs([])}>纯文本生成</button>
          </div>
          <ol>
            {refs.map((ref, i) => (
              <li key={ref}>
                {props.assets[
                  props.pictures.find((p) => p.id === ref)?.assetId || ""
                ] && (
                  <img
                    className="reference-thumb"
                    src={
                      props.assets[
                        props.pictures.find((p) => p.id === ref)!.assetId
                      ].url
                    }
                    alt="参考图预览"
                  />
                )}
                <span>
                  {i === 0 ? "主参考图" : "参考图 " + (i + 1)} ·{" "}
                  {props.assets[
                    props.pictures.find((p) => p.id === ref)?.assetId || ""
                  ]?.name || "已删除"}
                </span>
                <button
                  disabled={i === 0}
                  aria-label={"前移参考图 " + (i + 1)}
                  onClick={() =>
                    setRefs((list) => {
                      const next = [...list];
                      [next[i - 1], next[i]] = [next[i], next[i - 1]];
                      return next;
                    })
                  }
                >
                  前移
                </button>
                <button
                  aria-label={"移除参考图 " + (i + 1)}
                  onClick={() =>
                    setRefs((list) => list.filter((v) => v !== ref))
                  }
                >
                  移除
                </button>
              </li>
            ))}
          </ol>
        </div>
        <div className="generation-form">
          <div className="prompt-heading">
            <label htmlFor="generation-prompt">生成描述</label>
            <span>{prompt.length} 字</span>
          </div>
          <textarea
            id="generation-prompt"
            aria-label="生成描述"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={9}
            placeholder="描述你希望生成或修改的内容。支持长提示词，可拖动右下角调整输入框高度。"
          />
        </div>
        {configError && (
          <p role="alert">
            {configError}
            <button onClick={() => void loadConfig()}>重试配置</button>
          </p>
        )}
        {error && <p role="alert">{error}</p>}
      </div>
      <div className="generation-options">
        <div className="generation-settings">
          <label>
            生成模型
            <select
              aria-label="生成模型"
              value={model}
              disabled={!config}
              onChange={(e) => {
                const value = e.target.value;
                setModel(value);
                setSize(
                  config?.MODELS.find((m) => m.value === value)?.kind === "gpt"
                    ? "auto"
                    : "1:1",
                );
              }}
            >
              {config?.MODELS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            生成尺寸
            <select
              aria-label="生成尺寸"
              value={size}
              onChange={(e) => setSize(e.target.value)}
            >
              {sizes.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            生成质量
            <select
              aria-label="生成质量"
              value={quality}
              disabled={kind !== "gpt"}
              onChange={(e) => setQuality(e.target.value)}
            >
              <option value="low">低</option>
              <option value="medium">中</option>
              <option value="high">高</option>
            </select>
          </label>
        </div>
        <div className="local-edit-settings">
          <label className="check">
            <input
              type="checkbox"
              checked={masked}
              onChange={(e) => setMasked(e.target.checked)}
            />
            使用主参考图 PNG mask
          </label>
          {masked && (
            <label className="check">
              <input
                type="checkbox"
                checked={preserve}
                disabled={!masked}
                onChange={(e) => setPreserve(e.target.checked)}
              />
              区域外保持原图（原图分辨率）
            </label>
          )}
          {masked && kind !== "gpt" && (
            <p role="alert">所选模型不支持 PNG mask，请选择 GPT Image。</p>
          )}
        </div>
      </div>
      <div className="generation-submit">
        <div className="generation-feedback">
          <span>{fee}</span>
          <button onClick={() => void loadFee()}>刷新费用</button>
        </div>
        <button
          className="generate-action"
          disabled={
            preparing || !config || !prompt.trim() || (masked && kind !== "gpt")
          }
          onClick={() => void prepare()}
        >
          {preparing ? "正在准备输入…" : "生成图片"}
        </button>
      </div>
      {jobs.length > 0 && (
        <section className="job-list" aria-label="生成任务">
          {jobs.map((job) => (
            <div key={job.id}>
              <strong>{job.snapshot.prompt.slice(0, 24)}</strong>
              <span>{job.message}</span>
              <code>{job.taskId || job.id}</code>
              <details>
                <summary>输入快照</summary>
                <p>
                  {job.snapshot.createdAt} · {job.snapshot.model} ·{" "}
                  {job.snapshot.size} · {job.snapshot.quality}
                </p>
                <p>
                  {job.sourceIds.length} 张参考图；
                  {job.snapshot.pictures.map((p) => p.id).join(", ") ||
                    "纯文本"}
                </p>
              </details>
              {job.status === "submit_error" && (
                <button onClick={() => void send(job)}>
                  重试提交（同一请求）
                </button>
              )}
              {job.status === "query_error" && (
                <>
                  <button onClick={() => void poll(job)}>继续查询</button>
                  <button onClick={() => regenerate(job)}>
                    重新生成（新任务）
                  </button>
                </>
              )}
              {job.status === "failed" && (
                <button onClick={() => regenerate(job)}>
                  重新生成（新任务）
                </button>
              )}
              {job.status === "fill_error" && (
                <button
                  onClick={() =>
                    void fill(job, results.current.get(job.id) || [])
                  }
                >
                  重试回填
                </button>
              )}
            </div>
          ))}
        </section>
      )}
    </section>
  );
}
