import { useState } from "react"
import {
    Alert,
    Button,
    Card,
    Form,
    Input,
    InputNumber,
    Modal,
    Popconfirm,
    Select,
    Space,
    Table,
    Tag,
    message,
} from "antd"
import { KeyRound, Plus, RefreshCw, Star, Trash2 } from "lucide-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { ApiError, apiDelete, apiGet, apiPost } from "../api/client"
import { AdminPage } from "../components/AdminPage"

// Account binding console (contract 3.5).
//
// Every read and write talks to `/api/bindings/*` over JSON; the page never
// touches SQLite directly (docs/admin/README.md).

type BindingPlatform = "qq" | "kook"
type BindState = "pending" | "active" | "disabled"
type SignupCodeStatus = "pending" | "bound" | "expired" | "revoked"

interface BindingRow {
    id: number
    accountId: number
    username: string | null
    viewerId: number
    bindState: BindState
    platform: BindingPlatform
    platformUid: string
    displayName: string | null
    isPrimary: boolean
    createdBy: string
    note: string | null
    createdAt: string
    updatedAt: string
    revision: number
}

interface SignupCodeRow {
    id: number
    code: string
    accountId: number
    username: string | null
    viewerId: number
    status: SignupCodeStatus
    platform: BindingPlatform | null
    platformUid: string | null
    attempts: number
    expiresAt: string
    createdAt: string
    updatedAt: string
    revision: number
}

interface BindingPage {
    page: number
    pageSize: number
    totalCount: number
    rows: BindingRow[]
}

interface SignupCodeList {
    totalCount: number
    rows: SignupCodeRow[]
}

interface AddBindingForm {
    accountId: number
    platform: BindingPlatform
    platformUid: string
    displayName?: string
    note?: string
}

interface IssueCodeForm {
    accountId: number
    platform?: BindingPlatform
}

const PLATFORM_LABEL: Record<BindingPlatform, string> = { qq: "QQ", kook: "KOOK" }
const STATE_LABEL: Record<BindState, string> = { pending: "待绑定", active: "已绑定", disabled: "已停用" }
const STATE_COLOR: Record<BindState, string> = { pending: "gold", active: "green", disabled: "red" }
const CODE_STATUS_LABEL: Record<SignupCodeStatus, string> = {
    pending: "待使用",
    bound: "已使用",
    expired: "已过期",
    revoked: "已吊销",
}
const CODE_STATUS_COLOR: Record<SignupCodeStatus, string> = {
    pending: "green",
    bound: "blue",
    expired: "default",
    revoked: "red",
}

function formatTime(value: string): string {
    return new Date(value).toLocaleString("zh-CN")
}

function describeError(error: Error): string {
    if (error instanceof ApiError && error.status === 409) return "该平台账号已存在主绑定，请刷新"
    return error.message
}

