export interface DeviceBinding {
    deviceId: number
    name: string | null
}

export interface PlayerBrief {
    id: number
    accountId: number
    name: string
    rank: number
    isDefault: boolean
    isActive: boolean
}

export interface AccountRow {
    id: number
    /** `accounts.username` — the login name; NULL for accounts the game created. */
    username: string | null
    /** Whether `accounts.password_hash` already holds a bcrypt hash. */
    hasPassword: boolean
    saveCount: number
    defaultPlayerId: number | null
    defaultPlayerName: string | null
    activePlayerId: number | null
    devices: DeviceBinding[]
    players: PlayerBrief[]
    playerIds: number[]
}
