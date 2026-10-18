import Fastify from "fastify";
import path from "path";
import { getServerTime } from "./utils";
import { getRealNow, getRealNowMs } from "./runtime/time/game-time";
import getDatabase, {
    checkpointDatabase,
    closeDatabase,
    Database,
    getDatabaseStatus,
    initializeDatabase,
} from "./data";
import { ServerTimeService } from "./runtime/server-time/service";
import { getContentSnapshot, initializeContentSnapshot } from "./content/runtime/content-snapshot";
import { resolveCnCdnRoot } from "./content/paths";
import { createContentLifecycleDependencies } from "./modes/cn-lifecycle";
import { listLoadedModeIdentities } from "./modes/registry";
import { configureSerializedAssetVersionProvider } from "./data/utils/serialized-asset-version";
import {
    createRuntimeCapabilitiesSnapshot,
    registerRuntimeCapabilitiesRoute,
} from "./runtime/capabilities";
import { parseCnRuntimeConfig } from "./runtime/config";
import {
    createRuntimeCoordinator,
    RuntimeCoordinator,
} from "./runtime/lifecycle";
import { productionGameCalendarProvider } from "./time/game-calendar-provider";
import { registerRuntimeHealthRoute } from "./runtime/health";
import { loadBundleMetadata } from "./runtime/bundle-metadata";
import { registerAdminUi } from "./runtime/admin";
import { installAdminAuth, resolveAdminAuthConfig } from "./runtime/admin-auth";
import { installCnBodyParsers } from "./runtime/cn-body-parsers";
import { installConsoleLogGate, resolveServerLogFilePath, resolveServerLogLevel } from "./runtime/log-level";

