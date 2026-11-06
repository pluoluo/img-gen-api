export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch("/api/v1" + path, init);
  if (!response.ok) {
    let detail = `请求失败（${response.status}）`;
    try {
      const body = await response.json();
      detail = typeof body.detail === "string" ? body.detail : detail;
    } catch {}
    throw new Error(detail);
  }
  return response.json();
}
export type GalleryItem = {
  id: string;
  filename: string;
  thumb_filename?: string;
  prompt: string;
};
export const getGallery = () =>
  request<{ items: GalleryItem[]; total: number }>("/gallery?limit=50");
export type GenerateInput = {
  model: string;
  sub_model: string;
  prompt: string;
  size: string;
  n: number;
  quality?: string;
  image_base64s?: string[];
  mask_base64?: string;
  mask_reference_index?: number;
  preserve_outside_mask?: boolean;
  preserve_source_base64?: string;
  client_request_id: string;
};
export type ImageResult = {
  base64?: string;
  url?: string;
  adjusted_size?: string;
  upstream_size?: string;
};
export type TaskResult = {
  task_id: string;
  status: "pending" | "running" | "completed" | "failed";
  progress: number;
  images: ImageResult[];
  error?: string;
};
export const submitGeneration = (input: GenerateInput) =>
  request<{ task_id: string }>("/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
export const getTask = (id: string) =>
  request<TaskResult>("/tasks/" + encodeURIComponent(id));
export const getRoute = () => request<{ hint: string }>("/gpt-route");
export type ModelConfig = {
  MODELS: { value: string; label: string; kind: string }[];
  SIZE_OVERRIDES: Record<string, { values: string[]; labels: string[] }>;
  SIZES: { name: string; d: Record<string, number[] | null> }[];
};
export async function getModelConfig(): Promise<ModelConfig> {
  const response = await fetch("/workspace-assets/model-config.json");
  if (!response.ok) throw new Error("模型配置加载失败，请重试");
  return response.json();
}

export const getSubmission = (id: string) =>
  request<{ task_id: string }>("/submissions/" + encodeURIComponent(id));
