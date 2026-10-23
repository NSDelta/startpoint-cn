import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { generateDataHeaders, generateViewerId } from "../../utils";
import { deleteAccountSessionsOfTypeSync, deleteDeviceBindingSync, getAccountSessionsOfTypeSync, getDeviceBindingSync, insertDeviceBindingSync, insertSessionWithToken } from "../../data/domains/session"
import { getAccountSync, insertAccountSync, updateAccountSync } from "../../data/domains/account"
import { getPlayerSync, insertDefaultPlayerSync } from "../../data/domains/player"
import { appendBindAuditSync } from "../../data/domains/account-binding"
import { SessionType } from "../../data/types";
import { saveAccountDefaultPlayer } from "../../data/activeAccount";
import { getAccountIdentityProvider } from "../../lib/account-identity-provider";
import { isGiftCodeEnabledSync } from "../../lib/gift-code/capability";
import { getRealNow, getRealNowMs } from "../../runtime/time/game-time";
import { buildBindGateRejection, evaluateBindGate, recordBindGateRejection } from "../../lib/bind-gate";
import { issueLoginTokenSync } from "../../lib/game-auth";
import {
    DEVICE_FOLLOW_NAME,
    followAccountForSignup,
    noteSignupDevice,
} from "../../lib/sp-auth/device-follow";

interface CnSignupBody {
    device_id: number;
    channelNo: string;
    media?: string;
    androidId?: string;
    oaid?: string;
    mac?: string;
    terminInfo?: string;
    osVer?: string;
    storage_directory_path?: string;
    first_viewer_id?: number;
    advertise_id?: string;
}

const viewerIdToAccountId = new Map<number, number>();

interface GetHeaderResponseBody {
    viewer_id: number
}

