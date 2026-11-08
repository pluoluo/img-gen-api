import type { Prompt } from "./prompts";

export const PROMPT_TOPICS = ["人像与写真", "角色与头像", "产品与电商", "海报与排版", "品牌与标志", "插画与艺术", "建筑与空间", "图表与教学", "界面与网页", "场景与故事", "图像编辑", "文档与出版", "其他灵感"];
const topicRules: [string, RegExp][] = [
    ["图像编辑", /图像编辑|风格迁移|修复|去除|换装|替换|重绘|转为|转成|变为|转换|image edit|style transfer|photo restoration|turn.*into/i],
    ["产品与电商", /产品|电商|商品|美食|包装|product|e-commerce|food|packaging/i],
    ["品牌与标志", /品牌|标志|商标|logo|brand/i],
    ["海报与排版", /海报|排版|封面|缩略图|poster|typograph|cover|thumbnail|advertisement|广告/i],
    ["图表与教学", /信息图|图表|教学|教育|学习卡|infographic|chart|education|diagram|blueprint/i],
    ["界面与网页", /界面|网页|\bUI\b|\bUX\b|interface|web design|app design/i],
    ["建筑与空间", /建筑|空间|室内|庭院|architecture|interior|isometric|city/i],
    ["角色与头像", /角色|头像|手办|人物设定|表情|character|avatar|emoji|action figure|figure box/i],
    ["人像与写真", /人像|写真|摄影|肖像|portrait|photograph|realism|photo|girl/i],
    ["文档与出版", /文档|出版|书籍|手账|护照|杂志|document|publishing|passport|magazine/i],
    ["场景与故事", /场景|故事|叙事|历史|古典|旅行|风景|景观|城市|电影城|空战|街机|scene|story|history|classical|travel/i],
    ["插画与艺术", /插画|绘画|艺术|雕塑|漫画|illustrat|art|sculpture|low poly|claymation/i],
];
const styleRules: [string, RegExp][] = [
    ["写实摄影", /写实|摄影|写真|realistic|photography|hyper.real/i], ["插画", /插画|illustration/i],
    ["3D 渲染", /3d|三维|立体渲染/i], ["动漫", /动漫|二次元|anime/i], ["漫画", /漫画|comic|manga/i],
    ["水彩", /水彩|watercolor/i], ["油画", /油画|oil painting/i], ["素描线稿", /素描|线稿|sketch|line art/i],
    ["像素风", /像素|pixel art/i], ["极简", /极简|简约|minimalis/i], ["复古", /复古|retro|vintage/i],
    ["电影感", /电影感|cinematic/i], ["胶片", /胶片|film grain|analog film/i], ["黑白", /黑白|monochrome|black.and.white/i],
    ["国风", /国风|水墨|chinese ink/i], ["赛博朋克", /赛博朋克|cyberpunk/i], ["科幻", /科幻|sci.fi/i],
    ["黏土", /黏土|粘土|clay/i], ["纸艺", /纸艺|剪纸|paper.?cut|paper.?craft/i], ["扁平矢量", /矢量|flat design|vector art/i],
];
export const PROMPT_STYLES = styleRules.map(([name]) => name);

const categoryAliases: Record<string, string> = {
    "Architecture & Spaces": "建筑与空间", "建筑与空间": "建筑与空间", "空间设计": "建筑与空间",
    "Brand & Logos": "品牌与标志", "品牌与Logo": "品牌与标志", "Characters & People": "角色与头像", "角色与人物": "角色与头像",
    "Charts & Infographics": "图表与教学", "图表与信息图": "图表与教学", "信息图、教育与文档": "图表与教学",
    "Documents & Publishing": "文档与出版", "文档与出版": "文档与出版", "History & Classical Themes": "场景与故事", "历史与古典主题": "场景与故事",
    "Illustration & Art": "插画与艺术", "绘画与艺术": "插画与艺术", "Photography & Realism": "人像与写真", "摄影与写实": "人像与写真",
    "Posters & Typography": "海报与排版", "海报与排版": "海报与排版", "字体排版与海报设计": "海报与排版",
    "Products & E-commerce": "产品与电商", "产品与电商": "产品与电商", "电商主图": "产品与电商", "产品营销": "产品与电商",
    "Scenes & Storytelling": "场景与故事", "场景与叙事": "场景与故事", "漫画 / 故事板": "场景与故事",
    "UI & Interfaces": "界面与网页", "UI与界面": "界面与网页", "UI / UX 与社交媒体": "界面与网页",
    "个人资料 / 头像": "角色与头像", "图像编辑与风格迁移": "图像编辑",
};
const titleTranslations: Record<string, string> = {
    "a premium claw machine": "高端品牌抓娃娃机", "a luxurious wooden door": "奢华木门特写", "candy sculpture": "糖果雕塑人像",
    "3D miniature scene inside a clear glass snow globe": "玻璃雪景球中的 3D 微缩场景", "3D Emoji": "3D 表情符号",
    "Blueprint schematic": "蓝图结构示意图", "A whimsical miniature Apple Store": "奇趣微缩苹果商店", "Capsule": "胶囊微缩场景",
    "Advertisement poster": "广告海报", "dimensional break card": "突破画框的立体卡片", "poster": "创意海报",
    "fashion magazine cover": "时尚杂志封面", "passport page": "护照内页设计", "PSA": "公益宣传海报", "keycap scene": "键帽上的微缩场景",
    "low poly": "低多边形艺术", "typographic portrait": "文字排版人像", "illustration": "创意插画",
    "Turn your profile image into a sculpture!": "将头像变为雕塑", "Reality photo": "写实照片", "Turn drawings into stunning photographs": "将绘画变为真实照片",
    "Isometric view of a city": "城市等距视角", "Figure Box": "手办展示盒", "Changer ages": "人物年龄变化", "3D characters": "3D 角色设计",
    "action figure": "可动人偶", "fluffy logo": "毛绒标志", "3D fluffy emojis": "3D 毛绒表情", "3D-style icons": "3D 风格图标",
    "3d avatar asset": "3D 头像素材", "action figure pack": "可动人偶套装", "3D character": "3D 角色", "claymation": "黏土动画风格",
    "Arcade diorama": "街机微缩场景", "LinkedIn Photo": "职业社交头像", "Girl": "人物写真", "PPT": "演示文稿设计",
};

