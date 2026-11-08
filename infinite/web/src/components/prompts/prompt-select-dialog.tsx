import { Plus, Search } from "lucide-react";
import { type UIEvent, useEffect, useState } from "react";
import { App, Button, Empty, Input, Modal, Spin, Tag } from "antd";
import { useTranslation } from "react-i18next";

import { LocalPromptEditor } from "./local-prompt-editor";
import { LOCAL_PROMPT_CATEGORY } from "@/stores/use-local-prompt-store";
import { ALL_PROMPTS_OPTION, type Prompt } from "@/services/api/prompts";
import { cn } from "@/lib/utils";
import { PromptCard } from "./prompt-card";
import { usePromptList } from "./use-prompt-list";

import { PromptDetailDialog } from "@/pages/prompts/components/prompt-detail-dialog";

export function PromptSelectDialog({ open, onOpenChange, onSelect }: { open: boolean; onOpenChange: (open: boolean) => void; onSelect: (prompt: string) => void }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const [detail, setDetail] = useState<Prompt | null>(null);
    const [editorOpen, setEditorOpen] = useState(false);
    const [keyword, setKeyword] = useState("");
    const [selectedTags, setSelectedTags] = useState<string[]>([]);
    const [selectedCategory, setSelectedCategory] = useState(ALL_PROMPTS_OPTION);
    const { query, items, tags: promptTags, categories: promptCategories } = usePromptList({ keyword, tags: selectedTags, category: selectedCategory, enabled: open });
    const toggleTag = (tag: string) => {
        if (tag === ALL_PROMPTS_OPTION) return setSelectedTags([]);
        setSelectedTags((items) => (items.includes(tag) ? items.filter((item) => item !== tag) : [...items, tag]));
    };
    const selectPrompt = (prompt: string) => {
        onSelect(prompt);
        onOpenChange(false);
    };

    useEffect(() => {
        if (query.isError) message.error(query.error instanceof Error ? query.error.message : t("prompts.loadFailed"));
    }, [message, query.error, query.isError, t]);

    const handleListScroll = (event: UIEvent<HTMLDivElement>) => {
        const target = event.currentTarget;
        if (query.hasNextPage && !query.isFetchingNextPage && target.scrollTop + target.clientHeight >= target.scrollHeight - 160) void query.fetchNextPage();
    };

    return (
        <>
        <Modal title={t("prompts.library")} open={open} onCancel={() => onOpenChange(false)} footer={null} width={880} centered>
            <div className="grid h-[70dvh] min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-4 sm:grid-cols-[180px_minmax(0,1fr)] sm:grid-rows-1" data-canvas-no-zoom onWheelCapture={(event) => event.stopPropagation()}>
                <aside className="thin-scrollbar max-h-32 min-h-0 overflow-y-auto border-r sm:max-h-none border-stone-200 pr-4 dark:border-stone-800">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-widest text-stone-400 dark:text-stone-500">创作用途</div>
                    <div className="flex flex-wrap gap-1.5">
                        {promptCategories.map((category) => (
                            <Tag.CheckableTag key={category} checked={selectedCategory === category} className={cn("prompt-filter-tag", selectedCategory === category && "is-active")} onChange={() => setSelectedCategory(category)}>
                                {category === ALL_PROMPTS_OPTION ? t("common.all") : category}
                            </Tag.CheckableTag>
                        ))}
                    </div>
                    <div className="mb-2 mt-5 text-xs font-semibold uppercase tracking-widest text-stone-400 dark:text-stone-500">视觉风格</div>
                    <div className="flex flex-wrap gap-1.5">
                        {promptTags.map((tag) => {
                            const active = tag === ALL_PROMPTS_OPTION ? selectedTags.length === 0 : selectedTags.includes(tag);
                            return (
                                <Tag.CheckableTag key={tag} checked={active} className={cn("prompt-filter-tag", active && "is-active")} onChange={() => toggleTag(tag)}>
                                    {tag === ALL_PROMPTS_OPTION ? t("common.all") : tag}
                                </Tag.CheckableTag>
                            );
                        })}
                    </div>
                </aside>
                <section className="flex min-h-0 min-w-0 flex-col">
                    <div className="mb-3 flex justify-end"><Button type="text" icon={<Plus className="size-4" />} onClick={() => setEditorOpen(true)}>新增本地提示词</Button></div>
                    <Input size="large" prefix={<Search className="size-4 text-stone-400" />} value={keyword} onChange={(event) => setKeyword(event.target.value)} allowClear placeholder="搜索主题、中文描述或原文" />
                    <div className="thin-scrollbar mt-4 min-h-0 flex-1 overflow-y-auto pr-2" data-canvas-no-zoom onScroll={handleListScroll} onWheelCapture={(event) => event.stopPropagation()}>
                        {query.isLoading ? (
                            <div className="flex h-40 items-center justify-center">
                                <Spin />
                            </div>
                        ) : null}
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                            {items.map((item) => (
                                <PromptCard key={`${item.sourceId}:${item.id}`} item={item} onOpen={() => setDetail(item)} onCopy={() => selectPrompt(item.prompt)} compact />
                            ))}
                        </div>
                        {!query.isLoading && items.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("prompts.empty")} className="py-8" /> : null}
                        {query.isFetchingNextPage ? (
                            <div className="py-4 text-center">
                                <Spin size="small" />
                            </div>
                        ) : null}
                    </div>
                </section>
            </div>
        </Modal>
        <PromptDetailDialog prompt={detail} onClose={() => setDetail(null)} onCopy={text => { void navigator.clipboard.writeText(text).then(() => message.success("已复制提示词"), () => message.error("复制失败")); }} onUse={text => { selectPrompt(text); setDetail(null); }} />
        <LocalPromptEditor open={editorOpen} onClose={() => setEditorOpen(false)} onSaved={() => { setSelectedCategory(LOCAL_PROMPT_CATEGORY); setSelectedTags([]); setKeyword(""); }} />
        </>
    );
}