export default function Bindings() {
    const queryClient = useQueryClient()
    const [page, setPage] = useState(1)
    const [pageSize, setPageSize] = useState(20)
    const [platform, setPlatform] = useState<BindingPlatform | "">("")
    const [state, setState] = useState<BindState | "">("")
    const [search, setSearch] = useState("")
    const [query, setQuery] = useState("")
    const [codeAccountId, setCodeAccountId] = useState<number | null>(null)
    const [addOpen, setAddOpen] = useState(false)
    const [codeOpen, setCodeOpen] = useState(false)
    const [addForm] = Form.useForm<AddBindingForm>()
    const [codeForm] = Form.useForm<IssueCodeForm>()

    const bindings = useQuery({
        queryKey: ["adminBindings", platform, state, query, page, pageSize],
        queryFn: () => apiGet<BindingPage>(
            `/api/bindings?platform=${encodeURIComponent(platform)}`
            + `&state=${encodeURIComponent(state)}`
            + `&query=${encodeURIComponent(query)}`
            + `&page=${page}&pageSize=${pageSize}`,
        ),
    })

    const codes = useQuery({
        queryKey: ["adminBindingCodes", codeAccountId],
        queryFn: () => apiGet<SignupCodeList>(codeAccountId === null
            ? "/api/bindings/codes"
            : `/api/bindings/codes?accountId=${codeAccountId}`),
    })

    const invalidateBindings = () => {
        queryClient.invalidateQueries({ queryKey: ["adminBindings"] })
        queryClient.invalidateQueries({ queryKey: ["adminBindingCodes"] })
    }

    const addBinding = useMutation({
        mutationFn: (values: AddBindingForm) => apiPost<BindingRow>("/api/bindings", {
            accountId: values.accountId,
            platform: values.platform,
            platformUid: values.platformUid,
            displayName: values.displayName,
            note: values.note,
        }),
        onSuccess: row => {
            message.success(`已为账号 ${row.accountId} 新增 ${PLATFORM_LABEL[row.platform]} 绑定`)
            setAddOpen(false)
            addForm.resetFields()
            invalidateBindings()
        },
        onError: (error: Error) => message.error(describeError(error)),
    })

    const promote = useMutation({
        mutationFn: (row: BindingRow) => apiPost<BindingRow>(`/api/bindings/${row.id}/primary`, {}),
        onSuccess: row => {
            message.success(`账号 ${row.accountId} 的 ${PLATFORM_LABEL[row.platform]} 绑定已设为主账号`)
            invalidateBindings()
        },
        onError: (error: Error) => message.error(describeError(error)),
    })

    const remove = useMutation({
        mutationFn: (row: BindingRow) => apiDelete<{ ok: boolean }>(`/api/bindings/${row.id}`),
        onSuccess: (_result, row) => {
            message.success(`已解绑 ${PLATFORM_LABEL[row.platform]} ${row.platformUid}`)
            invalidateBindings()
        },
        onError: (error: Error) => message.error(error.message),
    })

    const issueCode = useMutation({
        mutationFn: (values: IssueCodeForm) => apiPost<SignupCodeRow>("/api/bindings/codes", {
            accountId: values.accountId,
            platform: values.platform,
        }),
        onSuccess: row => {
            message.success(`邀请码 ${row.code} 已生成，有效期至 ${formatTime(row.expiresAt)}`)
            setCodeOpen(false)
            codeForm.resetFields()
            invalidateBindings()
        },
        onError: (error: Error) => message.error(error.message),
    })

    const revokeCode = useMutation({
        mutationFn: (row: SignupCodeRow) => apiPost<{ ok: boolean }>(`/api/bindings/codes/${row.id}/revoke`, {}),
        onSuccess: () => {
            message.success("邀请码已吊销")
            invalidateBindings()
        },
        onError: (error: Error) => message.error(error.message),
    })

    return (
        <AdminPage
            eyebrow="OPERATIONS"
            title="账号绑定"
            description="查看 QQ / KOOK 与游戏账号的绑定关系，补发绑定码并手动维护绑定。同一个平台账号只能有一个主绑定。"
            actions={(
                <Space>
                    <Button icon={<KeyRound size={16} />} onClick={() => setCodeOpen(true)}>
                        补发绑定码
                    </Button>
                    <Button type="primary" icon={<Plus size={16} />} onClick={() => setAddOpen(true)}>
                        新增绑定
                    </Button>
                </Space>
            )}
        >
            <Space direction="vertical" size="large" className="admin-stack">
                {bindings.isError && (
                    <Alert
                        type="error"
                        showIcon
                        message="绑定列表不可用"
                        action={<Button onClick={() => bindings.refetch()}>重试</Button>}
                    />
                )}
                <Card title="绑定关系" className="admin-table-card">
                    <Space wrap style={{ marginBottom: 12 }}>
                        <Select
                            value={platform}
                            style={{ width: 130 }}
                            onChange={value => {
                                setPlatform(value)
                                setPage(1)
                            }}
                            options={[
                                { value: "", label: "全部平台" },
                                { value: "qq", label: "QQ" },
                                { value: "kook", label: "KOOK" },
                            ]}
                        />
                        <Select
                            value={state}
                            style={{ width: 140 }}
                            onChange={value => {
                                setState(value)
                                setPage(1)
                            }}
                            options={[
                                { value: "", label: "全部状态" },
                                { value: "active", label: "已绑定" },
                                { value: "pending", label: "待绑定" },
                                { value: "disabled", label: "已停用" },
                            ]}
                        />
                        <Input.Search
                            allowClear
                            style={{ width: 260 }}
                            placeholder="账号 / 用户名 / 平台 UID"
                            value={search}
                            onChange={event => setSearch(event.target.value)}
                            onSearch={value => {
                                setQuery(value.trim())
                                setPage(1)
                            }}
                        />
                        <Button icon={<RefreshCw size={16} />} onClick={() => bindings.refetch()}>
                            刷新
                        </Button>
                    </Space>
                    <Table<BindingRow>
                        rowKey="id"
                        loading={bindings.isLoading}
                        dataSource={bindings.data?.rows ?? []}
                        scroll={{ x: "max-content" }}
                        locale={{ emptyText: "暂无绑定关系" }}
                        pagination={{
                            current: page,
                            pageSize,
                            total: bindings.data?.totalCount ?? 0,
                            showSizeChanger: true,
                            onChange: (nextPage, nextPageSize) => {
                                setPage(nextPage)
                                setPageSize(nextPageSize)
                            },
                        }}
                        columns={[
                            { title: "账号 ID", dataIndex: "accountId", width: 100 },
                            {
                                title: "账号名",
                                dataIndex: "username",
                                width: 160,
                                render: (_, row) => row.username ?? "—",
                            },
                            { title: "UID", dataIndex: "viewerId", width: 110 },
                            {
                                title: "平台",
                                dataIndex: "platform",
                                width: 90,
                                render: (_, row) => <Tag color={row.platform === "qq" ? "blue" : "purple"}>
                                    {PLATFORM_LABEL[row.platform]}
                                </Tag>,
                            },
                            { title: "平台账号", dataIndex: "platformUid", width: 180 },
                            {
                                title: "平台昵称",
                                dataIndex: "displayName",
                                width: 150,
                                render: (_, row) => row.displayName ?? "—",
                            },
                            {
                                title: "主绑定",
                                dataIndex: "isPrimary",
                                width: 100,
                                render: (_, row) => row.isPrimary
                                    ? <Tag color="gold" icon={<Star size={13} />}>主账号</Tag>
                                    : <Tag>附加</Tag>,
                            },
                            {
                                title: "账号状态",
                                dataIndex: "bindState",
                                width: 100,
                                render: (_, row) => <Tag color={STATE_COLOR[row.bindState]}>
                                    {STATE_LABEL[row.bindState]}
                                </Tag>,
                            },
                            {
                                title: "来源",
                                dataIndex: "createdBy",
                                width: 90,
                                render: (_, row) => row.createdBy,
                            },
                            {
                                title: "绑定时间",
                                dataIndex: "createdAt",
                                width: 190,
                                render: (_, row) => formatTime(row.createdAt),
                            },
                            {
                                title: "操作",
                                fixed: "right",
                                width: 210,
                                render: (_, row) => (
                                    <Space>
                                        {!row.isPrimary && (
                                            <Button
                                                size="small"
                                                icon={<Star size={15} />}
                                                loading={promote.isPending && promote.variables?.id === row.id}
                                                onClick={() => promote.mutate(row)}
                                            >
                                                设为主账号
                                            </Button>
                                        )}
                                        <Button
                                            size="small"
                                            icon={<KeyRound size={15} />}
                                            onClick={() => setCodeAccountId(row.accountId)}
                                        >
                                            绑定码
                                        </Button>
                                        <Popconfirm
                                            title="解除这条绑定？"
                                            description={row.isPrimary
                                                ? "这是主绑定，解绑后账号将回到待绑定状态。"
                                                : "解绑后该平台账号需要重新绑定才能登录。"}
                                            okText="解绑"
                                            cancelText="取消"
                                            okButtonProps={{ danger: true }}
                                            onConfirm={() => remove.mutate(row)}
                                        >
                                            <Button danger size="small" icon={<Trash2 size={15} />}>
                                                解绑
                                            </Button>
                                        </Popconfirm>
                                    </Space>
                                ),
                            },
                        ]}
                    />
                </Card>
                <Card
                    title={codeAccountId === null ? "绑定码" : `绑定码 · 账号 ${codeAccountId}`}
                    className="admin-table-card"
                    extra={codeAccountId === null
                        ? (
                            <Button size="small" icon={<KeyRound size={15} />} onClick={() => setCodeOpen(true)}>
                                补发绑定码
                            </Button>
                        )
                        : (
                            <Space>
                                <Button size="small" onClick={() => setCodeAccountId(null)}>查看全部</Button>
                                <Button size="small" icon={<KeyRound size={15} />} onClick={() => setCodeOpen(true)}>
                                    补发绑定码
                                </Button>
                            </Space>
                        )}
                >
                    <Table<SignupCodeRow>
                        rowKey="id"
                        size="small"
                        loading={codes.isLoading}
                        dataSource={codes.data?.rows ?? []}
                        scroll={{ x: "max-content" }}
                        locale={{ emptyText: "暂无绑定码" }}
                        pagination={false}
                        columns={[
                            {
                                title: "绑定码",
                                dataIndex: "code",
                                width: 130,
                                render: (_, row) => <Tag color="geekblue">{row.code}</Tag>,
                            },
                            { title: "账号 ID", dataIndex: "accountId", width: 100 },
                            {
                                title: "账号名",
                                dataIndex: "username",
                                width: 160,
                                render: (_, row) => row.username ?? "—",
                            },
                            {
                                title: "平台",
                                dataIndex: "platform",
                                width: 90,
                                render: (_, row) => row.platform === null
                                    ? "不限"
                                    : PLATFORM_LABEL[row.platform],
                            },
                            {
                                title: "状态",
                                dataIndex: "status",
                                width: 100,
                                render: (_, row) => <Tag color={CODE_STATUS_COLOR[row.status]}>
                                    {CODE_STATUS_LABEL[row.status]}
                                </Tag>,
                            },
                            { title: "尝试次数", dataIndex: "attempts", width: 100 },
                            {
                                title: "过期时间",
                                dataIndex: "expiresAt",
                                width: 190,
                                render: (_, row) => formatTime(row.expiresAt),
                            },
                            {
                                title: "操作",
                                fixed: "right",
                                width: 120,
                                render: (_, row) => row.status === "pending"
                                    ? (
                                        <Button
                                            size="small"
                                            danger
                                            loading={revokeCode.isPending && revokeCode.variables?.id === row.id}
                                            onClick={() => revokeCode.mutate(row)}
                                        >
                                            吊销
                                        </Button>
                                    )
                                    : <span>—</span>,
                            },
                        ]}
                    />
                </Card>
            </Space>
            <Modal
                title="新增绑定"
                open={addOpen}
                okText="保存"
                cancelText="取消"
                confirmLoading={addBinding.isPending}
                onCancel={() => setAddOpen(false)}
                onOk={() => {
                    void addForm.validateFields()
                        .then(values => addBinding.mutate(values))
                        .catch(() => undefined)
                }}
            >
                <Form<AddBindingForm>
                    form={addForm}
                    layout="vertical"
                    initialValues={{ platform: "qq" }}
                    onFinish={values => addBinding.mutate(values)}
                >
                    <Form.Item
                        name="accountId"
                        label="游戏账号 ID"
                        rules={[{ required: true, message: "请填写游戏账号 ID" }]}
                    >
                        <InputNumber min={1} precision={0} style={{ width: "100%" }} placeholder="如 10001" />
                    </Form.Item>
                    <Form.Item name="platform" label="平台" rules={[{ required: true, message: "请选择平台" }]}>
                        <Select
                            options={[
                                { value: "qq", label: "QQ" },
                                { value: "kook", label: "KOOK" },
                            ]}
                        />
                    </Form.Item>
                    <Form.Item
                        name="platformUid"
                        label="平台账号"
                        rules={[{ required: true, message: "请填写平台账号（QQ 号 / KOOK ID）" }]}
                    >
                        <Input maxLength={64} placeholder="QQ 号或 KOOK 用户 ID" />
                    </Form.Item>
                    <Form.Item name="displayName" label="平台昵称">
                        <Input maxLength={128} placeholder="可选，用于后台辨认" />
                    </Form.Item>
                    <Form.Item name="note" label="备注">
                        <Input maxLength={256} placeholder="可选，例如「服主手动补绑」" />
                    </Form.Item>
                </Form>
            </Modal>
            <Modal
                title="补发绑定码"
                open={codeOpen}
                okText="生成"
                cancelText="取消"
                confirmLoading={issueCode.isPending}
                onCancel={() => setCodeOpen(false)}
                onOk={() => {
                    void codeForm.validateFields()
                        .then(values => issueCode.mutate(values))
                        .catch(() => undefined)
                }}
            >
                <Alert
                    type="info"
                    showIcon
                    message="绑定码只显示一次"
                    description="把生成的 6 位绑定码交给玩家，在 QQ / KOOK 群内向机器人发送 /bind <码> 完成绑定。"
                    style={{ marginBottom: 16 }}
                />
                <Form<IssueCodeForm>
                    form={codeForm}
                    layout="vertical"
                    initialValues={{ platform: undefined }}
                    onFinish={values => issueCode.mutate(values)}
                >
                    <Form.Item
                        name="accountId"
                        label="游戏账号 ID"
                        rules={[{ required: true, message: "请填写游戏账号 ID" }]}
                    >
                        <InputNumber min={1} precision={0} style={{ width: "100%" }} placeholder="如 10001" />
                    </Form.Item>
                    <Form.Item name="platform" label="限定平台">
                        <Select
                            allowClear
                            placeholder="不限平台"
                            options={[
                                { value: "qq", label: "QQ" },
                                { value: "kook", label: "KOOK" },
                            ]}
                        />
                    </Form.Item>
                </Form>
            </Modal>
        </AdminPage>
    )
}
