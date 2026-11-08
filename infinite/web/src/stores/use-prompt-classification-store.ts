import { create } from "zustand";
import localforage from "localforage";
import type { Prompt } from "@/services/api/prompts";
import { promptClassificationKeys, PROMPT_TOPICS, type PromptClassifications } from "@/services/api/prompt-organization";

const storage = localforage.createInstance({ name: "infinite-canvas", storeName: "prompt_classifications" });
let loading: Promise<void> | null = null;
type ClassificationStore = {
    overrides: PromptClassifications;
    loaded: boolean;
    revision: number;
    load: () => Promise<void>;
    save: (prompt: Prompt, topic: string, tags: string[]) => Promise<void>;
    reset: (prompt: Prompt) => Promise<void>;
};
export const usePromptClassificationStore = create<ClassificationStore>((set, get) => ({
    overrides: {}, loaded: false, revision: 0,
    load: async () => {
        if (get().loaded) return;
        if (!loading) loading = storage.getItem<PromptClassifications>("overrides").then(value => { set({ overrides: value || {}, loaded: true }); }).finally(() => { loading = null; });
        await loading;
    },
    save: async (prompt, topic, tags) => {
        await get().load();
        if (!PROMPT_TOPICS.includes(topic)) throw new Error("请选择有效分类");
        const next = { ...get().overrides };
        const correction = { topic, tags: [...new Set(tags.map(tag => tag.trim()).filter(Boolean))], updatedAt: Date.now() };
        for (const key of promptClassificationKeys(prompt)) next[key] = correction;
        await storage.setItem("overrides", next);
        set(state => ({ overrides: next, revision: state.revision + 1 }));
    },
    reset: async prompt => {
        await get().load();
        const next = { ...get().overrides };
        for (const key of promptClassificationKeys(prompt)) delete next[key];
        await storage.setItem("overrides", next);
        set(state => ({ overrides: next, revision: state.revision + 1 }));
    },
}));
