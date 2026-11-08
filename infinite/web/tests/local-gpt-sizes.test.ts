import { expect, test } from "bun:test";
import { computeMediaSize, imageSizePresets, imageSizePresetsForModel, inferMediaRatio, inferMediaScale, LOCAL_GPT_1K_MAX_PIXELS, mediaRatioOptions, parsePixelSize, readMediaDimensions } from "../src/lib/media-size";
const model = "image-api::gpt-image-2.5-flare";

test("local GPT 1K presets use at least 99% of the existing pixel budget with 16-pixel alignment", () => {
    for (const ratio of mediaRatioOptions.filter(r => r.value !== "auto")) {
        const size = computeMediaSize("1k", ratio.value, model);
        const { width, height } = parsePixelSize(size)!;
        expect(width * height).toBeLessThanOrEqual(LOCAL_GPT_1K_MAX_PIXELS);
        expect(width * height).toBeGreaterThanOrEqual(LOCAL_GPT_1K_MAX_PIXELS * .99);
        expect(width % 16 + height % 16).toBe(0);
        expect(Math.abs(width / height / (ratio.width / ratio.height) - 1)).toBeLessThan(.01);
        expect(inferMediaScale(size, undefined, model)).toBe("1k");
        expect(inferMediaRatio(size)).toBe(ratio.value);
    }
});
test("local GPT classification uses total pixels even for wide images over 1920", () => {
    expect(inferMediaScale("2048x768", undefined, model)).toBe("1k");
    expect(inferMediaScale("2160x720", undefined, model)).toBe("1k");
    expect(inferMediaScale("1920x1080", undefined, model)).toBe("2k");
    expect(inferMediaScale("1536x1536", undefined, model)).toBe("2k");
});
test("other channels and larger tiers retain their existing presets", () => {
    for (const other of [undefined, "external::gpt-image-2.5-flare", "image-api::gemini-3.1-flash-image-preview"]) {
        expect(imageSizePresetsForModel(other)).toBe(imageSizePresets);
        expect(computeMediaSize("1k", "1:1", other)).toBe("1024x1024");
    }
    for (const scale of ["2k", "4k"]) for (const ratio of mediaRatioOptions.filter(r => r.value !== "auto")) expect(computeMediaSize(scale, ratio.value, model)).toBe(imageSizePresets[scale][ratio.value]);
});
test("explicit node dimensions and automatic settings are preserved until the preset is selected", () => {
    expect(readMediaDimensions("1024x1024", "1k", "1:1", model)).toEqual({ width: 1024, height: 1024 });
    expect(computeMediaSize("1k", "1:1", model)).toBe("1248x1248");
    expect(computeMediaSize("auto", "16:9", model)).toBe("16:9");
    expect(computeMediaSize("1k", "auto", model)).toBe("auto");
});
