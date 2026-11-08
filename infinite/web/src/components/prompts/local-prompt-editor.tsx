import { useEffect, useState } from "react";
import { App, Form, Input, Modal, Select } from "antd";
import type { Prompt } from "@/services/api/prompts";
import { useLocalPromptStore } from "@/stores/use-local-prompt-store";

type Draft = Pick<Prompt, "title" | "prompt" | "description" | "tags">;
export function LocalPromptEditor({ open, prompt, onClose, onSaved }: { open: boolean; prompt?: Prompt | null; onClose: () => void; onSaved: (prompt: Prompt) => void }) {
    const [form] = Form.useForm<Draft>();
    const [saving, setSaving] = useState(false);
    const { message } = App.useApp();
    const save = useLocalPromptStore((state) => state.save);
    useEffect(() => {
        if (open) form.setFieldsValue({ title: prompt?.title || "", prompt: prompt?.prompt || "", description: prompt?.description || "", tags: prompt?.tags || [] });
    }, [open, prompt, form]);
    const submit = async (draft: Draft) => {
        if (saving) return;
        setSaving(true);
        try {
            const item = await save(draft, prompt?.id);
            message.success("已保存到本地提示词库");
            onSaved(item);
            onClose();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存失败，请重试");
        } finally {
            setSaving(false);
        }
    };
    return (
        <Modal
            modalRender={node => <div data-canvas-no-zoom>{node}</div>}
            title={prompt ? "编辑本地提示词" : "新增本地提示词"}
            open={open}
            onCancel={() => {
                if (!saving) onClose();
            }}
            onOk={() => form.submit()}
            okText="保存"
            cancelText="取消"
            confirmLoading={saving}
            cancelButtonProps={{ disabled: saving }}
            keyboard={!saving}
            maskClosable={!saving}
            width={680}
        >
            <p className="mb-4 text-xs opacity-65">保存在当前浏览器，可从画布和工作台的提示词库中直接使用。</p>
            <Form form={form} layout="vertical" onFinish={submit}>
                <Form.Item name="title" label="标题" rules={[{ required: true, whitespace: true, message: "请填写标题" }]}>
                    <Input placeholder="例如：展台设计 · 自然光效果" disabled={saving} />
                </Form.Item>
                <Form.Item name="prompt" label="提示词正文" rules={[{ required: true, whitespace: true, message: "请填写提示词正文" }]}>
                    <Input.TextArea rows={9} placeholder="粘贴或编写提示词，保留分段与换行" disabled={saving} />
                </Form.Item>
                <Form.Item name="tags" label="标签">
                    <Select mode="tags" tokenSeparators={[",", "，"]} placeholder="输入标签后按回车" disabled={saving} />
                </Form.Item>
                <Form.Item name="description" label="备注">
                    <Input.TextArea rows={2} placeholder="可选，用来说明用途" disabled={saving} />
                </Form.Item>
            </Form>
        </Modal>
    );
}
