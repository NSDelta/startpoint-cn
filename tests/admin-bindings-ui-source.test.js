"use strict"

// Source-level guard for the admin binding console (contract A6 / section 3.5).
//
// The page is only ever allowed to talk to the server through the shared
// `admin/src/api/client.ts` helpers: no SQLite, no direct fetch, no bot API
// surface. Those rules are asserted here because the admin workspace is not
// covered by `tsc --noEmit` (root tsconfig excludes `admin`).

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const projectRoot = path.resolve(__dirname, "..")
const appPath = path.join(projectRoot, "admin/src/App.tsx")
const pagePath = path.join(projectRoot, "admin/src/pages/Bindings.tsx")
const clientPath = path.join(projectRoot, "admin/src/api/client.ts")

test("admin bindings UI is wired into App.tsx in all four places", () => {
    assert.equal(fs.existsSync(pagePath), true, `缺少绑定管理页面：${pagePath}`)

    const app = fs.readFileSync(appPath, "utf8")

    assert.match(app, /import Bindings from "\.\/pages\/Bindings"/)
    assert.match(app, /key: "\/bindings"/)
    assert.match(app, /label: "账号绑定"/)
    assert.match(app, /"\/bindings": "账号绑定",/)
    assert.match(app, /<Route path="\/bindings" element=\{<Bindings \/>\} \/>/)

    // The menu entry must carry a lucide icon imported at the top of the file.
    const menuItem = app.match(/key: "\/bindings".{0,120}/)?.[0] ?? ""
    assert.match(menuItem, /icon: <[A-Za-z0-9]+ size=\{18\}/)
    const iconName = menuItem.match(/icon: <([A-Za-z0-9]+)/)?.[1] ?? ""
    assert.notEqual(iconName, "")
    assert.match(app, new RegExp(`import \\{[^}]*\\b${iconName}\\b[^}]*\\} from "lucide-react"`))
})

test("admin bindings page uses only the shared API client", () => {
    const page = fs.readFileSync(pagePath, "utf8")

    assert.match(page, /import \{ ApiError, apiDelete, apiGet, apiPost \} from "\.\.\/api\/client"/)
    assert.match(page, /import \{ AdminPage \} from "\.\.\/components\/AdminPage"/)

    // Never reach past the JSON API into storage or a raw network call.
    assert.doesNotMatch(page, /better-sqlite3|node:sqlite|require\(["']sqlite/i)
    assert.doesNotMatch(page, /\.prepare\(|SELECT |INSERT INTO|UPDATE |DELETE FROM/)
    assert.doesNotMatch(page, /getDb\(/)
    assert.doesNotMatch(page, /\bfetch\(|XMLHttpRequest|axios/)
    assert.doesNotMatch(page, /dangerouslySetInnerHTML/)

    // The bot control plane (X-Bot-Token) is not part of the admin surface.
    assert.doesNotMatch(page, /\/api\/bot/)
    assert.doesNotMatch(page, /BOT_API_TOKEN|X-Bot-Token|bot token/i)

    // No external branding or copy-pasted vendor assets.
    assert.doesNotMatch(page, /https?:\/\//)
    assert.doesNotMatch(page, /\.(png|jpg|jpeg|svg)["']/)
})

test("admin bindings page implements the frozen section 3.5 endpoints", () => {
    const page = fs.readFileSync(pagePath, "utf8")

    // GET /api/bindings?platform=&state=&query=&page=&pageSize=
    assert.match(page, /apiGet<BindingPage>\(/)
    assert.match(page, /`\/api\/bindings\?platform=\$\{encodeURIComponent\(platform\)\}`/)
    assert.match(page, /&state=\$\{encodeURIComponent\(state\)\}/)
    assert.match(page, /&query=\$\{encodeURIComponent\(query\)\}/)
    assert.match(page, /&page=\$\{page\}&pageSize=\$\{pageSize\}/)

    // GET /api/bindings/codes
    assert.match(page, /"\/api\/bindings\/codes"/)
    assert.match(page, /`\/api\/bindings\/codes\?accountId=\$\{codeAccountId\}`/)

    // POST /api/bindings (add binding, is_primary defaults to false server side)
    assert.match(page, /apiPost<BindingRow>\("\/api\/bindings", \{/)
    // POST /api/bindings/:id/primary
    assert.match(page, /apiPost<BindingRow>\(`\/api\/bindings\/\$\{row\.id\}\/primary`, \{\}\)/)
    // DELETE /api/bindings/:id
    assert.match(page, /apiDelete<\{ ok: boolean \}>\(`\/api\/bindings\/\$\{row\.id\}`\)/)
    // POST /api/bindings/codes (re-issue)
    assert.match(page, /apiPost<SignupCodeRow>\("\/api\/bindings\/codes", \{/)
    // POST /api/bindings/codes/:id/revoke
    assert.match(page, /apiPost<\{ ok: boolean \}>\(`\/api\/bindings\/codes\/\$\{row\.id\}\/revoke`, \{\}\)/)

    // React Query caches must be invalidated after every write.
    assert.match(page, /queryClient\.invalidateQueries\(\{ queryKey: \["adminBindings"\] \}\)/)
    assert.match(page, /queryClient\.invalidateQueries\(\{ queryKey: \["adminBindingCodes"\] \}\)/)
})

test("admin bindings page keeps destructive actions behind confirmation", () => {
    const page = fs.readFileSync(pagePath, "utf8")

    // Unbinding is the destructive action and must ask first.
    const unbindBlock = page.match(/<Popconfirm[\s\S]*?<\/Popconfirm>/)?.[0] ?? ""
    assert.notEqual(unbindBlock, "", "解绑必须使用 Popconfirm 二次确认")
    assert.match(unbindBlock, /解绑/)
    assert.match(unbindBlock, /okButtonProps=\{\{ danger: true \}\}/)

    assert.match(page, /<Tag color="gold" icon=\{<Star size=\{13\} \/>\}>主账号<\/Tag>/)
    assert.match(page, /设为主账号/)
    assert.match(page, /补发绑定码/)
    assert.match(page, /新增绑定/)
    assert.match(page, /吊销/)

    // Aliases are shown so the operator knows what to type in the bot.
    assert.match(page, /\/bind /)
    assert.match(page, /["']qq["']/)
    assert.match(page, /["']kook["']/)
})

test("shared api client exposes the helpers the page relies on", () => {
    const client = fs.readFileSync(clientPath, "utf8")
    assert.match(client, /export function apiGet</)
    assert.match(client, /export function apiPost</)
    assert.match(client, /export function apiDelete</)
    assert.match(client, /export class ApiError/)
})
