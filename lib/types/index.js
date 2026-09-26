/**
 * Register {@link QoderAdapter} for the `qoder` and `qoder-byok` provider
 * routes on `ctx.llm`. The inner sessions ride on the local `qodercli` login
 * state through the qoder-agent-sdk: the advertised model catalog is fetched
 * live from the CLI and split into the account's built-in models (`qoder`)
 * and its custom models (`qoder-byok`), every model is addressable by its SDK
 * value (plus the two `deepseek-v4-*` aliases), and warm inner sessions close
 * with the plugin.
 *
 * Configuration rides the profile entry's own `Config` schema: the settings
 * service projects it for the entry id, so this plugin needs no settings
 * namespace registration of its own.
 * @module @mreate/dsh-llm-qoder
 */
import z from '@deepseek-ai/schemastery';
import { QoderAdapter, QODER_BYOK_PROVIDER, QODER_PROVIDER } from "./adapter.js";
export { QoderAdapter, QODER_PROVIDER, QODER_BYOK_PROVIDER } from "./adapter.js";
export { QoderSession, QoderSessionManager } from "./session.js";
export { QODER_MODELS, resolveQoderModelId } from "./catalog.js";
export { QoderModelCatalog } from "./models.js";
export const name = 'llm-qoder';
export const inject = ['llm'];
/**
 * Directory namespace shared by both routes. It is the profile entry id this
 * plugin is mounted under (`llm-qoder` in `cordis.patch.yml`), which is the
 * key configuration surfaces address; the seam types it as a plain string.
 */
const NS = 'llm-qoder';
export const Config = z.object({
    maxSessions: z.number().step(1).min(1).max(64).default(8),
    modelCacheTtlSeconds: z.number().step(1).min(10).max(86_400).default(300),
});
export function apply(ctx, config) {
    const adapter = new QoderAdapter({
        maxSessions: config.maxSessions ?? 8,
        modelCacheTtlMs: (config.modelCacheTtlSeconds ?? 300) * 1000,
    });
    ctx.llm.registerAdapter([QODER_PROVIDER, QODER_BYOK_PROVIDER], adapter);
    // Declare the routes in the configurable-provider directory so selection
    // surfaces (the composer model seat, the Models settings page) render the
    // Qoder groups with their display names instead of anonymous routes.
    ctx.llm.registerConfigurableProviders([
        { provider: QODER_PROVIDER, displayName: 'Qoder CLI', settingsNs: NS, settingsPath: [] },
        { provider: QODER_BYOK_PROVIDER, displayName: 'Qoder 自定义', settingsNs: NS, settingsPath: [] },
    ]);
    // registerAdapter's disposer only withdraws the routes; the warm qodercli
    // subprocesses are owned by the adapter and must close with the plugin.
    ctx.effect(() => () => adapter.close(), 'llm-qoder.sessions');
}
//# sourceMappingURL=index.js.map