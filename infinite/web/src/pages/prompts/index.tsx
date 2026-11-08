import { FolderPlus, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { type ReactNode, type UIEvent, useEffect, useState } from "react";
import { App, Button, Empty, Input, Popconfirm, Spin, Tag, Segmented } from "antd";
import { useTranslation } from "react-i18next";

import { LocalPromptEditor } from "@/components/prompts/local-prompt-editor";
import { LOCAL_PROMPT_CATEGORY, LOCAL_PROMPT_SOURCE_ID, useLocalPromptStore } from "@/stores/use-local-prompt-store";
import { PromptCard } from "@/components/prompts/prompt-card";
import { usePromptList } from "@/components/prompts/use-prompt-list";
import { PromptDetailDialog } from "./components/prompt-detail-dialog";
import { useCopyText } from "@/hooks/use-copy-text";
import { cn } from "@/lib/utils";
import { useAssetStore } from "@/stores/use-asset-store";
import { ALL_PROMPTS_OPTION, type Prompt } from "@/services/api/prompts";

export default function PromptsPage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [view, setView] = useState("all");
    const [titleKeyword, setTitleKeyword] = useState("");
    const [selectedTags, setSelectedTags] = useState<string[]>([]);
    const [selectedCategory, setSelectedCategory] = useState(ALL_PROMPTS_OPTION);
    const [editor, setEditor] = useState<Prompt | null>();
    const removeLocalPrompt = useLocalPromptStore(state => state.remove);
    const [selectedPrompt, setSelectedPrompt] = useState<Prompt | null>(null);
    const addAsset = useAssetStore((state) => state.addAsset);
    const copyText = useCopyText();
    const { query, items: promptItems, tags: promptTags, categories: promptCategoryOptions, total: totalPrompts, mergedCount, warnings } = usePromptList({ keyword: titleKeyword, tags: selectedTags, category: selectedCategory, view });

    useEffect(() => {
        if (query.isError) message.error(query.error instanceof Error ? query.error.message : t("prompts.loadFailed"));
    }, [message, query.error, query.isError, t]);

    const toggleTag = (tag: string) => {
        if (tag === ALL_PROMPTS_OPTION) return setSelectedTags([]);
        setSelectedTags((items) => (items.includes(tag) ? items.filter((item) => item !== tag) : [...items, tag]));
    };

    const savePromptAsset = (item: Prompt) => {
        addAsset({ kind: "text", title: item.title, coverUrl: item.coverUrl, tags: item.tags, source: item.category, data: { content: item.prompt }, metadata: { source: "prompt-library", promptId: item.id, githubUrl: item.githubUrl } });
        message.success(t("common.addedToAssets"));
    };

    const deleteLocalPrompt = async (item: Prompt) => {
        try { await removeLocalPrompt(item.id); if (selectedPrompt?.id === item.id) setSelectedPrompt(null); message.success("已删除本地提示词"); }
        catch (error) { message.error(error instanceof Error ? error.message : "删除失败，请重试"); }
    };
    const handleListScroll = (event: UIEvent<HTMLDivElement>) => {
        const target = event.currentTarget;
        if (query.hasNextPage && !query.isFetchingNextPage && target.scrollTop + target.clientHeight >= target.scrollHeight - 160) void query.fetchNextPage();
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-background text-stone-800 dark:text-stone-100">
            <main className="min-h-0 flex-1 overflow-y-auto bg-background px-4 py-6 sm:px-6 lg:py-8" onScroll={handleListScroll}>
                <div className="mx-auto max-w-7xl">
                    <div>
                        <h1 className="text-2xl font-semibold text-stone-950 dark:text-stone-100">{t("prompts.title")}</h1>
                        <p className="mt-2 text-sm leading-6 text-stone-500 dark:text-stone-400">按用途找灵感，查看示例图，再把提示词带进画布。在线案例和本机模板统一检索，重复内容合并出处。</p><p className="mt-2 text-xs text-stone-500 dark:text-stone-400">{totalPrompts} 条匹配{mergedCount > 0 ? ` · 已合并 ${mergedCount} 个重复来源` : ""}</p>
                    </div>
                    <div className="mt-5 grid items-start gap-5 lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-6">
                        <aside className="thin-scrollbar max-h-72 overflow-y-auto border-b border-stone-200 pb-5 lg:sticky lg:top-0 lg:max-h-[calc(100dvh-6rem)] lg:border-b-0 lg:border-r lg:pb-8 lg:pr-5 dark:border-stone-800">
                            <button type="button" className="flex w-full items-center justify-between gap-2 py-1 text-left text-sm lg:hidden" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(value => !value)}><span>筛选用途与风格{selectedCategory !== ALL_PROMPTS_OPTION ? ` · ${selectedCategory}` : ""}{selectedTags.length ? ` · ${selectedTags.length} 个风格` : ""}</span><span>{filtersOpen ? "收起" : "展开"}</span></button>
                            <div className={cn("hidden lg:block", filtersOpen && "!block")}>
                            <PromptFilter label="创作用途" options={promptCategoryOptions} selected={selectedCategory} onChange={(value) => { setSelectedCategory(value); setSelectedTags([]); }} />
                            <div className="mt-6">
                                <div className="mb-2 text-xs font-semibold uppercase tracking-widest text-stone-400 dark:text-stone-500">视觉风格</div>
                                <div className="flex flex-wrap gap-1.5">
                                    {promptTags.map((tag) => {
                                        const active = tag === ALL_PROMPTS_OPTION ? selectedTags.length === 0 : selectedTags.includes(tag);
                                        return <Tag.CheckableTag key={tag} checked={active} className={cn("prompt-filter-tag", active && "is-active")} onChange={() => toggleTag(tag)}>{tag === ALL_PROMPTS_OPTION ? t("common.all") : tag}</Tag.CheckableTag>;
                                    })}
                                </div>
                            </div>
                            </div>
                        </aside>
                        <section className="min-w-0">
                            <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><span className="text-sm opacity-65">本机案例已整合；个人提示词保存在当前浏览器</span><Button type="primary" icon={<Plus className="size-4" />} onClick={() => setEditor(null)}>新增本地提示词</Button></div>
                            <Input size="large" prefix={<Search className="size-4 text-stone-400" />} value={titleKeyword} allowClear placeholder="搜索主题、中文描述或原文，例如：人像 胶片" onChange={(event) => setTitleKeyword(event.target.value)} />
                            <div className="mt-3 flex flex-wrap items-center justify-between gap-2"><Segmented value={view} onChange={value => setView(String(value))} options={[{ label: "全部内容", value: "all" }, { label: "有示例图", value: "illustrated" }, { label: "有中文正文", value: "chinese" }]} /><Button type="text" size="small" onClick={() => { setTitleKeyword(""); setSelectedTags([]); setSelectedCategory(ALL_PROMPTS_OPTION); setView("all"); }}>清除筛选</Button></div>
                            {warnings.length ? <p role="status" className="mt-3 text-xs leading-5 text-stone-500 dark:text-stone-400">部分来源更新失败，已保留可用内容：{warnings.join("、")}。可在配置的提示词来源中重试。</p> : null}
                            {query.isError ? <div role="alert" className="mt-4 text-sm">提示词加载失败。<Button type="link" onClick={() => void query.refetch()}>重新加载</Button></div> : null}
                            {query.isLoading ? <div className="flex h-60 items-center justify-center"><Spin /></div> : null}
                            {!query.isLoading ? <div className="mt-5"><PromptGrid items={promptItems} onOpen={setSelectedPrompt} renderActions={(item) => item.sourceId === LOCAL_PROMPT_SOURCE_ID ? <><Button type="text" size="small" aria-label="编辑本地提示词" icon={<Pencil className="size-3.5" />} onClick={() => setEditor(item)} /><Popconfirm title="删除这条本地提示词？" okText="删除" cancelText="取消" onConfirm={() => deleteLocalPrompt(item)}><Button type="text" size="small" danger aria-label="删除本地提示词" icon={<Trash2 className="size-3.5" />} /></Popconfirm></> : <Button type="text" size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => savePromptAsset(item)}>{t("common.addToAssets")}</Button>} onCopy={(item) => copyText(item.prompt, t("common.promptCopied"))} emptyText={t("prompts.empty")} /></div> : null}
                            <div className="mt-6 text-center text-xs text-stone-500 dark:text-stone-400">{query.isFetchingNextPage ? t("prompts.loading") : query.hasNextPage ? t("prompts.loadMore") : promptItems.length > 0 ? t("prompts.end") : null}</div>
                        </section>
                    </div>
                </div>
            </main>

            <LocalPromptEditor open={editor !== undefined} prompt={editor} onClose={() => setEditor(undefined)} onSaved={(item) => { setView("all"); setSelectedCategory(LOCAL_PROMPT_CATEGORY); setSelectedTags([]); setTitleKeyword(""); if (selectedPrompt?.id === item.id) setSelectedPrompt(item); }} />
            <PromptDetailDialog prompt={selectedPrompt} onClose={() => setSelectedPrompt(null)} onCopy={(prompt) => copyText(prompt, t("common.promptCopied"))} onSaveAsset={savePromptAsset} />
        </div>
    );
}

function PromptFilter({ label, options, selected, onChange }: { label: string; options: string[]; selected: string; onChange: (value: string) => void }) {
    const { t } = useTranslation();
    return <div><div className="mb-2 text-xs font-semibold uppercase tracking-widest text-stone-400 dark:text-stone-500">{label}</div><div className="flex flex-wrap gap-1.5">{options.map((option) => <Tag.CheckableTag key={option} checked={selected === option} className={cn("prompt-filter-tag", selected === option && "is-active")} onChange={() => onChange(option)}>{option === ALL_PROMPTS_OPTION ? t("common.all") : option}</Tag.CheckableTag>)}</div></div>;
}

function PromptGrid({ items, onOpen, onCopy, renderActions, emptyText }: { items: Prompt[]; onOpen: (item: Prompt) => void; onCopy: (item: Prompt) => void; renderActions: (item: Prompt) => ReactNode; emptyText: string }) {
    return <div><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{items.map((item) => <PromptCard key={`${item.sourceId}:${item.id}`} item={item} onOpen={() => onOpen(item)} onCopy={() => onCopy(item)} extraAction={renderActions(item)} />)}</div>{items.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} className="py-16" /> : null}</div>;
}