import versionCheckPlugin from "./routes/cn/versionCheck";
import iosLeitingPlugin from "./routes/cn/ios-leiting";
import leitingAuthPlugin from "./routes/cn/leitingAuth";
import cnTakeOverPlugin from "./routes/cn/takeOver";
import cnToolPlugin from "./routes/cn/tool";
import cnLoadPlugin from "./routes/cn/load";
import { registerCnAssetProviderRoutes } from "./routes/cn/asset-provider";
import { registerCnMsgpackOnSend } from "./routes/cn/msgpack";
import indexWebApiPlugin from "./routes/web_api";
import spAuthPlugin from "./routes/sp-auth";
import seedsWebApiPlugin from "./routes/web_api/seeds";
import { resolveBotApiToken } from "./routes/web_api/bot";
import { getDefaultGachaSeedQuarantine } from "./lib/gacha-seed-quarantine";
import { getMissionCatalog } from "./lib/mission/mission-catalog";
import { assertMissionConditionRouting } from "./lib/mission/requirements/routing-validation";
import reproduceApiPlugin from "./routes/api/reproduce";
import tutorialApiPlugin from "./routes/api/tutorial";
import gachaApiPlugin from "./routes/api/gacha";
import partyApiPlugin from "./routes/api/party";
import expodApiPlugin from "./routes/api/expod";
import storyQuestApiPlugin from "./routes/api/storyQuest";
import optionApiPlugin from "./routes/api/option";
import singleBattleQuestApiPlugin from "./routes/api/singleBattleQuest";
import { multiBattleRoutes } from "./multi";
import { createMultiRuntimeService } from "./multi/runtime/service";
import { MultiManagementService } from "./multi/management/service";
import { createMultiManagementCredentialProvider } from "./multi/management/credentials";
import attentionApiPlugin from "./routes/api/attention";
import characterApiPlugin from "./routes/api/character";
import characterManaPlugin from "./routes/api/character/mana";
import characterBondPlugin from "./routes/api/character/bond";
import partyGroupApiPlugin from "./routes/api/partyGroup";
import equipmentApiPlugin from "./routes/api/equipment";
import sellApiPlugin from "./routes/api/sell";
import exBoostApiPlugin from "./routes/api/exBoost";
import boxGachaApiPlugin from "./routes/api/boxGacha";
import shopApiPlugin from "./routes/api/shop";
import howToGetApiPlugin from "./routes/api/howToGet";
import exchangeApiPlugin from "./routes/api/exchange";
import encyclopediaApiPlugin from "./routes/api/encyclopedia";
import mailApiPlugin from "./routes/api/mail";
import rankingEventApiPlugin from "./routes/api/rankingEvent";
import missionApiPlugin from "./routes/api/mission";
import activeMissionApiPlugin from "./routes/api/activeMission";
import passCardApiPlugin from "./routes/api/passCard";
import paymentApiPlugin from "./routes/api/payment";
import newsApiPlugin from "./routes/api/news";
import raidEventApiPlugin from "./routes/api/raidEvent";
import rushEventApiPlugin from "./routes/api/rushEvent";
import carnivalEventApiPlugin from "./routes/api/carnivalEvent";
import contentsGuideApiPlugin from "./routes/api/contentsGuide";
import profileApiPlugin from "./routes/api/profile";
import playerHistoryApiPlugin from "./routes/api/playerHistory";
import { snsCompatibilityRoutes } from "./routes/api/socialCompatibility";
import followApiPlugin from "./routes/api/follow";
import historyApiPlugin from "./routes/api/history";
import comicApiPlugin from "./routes/api/comic";
import questUnlockApiPlugin from "./routes/api/questUnlock";
import itemApiPlugin from "./routes/api/item";
import characterElectionApiPlugin from "./routes/api/characterElection";
import giftApiPlugin from "./routes/api/gift";
import bonusApiPlugin from "./routes/api/bonus";
import { installTakeoverUdidGuard } from "./lib/takeover-access";
import { installGameAuthGuard } from "./lib/game-auth";
import { installUdidProbeFromEnv } from "./lib/udid-probe";
import { reportBindGateMode } from "./lib/bind-gate";
import { reportDeviceFollowMode } from "./lib/sp-auth/device-follow";
import { createIosNoticeCodeProvider } from "./lib/ios-notice-code";
import { AccountCleanupService } from "./lib/account-cleanup";
import {
    ReceiveHistoryRetentionService,
    resolveReceiveHistoryRetentionConfig,
} from "./lib/receive-history-retention";
// 日志开关（`SP_LOG_LEVEL` / `SP_LOG_FILE`，语义见 src/runtime/log-level.ts）：
// 缺省 info = 与历史行为一致；低于 info 时窗口只留 warn/error，其余改道落盘（缺省 logs/server.log）。
// 必须在建 Fastify 之前安装 —— 之后 pino 的请求日志才跟着降级。
const serverLogLevel = resolveServerLogLevel(process.env);
if (serverLogLevel !== "info") {
    const gate = installConsoleLogGate({
        level: serverLogLevel,
        filePath: resolveServerLogFilePath(process.env, path.resolve(__dirname, "..")),
    });
    console.warn(
        gate.filePath === null
            ? `[LOG] SP_LOG_LEVEL=${serverLogLevel}：请求日志与 info 级输出已静默（SP_LOG_FILE=0，不落盘）`
            : `[LOG] SP_LOG_LEVEL=${serverLogLevel}：请求日志与 info 级输出改道 ${gate.filePath}（窗口只留 warn/error）`,
    );
}
const fastify = Fastify({
    logger: {
        level: serverLogLevel
    },
    bodyLimit: 262144  // 256KB — covers /single_battle_quest/finish large battle stats
});
const projectRoot = path.resolve(__dirname, "..");
let runtimeCoordinator: RuntimeCoordinator;
const multiRuntimeService = createMultiRuntimeService();
let startupRuntimeConfig: ReturnType<typeof parseCnRuntimeConfig> | null = null;
let multiManagementService: MultiManagementService | null = null;
const serverTimeService = new ServerTimeService();
const gachaSeedQuarantine = getDefaultGachaSeedQuarantine();
const accountCleanupService = new AccountCleanupService();
const receiveHistoryRetentionService = new ReceiveHistoryRetentionService(
    () => getDatabase(Database.WDFP_DATA),
    resolveReceiveHistoryRetentionConfig(),
    { getNow: () => getRealNow() },
);

