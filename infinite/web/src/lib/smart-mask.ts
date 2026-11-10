import model from "./smart-mask-models.json";

export type SmartMaskPoint = { x: number; y: number; label: 0 | 1 };
export type BinaryMask = { width: number; height: number; data: Uint8Array };
export type SmartMaskBackend = "webgpu" | "wasm";
export type SmartMaskDtype = "q8" | "fp16" | "fp32";
export type SmartMaskStage = "idle" | "loading" | "compiling" | "preprocessing" | "encoding" | "ready" | "selecting" | "rendering" | "error";
export type MaskCandidate = { index: number; score: number; misses: number };
export type SmartMaskRequest =
    | { id: number; type: "prepare"; imageUrl: string; assetBase: string; cpu: boolean }
    | { id: number; type: "predict"; points: SmartMaskPoint[] }
    | { id: number; type: "candidate"; index: number };
export type SmartMaskResponse =
    | { id: number; type: "status"; stage: SmartMaskStage; backend?: SmartMaskBackend; dtype?: SmartMaskDtype; progress?: number }
    | { id: number; type: "ready"; backend: SmartMaskBackend; dtype: SmartMaskDtype }
    | { id: number; type: "result"; mask: BinaryMask; candidates: MaskCandidate[]; selected: number }
    | { id: number; type: "error"; message: string };

export async function smartMaskDevice(secure: boolean, gpu?: { requestAdapter: () => Promise<{ features?: { has: (feature: string) => boolean } } | null> }): Promise<{ backend: SmartMaskBackend; dtype: SmartMaskDtype }> {
    if (secure && gpu) {
        try {
            const adapter = await gpu.requestAdapter();
            if (adapter) return { backend: "webgpu", dtype: adapter.features?.has("shader-f16") ? "fp16" : "fp32" };
        } catch { /* Use CPU when a GPU adapter is unavailable. */ }
    }
    return { backend: "wasm", dtype: "q8" };
}

export function modelWeightFiles(dtype: SmartMaskDtype) {
    const suffix = dtype === "q8" ? "_quantized" : dtype === "fp16" ? "_fp16" : "";
    return Object.entries(model.files).filter(([name]) => ["vision_encoder", "prompt_encoder_mask_decoder"].some(part => name === `onnx/${part}${suffix}.onnx` || name === `onnx/${part}${suffix}.onnx_data`));
}

// Coarse mask sampling near an edge can miss a prompt. Rank all alternatives
// instead of rejecting every candidate and leaving a complex object unselectable.
export function rankMaskCandidates(scores: ArrayLike<number | bigint>, misses: (index: number) => number): MaskCandidate[] {
    return Array.from(scores, (score, index) => ({ index, score: Number(score), misses: misses(index) }))
        .sort((a, b) => a.misses - b.misses || b.score - a.score);
}

export const isSmartMaskBusy = (stage: SmartMaskStage) => !["idle", "ready", "error"].includes(stage);
