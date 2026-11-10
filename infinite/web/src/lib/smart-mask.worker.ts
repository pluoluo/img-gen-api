/// <reference lib="webworker" />
import { AutoModel, AutoProcessor, RawImage, Sam2Model, SamProcessor, Tensor, env } from "@huggingface/transformers";
import { modelWeightFiles, rankMaskCandidates, smartMaskDevice, type MaskCandidate, type SmartMaskBackend, type SmartMaskDtype, type SmartMaskRequest, type SmartMaskResponse } from "./smart-mask";

const scope = self as unknown as DedicatedWorkerGlobalScope;
let model: Sam2Model;
let processor: SamProcessor;
let inputs: { original_sizes: number[][]; reshaped_input_sizes: number[][] };
let embeddings: Awaited<ReturnType<Sam2Model["get_image_embeddings"]>>;
let predictions: { pred_masks: Tensor; iou_scores: Tensor } | undefined;
let candidates: MaskCandidate[] = [];
const reply = (message: SmartMaskResponse, transfer: Transferable[] = []) => scope.postMessage(message, transfer);

async function render(id: number, index: number) {
    if (!predictions || !candidates.some(candidate => candidate.index === index)) throw new Error("No selection candidate available");
    reply({ id, type: "status", stage: "rendering" });
    const selected = predictions.pred_masks.slice(null, null, [index, index + 1]);
    try {
        const masks = await processor.post_process_masks(selected, inputs.original_sizes, inputs.reshaped_input_sizes);
        const mask = masks[0];
        const data = new Uint8Array(mask.data);
        mask.dispose();
        reply({ id, type: "result", mask: { width: inputs.original_sizes[0][1], height: inputs.original_sizes[0][0], data }, candidates, selected: index }, [data.buffer]);
    } finally { selected.dispose(); }
}

scope.onmessage = async ({ data: request }: MessageEvent<SmartMaskRequest>) => {
    const id = request.id;
    try {
        if (request.type === "prepare") {
            const gpu = (scope.navigator as WorkerNavigator & { gpu?: Parameters<typeof smartMaskDevice>[1] }).gpu;
            let device = request.cpu ? { backend: "wasm" as const, dtype: "q8" as const } : await smartMaskDevice(scope.isSecureContext, gpu);
            env.allowLocalModels = true;
            env.allowRemoteModels = false;
            env.localModelPath = request.assetBase + "models/";
            env.useBrowserCache = typeof caches !== "undefined";
            env.backends.onnx.wasm!.wasmPaths = request.assetBase + "runtime/";
            const load = ({ backend, dtype }: { backend: SmartMaskBackend; dtype: SmartMaskDtype }) => {
                const files = modelWeightFiles(dtype);
                const total = files.reduce((sum, [, info]) => sum + info.bytes, 0);
                const loaded = new Map<string, number>();
                reply({ id, type: "status", stage: "loading", backend, dtype });
                return AutoModel.from_pretrained("sam2.1-tiny", {
                    device: backend, dtype, local_files_only: true, use_external_data_format: true,
                    progress_callback: (event) => {
                        if (event.status !== "progress" && event.status !== "done") return;
                        const file = files.find(([name]) => name === event.file);
                        if (!file) return;
                        loaded.set(file[0], event.status === "done" ? file[1].bytes : Math.min(file[1].bytes, event.loaded));
                        const bytes = [...loaded.values()].reduce((sum, value) => sum + value, 0);
                        reply({ id, type: "status", stage: bytes === total ? "compiling" : "loading", backend, dtype, progress: 100 * bytes / total });
                    },
                }) as Promise<Sam2Model>;
            };
            try { model = await load(device); }
            catch (error) {
                if (device.backend === "wasm") throw error;
                device = { backend: "wasm", dtype: "q8" };
                model = await load(device);
            }
            processor = await AutoProcessor.from_pretrained("sam2.1-tiny", { local_files_only: true }) as SamProcessor;
            reply({ id, type: "status", stage: "preprocessing", ...device });
            const image = await RawImage.fromURL(request.imageUrl);
            const processed = await processor(image);
            inputs = { original_sizes: processed.original_sizes, reshaped_input_sizes: processed.reshaped_input_sizes };
            reply({ id, type: "status", stage: "encoding", ...device });
            try { embeddings = await model.get_image_embeddings(processed); }
            finally { processed.pixel_values.dispose(); }
            reply({ id, type: "ready", ...device });
        } else if (request.type === "candidate") {
            await render(id, request.index);
        } else {
            predictions?.pred_masks.dispose(); predictions?.iou_scores.dispose(); predictions = undefined;
            const resized = inputs.reshaped_input_sizes[0];
            const points = new Tensor("float32", request.points.flatMap(point => [point.x * resized[1], point.y * resized[0]]), [1, 1, request.points.length, 2]);
            const labels = new Tensor("int64", request.points.map(point => BigInt(point.label)), [1, 1, request.points.length]);
            try {
                const output = await model({ ...embeddings, input_points: points, input_labels: labels });
                output.object_score_logits.dispose();
                predictions = output;
            } finally { points.dispose(); labels.dispose(); }
            const output = predictions!;
            const [height, width] = output.pred_masks.dims.slice(-2);
            candidates = rankMaskCandidates(output.iou_scores.data, index => request.points.filter(point => {
                const x = Math.min(width - 1, Math.floor(point.x * width));
                const y = Math.min(height - 1, Math.floor(point.y * height));
                return (Number(output.pred_masks.data[index * width * height + y * width + x]) > 0) !== Boolean(point.label);
            }).length);
            await render(id, candidates[0].index);
        }
    } catch (error) {
        reply({ id, type: "error", message: error instanceof Error ? error.message : String(error) });
    }
};
