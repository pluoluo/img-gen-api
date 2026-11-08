import { useEffect, useState } from "react";
import { App, Button, Input, Modal, Select, Space } from "antd";
import type { Prompt } from "@/services/api/prompts";
import { PROMPT_STYLES, PROMPT_TOPICS } from "@/services/api/prompt-organization";
import { usePromptClassificationStore } from "@/stores/use-prompt-classification-store";

export function PromptClassificationEditor({ prompt, open, onClose }: { prompt: Prompt; open: boolean; onClose: () => void }) {
    const { message } = App.useApp();
    const save = usePromptClassificationStore(state => state.save);
    const reset = usePromptClassificationStore(state => state.reset);
    const [topic, setTopic] = useState(prompt.topic || "其他灵感");
    const [tags, setTags] = useState<string[]>(prompt.tags);
    const [customTag, setCustomTag] = useState("");
    const [saving, setSaving] = useState(false);
    useEffect(() => { if (open) { setTopic(prompt.topic || "其他灵感"); setTags(prompt.tags); setCustomTag(""); } }, [open, prompt.id]);
    const finish = async (restore = false) => {
        if (saving) return;
        setSaving(true);
        try {
            if (restore) await reset(prompt);
            else await save(prompt, topic, [...tags, ...(customTag.trim() ? [customTag.trim()] : [])]);
            message.success(restore ? "已恢复自动分类与标签" : "分类与标签已保存");
            onClose();
        } catch (error) { message.error(error instanceof Error ? error.message : "保存失败，请重试"); }
        finally { setSaving(false); }
    };
    const options = [...new Set([...PROMPT_STYLES, ...prompt.tags, ...tags])];
    return <Modal title="修改分类与标签" open={open} onCancel={() => { if (!saving) onClose(); }} keyboard={!saving} maskClosable={!saving} width={560} footer={<Space wrap><Button disabled={saving} onClick={() => void finish(true)}>恢复自动分类</Button><Button disabled={saving} onClick={onClose}>取消</Button><Button type="primary" loading={saving} onClick={() => void finish()}>保存</Button></Space>} modalRender={node => <div data-canvas-no-zoom>{node}</div>}>
        <p className="mb-4 text-sm leading-6 text-stone-600 dark:text-stone-400">{prompt.title}</p>
        <div className="space-y-4">
            <div className="space-y-2"><label className="block text-sm" htmlFor="prompt-correction-topic">分类</label><Select id="prompt-correction-topic" aria-label="提示词分类" className="w-full" value={topic} onChange={setTopic} disabled={saving} options={PROMPT_TOPICS.map(value => ({ value, label: value }))} /></div>
            <div className="space-y-2"><div className="text-sm">标签（可多选，再次点击取消）</div><div role="group" aria-label="编辑提示词标签" className="flex max-h-52 flex-wrap gap-1.5 overflow-y-auto">{options.map(tag => <Button key={tag} autoInsertSpace={false} size="small" type={tags.includes(tag) ? "primary" : "text"} aria-pressed={tags.includes(tag)} disabled={saving} onClick={() => setTags(current => current.includes(tag) ? current.filter(value => value !== tag) : [...current, tag])}>{tag}</Button>)}</div><Input aria-label="自定义标签" placeholder="输入自定义标签，按回车添加" value={customTag} disabled={saving} onChange={event => setCustomTag(event.target.value)} onPressEnter={event => { event.preventDefault(); const value = customTag.trim(); if (value) setTags(current => [...new Set([...current, value])]); setCustomTag(""); }} /></div>
            <p className="text-xs leading-5 text-stone-500 dark:text-stone-400">校正保存在当前浏览器，来源更新时会保留。只调整本库的分类和标签，提示词正文及原始来源保持完整。</p>
        </div>
    </Modal>;
}