// 调试/崩溃上报端点的每-IP 限流（2026-10-18 加固）。
// 以前只拦 `/crash`，而 `/debug` 是任何人可打的日志写入口（`loc` 原样进日志 ⇒
// 可注入换行伪造日志行、可无限刷把日志与磁盘撑满）；限流键还取过
// `X-Forwarded-For` 的第一个值 —— 那是调用方自带的字段，换一个值就换一个桶，
// 限流形同虚设、Map 还会被伪造键撑爆。现在：两个端点共用一张表，
// 键只用 TCP 对端地址（本部署不挂反向代理），并给 Map 加了清理。
const RATE_LIMITED_PATHS = new Set(["/crash", "/debug"]);
const rateLimitMap = new Map<string, { count: number; reset: number }>();
const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAP_LIMIT = 4096;
fastify.addHook("onRequest", async (request, reply) => {
    if (!RATE_LIMITED_PATHS.has(request.url.split("?")[0])) return;
    const ip = request.ip;
    const now = getRealNowMs();
    const entry = rateLimitMap.get(ip) || { count: 0, reset: now + RATE_LIMIT_WINDOW };
    if (now > entry.reset) { entry.count = 0; entry.reset = now + RATE_LIMIT_WINDOW; }
    if (++entry.count > RATE_LIMIT_MAX) {
        return reply.status(429).send("Too Many Requests");
    }
    if (rateLimitMap.size >= RATE_LIMIT_MAP_LIMIT) {
        for (const [key, value] of rateLimitMap) {
            if (now > value.reset) rateLimitMap.delete(key);
        }
    }
    rateLimitMap.set(ip, entry);
});

registerCnMsgpackOnSend(fastify);

// 统一错误出口（2026-10-18 加固）：Fastify 缺省会把未捕获异常的 message 原样回给
// 调用方 —— SQLite 的报错里带表名/列名/SQL 片段、ENOENT 里带绝对路径，等于让任何人
// 免费测绘服务端内部结构。5xx 一律压成固定文案（细节仍进服务端日志），4xx 保留原文。
fastify.setErrorHandler((error, request, reply) => {
    const statusCode = typeof error.statusCode === "number" && error.statusCode >= 400
        ? error.statusCode
        : 500;
    if (statusCode >= 500) {
        request.log.error({ err: error }, "unhandled request failure");
        return reply.status(statusCode).send({
            statusCode,
            error: "Internal Server Error",
            message: "Internal Server Error",
        });
    }
    return reply.status(statusCode).send({
        statusCode,
        code: (error as { code?: string }).code,
        error: error.name || "Bad Request",
        message: error.message,
    });
});
registerRuntimeHealthRoute(fastify, () => runtimeCoordinator.getHealthSnapshot());
installTakeoverUdidGuard(fastify);
// B0 身份取证探针（默认关，SP_PROBE_UDID=1 才注册）：只记日志，不改行为。
installUdidProbeFromEnv(fastify);
// 绑定闸门（契约 C3，卡 A5）：启动时打一行开/关横幅，服主一眼可见。
reportBindGateMode();
// 「并号」（2026-10-18）：门里换账号后游戏仍进旧账号的修法，同样在启动时打一行横幅。
reportDeviceFollowMode();

// 请求正文解析器（JSON + 表单/base64 msgpack）住在 `src/runtime/cn-body-parsers.ts`：
// 那里能被契约测试直接喂真实实现（本文件 import 即启动整台服务器，测不了）。
// 后台登录表单的解析顺序 bug（对正确口令也 401）就栽在那段逻辑上，见该文件头部注释。
installCnBodyParsers(fastify);

// 游戏 API 的请求认证（2026-10-18 加固）：校验客户端 `LOGIN_TOKEN` 头与请求体
// `viewer_id` 是否属于同一账号。**默认 enforce**（拦下没有令牌或不匹配的请求），
// 逃生门是 GAME_AUTH_MODE=audit（只记录不拦）。
// 必须在这里装 —— signup 发出令牌，而它签发的 accountId 要从 body 里读。
installGameAuthGuard(fastify);

fastify.register(leitingAuthPlugin, { prefix: "/api/index.php" });
fastify.register(cnTakeOverPlugin, { prefix: "/api/index.php" });
// 自研客户端登录/绑定 API（契约 C1）：与游戏 API 分开挂载，客户端硬编码地址时用它。
fastify.register(spAuthPlugin, { prefix: "/sp-auth" });

