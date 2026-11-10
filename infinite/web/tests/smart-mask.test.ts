import { expect, test } from "bun:test";
import { isSmartMaskBusy, modelWeightFiles, rankMaskCandidates, smartMaskDevice } from "../src/lib/smart-mask";

test("plain HTTP never attempts WebGPU even when an adapter is exposed", async () => {
    let attempts = 0;
    expect(await smartMaskDevice(false, { requestAdapter: async () => { attempts++; return {}; } })).toEqual({ backend: "wasm", dtype: "q8" });
    expect(attempts).toBe(0);
});

test("GPU uses fp16 only with shader support, and missing adapters use CPU", async () => {
    expect(await smartMaskDevice(true, { requestAdapter: async () => ({ features: new Set(["shader-f16"]) }) })).toEqual({ backend: "webgpu", dtype: "fp16" });
    expect(await smartMaskDevice(true, { requestAdapter: async () => ({}) })).toEqual({ backend: "webgpu", dtype: "fp32" });
    expect((await smartMaskDevice(true, { requestAdapter: async () => null })).backend).toBe("wasm");
    expect((await smartMaskDevice(true)).backend).toBe("wasm");
    expect((await smartMaskDevice(true, { requestAdapter: async () => { throw new Error("blocked"); } })).backend).toBe("wasm");
});

test("candidates prioritize prompt agreement, then predicted confidence", () => {
    expect(rankMaskCandidates(new Float32Array([0.9, 0.7, 0.8]), index => index === 0 ? 1 : 0).map(candidate => candidate.index)).toEqual([2, 1, 0]);
});

test("edge sampling disagreements retain alternatives instead of discarding the selection", () => {
    const candidates = rankMaskCandidates([0.8, 0.7, 0.9], index => index === 0 ? 2 : 1);
    expect(candidates.map(candidate => candidate.index)).toEqual([2, 1, 0]);
    expect(candidates).toHaveLength(3);
});

test("download progress includes external weights for exactly one precision", () => {
    for (const [dtype, bytes] of [["q8", 61966687], ["fp16", 78004244], ["fp32", 155610424]] as const) {
        const files = modelWeightFiles(dtype);
        expect(files).toHaveLength(4);
        expect(files.filter(([name]) => name.endsWith(".onnx_data"))).toHaveLength(2);
        expect(files.reduce((sum, [, info]) => sum + info.bytes, 0)).toBe(bytes);
    }
});

test("analysis and preview remain busy until completion", () => {
    for (const stage of ["loading", "compiling", "preprocessing", "encoding", "selecting", "rendering"] as const) expect(isSmartMaskBusy(stage)).toBe(true);
    for (const stage of ["idle", "ready", "error"] as const) expect(isSmartMaskBusy(stage)).toBe(false);
});
