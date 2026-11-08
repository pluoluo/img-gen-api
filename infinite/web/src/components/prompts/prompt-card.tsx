import { Copy } from "lucide-react";
import type { ReactNode } from "react";
import { Button, Card, Tag } from "antd";
import { useTranslation } from "react-i18next";

import { type Prompt } from "@/services/api/prompts";

import { PromptImage } from "./prompt-image";
import { promptSummary } from "@/services/api/prompt-organization";

export function PromptCard({
    item,
    onOpen,
    onCopy,
    actionLabel,
    actionIcon = <Copy className="size-3.5" />,
    actionType = "text",
    extraAction,
    compact = false,
}: {
    item: Prompt;
    onOpen: () => void;
    onCopy: () => void;
    actionLabel?: string;
    actionIcon?: ReactNode;
    actionType?: "text" | "primary";
    extraAction?: ReactNode;
    compact?: boolean;
}) {
    const { t } = useTranslation();
    return (
        <Card
            hoverable
            className={compact ? "group cursor-pointer overflow-hidden transition-transform duration-200 hover:-translate-y-1" : "flex h-full flex-col overflow-hidden"}
            styles={{ body: compact ? { padding: 0 } : { display: "flex", flex: 1, flexDirection: "column", padding: 0 } }}
            cover={
                <button type="button" className="block w-full cursor-pointer text-left" onClick={onOpen}>
                    <PromptImage src={item.coverUrl} title={item.title} className={compact ? "aspect-square w-full object-cover" : "aspect-[4/3] w-full object-cover"} />
                </button>
            }
        >
            <button type="button" className={compact ? "block w-full cursor-pointer text-left" : "block w-full flex-1 cursor-pointer text-left"} onClick={onOpen}>
                <div className={compact ? "px-3 py-2.5" : "p-4"}>
                    <div className="flex items-start justify-between gap-3">
                        <h2 className="line-clamp-2 text-sm font-semibold text-stone-950 dark:text-stone-100">{item.title}</h2>

                    </div>
                    {!compact ? <><div className="mt-2 text-xs text-stone-500 dark:text-stone-400">{item.topic}{item.promptZh ? " · 中文可读" : " · 英文原文"}</div><p className="mt-2 line-clamp-3 text-xs leading-5 text-stone-600 dark:text-stone-400">{promptSummary(item)}</p><div className="mt-3 flex flex-wrap gap-1.5">{item.tags.slice(0, 3).map((tag) => <Tag key={tag} className="m-0 text-[11px]">{tag}</Tag>)}</div></> : null}
                </div>
            </button>
            {!compact ? <div className="mt-auto flex items-center gap-2 px-4 pb-4"><Button block={actionType === "primary"} type={actionType} size="small" icon={actionIcon} onClick={onCopy}>{actionLabel || (item.promptZh && item.promptZh !== (item.originalPrompt || item.prompt) ? "复制原文" : t("common.copy"))}</Button>{extraAction}</div> : null}
        </Card>
    );
}
