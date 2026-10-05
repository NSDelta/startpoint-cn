// 统一 fetch 封装：所有请求走 /api（dev 由 Vite 代理到 8001）
export class ApiError extends Error {
    constructor(public status: number, message: string) {
        super(message)
    }
}

/**
 * 部署层后台闸门（服务端 src/runtime/admin-auth.ts）返回 401 时，会话已失效或从未登录。
 * 跳到登录页，由登录页在口令通过后接管后续导航——页面内 route 状态全部作废，
 * 因此这里不做"记住原地址再跳回来"的处理。
 */
export function handleAdminSessionExpired(status: number): boolean {
    if (status !== 401) return false
    const path = window.location.pathname
    if (path === "/admin/login" || path.startsWith("/admin/login/")) return false
    window.location.replace("/admin/login")
    return true
}

async function readError(res: Response, fallback: string): Promise<string> {
    const text = await res.text().catch(() => "")
    let msg = text || fallback
    // 后端错误多为 { "error": "..." }，提取出来更友好
    try { const j = JSON.parse(text); if (j && typeof j.error === "string") msg = j.error } catch { /* not json */ }
    return msg
}

async function handle<T>(res: Response): Promise<T> {
    if (!res.ok) {
        const msg = await readError(res, res.statusText)
        if (handleAdminSessionExpired(res.status)) throw new ApiError(res.status, "登录状态已失效，正在跳转登录页")
        throw new ApiError(res.status, msg)
    }
    const ct = res.headers.get("content-type") ?? ""
    return ct.includes("application/json") ? res.json() : (res.text() as unknown as T)
}

export function apiGet<T>(url: string): Promise<T> {
    return fetch(url, { headers: { Accept: "application/json" } }).then(r => handle<T>(r))
}

export function apiPost<T>(url: string, body?: unknown): Promise<T> {
    return fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
    }).then(r => handle<T>(r))
}

export function apiPatch<T>(url: string, body?: unknown): Promise<T> {
    return fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
    }).then(r => handle<T>(r))
}

export function apiDelete<T>(url: string): Promise<T> {
    return fetch(url, { method: "DELETE", headers: { Accept: "application/json" } })
        .then(r => handle<T>(r))
}

// multipart 上传：不手动设 Content-Type，交给浏览器带 boundary
export function apiUpload<T>(url: string, file: File, fieldName = "file"): Promise<T> {
    const fd = new FormData()
    fd.append(fieldName, file)
    return fetch(url, { method: "POST", headers: { Accept: "application/json" }, body: fd })
        .then(r => handle<T>(r))
}

// 附件下载：走与其它 /api 相同的 fetch 通道（浏览器自动带上后台会话 Cookie），
// 错误就地抛 ApiError 供页面显示，成功后按 content-disposition 文件名触发保存。
export async function apiDownloadFile(url: string, fallbackFilename: string): Promise<void> {
    const res = await fetch(url, { headers: { Accept: "application/json" } })
    if (!res.ok) {
        const msg = await readError(res, res.statusText)
        if (handleAdminSessionExpired(res.status)) throw new ApiError(res.status, "登录状态已失效，正在跳转登录页")
        throw new ApiError(res.status, msg)
    }
    const blob = await res.blob()
    const disposition = res.headers.get("content-disposition") ?? ""
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallbackFilename
    const objectUrl = URL.createObjectURL(blob)
    try {
        const a = document.createElement("a")
        a.href = objectUrl
        a.download = filename
        document.body.appendChild(a)
        a.click()
        a.remove()
    } finally {
        URL.revokeObjectURL(objectUrl)
    }
}