// 后台口令闸门：必须在所有 /admin/ 与 /api/* 管理路由之前注册（onRequest 钩子按注册顺序生效）。
// 配置错误（ADMIN_PASSWORD 太短/带空白）在这里抛异常 —— 进程退出，不静默降级成"无认证"。
installAdminAuth(fastify, {
    config: resolveAdminAuthConfig(),
    // 机器人（/api/bot 契约）没有后台会话，它带 X-Bot-Token；闸门据此放行机器人端点与握手元数据，
    // 其余管理面照旧只认会话（见 src/runtime/admin-auth.ts 的 BOT_TOKEN_PASSTHROUGH_PATHS）。
    botToken: resolveBotApiToken(process.env),
});

const apiPrefix = "/api/index.php";

function stubMsgpackReply(reply: any, data: any) {
    const servertime = getServerTime()
    reply.header("content-type", "application/x-msgpack");
    reply.status(200).send({
        data_headers: { force_update: false, asset_update: false, short_udid: 0, viewer_id: 0, servertime, result_code: 1 },
        data
    });
}

fastify.post(`${apiPrefix}/tool/check_social_link_enable`, async (_request, reply) => {
    stubMsgpackReply(reply, { enable: false });
});

fastify.post(`${apiPrefix}/tool/contact_active`, async (_request, reply) => {
    stubMsgpackReply(reply, { enable_customer_service: false });
});

fastify.post(`${apiPrefix}/tool/custom_notify`, async (_request, reply) => {
    stubMsgpackReply(reply, {});
});

fastify.post(`${apiPrefix}/channels/channel_leiting_pay/query_unfinish_order`, async (_request, reply) => {
    stubMsgpackReply(reply, { order_id: "" });
});

fastify.post(`${apiPrefix}/channels/channel_leiting_pay/query_purcharge`, async (_request, reply) => {
    stubMsgpackReply(reply, { status: 3 });  // 3 = purchase success
});

fastify.post(`${apiPrefix}/channels/channel_leiting_pay/set_unfinish_order_status`, async (_request, reply) => {
    stubMsgpackReply(reply, {});
});

// Episode trial reading: finish stub (character story trial)
fastify.post(`${apiPrefix}/episode_trial_reading/finish`, async (_request, reply) => {
    stubMsgpackReply(reply, {});
});

/** 进日志前把外部字符串压成单行并限长：换行可以伪造日志行，不限长可以撑爆磁盘。 */
function sanitizeLogText(value: unknown, maxLength = 2000): string {
    const text = typeof value === "string" ? value : String(value ?? "");
    return text.replace(/[\r\n\t]+/g, " ").slice(0, maxLength);
}

fastify.get("/debug", async (request, reply) => {
    const loc = sanitizeLogText((request.query as any)?.loc ?? "unknown", 2048);
    parseC3032Beacon(loc, "debug-get");
    reply.status(200).send("OK");
});

