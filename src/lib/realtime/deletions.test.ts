import { describe, expect, it } from 'vitest'

import { DELETION_CHANGES, deletionFor, parseDeletionSignal } from './deletions'

describe('deletion signals', () => {
  it('subscribes to INSERT on the signal table only (DELETE events are never published)', () => {
    expect(DELETION_CHANGES).toEqual({ event: 'INSERT', schema: 'public', table: 'realtime_deletions' })
  })

  it('parses a valid signal into the shape the DELETE handlers use', () => {
    const payload = { new: { id: 7, account_id: 'a', table_name: 'message_reactions', old_row: { id: 'r1', conversation_id: 'c1' } } }
    expect(parseDeletionSignal(payload)).toEqual({ table: 'message_reactions', old: { id: 'r1', conversation_id: 'c1' } })
  })

  it('rejects malformed, unknown-table and non-object payloads', () => {
    expect(parseDeletionSignal(null)).toBeNull()
    expect(parseDeletionSignal({})).toBeNull()
    expect(parseDeletionSignal({ new: { table_name: 'profiles', old_row: { id: 'x' } } })).toBeNull()
    expect(parseDeletionSignal({ new: { table_name: 'messages', old_row: 'nope' } })).toBeNull()
    expect(parseDeletionSignal({ new: { table_name: 'messages', old_row: [1] } })).toBeNull()
    expect(parseDeletionSignal({ new: { table_name: 'messages' } })).toBeNull()
  })

  it('deletionFor returns the old row only for the requested table', () => {
    const payload = { new: { table_name: 'conversations', old_row: { id: 'c9' } } }
    expect(deletionFor('conversations', payload)).toEqual({ id: 'c9' })
    expect(deletionFor('messages', payload)).toBeNull()
  })
})