const routes = async (fastify: FastifyInstance) => {
    const identityProvider = getAccountIdentityProvider()
    fastify.post("/get_header_response", (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as GetHeaderResponseBody;
        reply.header("content-type", "application/x-msgpack");
        reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: body.viewer_id
            }),
            "data": []
        });
    });

    fastify.post("/check_enable_gift", async (_request, reply) => {
        reply.header("content-type", "application/x-msgpack");
        reply.status(200).send({
            data_headers: generateDataHeaders(),
            data: { enable_gift: isGiftCodeEnabledSync() },
        });
    });

    fastify.post("/auth", async (_request: FastifyRequest, reply: FastifyReply) => {
        reply.header("content-type", "application/x-msgpack");
        reply.status(200).send({
            data_headers: generateDataHeaders(),
            data: {}
        });
    });

    fastify.post("/signup", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as CnSignupBody;
        const udid = request.headers["udid"] as string || "unknown";
        const shortUdid = 0;
        const deviceId = body.device_id

        let accountId: number;
        let newAccount = true;
        let viewerId: number | undefined;   // set when reusing existing session

        if (!deviceId) {
            return reply.status(400).send({ error: "Missing device_id" })
        }

        const clientIp = request.ip
        const storagePath = typeof body.storage_directory_path === "string"
            ? body.storage_directory_path
            : ""

        // 「并号」（2026-10-18，修业主「门里换号后游戏仍进旧号」）：同一台机器上的门刚成功
        // 登录过哪个账号，这台设备就归谁。**必须卡在绑定闸门之前** —— 否则闸门会先按旧映射
        // （或 unmapped ⇒ 517）把这次报到拒掉，改绑永远轮不到。见 lib/sp-auth/device-follow.ts。
        let binding = getDeviceBindingSync(deviceId)
        // device_id 必须是正整数（`parseDeviceId` 同一口径）：非数字/负数直接判 400，
        // 绝不把它带进并号改绑（否则会往 INTEGER 主键里写字符串 ⇒ SQLITE 抛错 ⇒ 500）。
        const deviceIdIsValid = typeof deviceId === "number"
            && Number.isSafeInteger(deviceId) && deviceId > 0
        const followAccountId = !deviceIdIsValid
            ? null
            : followAccountForSignup({ deviceId, ip: clientIp, path: storagePath })
        const followAccount = followAccountId === null ? null : getAccountSync(followAccountId)
        if (
            followAccount !== null
            && followAccount !== undefined
            && (binding === null || binding.account_id !== followAccount.id)
        ) {
            insertDeviceBindingSync(deviceId, followAccount.id, DEVICE_FOLLOW_NAME)
            appendBindAuditSync({
                action: "login",
                accountId: followAccount.id,
                detail: {
                    reason: "device_rebind",
                    source: "device-follow",
                    via: "signup",
                    device_id: deviceId,
                    previous_account_id: binding === null ? null : binding.account_id,
                },
                actor: "sp-auth",
                createdAt: getRealNow().toISOString(),
            })
            binding = { device_id: deviceId, account_id: followAccount.id, name: DEVICE_FOLLOW_NAME }
            console.log(
                `[SIGNUP] device-follow 改绑 device_id=${deviceId} -> account_id=${followAccount.id}`,
            )
        }
        // 记一笔报到，供门下次登录时反向认领（claimReportedDevices）。
        if (deviceIdIsValid) noteSignupDevice({ deviceId, ip: clientIp, path: storagePath })

        // P4 绑定闸门（契约 C3）：必须卡在下面「已知设备 → 复用 binding 账号」分支之前，
        // 否则 pending（已发码未绑定）账号会被它直接放行。开关缺省关 ⇒ 此处零开销旁路。
        const bindGate = evaluateBindGate({
            deviceId,
            udid: request.headers["udid"],
            userAgent: request.headers["user-agent"],
            requestedBy: request.headers["requestedby"],
        });
        if (!bindGate.allow) {
            recordBindGateRejection(bindGate);
            reply.header("content-type", "application/x-msgpack");
            return reply.status(200).send(buildBindGateRejection(bindGate));
        }

        // ★ 闸门认定的主体才是这台设备的账号。`resolveBindGateSubject` 的身份键是
        //   `device_bindings` ∪ 未过期的 `device_grants`（bind-gate.ts:201/217），而这里原先只认
        //   `device_bindings`。两者一旦不一致（只有 grant 的历史设备、binding 被清掉但 grant 还在），
        //   闸门放行的是一张老账号，旧代码却会给这台设备新建一个空账号 —— 玩家的主号与游戏号
        //   就此分裂（本机 account 8/9 就是这么来的）。放行 ≠ 可以另起炉灶。
        const gateAccountId = bindGate.subject === null ? null : bindGate.subject.accountId
        const boundAccountId = binding === null ? gateAccountId : binding.account_id

        if (boundAccountId !== null && getAccountSync(boundAccountId)) {
            accountId = boundAccountId
            newAccount = false
            updateAccountSync({ id: accountId, lastLoginTime: getRealNow() })
            if (binding === null) {
                // 只有 grant 作证：补写 binding，这台设备从此不再依赖会过期的 grant
                // （闸门的 device_bindings 分支不判有效期）。
                insertDeviceBindingSync(deviceId, accountId)
            }
            // Clean all old sessions for this account, reuse first token
            const sessions = getAccountSessionsOfTypeSync(accountId, SessionType.VIEWER)
            if (sessions.length > 0) {
                viewerId = parseInt(sessions[0].token)
                deleteAccountSessionsOfTypeSync(accountId, SessionType.VIEWER)
            }
        } else {
            // 建号：① 已知设备但账号已被删（binding 悬空；闸门此时必然已拒，这里是纵深防御）
            // ② 闸门关着（本地/单机）③ 命中服主自测白名单。
            if (binding !== null) deleteDeviceBindingSync(deviceId)
            const identity = identityProvider.resolveCnSignup({ appId: "wf_cn" })
            const account = insertAccountSync({
                appId: "wf_cn", ...identity, status: "normal"
            })
            accountId = account.id
            const player = insertDefaultPlayerSync(accountId)
            saveAccountDefaultPlayer(accountId, player.id)
            insertDeviceBindingSync(deviceId, accountId)
            // 闸门开着却走到建号 = 这台设备没经过闸门作证（只可能是白名单）：留痕，便于回头
            // 把它的设备号从白名单里捞出来。闸门关着属正常，不写审计也不打日志。
            if (bindGate.reason === "udid_exempt") {
                appendBindAuditSync({
                    action: "register",
                    accountId,
                    detail: {
                        reason: "gate_exempt_signup",
                        device_id: deviceId,
                        udid: bindGate.udid,
                        exempt_token: bindGate.exemptToken,
                    },
                    actor: "cn-signup",
                })
                console.warn(
                    `[SIGNUP] 白名单放行的设备建了新账号 device_id=${deviceId} account_id=${accountId}`,
                )
            }
        }

        if (!viewerId) {
            viewerId = generateViewerId()
        }
        await insertSessionWithToken({
            token: String(viewerId),
            accountId: accountId,
            type: SessionType.VIEWER,
            expires: new Date(getRealNowMs() + 365 * 24 * 60 * 60 * 1000)
        });

        viewerIdToAccountId.set(viewerId, accountId);

        reply.header("content-type", "application/x-msgpack");
        reply.status(200).send({
            data_headers: generateDataHeaders({
                viewer_id: viewerId,
                short_udid: shortUdid,
                udid: udid,
            }),
            data: {
                login_token: issueLoginTokenSync(accountId),
                newAccount: newAccount ? 1 : 0,
                roleName: `Player${accountId}`,
                accountName: `Player${accountId}`,
                sign: "dummy_sign",
                createDate: getRealNow().toISOString(),
                serverName: "StarPoint CN",
                serverId: 1,
            }
        });
    });
};

export default routes;