function parseC3032Beacon(loc: string, source: string): void {
    if (!loc.includes("C3032")) return;
    const seedMatch = loc.match(/seed=(\d+)/);
    const movieMatch = loc.match(/movie_id=(\w+)/);
    if (!seedMatch || !movieMatch) return;
    const badSeed = parseInt(seedMatch[1], 10);
    const movieId = movieMatch[1];
    try {
        const quarantined = gachaSeedQuarantine.quarantineIfRecentlySent(movieId, badSeed);
        console.log(
            `[GACHA-SEED] C3032 source=${source} movie=${movieId} seed=${badSeed} `
            + (quarantined ? "quarantined" : "ignored-not-recent"),
        );
    } catch (error) {
        console.error(`[GACHA-SEED] C3032 quarantine failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

fastify.post("/debug", async (request, reply) => {
    const ts = getRealNow().toISOString();
    const loc = sanitizeLogText((request.body as any)?.loc ?? "unknown", 2048);
    console.log(`[BEACON ${ts}] ${loc}`);

    parseC3032Beacon(loc, "debug-post");

    reply.status(200).send("OK");
});

fastify.post("/crash", async (request, reply) => {
    // Log crash (sanitized + truncated to avoid log injection / explosion)
    const bodyStr = sanitizeLogText(JSON.stringify(request.body ?? {}), 2000);
    console.log(`[CRASH] ${bodyStr}`);

    parseC3032Beacon(bodyStr, "crash");

    reply.status(200).send("OK");
});


fastify.register(cnToolPlugin, { prefix: `${apiPrefix}/tool` });
fastify.register(reproduceApiPlugin, { prefix: `${apiPrefix}/reproduce` });
fastify.register(tutorialApiPlugin, { prefix: `${apiPrefix}/tutorial` });
fastify.register(gachaApiPlugin, { prefix: `${apiPrefix}/gacha` });
fastify.register(partyApiPlugin, { prefix: `${apiPrefix}/party` });
fastify.register(expodApiPlugin, { prefix: `${apiPrefix}/expod` });
fastify.register(storyQuestApiPlugin, { prefix: `${apiPrefix}/story_quest` });
fastify.register(optionApiPlugin, { prefix: `${apiPrefix}/option` });
fastify.register(attentionApiPlugin, {
    prefix: `${apiPrefix}/attention`,
    multiContext: () => multiRuntimeService.getHttpContext(),
});
fastify.register(characterApiPlugin, { prefix: `${apiPrefix}/character` });
fastify.register(characterManaPlugin, { prefix: `${apiPrefix}/character` });
fastify.register(characterBondPlugin, { prefix: `${apiPrefix}/character` });
fastify.register(partyGroupApiPlugin, { prefix: `${apiPrefix}/party_group` });
fastify.register(equipmentApiPlugin, { prefix: `${apiPrefix}/equipment` });
fastify.register(sellApiPlugin, { prefix: `${apiPrefix}/equipment` });
fastify.register(exBoostApiPlugin, { prefix: `${apiPrefix}/ex_boost` });
fastify.register(boxGachaApiPlugin, { prefix: `${apiPrefix}/box_gacha` });
fastify.register(exchangeApiPlugin, { prefix: `${apiPrefix}/exchange` });
fastify.register(encyclopediaApiPlugin, { prefix: `${apiPrefix}/encyclopedia` });
fastify.register(mailApiPlugin, { prefix: `${apiPrefix}/mail` });
fastify.register(rankingEventApiPlugin, { prefix: `${apiPrefix}/ranking_event` });
fastify.register(missionApiPlugin, { prefix: `${apiPrefix}/mission` });
fastify.register(activeMissionApiPlugin, { prefix: `${apiPrefix}/active_mission` });
fastify.register(passCardApiPlugin, { prefix: `${apiPrefix}/Pass_card` });
fastify.register(paymentApiPlugin, { prefix: `${apiPrefix}/payment` });
fastify.register(newsApiPlugin, { prefix: `${apiPrefix}/news` });
fastify.register(raidEventApiPlugin, { prefix: `${apiPrefix}/event/raid` });
fastify.register(rushEventApiPlugin, { prefix: `${apiPrefix}/event/rush` });
fastify.register(carnivalEventApiPlugin, { prefix: `${apiPrefix}/carnival_event` });
fastify.register(contentsGuideApiPlugin, { prefix: `${apiPrefix}/contents_guide` });
fastify.register(profileApiPlugin, { prefix: `${apiPrefix}/profile` });
fastify.register(playerHistoryApiPlugin, { prefix: `${apiPrefix}/player_history` });
fastify.register(followApiPlugin, { prefix: `${apiPrefix}/follow` });
fastify.register(snsCompatibilityRoutes, { prefix: `${apiPrefix}/sns` });
fastify.register(historyApiPlugin, { prefix: `${apiPrefix}/history` });
fastify.register(questUnlockApiPlugin, { prefix: `${apiPrefix}/quest` });
fastify.register(itemApiPlugin, { prefix: `${apiPrefix}/item` });
fastify.register(giftApiPlugin, { prefix: `${apiPrefix}/gift` });
fastify.register(characterElectionApiPlugin, { prefix: `${apiPrefix}/character_election` });
fastify.register(bonusApiPlugin, { prefix: `${apiPrefix}/bonus` });

fastify.register(indexWebApiPlugin, {
    prefix: "/api",
    getMultiStatus: () => multiRuntimeService.getAdminStatus(),
    getMultiManagementService: () => multiManagementService,
    getRuntimeConfig: () => startupRuntimeConfig,
    serverTimeService,
    // loadConfig（启动序列）后必有值；请求期 getter 惰性读取
    getGameCalendarUtcOffsetMinutes: () => {
        if (startupRuntimeConfig === null) {
            throw new Error("runtime config not loaded");
        }
        return startupRuntimeConfig.gameCalendarUtcOffsetMinutes;
    },
    // Lazy: CDN_DIR may resolve to a directory that only exists under the
    // local asset mode; avatar requests degrade to 404 when it is absent.
    getAvatarCdnRoot: () => {
        try {
            return resolveCnCdnRoot(process.env.CDN_DIR ?? ".cdn", projectRoot);
        } catch {
            return null;
        }
    },
});
fastify.register(seedsWebApiPlugin, { prefix: "/api/seeds" });

registerAdminUi(fastify, { projectRoot });

let runtimeHttpConfigured = false;
function configureRuntimeHttp(config: ReturnType<typeof parseCnRuntimeConfig>): void {
    if (runtimeHttpConfigured) return;
    configureSerializedAssetVersionProvider(() => getContentSnapshot().cdn.targetVersion);
    fastify.register(singleBattleQuestApiPlugin, {
        prefix: `${apiPrefix}/single_battle_quest`,
        dailyResetHour: config.dailyResetHour,
    });
    fastify.register(shopApiPlugin, {
        prefix: `${apiPrefix}/shop`,
        dailyResetHour: config.dailyResetHour,
    });
    fastify.register(howToGetApiPlugin, {
        prefix: `${apiPrefix}/how_to_get`,
        dailyResetHour: config.dailyResetHour,
    });
    const multiContext = multiRuntimeService.getHttpContext();
    fastify.register(multiBattleRoutes, {
        prefix: `${apiPrefix}/multi_battle_quest`,
        context: multiContext,
    });
    fastify.register(cnLoadPlugin, {
        prefix: apiPrefix,
        assetProvider: config.assetProvider,
        httpDisplayHost: config.httpDisplayHost,
        httpPort: config.http.port,
        summonComSeconds: config.summonComSeconds,
        dailyResetHour: config.dailyResetHour,
        multiMode: config.multi.mode,
        multiRecoveryVerifier: multiContext.settlementVerifier,
        getMultiParticipant: multiContext.snapshotProvider.getParticipant,
    });
    fastify.register(comicApiPlugin, {
        prefix: `${apiPrefix}/comic`,
        comicDir: config.comicDir,
        httpDisplayHost: config.httpDisplayHost,
        httpPort: config.http.port,
    });
    // iosCompat 必须与 versionCheck/iosLeiting 一致地下传：asset 路由据此接受 iOS DEVICE 标识
    // （DEVICE: 1 / ios）；漏传会让 iOS 客户端在 get_path 上被 400 UNSUPPORTED_PLATFORM 拒掉。
    registerCnAssetProviderRoutes(fastify, {
        config: config.assetProvider,
        iosCompat: config.iosCompat,
    });
    // iOS实验性兼容（IOS_COMPAT_ENABLED=1）：SDK裸路由与 iOS专用行为仅在启用时注册。
    // versionCheck需要运行时配置，故在 config就绪的 http阶段注册（不能早于此时）。
    fastify.register(versionCheckPlugin, { ios: config.iosCompat });
    if (config.iosCompat.enabled) {
        // iOS SDK请求的是裸路径（/sdk/v3-3/...、/mobile!...），必须无前缀注册。
        // provideCode：借 SDK 原生公告弹窗把绑定验证码显示给 iOS 玩家（iOS 没有自研登录页）。
        // 实现见 src/lib/ios-notice-code.ts —— 账号解析复用绑定闸门那套，反复打开公告不换码。
        fastify.register(iosLeitingPlugin, {
            ios: config.iosCompat,
            notice: { provideCode: createIosNoticeCodeProvider() },
        });
    }
    runtimeHttpConfigured = true;
}

function getRuntimeDatabaseHealth(): { ready: boolean; schema: number | null } {
    const status = getDatabaseStatus();
    if (!status.open || !status.ready || status.schema === null) {
        return { ready: false, schema: null };
    }
    try {
        const row = getDatabase(Database.WDFP_DATA)
            .prepare("SELECT 1 AS value")
            .get() as { value?: number } | undefined;
        return { ready: row?.value === 1, schema: status.schema };
    } catch {
        return { ready: false, schema: status.schema };
    }
}

let bundleMetadataError = false;
let bundleMetadata = { version: "unknown", bundleId: null as string | null };
try {
    bundleMetadata = loadBundleMetadata({
        bundleRoot: projectRoot,
        requireManifest: process.env.EMBEDDED_RUNTIME === "1",
    });
} catch {
    bundleMetadataError = true;
}
registerRuntimeCapabilitiesRoute(fastify, () => createRuntimeCapabilitiesSnapshot({
    bundle: bundleMetadata,
    content: getContentSnapshot(),
    loadedModes: listLoadedModeIdentities(),
    node: process.versions.node,
    nodeAbi: process.versions.modules,
    platform: process.platform,
    arch: process.arch,
}));
runtimeCoordinator = createRuntimeCoordinator({
    loadConfig: () => {
        if (bundleMetadataError) throw new Error("invalid embedded bundle metadata");
        const config = parseCnRuntimeConfig({ projectRoot });
        startupRuntimeConfig = config;
        if (multiManagementService === null) {
            multiManagementService = new MultiManagementService({
                mode: config.multi.mode,
                credentials: createMultiManagementCredentialProvider({
                    mode: config.multi.mode,
                    env: process.env,
                    projectRoot,
                }),
                getStatus: () => multiRuntimeService.getAdminStatus(),
                probe: () => multiRuntimeService.probeControlStatus(),
                getAuthenticationDiagnostics: () => multiRuntimeService.getAuthenticationDiagnostics(),
            });
        }
        return config;
    },
    configureGameCalendar: config => {
        productionGameCalendarProvider.initialize(config.gameCalendarUtcOffsetMinutes);
    },
    configureHttp: configureRuntimeHttp,
    initializeDatabase,
    restoreServerTime: () => { serverTimeService.restore(); },
    // Content snapshot, then operator-installed gameplay modules (modes.d/).
    // Composed by the seam so the lifecycle test drives this exact entry
    // point instead of re-creating the ordering.
    ...createContentLifecycleDependencies<ReturnType<typeof parseCnRuntimeConfig>>({
        projectRoot,
        initializeContentSnapshot: config => initializeContentSnapshot({
            assetMode: config.assetProvider.mode,
            localCdn: config.assetProvider.mode === "local",
            contentEnvironment: config.contentEnvironment,
            // The snapshot must match the frozen RuntimeConfig offset; a
            // release built under another calendar fails startup here.
            expectedGameCalendarUtcOffsetMinutes: config.gameCalendarUtcOffsetMinutes,
        }),
    }),
    readyHttp: async () => {
        // Startup data-validity gate: content that moves an audited mission
        // pattern off its condition-number capability must fail startup
        // instead of silently re-routing settlement facts.
        assertMissionConditionRouting(getMissionCatalog());
        await fastify.ready();
        accountCleanupService.start();
        receiveHistoryRetentionService.start();
    },
    listenHttp: config => fastify.listen({ ...config.http }),
    closeHttp: async () => {
        await receiveHistoryRetentionService.stop();
        accountCleanupService.stop();
        await fastify.close();
    },
    forceCloseHttp: () => {
        fastify.server.closeIdleConnections?.();
        fastify.server.closeAllConnections?.();
    },
    startMulti: (config, onFatalError) => multiRuntimeService.start(
        config.multi,
        onFatalError,
        config.multiTuning,
    ),
    stopMulti: () => multiRuntimeService.stop(),
    checkpointDatabase,
    closeDatabase,
    getDatabaseHealth: getRuntimeDatabaseHealth,
    isHttpListening: () => fastify.server.listening,
    getMultiStatus: () => multiRuntimeService.getStatus(),
    processTarget: process,
    setExitCode: code => { process.exitCode = code; },
    bundleVersion: bundleMetadata.version,
    bundleId: bundleMetadata.bundleId,
    nodeVersion: process.version,
    adminAvailable: true,
    reportStartupFailure: stage => console.error(`[runtime] ${stage} startup failed`),
    reportShutdownFailures: failures => console.error(
        `[runtime] shutdown failed steps=${failures.map(failure => (
            `${failure.step}:${failure.code ?? "UNKNOWN"}`
        )).join(",")}`,
    ),
    reportShutdownComplete: () => console.log("[runtime] shutdown complete"),
});

void runtimeCoordinator.start();
