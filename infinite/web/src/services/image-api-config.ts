import { IMAGE_API_PATH, imageApiRequest } from "@/services/api/image-api";
import { modelOptionsFromChannels, useConfigStore, type ChannelModel, type ModelChannel } from "@/stores/use-config-store";

export async function initializeImageApi() {
    // The upstream standalone application remains usable without image-api.
    if (!import.meta.env.VITE_IMAGE_API) return;
    const metadata = await imageApiRequest<{ app: string; models: ChannelModel[]; provider_models: ChannelModel[] }>(`${IMAGE_API_PATH}/config`);
    if (metadata.app !== "image-api") throw new Error("画布服务配置不正确");
    const { config, webdav } = useConfigStore.getState();
    const channel: ModelChannel = {
        id: "image-api",
        name: "本机生图服务",
        baseUrl: `${location.origin}${IMAGE_API_PATH}`,
        apiKey: "",
        apiFormat: "openai",
        models: metadata.models.map((model) => ({ ...model, script: config.channels.find((item) => item.id === "image-api")?.models.find((item) => item.name === model.name)?.script })),
    };
    const providerModels = config.channels.find((item) => item.id === "image-api-openai")?.models || [];
    const provider: ModelChannel = {
        ...channel,
        id: "image-api-openai",
        name: "本机文本与音频服务",
        baseUrl: `${channel.baseUrl}/openai`,
        models: metadata.provider_models.map((model) => ({ ...model, script: providerModels.find((item) => item.name === model.name)?.script })),
    };
    const defaultChannelConfigured = Boolean(config.channels.find((item) => item.id === "default")?.apiKey.trim());
    const channels = [channel, ...(provider.models.length ? [provider] : []), ...config.channels.filter((item) => item.id !== channel.id && item.id !== provider.id && (item.id !== "default" || defaultChannelConfigured))];
    const firstModel = metadata.models[0]?.name;
    const unsupportedSelection = (value: string) => (!defaultChannelConfigured && value.startsWith("default::")) || (!provider.models.length && value.startsWith("image-api-openai::"));
    const unconfiguredDefault = config.imageModel.startsWith("default::") && !defaultChannelConfigured;
    const imageModel = (!config.imageModel || unconfiguredDefault) && firstModel ? `image-api::${firstModel}` : config.imageModel;
    useConfigStore.setState({
        config: {
            ...config,
            channels,
            models: modelOptionsFromChannels(channels),
            imageModel,
            model: imageModel,
            textModel: unsupportedSelection(config.textModel) ? "" : config.textModel,
            audioModel: unsupportedSelection(config.audioModel) ? "" : config.audioModel,
            videoModel: unsupportedSelection(config.videoModel) ? "" : config.videoModel,
        },
        webdav: webdav.url ? webdav : { ...webdav, url: `${location.origin}${IMAGE_API_PATH}/storage` },
    });
}
