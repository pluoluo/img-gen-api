import { useEffect, useState } from "react";
import { App, Alert, Button, Empty, Input, Modal, Image, Pagination, Skeleton } from "antd";
import { galleryThumbnailUrl, importGalleryImage, readImageApiGallery, type GalleryImage } from "@/services/api/image-api-gallery";
import { useAssetStore } from "@/stores/use-asset-store";
import type { InsertAssetPayload } from "./asset-picker-modal";

const PAGE_SIZE = 8;

export function ImageApiGallery({ onInsert }: { onInsert?: (payload: InsertAssetPayload) => void }) {
    const { message } = App.useApp();
    const assets = useAssetStore((state) => state.assets);
    const [page, setPage] = useState(1);
    const [inputImage, setInputImage] = useState<GalleryImage | null>(null);
    const [keyword, setKeyword] = useState("");
    const [result, setResult] = useState<{ items: GalleryImage[]; total: number }>({ items: [], total: 0 });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [refresh, setRefresh] = useState(0);
    const [importing, setImporting] = useState<string | null>(null);
    useEffect(() => {
        let active = true;
        setLoading(true);
        setError("");
        void readImageApiGallery(page, PAGE_SIZE, keyword)
            .then((data) => {
                if (active) {
                    setResult(data);
                    if (page > 1 && (page - 1) * PAGE_SIZE >= data.total) setPage(Math.max(1, Math.ceil(data.total / PAGE_SIZE)));
                }
            })
            .catch((failure) => {
                if (active) setError(String(failure));
            })
            .finally(() => {
                if (active) setLoading(false);
            });
        return () => {
            active = false;
        };
    }, [page, keyword, refresh]);
    useEffect(() => {
        const refreshGallery = () => setRefresh((value) => value + 1);
        window.addEventListener("focus", refreshGallery);
        return () => window.removeEventListener("focus", refreshGallery);
    }, []);
    const importImage = async (image: GalleryImage, insert: boolean) => {
        setImporting(image.id);
        try {
            const asset = await importGalleryImage(image);
            if (insert && asset.kind === "image") await onInsert?.({ kind: "image", dataUrl: asset.data.dataUrl, storageKey: asset.data.storageKey, title: asset.title });
            else message.success("已加入我的资产");
        } catch (failure) {
            message.error(String(failure));
        } finally {
            setImporting(null);
        }
    };
    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2"><a href="/gallery" target="_blank" rel="noopener noreferrer" className="text-sm underline">管理图库</a></div>
            <p className="text-sm text-muted-foreground">导入到“我的资产”后，即可在画布和工作台使用。</p>
            <Modal title="生成时使用的参考图" open={Boolean(inputImage)} onCancel={() => setInputImage(null)} footer={null} width={720} destroyOnHidden>
                <p className="mb-4 text-sm text-muted-foreground">按提交顺序保存原图；下载和插入不会重新生成。</p>
                <div className="grid grid-cols-2 gap-4">
                    {inputImage?.inputs?.references.map((reference, index) => (
                        <div key={`${reference.filename}-${index}`} className="space-y-2">
                            <div className="overflow-hidden rounded-lg border border-border bg-muted/30"><Image src={reference.url} alt={`参考图 ${index + 1}`} className="aspect-square object-contain" /></div>
                            <p className="text-sm">参考图 {index + 1}</p>
                            <a href={reference.url} download={reference.filename} className="text-sm underline">下载原图</a>
                            {onInsert ? <Button size="small" type="text" disabled={Boolean(importing)} onClick={() => void importImage({ ...inputImage, id: `${inputImage.id}:reference:${index}`, filename: "", image_url: reference.url, prompt: `${inputImage.prompt} · 参考图 ${index + 1}`, inputs: null }, true)}>插入参考图</Button> : null}
                        </div>
                    ))}
                </div>
                {inputImage?.inputs?.mask ? <div className="mt-4 space-y-2"><p className="text-sm">局部编辑蒙版</p><span className="inline-block overflow-hidden rounded-lg border border-border bg-muted/30"><Image src={inputImage.inputs.mask.url} alt="局部编辑蒙版" width={160} /></span><a href={inputImage.inputs.mask.url} download={inputImage.inputs.mask.filename} className="ml-3 text-sm underline">下载蒙版</a></div> : null}
            </Modal>
            <Input.Search
                aria-label="搜索旧图库"
                placeholder="搜索提示词或模型"
                allowClear
                onSearch={(value) => {
                    setKeyword(value);
                    setPage(1);
                }}
            />
            {error ? (
                <Alert type="error" title="图库加载失败" description={error} action={<Button onClick={() => setRefresh((value) => value + 1)}>重试加载</Button>} />
            ) : loading ? (
                <div aria-label="正在加载图库" className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                    {Array.from({ length: 4 }, (_, index) => (
                        <Skeleton.Image key={index} active />
                    ))}
                </div>
            ) : result.items.length ? (
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                    {result.items.map((image) => {
                        const imported = assets.some((asset) => asset.metadata?.galleryId === image.id);
                        const available = Boolean(galleryThumbnailUrl(image));
                        return (
                            <div key={image.id} className="min-w-0 space-y-2">
                                {available ? (
                                    <img src={galleryThumbnailUrl(image)} alt={image.prompt || image.filename} loading="lazy" className="aspect-square w-full rounded-lg object-cover" />
                                ) : (
                                    <div className="flex aspect-square items-center justify-center text-sm text-muted-foreground">原图不可用</div>
                                )}
                                <p className="line-clamp-2 min-h-10 text-sm" title={image.prompt}>
                                    {image.prompt || image.filename}
                                </p>
                                {image.inputs?.references.length ? (
                                    <Button size="small" type="text" onClick={() => setInputImage(image)}>参考图 {image.inputs.references.length} 张</Button>
                                ) : <p className="text-xs text-muted-foreground">{image.inputs ? "文生图 · 无参考图" : "旧记录未保存参考图"}</p>}
                                <div className="flex flex-wrap gap-2">
                                    <Button size="small" type="text" disabled={!available || imported || Boolean(importing)} loading={importing === image.id} onClick={() => void importImage(image, false)}>
                                        {imported ? "已加入" : "加入我的资产"}
                                    </Button>
                                    {onInsert ? (
                                        <Button size="small" type="text" disabled={!available || Boolean(importing)} onClick={() => void importImage(image, true)}>
                                            插入
                                        </Button>
                                    ) : null}
                                </div>
                            </div>
                        );
                    })}
                </div>
            ) : (
                <Empty description={keyword ? "没有匹配的图片，试试其他关键词" : "旧图库暂无图片，生成后可在这里导入"} />
            )}
            {result.total > PAGE_SIZE ? <Pagination size="small" current={page} pageSize={PAGE_SIZE} total={result.total} showSizeChanger={false} onChange={setPage} /> : null}
        </div>
    );
}
