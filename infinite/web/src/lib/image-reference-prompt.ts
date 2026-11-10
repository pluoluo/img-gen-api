import type { ReferenceImage } from "@/types/image";

import i18n from "@/i18n";

export function imageReferenceLabel(index: number) {
    return i18n.t("imageReferences.label", { index: index + 1 });
}

export function buildImageReferencePromptText(prompt: string, references: ReferenceImage[]) {
    const text = prompt.trim();
    if (!references.length) return text;
    const labels = references.map((_, index) => imageReferenceLabel(index));
    return i18n.t("imageReferences.promptPrefix", { labels: labels.join(i18n.t("imageReferences.separator")), prompt: text });
}

/** Keep explicit image labels attached to their images when a mask moves first. */
export function remapImageReferenceLabels(prompt: string, indices: number[]) {
    const labels = new Map(indices.map((index, previous) => [imageReferenceLabel(previous), imageReferenceLabel(index)]));
    if (!labels.size) return prompt;
    const pattern = [...labels.keys()].sort((a, b) => b.length - a.length).map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    return prompt.replace(new RegExp(`(?:${pattern})(?!\\d)`, "g"), (label) => labels.get(label)!);
}
