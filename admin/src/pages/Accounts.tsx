import { useState } from "react"
import { Alert, Card, Table, Button, Space, Popconfirm, Input, message, Tag, Grid, Form, Modal } from "antd"
import { PlusOutlined, CopyOutlined, DeleteOutlined, SwapOutlined, EditOutlined, LeftOutlined, KeyOutlined } from "@ant-design/icons"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { apiGet, apiPost } from "../api/client"
import { AdminPage } from "../components/AdminPage"
import { AccountsMobileView } from "./accounts/AccountsMobileView"
import type { AccountRow, PlayerBrief } from "./accounts/types"

const { useBreakpoint } = Grid

/**
 * Login name and password rules, copied from the server's single source of truth
 * (`src/lib/sp-auth/contract.ts`, `isValidUsername` / `isStrongPassword`). The
 * server re-checks both and rejects with the identical wording; this copy only
 * exists so the owner sees the problem before the round trip.
 */
const USERNAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{3,19}$/
const USERNAME_MESSAGE = "登录名格式不合法（4-20 位字母/数字/下划线，且不能以数字开头）。"
const PASSWORD_PATTERN = /^(?=.*[A-Z])(?=.*[a-z])(?=.*[0-9])[!-~]{8,64}$/
const PASSWORD_MESSAGE = "密码强度不足（8-64 位，字母/数字/符号都行，但不能有空格或中文，且需同时含大写字母、小写字母和数字）。"

interface PasswordForm {
    username?: string
    password: string
    confirmPassword: string
}

