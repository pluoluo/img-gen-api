import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";

import { LOCAL_PROMPT_CATEGORY, useLocalPromptStore } from "@/stores/use-local-prompt-store";
import { usePromptClassificationStore } from "@/stores/use-prompt-classification-store";
import { usePromptSourceStore } from "@/stores/use-prompt-source-store";
import { ALL_PROMPTS_OPTION, fetchPrompts } from "@/services/api/prompts";

export const PROMPT_PAGE_SIZE = 20;

export function usePromptList({ keyword, tags, category, enabled = true, view = "all" }: { keyword: string; tags: string[]; category: string; enabled?: boolean; view?: string }) {
    const sources = usePromptSourceStore(state => state.sources);
    const classificationRevision = usePromptClassificationStore(state => state.revision);
    const localRevision = useLocalPromptStore(state => state.revision);
    const [debouncedKeyword, setDebouncedKeyword] = useState(keyword);
    useEffect(() => {
        const timer = setTimeout(() => setDebouncedKeyword(keyword), 300);
        return () => clearTimeout(timer);
    }, [keyword]);
    const query = useInfiniteQuery({
        queryKey: ["prompts", debouncedKeyword, tags, category, localRevision, sources, view, classificationRevision],
        queryFn: ({ pageParam }) => fetchPrompts({ keyword: debouncedKeyword, tag: tags, category, page: pageParam, pageSize: PROMPT_PAGE_SIZE, view }),
        initialPageParam: 1,
        getNextPageParam: (lastPage, pages) => (pages.reduce((total, page) => total + page.items.length, 0) < lastPage.total ? pages.length + 1 : undefined),
        enabled,
    });
    const firstPage = query.data?.pages[0];
    return {
        query,
        items: useMemo(() => query.data?.pages.flatMap((page) => page.items) || [], [query.data?.pages]),
        tags: useMemo(() => [ALL_PROMPTS_OPTION, ...(firstPage?.tags || [])], [firstPage?.tags]),
        categories: useMemo(() => [...new Set([ALL_PROMPTS_OPTION, LOCAL_PROMPT_CATEGORY, ...(firstPage?.categories || [])])], [firstPage?.categories]),
        total: firstPage?.total || 0,
        warnings: firstPage?.warnings || [],
        mergedCount: firstPage?.mergedCount || 0,
    };
}
