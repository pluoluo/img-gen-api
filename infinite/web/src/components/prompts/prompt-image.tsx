import { ImageOff, FileText } from "lucide-react";
import { useState } from "react";

export function PromptImage({ src, title, className = "aspect-[4/3] w-full object-cover" }: { src: string; title: string; className?: string }) {
    const [failedUrl, setFailedUrl] = useState("");
    if (!src || failedUrl === src) return <span className={`flex flex-col items-center justify-center gap-2 bg-stone-100 text-stone-500 dark:bg-stone-900 dark:text-stone-400 ${className}`}>
        {src ? <ImageOff className="size-6" /> : <FileText className="size-6" />}<span className="text-xs">{src ? "示例图暂不可用" : "文字模板"}</span>
    </span>;
    return <img src={src} alt={title} className={className} loading="lazy" decoding="async" onError={() => setFailedUrl(src)} />;
}
