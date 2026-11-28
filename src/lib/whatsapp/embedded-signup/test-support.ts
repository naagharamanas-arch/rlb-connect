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