export default function Accounts() {
    const qc = useQueryClient()
    const navigate = useNavigate()
    const screens = useBreakpoint()
    const isMobile = !screens.md
    const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null)
    const [renameId, setRenameId] = useState<number | null>(null)
    const [renameName, setRenameName] = useState("")
    const [renameDeviceId, setRenameDeviceId] = useState<number | null>(null)
    const [renameDeviceName, setRenameDeviceName] = useState("")
    const [passwordAccountId, setPasswordAccountId] = useState<number | null>(null)
    const [passwordForm] = Form.useForm<PasswordForm>()

    const { data: accounts = [], isLoading } = useQuery({
        queryKey: ["accounts"],
        queryFn: () => apiGet<AccountRow[]>("/api/server/accounts"),
    })

    const passwordAccount = accounts.find(a => a.id === passwordAccountId)
    const openPassword = (account: AccountRow) => {
        setPasswordAccountId(account.id)
    }

    const selectedAccount = accounts.find(a => a.id === selectedAccountId)
    const savePlayers = selectedAccount?.players ?? []

    const refresh = () => {
        qc.invalidateQueries({ queryKey: ["accounts"] })
    }
    const showMutationError = (error: Error) => message.error(error.message)

    const activateSave = useMutation({
        mutationFn: (playerId: number) => apiPost("/api/server/activateSave?playerId=" + playerId),
        onSuccess: () => { message.success("已切换生效存档"); refresh() },
        onError: showMutationError,
    })

    const newSave = useMutation({
        mutationFn: (accountId: number) => apiPost("/api/server/newSave?accountId=" + accountId),
        onSuccess: () => { message.success("新存档已创建"); refresh() },
        onError: showMutationError,
    })

    const deleteSave = useMutation({
        mutationFn: (playerId: number) => apiPost("/api/server/deleteSave?playerId=" + playerId),
        onSuccess: () => { message.success("存档已删除"); refresh() },
        onError: showMutationError,
    })

    const deleteAccount = useMutation({
        mutationFn: (id: number) => apiPost("/api/server/deleteAccount?id=" + id),
        onSuccess: () => {
            message.success("账号已删除")
            if (selectedAccountId === (deleteAccount.variables as number)) setSelectedAccountId(null)
            refresh()
        },
        onError: showMutationError,
    })

    const renameSave = useMutation({
        mutationFn: ({ playerId, name }: { playerId: number; name: string }) =>
            apiPost("/api/server/renameSave", { playerId, name }),
        onSuccess: () => { message.success("已改名"); setRenameId(null); refresh() },
        onError: showMutationError,
    })

    const cloneSave = useMutation({
        mutationFn: ({ playerId, accountId }: { playerId: number; accountId: number }) =>
            apiPost(`/api/server/cloneSave?playerId=${playerId}&accountId=${accountId}`),
        onSuccess: () => { message.success("存档已复制"); refresh() },
        onError: showMutationError,
    })

    const renameDevice = useMutation({
        mutationFn: ({ deviceId, name }: { deviceId: number; name: string }) =>
            apiPost<{ ok: boolean; deviceId: number; name: string | null }>(
                "/api/server/device/rename",
                { deviceId, name },
            ),
        onSuccess: ({ name }) => {
            message.success(name === null ? "设备名称已清除" : "设备名称已更新")
            setRenameDeviceId(null)
            refresh()
        },
        onError: showMutationError,
    })

    // The login name travels only when the owner actually typed one; sending an
    // empty string would be read by the server as an invalid rename attempt.
    const setPassword = useMutation({
        mutationFn: ({ accountId, password, username }: { accountId: number; password: string; username: string }) =>
            apiPost<{ ok: boolean; data: { id: number; username: string | null; hasPassword: boolean } }>(
                `/api/server/accounts/${accountId}/password`,
                username === "" ? { password } : { password, username },
            ),
        onSuccess: (_result, { accountId }) => {
            message.success(`账号 ${accountId} 的密码已更新`)
            setPasswordAccountId(null)
            passwordForm.resetFields()
            refresh()
        },
        onError: showMutationError,
    })

    const accountColumns = [
        { title: "ID", dataIndex: "id", width: 64 },
        { title: "存档数", dataIndex: "saveCount", width: 80, responsive: ["sm"] as any },
        {
            title: "默认存档", width: 180, responsive: ["md"] as any,
            render: (_: unknown, row: AccountRow) => {
                if (!row.defaultPlayerId) return <Tag>无</Tag>
                const isActive = row.activePlayerId === row.defaultPlayerId
                return (
                    <Space size={6} wrap>
                        <span>{row.defaultPlayerName ?? `#${row.defaultPlayerId}`}</span>
                        <Tag color={isActive ? "green" : "blue"}>{isActive ? "当前活动" : "账号默认"}</Tag>
                    </Space>
                )
            },
        },
        {
            title: "绑定设备", width: 230,
            render: (_: unknown, row: AccountRow) => row.devices.length === 0 ? <Tag>无</Tag> : (
                <Space direction="vertical" size={4}>
                    {row.devices.map(device => renameDeviceId === device.deviceId ? (
                        <div className="admin-edit-compact" key={device.deviceId}>
                            <Input
                                size="small"
                                value={renameDeviceName}
                                maxLength={64}
                                placeholder={`设备 ${device.deviceId}`}
                                onChange={event => setRenameDeviceName(event.target.value)}
                                onPressEnter={() => renameDevice.mutate({
                                    deviceId: device.deviceId,
                                    name: renameDeviceName,
                                })}
                                style={{ width: 120 }}
                            />
                            <Button
                                size="small"
                                type="primary"
                                loading={renameDevice.isPending}
                                onClick={() => renameDevice.mutate({
                                    deviceId: device.deviceId,
                                    name: renameDeviceName,
                                })}
                            >确定</Button>
                            <Button size="small" onClick={() => setRenameDeviceId(null)}>取消</Button>
                        </div>
                    ) : (
                        <Space size={4} key={device.deviceId}>
                            <Tag>{device.name ?? `设备 ${device.deviceId}`}</Tag>
                            <Button
                                type="text"
                                size="small"
                                title="修改设备名称"
                                icon={<EditOutlined />}
                                onClick={() => {
                                    setRenameDeviceId(device.deviceId)
                                    setRenameDeviceName(device.name ?? "")
                                }}
                            />
                        </Space>
                    ))}
                </Space>
            ),
        },
        {
            title: "登录名", width: 190,
            render: (_: unknown, row: AccountRow) => row.username ? (
                <Space size={4}>
                    <Tag color="blue">{row.username}</Tag>
                    <Tag color={row.hasPassword ? "green" : "orange"}>{row.hasPassword ? "有密码" : "无密码"}</Tag>
                </Space>
            ) : <Tag>未设置</Tag>,
        },
        {
            title: "操作", width: 320,
            render: (_: unknown, row: AccountRow) => (
                <div className="admin-action-row">
                    <Button size="small" type="primary" onClick={() => setSelectedAccountId(row.id)}>管理存档</Button>
                    <Button size="small" icon={<PlusOutlined />} onClick={() => newSave.mutate(row.id)}>新建存档</Button>
                    <Button size="small" icon={<KeyOutlined />} onClick={() => openPassword(row)}>改密码</Button>
                    <Popconfirm title={`删除账号 ${row.id} 及所有存档？`} onConfirm={() => deleteAccount.mutate(row.id)} okText="确认" cancelText="取消" okButtonProps={{ danger: true }}>
                        <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
                    </Popconfirm>
                </div>
            ),
        },
    ]

    const saveColumns = [
        { title: "ID", dataIndex: "id", width: 60, responsive: ["sm"] as any },
        {
            title: "名字", width: 150,
            render: (_: unknown, row: PlayerBrief) => renameId === row.id ? (
                <div
                    className="admin-edit-compact"
                    onClick={event => event.stopPropagation()}
                    onKeyDown={event => event.stopPropagation()}
                >
                    <Input size="small" value={renameName} onChange={e => setRenameName(e.target.value)} onPressEnter={() => renameSave.mutate({ playerId: row.id, name: renameName })} style={{ width: 100 }} />
                    <Button size="small" type="primary" onClick={() => renameSave.mutate({ playerId: row.id, name: renameName })}>确定</Button>
                    <Button size="small" onClick={() => setRenameId(null)}>取消</Button>
                </div>
            ) : (
                <Space onClick={event => event.stopPropagation()}>
                    <a onClick={() => navigate(`/players/${row.id}`)}>{row.name}</a>
                    <Button
                        type="text"
                        size="small"
                        title="重命名存档"
                        icon={<EditOutlined />}
                        onClick={() => { setRenameId(row.id); setRenameName(row.name) }}
                    />
                </Space>
            ),
        },
        { title: "Rank", width: 80, render: (_: unknown, row: PlayerBrief) => `Rank ${row.rank}` },
        {
            title: "状态", width: 80, responsive: ["sm"] as any,
            render: (_: unknown, row: PlayerBrief) => (
                <Space size={4} wrap>
                    {row.isDefault && <Tag color="blue">账号默认</Tag>}
                    {row.isActive && <Tag color="green">当前活动</Tag>}
                </Space>
            ),
        },
        {
            title: "操作", width: 320,
            render: (_: unknown, row: PlayerBrief) => (
                <div className="admin-action-row" onClick={event => event.stopPropagation()}>
                    <Button size="small" type="primary" icon={<EditOutlined />} onClick={() => navigate(`/players/${row.id}`)}>
                        编辑存档
                    </Button>
                    <Button size="small" icon={<SwapOutlined />} disabled={row.isDefault && row.isActive} onClick={() => activateSave.mutate(row.id)}>
                        设为默认并切换
                    </Button>
                    <Button size="small" icon={<CopyOutlined />} onClick={() => cloneSave.mutate({ playerId: row.id, accountId: selectedAccountId! })}>
                        复制
                    </Button>
                    <Popconfirm title={`删除存档 ${row.id}？`} onConfirm={() => deleteSave.mutate(row.id)} okText="确认" cancelText="取消" okButtonProps={{ danger: true }}>
                        <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
                    </Popconfirm>
                </div>
            ),
        },
    ]

    return (
        <AdminPage
            eyebrow="SAVES"
            title="账号 / 存档"
            description="查看账号与默认存档关系。账号默认存档决定该账号登录时选用哪个存档；当前活动存档只是管理端最近切换的全局状态。"
        >
        <Space direction="vertical" size="large" className="admin-stack">
            <Alert
                type="info"
                showIcon
                message="选档状态说明"
                description="新建和复制存档会设为该账号默认并切换为当前活动；删除默认存档后，服务端会在该账号剩余存档中回退到第一个可用存档。删除最后一个存档会同时删除账号。"
            />
            {isMobile ? (
                <Card
                    title={selectedAccount ? `账号 ${selectedAccount.id} 的存档` : "账号管理"}
                    className="admin-mobile-list-card"
                >
                    <AccountsMobileView
                        accounts={accounts}
                        selectedAccount={selectedAccount}
                        loading={isLoading}
                        renamePending={renameSave.isPending || renameDevice.isPending}
                        onSelectAccount={setSelectedAccountId}
                        onBack={() => setSelectedAccountId(null)}
                        onOpenPlayer={playerId => navigate(`/players/${playerId}`)}
                        onNewSave={accountId => newSave.mutateAsync(accountId)}
                        onDeleteAccount={accountId => deleteAccount.mutateAsync(accountId)}
                        onActivateSave={playerId => activateSave.mutateAsync(playerId)}
                        onCloneSave={(playerId, accountId) => cloneSave.mutateAsync({ playerId, accountId })}
                        onDeleteSave={playerId => deleteSave.mutateAsync(playerId)}
                        onRenameSave={(playerId, name) => renameSave.mutateAsync({ playerId, name })}
                        onRenameDevice={(deviceId, name) => renameDevice.mutateAsync({ deviceId, name })}
                        onChangePassword={accountId => setPasswordAccountId(accountId)}
                    />
                </Card>
            ) : selectedAccount ? (
                <Card
                    title={`账号 ${selectedAccount.id} 的存档`}
                    className="admin-table-card"
                    extra={(
                        <Space wrap>
                            <Button size="small" icon={<LeftOutlined />} onClick={() => setSelectedAccountId(null)}>返回账号列表</Button>
                            <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => newSave.mutate(selectedAccount.id)}>新建存档</Button>
                        </Space>
                    )}
                >
                    <Table
                        rowKey="id"
                        columns={saveColumns}
                        dataSource={savePlayers}
                        pagination={false}
                        size="small"
                        locale={{ emptyText: "暂无存档" }}
                        onRow={row => ({
                            className: "admin-clickable-table-row",
                            onClick: () => navigate(`/players/${row.id}`),
                        })}
                    />
                </Card>
            ) : (
                <Card title="账号管理" className="admin-table-card">
                    <Table
                        rowKey="id"
                        columns={accountColumns}
                        dataSource={accounts}
                        loading={isLoading}
                        pagination={false}
                        size="small"
                    />
                </Card>
            )}

        </Space>

        <Modal
            title={passwordAccount ? `账号 ${passwordAccount.id} 改密码` : "改密码"}
            open={passwordAccountId !== null}
            okText="保存"
            cancelText="取消"
            confirmLoading={setPassword.isPending}
            onCancel={() => setPasswordAccountId(null)}
            onOk={() => {
                void passwordForm.validateFields()
                    .then(values => setPassword.mutate({
                        accountId: passwordAccountId as number,
                        password: values.password,
                        username: values.username?.trim() ?? "",
                    }))
                    .catch(() => undefined)
            }}
        >
            <Alert
                type="info"
                showIcon
                style={{ marginBottom: 16 }}
                message="新密码用于客户端「账号登录」"
                description="规则与游戏内注册一致：8-64 位，需同时包含大写字母、小写字母和数字，可用符号但不能有空格。账号还需在「账号绑定」页完成 QQ / KOOK 绑定并处于已激活状态，否则登录会停在待绑定。"
            />
            <Form<PasswordForm>
                form={passwordForm}
                layout="vertical"
                key={passwordAccountId ?? "password-none"}
                initialValues={{ username: passwordAccount?.username ?? "", password: "", confirmPassword: "" }}
            >
                <Form.Item
                    name="username"
                    label="登录名"
                    rules={[
                        { required: !passwordAccount?.username, message: "该账号还没有登录名，请一并设置" },
                        {
                            validator: (_rule, value) => {
                                const text = typeof value === "string" ? value.trim() : ""
                                if (text === "") return Promise.resolve()
                                return USERNAME_PATTERN.test(text)
                                    ? Promise.resolve()
                                    : Promise.reject(new Error(USERNAME_MESSAGE))
                            },
                        },
                    ]}
                >
                    <Input
                        maxLength={20}
                        placeholder={passwordAccount?.username ? "留空表示不修改" : "该账号还没有登录名，请设置一个"}
                    />
                </Form.Item>
                <Form.Item
                    name="password"
                    label="新密码"
                    rules={[
                        { required: true, message: "请输入新密码" },
                        { pattern: PASSWORD_PATTERN, message: PASSWORD_MESSAGE },
                    ]}
                >
                    <Input.Password maxLength={64} autoComplete="new-password" placeholder="8-64 位，含大写、小写字母和数字，可用符号" />
                </Form.Item>
                <Form.Item
                    name="confirmPassword"
                    label="确认新密码"
                    dependencies={["password"]}
                    rules={[
                        { required: true, message: "请再次输入新密码" },
                        ({ getFieldValue }) => ({
                            validator: (_rule, value) => (!value || value === getFieldValue("password")
                                ? Promise.resolve()
                                : Promise.reject(new Error("两次输入的密码不一致"))),
                        }),
                    ]}
                >
                    <Input.Password maxLength={64} autoComplete="new-password" placeholder="再次输入新密码" />
                </Form.Item>
            </Form>
        </Modal>
        </AdminPage>
    )
}