export function isChinesePrompt(text: string) {
    return (text.match(/[\u4e00-\u9fff]/g)?.length || 0) > (text.match(/[a-z]/gi)?.length || 0) / 4;
}
const normalize = (value: string) => value.normalize("NFKC").replace(/\\n/g, "\n").replace(/\s+/g, " ").trim().toLocaleLowerCase();

export type PromptClassifications = Record<string, { topic: string; tags: string[]; updatedAt: number }>;

export function promptClassificationKeys(item: Prompt): string[] {
    return item.classificationKeys || (item.sourceId === "local-library" ? [`local:${item.id}`] : [normalize(item.originalPrompt || item.prompt), ...(item.promptZh ? [normalize(item.promptZh)] : [])]);
}

export function applyPromptClassification(item: Prompt, overrides: PromptClassifications): Prompt {
    const correction = promptClassificationKeys(item).map(key => overrides[key]).filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    const automatic = { ...item, topic: item.automaticTopic || item.topic, tags: item.automaticTags || item.tags, classificationEdited: false };
    return correction ? { ...automatic, topic: correction.topic, tags: [...correction.tags], classificationEdited: true } : automatic;
}

export function organizePrompts(items: Prompt[], overrides: PromptClassifications = {}): Prompt[] {
    const groups = new Map<string, Prompt>();
    const ordered: Prompt[] = [];
    for (const raw of items) {
        const body = raw.originalPrompt || raw.prompt;
        const rawTags = raw.originalTags || raw.tags;
        const title = titleTranslations[raw.title] || raw.title;
        // Titles carry intent; metadata is only the fallback. Never infer style from a negated body instruction.
        const topic = raw.topic || topicRules.find(([, rule]) => rule.test(title))?.[0] || rawTags.map(tag => categoryAliases[tag]).find(Boolean) || topicRules.find(([, rule]) => rule.test(rawTags.join(" ")))?.[0] || "其他灵感";
        const titleStyles = styleRules.filter(([, rule]) => rule.test(title)).map(([name]) => name);
        const tags = raw.sourceId === "local-library" ? [...rawTags] : titleStyles.length ? titleStyles : styleRules.filter(([, rule]) => rule.test(rawTags.join(" "))).map(([name]) => name);
        const promptZh = raw.promptZh || (isChinesePrompt(body) ? body : "");
        const origins = raw.origins || [{ sourceId: raw.sourceId, name: raw.category, url: raw.githubUrl, author: raw.author || "" }];
        const item: Prompt = { ...raw, title, originalTitle: raw.originalTitle || raw.title, originalPrompt: body, promptZh, topic, originalTags: rawTags, tags, origins };
        // Local records remain separately editable even when their text matches a public example.
        const keys = raw.sourceId === "local-library" ? [`local:${raw.id}`] : [normalize(body), ...(promptZh ? [normalize(promptZh)] : [])];
        item.classificationKeys = keys;
        const existing = keys.map(key => groups.get(key)).find(Boolean);
        if (existing) {
            existing.classificationKeys = [...new Set([...promptClassificationKeys(existing), ...keys])];
            existing.origins = [...(existing.origins || []), ...origins].filter((origin, index, all) => all.findIndex(other => other.sourceId === origin.sourceId && other.url === origin.url) === index);
            existing.promptZh ||= promptZh;
            existing.coverUrl ||= item.coverUrl;
            existing.translationLabel ||= item.translationLabel;
            existing.referenceImageUrls = [...new Set([...existing.referenceImageUrls, ...item.referenceImageUrls])];
            if (!existing.tags.length) existing.tags = tags;
            for (const key of keys) groups.set(key, existing);
        } else {
            ordered.push(item);
            for (const key of keys) groups.set(key, item);
        }
    }
    return ordered.map(item => applyPromptClassification({ ...item, automaticTopic: item.topic, automaticTags: item.tags }, overrides));
}

export function promptSummary(item: Prompt) {
    return item.description || (item.promptZh ? item.promptZh.replace(/\\n/g, "\n") : `${item.topic || "创作灵感"} · 英文原文，可在详情中按需翻译`);
}

export function promptMatches(item: Prompt, keyword: string) {
    const text = [item.title, item.originalTitle, item.prompt, item.promptZh, item.description, item.topic, ...item.tags].join(" ").toLocaleLowerCase();
    return keyword.trim().toLocaleLowerCase().split(/\s+/).every(word => text.includes(word));
}
