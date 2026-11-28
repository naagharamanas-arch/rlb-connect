import { createHash, randomBytes } from 'node:crypto'

/**
 * Embedded Signup session lifecycle (docs/architecture/09, slice S1).
 *
 * Pure logic over an injected store (the real one will be the service-role
 * client over `whatsapp_signup_sessions`, migration 070 — a file only in S1).
 * Nothing here is called by a route yet.
 *
 * Rules enforced here:
 *  - the account id comes ONLY from the server-resolved caller at `start`; it is
 *    bound into the session row and never read from a request body;
 *  - only the SHA-256 of the opaque `state` is stored;
 *  - a session is single-use: an atomic conditional claim (pending→exchanging)
 *    means a replay or a double click loses the race;
 *  - at finish the SAME user must still be an admin of THAT account.
 */

export const SESSION_TTL_MS = 10 * 60 * 1000

export type SignupMode = 'new_number' | 'coexistence'

export type SignupStatus =
  | 'pending'
  | 'exchanging'
  | 'connected'
  | 'needs_attention'
  | 'failed'

export interface SignupSession {
  id: string
  accountId: string
  userId: string
  stateHash: string
  mode: SignupMode
  status: SignupStatus
  /** Step names only — never payloads, tokens or codes. */
  completedSteps: string[]
  consentAt: Date | null
  expiresAt: Date
  usedAt: Date | null
  createdAt: Date
}

export type NewSignupSession = Omit<SignupSession, 'id' | 'createdAt'>

/** Persistence port. The real implementation uses the service role. */
export interface SignupSessionStore {
  insert(row: NewSignupSession): Promise<SignupSession>
  findByStateHash(stateHash: string): Promise<SignupSession | null>
  /**
   * Atomic: `UPDATE … SET status='exchanging', used_at=now WHERE id=$1 AND
   * status='pending' AND expires_at > now RETURNING *`. Returns null when the
   * row is no longer claimable (lost the race, replayed, or expired).
   */
  claimPending(id: string, now: Date): Promise<SignupSession | null>
  update(
    id: string,
    patch: Partial<Pick<SignupSession, 'status' | 'completedSteps'>>,
  ): Promise<void>
}

export function hashState(state: string): string {
  return createHash('sha256').update(state, 'utf8').digest('hex')
}

/** 256 bits of randomness; `state` goes to the browser, only its hash is stored. */
export function generateState(): { state: string; stateHash: string } {
  const state = randomBytes(32).toString('base64url')
  return { state, stateHash: hashState(state) }
}

export interface CreateSessionArgs {
  store: SignupSessionStore
  /** Server-resolved (requireRole). Never from a request body. */
  accountId: string
  userId: string
  mode: SignupMode
  /** The disclosure consent was ticked (required for coexistence). */
  consent: boolean
  now?: Date
}

export type CreateSessionResult =
  | { ok: true; state: string; session: SignupSession }
  | { ok: false; reason: 'consent_required' }

export async function createSession(args: CreateSessionArgs): Promise<CreateSessionResult> {
  const { store, accountId, userId, mode, consent } = args
  const now = args.now ?? new Date()
  if (mode === 'coexistence' && !consent) {
    return { ok: false, reason: 'consent_required' }
  }
  const { state, stateHash } = generateState()
  const session = await store.insert({
    accountId,
    userId,
    stateHash,
    mode,
    status: 'pending',
    completedSteps: [],
    consentAt: consent ? now : null,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    usedAt: null,
  })
  return { ok: true, state, session }
}

export type ClaimFailure =
  | 'not_found'
  | 'expired'
  | 'replayed'
  | 'foreign_user'
  | 'role_revoked'

export type ClaimResult =
  | { ok: true; session: SignupSession }
  | { ok: false; reason: ClaimFailure }

export interface ClaimSessionArgs {
  store: SignupSessionStore
  /** The opaque value the browser sent back. */
  state: string
  /** Server-resolved caller at finish time. */
  callerUserId: string
  /**
   * Re-check at finish: is `userId` STILL an admin/owner of `accountId` right
   * now (profiles today; memberships once workspace-aware)? Injected so this
   * module has no auth/DB dependency.
   */
  isStillAdmin: (accountId: string, userId: string) => Promise<boolean>
  now?: Date
}

/**
 * Validate and atomically claim a session. All read-only checks run BEFORE the
 * claim, so a foreign user or a downgraded admin can't burn someone else's
 * session; the claim itself is the single source of truth for single-use.
 */
export async function claimSession(args: ClaimSessionArgs): Promise<ClaimResult> {
  const { store, state, callerUserId, isStillAdmin } = args
  const now = args.now ?? new Date()

  if (!state) return { ok: false, reason: 'not_found' }
  const found = await store.findByStateHash(hashState(state))
  if (!found) return { ok: false, reason: 'not_found' }

  if (found.userId !== callerUserId) return { ok: false, reason: 'foreign_user' }
  if (found.status !== 'pending') return { ok: false, reason: 'replayed' }
  if (found.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: 'expired' }
  if (!(await isStillAdmin(found.accountId, found.userId))) {
    return { ok: false, reason: 'role_revoked' }
  }

  const claimed = await store.claimPending(found.id, now)
  if (!claimed) return { ok: false, reason: 'replayed' }
  return { ok: true, session: claimed }
}
