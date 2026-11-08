import { create } from "zustand";
import localforage from "localforage";
import { nanoid } from "nanoid";
import type { Prompt } from "@/services/api/prompts";

export const LOCAL_PROMPT_SOURCE_ID = "local-library";
export const LOCAL_PROMPT_CATEGORY = "本地提示词库";
type PromptDraft = Pick<Prompt, "title" | "prompt" | "description" | "tags">;
const storage = localforage.createInstance({ name: "infinite-canvas", storeName: "local_prompts" });
let loading: Promise<void> | null = null;
const newestFirst = (items: Prompt[]) => items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

type LocalPromptStore = {
    prompts: Prompt[];
    loaded: boolean;
    revision: number;
    load: () => Promise<void>;
    save: (draft: PromptDraft, id?: string) => Promise<Prompt>;
    remove: (id: string) => Promise<void>;
};

export const useLocalPromptStore = create<LocalPromptStore>((set, get) => ({
    prompts: [],
    loaded: false,
    revision: 0,
    load: async () => {
        if (get().loaded) return;
        if (!loading)
            loading = (async () => {
                const prompts: Prompt[] = [];
                await storage.iterate<Prompt, void>((item) => {
                    prompts.push(item);
                });
                set({ prompts: newestFirst(prompts), loaded: true });
            })().finally(() => {
                loading = null;
            });
        await loading;
    },
    save: async (draft, id) => {
        await get().load();
        if (!draft.title.trim() || !draft.prompt.trim()) throw new Error("请填写标题和提示词正文");
        const previous = id ? get().prompts.find((item) => item.id === id) : undefined;
        if (id && !previous) throw new Error("这条本地提示词已被删除，请重新添加");
        const now = new Date().toISOString();
        const item: Prompt = {
            id: id || `local:${nanoid()}`,
            title: draft.title.trim(),
            prompt: draft.prompt.trim(),
            description: draft.description?.trim() || "",
            tags: [...new Set((draft.tags || []).map((tag) => tag.trim()).filter(Boolean))],
            sourceId: LOCAL_PROMPT_SOURCE_ID,
            category: LOCAL_PROMPT_CATEGORY,
            githubUrl: "",
            coverUrl: "",
            referenceImageUrls: [],
            preview: "",
            createdAt: previous?.createdAt || now,
            updatedAt: now,
        };
        await storage.setItem(item.id, item);
        set((state) => ({ prompts: newestFirst([item, ...state.prompts.filter((current) => current.id !== item.id)]), revision: state.revision + 1 }));
        return item;
    },
    remove: async (id) => {
        await get().load();
        await storage.removeItem(id);
        set((state) => ({ prompts: state.prompts.filter((item) => item.id !== id), revision: state.revision + 1 }));
    },
}));
