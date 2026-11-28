import type { NewSignupSession, SignupSession, SignupSessionStore } from './session'

/** In-memory store with the same atomic-claim semantics as the SQL. */
export function memoryStore(): SignupSessionStore & { rows: SignupSession[] } {
  const rows: SignupSession[] = []
  let n = 0
  return {
    rows,
    async insert(row: NewSignupSession) {
      const s: SignupSession = { ...row, id: `s${++n}`, createdAt: new Date() }
      rows.push(s)
      return { ...s }
    },
    async findByStateHash(h) {
      const s = rows.find((r) => r.stateHash === h)
      return s ? { ...s } : null
    },
    async claimPending(id, now) {
      const s = rows.find((r) => r.id === id)
      if (!s || s.status !== 'pending' || s.expiresAt.getTime() <= now.getTime()) return null
      s.status = 'exchanging'
      s.usedAt = now
      return { ...s }
    },
    async update(id, patch) {
      Object.assign(rows.find((r) => r.id === id)!, patch)
    },
  }
}

import type {
  ConnectionStatus,
  ConnectionStore,
  StoredConnection,
  UpsertConnectionInput,
} from './connection-store'

/** In-memory ConnectionStore; records every write so tests can assert on it. */
export function memoryConnectionStore(): ConnectionStore & {
  rows: Map<string, StoredConnection>
  writes: UpsertConnectionInput[]
  statuses: Array<[string, ConnectionStatus]>
} {
  const rows = new Map<string, StoredConnection>()
  const writes: UpsertConnectionInput[] = []
  const statuses: Array<[string, ConnectionStatus]> = []
  return {
    rows,
    writes,
    statuses,
    async getByAccount(accountId) {
      return rows.get(accountId) ?? null
    },
    async upsertConnection(input) {
      writes.push(input)
      rows.set(input.accountId, {
        accountId: input.accountId,
        phoneNumberId: input.phoneNumberId,
        wabaId: input.wabaId,
        status: input.status,
        registeredAt: input.registeredAt,
        subscribedAppsAt: input.subscribedAppsAt,
      })
    },
    async markStatus(accountId, status) {
      const row = rows.get(accountId)
      if (!row) return { ok: false, reason: 'not_found' }
      row.status = status
      statuses.push([accountId, status])
      return { ok: true }
    },
  }
}
