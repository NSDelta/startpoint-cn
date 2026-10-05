/**
 * CN 服的请求正文解析器（`application/json` 与 `application/x-www-form-urlencoded`）。
 *
 * 为什么单独成文件：解析器是**只有真实 HTTP 才会暴露**的一类逻辑 —— 用假解析器做的
 * 单元测试全绿，线上却 401。要让它可被契约测试直接喂（而测试又不能 import
 * `src/cn-server.ts`，那个模块 import 即启动整台服务器），就只能把这段逻辑从入口里搬出来。
 *
 * ⚠️ 判定顺序不能反，这是本文件存在的主要理由：
 * `unpack(Buffer.from(body, "base64"))` 吃 `username=…&password=…` 这种表单正文
 * **不抛异常**，而是解出一堆垃圾。所以若把 base64 msgpack 放在最前面，后面那个
 * `URLSearchParams` fallback 永远轮不到 —— 表现为登录接口拿到空用户名，
 * 对**正确口令**也返回 401（服务端日志：`admin login rejected { username: "" }`）。
 */

import type { FastifyInstance, FastifyRequest } from "fastify"
import { ContentTypeParserDoneFunction } from "fastify/types/content-type-parser"
import { unpack } from "msgpackr"

/** `/admin/*` 前缀：后台登录页的表单、SPA 的 fetch 都落在这两个路由上（无游戏客户端）。 */
export const ADMIN_FORM_ROUTE_PREFIX = "/admin/"

/** 与 `src/server.ts` 同一取舍：JSON 解析失败返回 `undefined`，不 500。 */
export function parseJsonBody(_request: FastifyRequest, body: string, done: ContentTypeParserDoneFunction): void {
    try {
        done(null, JSON.parse(body))
    } catch {
        done(null, undefined)
    }
}

/**
 * `application/x-www-form-urlencoded` 正文的解析。
 *
 * 这个 content-type 被两类完全不同的调用方共用：
 *   - 游戏客户端（Android）：正文是 **base64 过的 msgpack**，要先 `unpack`；
 *   - 管理后台：登录页是普通 HTML 表单（`username=…&password=…`），SPA 走 JSON。
 *
 * 后台路由必须先判、并返回 `URLSearchParams` —— 与 `src/runtime/admin-auth.ts` 的
 * `fieldOf()` 约定一致。
 */
export function parseCnFormBody(
    request: FastifyRequest,
    body: string,
    done: ContentTypeParserDoneFunction,
): void {
    const routeUrl = request.routeOptions?.url ?? ""
    if (routeUrl.startsWith(ADMIN_FORM_ROUTE_PREFIX)) {
        // 两种形态都容错：真表单 → URLSearchParams；客户端图省事发 JSON 但挂错头 → JSON 对象。
        if (body.trimStart().startsWith("{")) parseJsonBody(request, body, done)
        else done(null, new URLSearchParams(body))
        return
    }
    try {
        done(null, unpack(Buffer.from(body, "base64")))
    } catch {
        try {
            done(null, Object.fromEntries(new URLSearchParams(body)))
        } catch {
            parseJsonBody(request, body, done)
        }
    }
}

/** 装上两个解析器。生产入口（`src/cn-server.ts`）与契约测试走的是同一个函数。 */
export function installCnBodyParsers(fastify: FastifyInstance): void {
    fastify.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, parseCnFormBody)
    fastify.addContentTypeParser("application/json", { parseAs: "string" }, parseJsonBody)
}
