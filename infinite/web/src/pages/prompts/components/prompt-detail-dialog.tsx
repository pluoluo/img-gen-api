import { Copy, FolderPlus, Languages, Pencil } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { App, Button, Image, Modal, Segmented, Space, Tag } from "antd";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { translatePrompt, type Prompt } from "@/services/api/prompts";
import { useConfigStore } from "@/stores/use-config-store";
import { PromptClassificationEditor } from "@/components/prompts/prompt-classification-editor";
import { usePromptClassificationStore } from "@/stores/use-prompt-classification-store";
import { applyPromptClassification, isChinesePrompt } from "@/services/api/prompt-organization";

export function PromptDetailDialog({ prompt: sourcePrompt, onClose, onCopy, onSaveAsset, onUse }: { prompt: Prompt | null; onClose: () => void; onCopy: (prompt: string) => void; onSaveAsset?: (prompt: Prompt) => void; onUse?: (text: string) => void }) {
    const overrides = usePromptClassificationStore(state => state.overrides);
    const prompt = sourcePrompt ? applyPromptClassification(sourcePrompt, overrides) : null;
    const [classificationOpen, setClassificationOpen] = useState(false);
    const { t } = useTranslation();
    const { message } = App.useApp();
    const config = useConfigStore(state => state.config);
    const ready = useConfigStore(state => state.isAiConfigReady);
    const queryClient = useQueryClient();
    const currentId = useRef(prompt?.id);
    currentId.current = prompt?.id;
    const [failedCover, setFailedCover] = useState("");
    const [language, setLanguage] = useState("zh");
    const [translation, setTranslation] = useState<{ promptZh: string; translationLabel: string } | null>(null);
    const [busy, setBusy] = useState(false);
    useEffect(() => { setTranslation(null); setLanguage("zh"); setClassificationOpen(false); }, [prompt?.id]);
    const original = prompt?.originalPrompt || prompt?.prompt || "";
    const chinese = translation?.promptZh || prompt?.promptZh || (isChinesePrompt(original) ? original : "");
    const text = language === "zh" && chinese ? chinese : original;
    const translate = async () => {
        if (!prompt) return;
        const requestId = prompt.id;
        setBusy(true);
        try {
            const result = await translatePrompt(prompt);
            if (currentId.current === requestId) { setTranslation(result); setLanguage("zh"); }
            await queryClient.invalidateQueries({ queryKey: ["prompts"] });
            message.success("中文译文已保存，原文保持完整");
        } catch (error) { message.error(error instanceof Error ? error.message : "翻译失败，请重试"); }
        finally { setBusy(false); }
    };
    return <><Modal title={prompt?.title} open={Boolean(prompt)} onCancel={onClose} footer={null} width={880} centered styles={{ body: { maxHeight: "80dvh", overflowY: "auto" } }}>
        {prompt ? <div className="min-w-0 space-y-5 py-2">
            {prompt.coverUrl && failedCover !== prompt.coverUrl ? <Image src={prompt.coverUrl} alt={prompt.title} width="100%" height={260} onError={() => setFailedCover(prompt.coverUrl)} styles={{ image: { objectFit: "contain" } }} /> : prompt.coverUrl ? <p className="py-6 text-center text-sm text-stone-500 dark:text-stone-400">示例图暂不可用，可在下方出处中查看原始案例。</p> : null}
            {prompt.referenceImageUrls.length > 1 ? <Image.PreviewGroup><div className="flex gap-2 overflow-x-auto">{prompt.referenceImageUrls.filter(url => url !== prompt.coverUrl).map(url => <Image key={url} src={url} alt="案例参考图" width={72} height={72} styles={{ image: { objectFit: "cover" } }} />)}</div></Image.PreviewGroup> : null}
            <div className="flex flex-wrap items-center gap-1.5">{prompt.topic ? <Tag>{prompt.topic}</Tag> : null}{prompt.tags.map(tag => <Tag key={tag}>{tag}</Tag>)}{prompt.sourceId !== "local-library" ? <Button type="text" size="small" icon={<Pencil className="size-3.5" />} onClick={() => setClassificationOpen(true)}>修改分类与标签</Button> : null}{prompt.classificationEdited ? <span className="text-xs text-stone-500 dark:text-stone-400">已校正</span> : null}</div>
            {prompt.description ? <p className="text-sm leading-6 text-stone-600 dark:text-stone-400">{prompt.description}</p> : null}
            <div className="flex flex-wrap items-center justify-between gap-3">
                <Segmented aria-label="提示词语言" value={language} onChange={value => setLanguage(String(value))} options={[{ label: chinese ? "中文版本" : "中文导读", value: "zh" }, { label: "原始提示词", value: "original" }]} />
                {language === "zh" && chinese ? <span className="text-xs text-stone-500 dark:text-stone-400">{translation?.translationLabel || prompt.translationLabel || "中文正文"}</span> : null}
            </div>
            {language === "zh" && !chinese ? <div className="space-y-3 rounded-lg bg-stone-100 p-4 text-sm leading-6 dark:bg-stone-900"><p>这是关于「{prompt.title}」的{prompt.topic || "图像创作"}提示词。原文为英文，复制和使用时会保留原始参数及文案。</p>{import.meta.env.VITE_IMAGE_API === "1" ? <><Button icon={<Languages className="size-4" />} loading={busy} onClick={() => void translate()}>生成中文译文</Button><p className="text-xs text-stone-500 dark:text-stone-400">{ready(config, config.textModel) ? "使用当前选中的文本模型，译文保存后可重复使用。" : "使用本机 Prompt 应用的翻译服务；也可先在配置中设置文本模型。"}</p></> : null}</div> : null}
            <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-7 text-stone-800 [overflow-wrap:anywhere] dark:text-stone-200">{text}</pre>
            <Space wrap>
                {onUse ? <Button type="primary" onClick={() => onUse(text)}>使用这条提示词</Button> : null}
                <Button type="primary" icon={<Copy className="size-4" />} onClick={() => onCopy(text)}>{language === "zh" && chinese ? "复制中文版本" : t("common.copyPrompt")}</Button>
                {chinese && chinese !== original ? <Button onClick={() => onCopy(original)}>复制原文</Button> : null}
                {onSaveAsset ? <Button icon={<FolderPlus className="size-4" />} onClick={() => onSaveAsset({ ...prompt, prompt: text })}>{t("common.addToAssets")}</Button> : null}
            </Space>
            <details className="border-t border-stone-200 pt-4 text-xs leading-6 text-stone-500 dark:border-stone-800 dark:text-stone-400"><summary className="cursor-pointer">出处与作者{(prompt.origins?.length || 0) > 1 ? ` · 合并 ${prompt.origins?.length} 个来源` : ""}</summary><ul className="mt-2 space-y-1">{(prompt.origins || [{ sourceId: prompt.sourceId, name: prompt.category, url: prompt.githubUrl, author: prompt.author || "" }]).map((origin, index) => <li key={`${origin.sourceId}:${index}`}>{origin.name}{origin.author ? ` · ${origin.author}` : ""}{origin.url ? <> · <a className="underline underline-offset-4" href={origin.url} target="_blank" rel="noopener noreferrer">原始出处</a></> : null}</li>)}</ul></details>
        </div> : null}
    </Modal>{prompt ? <PromptClassificationEditor prompt={prompt} open={classificationOpen} onClose={() => setClassificationOpen(false)} /> : null}</>;
}
