/**
 * Deletion signals over Supabase Realtime.
 *
 * Realtime never applies row level security to DELETE events, so the `supabase_realtime`
 * publication does NOT publish DELETE at all (migration 065): no subscriber — another
 * tenant, or anon — can receive one. The app still needs to know when a row it displays
 * is deleted, so a trigger records a minimal row in `public.realtime_deletions` and THAT
 * table's INSERT events are RLS-filtered per subscriber like any other tenant data.
 *
 * This module is the single place that turns such an INSERT back into the
 * `{ table, old }` shape the DELETE handlers already understand. Client-safe: no imports.
 */

export const DELETION_SIGNAL_TABLE = 'realtime_deletions'

/** `.on('postgres_changes', DELETION_CHANGES, handler)` — all of the caller's signals. */
export const DELETION_CHANGES = {
  event: 'INSERT',
  schema: 'public',
  table: DELETION_SIGNAL_TABLE,
} as const

export type DeletedTable =
  | 'messages'
  | 'message_reactions'
  | 'conversations'
  | 'notifications'
  | 'member_presence'

const DELETED_TABLES: ReadonlySet<string> = new Set<DeletedTable>([
  'messages',
  'message_reactions',
  'conversations',
  'notifications',
  'member_presence',
])

export interface DeletionSignal {
  table: DeletedTable
  /** Identifying columns of the deleted row (ids only; never content). */
  old: Record<string, unknown>
}

/** Parse the payload of an INSERT on `realtime_deletions`; null when it is not a valid signal. */
export function parseDeletionSignal(payload: { new?: unknown } | null | undefined): DeletionSignal | null {
  const row = payload?.new as { table_name?: unknown; old_row?: unknown } | null | undefined
  if (!row || typeof row.table_name !== 'string' || !DELETED_TABLES.has(row.table_name)) return null
  const old = row.old_row
  if (!old || typeof old !== 'object' || Array.isArray(old)) return null
  return { table: row.table_name as DeletedTable, old: old as Record<string, unknown> }
}

/** Parse, and return the signal only when it is for `table`. */
export function deletionFor(
  table: DeletedTable,
  payload: { new?: unknown } | null | undefined,
): Record<string, unknown> | null {
  const signal = parseDeletionSignal(payload)
  return signal && signal.table === table ? signal.old : null
}
