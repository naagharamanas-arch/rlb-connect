import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  handleTemplateWebhookChange,
  isTemplateWebhookField,
} from './template-webhook';

// ── In-memory fake of the two tables this module touches ──────────────
// Unlike a call-recorder, it holds real rows and applies filters, so the
// tests can assert WHICH workspace's data actually changed. It mirrors only
// the surface the module uses; anything else throws so unintended queries
// fail loudly:
//   whatsapp_config:   .select(cols).eq(col, v)
//   message_templates: .update(p).eq(col, v).in(col, [v]).select()
//                      .insert(row)
type Row = Record<string, unknown>;
type Filter = { kind: 'eq' | 'in'; column: string; value: unknown };
type Call = {
  table: string;
  op: 'select' | 'update' | 'insert';
  columns?: string;
  filters: Filter[];
  payload?: Row;
};

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((f) =>
    f.kind === 'eq'
      ? row[f.column] === f.value
      : (f.value as unknown[]).includes(row[f.column]),
  );
}

function makeDb(
  seed: { config?: Row[]; templates?: Row[] } = {},
  opts: {
    configError?: { message: string };
    updateError?: { message: string };
    insertError?: { message: string; code?: string };
    /** Runs when the stub INSERT loses a race — e.g. add the raced row. */
    onInsertError?: (templates: Row[]) => void;
  } = {},
) {
  const config = seed.config ?? [];
  const templates = seed.templates ?? [];
  const calls: Call[] = [];

  const db = {
    from(table: string) {
      if (table === 'whatsapp_config') {
        return {
          select(columns: string) {
            const call: Call = { table, op: 'select', columns, filters: [] };
            calls.push(call);
            const q = {
              eq(column: string, value: unknown) {
                call.filters.push({ kind: 'eq', column, value });
                return q;
              },
              then(resolve: (v: unknown) => unknown) {
                return Promise.resolve(
                  opts.configError
                    ? { data: null, error: opts.configError }
                    : { data: config.filter((r) => matches(r, call.filters)), error: null },
                ).then(resolve);
              },
            };
            return q;
          },
        };
      }
      if (table === 'message_templates') {
        return {
          update(payload: Row) {
            const call: Call = { table, op: 'update', filters: [], payload };
            calls.push(call);
            const q = {
              eq(column: string, value: unknown) {
                call.filters.push({ kind: 'eq', column, value });
                return q;
              },
              in(column: string, value: unknown[]) {
                call.filters.push({ kind: 'in', column, value });
                return q;
              },
              select() {
                if (opts.updateError) {
                  return Promise.resolve({ data: null, error: opts.updateError });
                }
                const hit = templates.filter((r) => matches(r, call.filters));
                hit.forEach((r) => Object.assign(r, payload));
                return Promise.resolve({
                  data: hit.map((r) => ({ id: r.id as string })),
                  error: null,
                });
              },
            };
            return q;
          },
          insert(row: Row) {
            calls.push({ table, op: 'insert', filters: [], payload: row });
            if (opts.insertError) {
              opts.onInsertError?.(templates);
              return Promise.resolve({ error: opts.insertError });
            }
            templates.push({ id: `stub-${templates.length + 1}`, ...row });
            return Promise.resolve({ error: null });
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };

  return { stub: db as unknown as SupabaseClient, calls, templates };
}

const WABA = 'WABA-1';
const cfg = (account_id: string, user_id: string, waba_id = WABA, created_at?: string): Row => ({
  account_id,
  user_id,
  waba_id,
  ...(created_at ? { created_at } : {}),
});
const tmpl = (id: string, account_id: string, meta_template_id: string, extra: Row = {}): Row => ({
  id,
  account_id,
  meta_template_id,
  status: 'PENDING',
  ...extra,
});
const updatesOf = (calls: Call[]) => calls.filter((c) => c.op === 'update');
const insertsOf = (calls: Call[]) => calls.filter((c) => c.op === 'insert');
const quiet = () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
};

function status(value: Row, wabaId: string | undefined = WABA) {
  return { field: 'message_template_status_update', value, wabaId };
}
function quality(value: Row, wabaId: string | undefined = WABA) {
  return { field: 'message_template_quality_update', value, wabaId };
}

describe('isTemplateWebhookField', () => {
  it('recognises the three template fields', () => {
    expect(isTemplateWebhookField('message_template_status_update')).toBe(true);
    expect(isTemplateWebhookField('message_template_quality_update')).toBe(true);
    expect(isTemplateWebhookField('message_template_components_update')).toBe(true);
  });
  it('rejects messaging fields', () => {
    expect(isTemplateWebhookField('messages')).toBe(false);
    expect(isTemplateWebhookField('message_status')).toBe(false);
  });
});

describe('handleTemplateWebhookChange — status update', () => {
  beforeEach(quiet);

  const world = () =>
    makeDb({
      config: [cfg('acc-1', 'u1')],
      templates: [tmpl('t1', 'acc-1', '12345', { rejection_reason: 'old', submission_error: 'old' })],
    });

  it('flips status to APPROVED and clears any rejection_reason', async () => {
    const { stub, calls, templates } = world();
    await handleTemplateWebhookChange(
      status({
        event: 'APPROVED',
        message_template_id: 12345,
        message_template_name: 'order_confirmation',
        message_template_language: 'en_US',
      }),
      stub,
    );
    const [u] = updatesOf(calls);
    expect(u.payload).toEqual({ status: 'APPROVED', rejection_reason: null, submission_error: null });
    // coerced to string so the .eq matches the TEXT column
    expect(u.filters).toContainEqual({ kind: 'eq', column: 'meta_template_id', value: '12345' });
    expect(templates[0]).toMatchObject({ status: 'APPROVED', rejection_reason: null });
  });

  it('persists the reason field on REJECTED', async () => {
    const { stub, calls } = world();
    await handleTemplateWebhookChange(
      status({
        event: 'REJECTED',
        message_template_id: '12345',
        reason: 'Template uses non-compliant language.',
      }),
      stub,
    );
    const [u] = updatesOf(calls);
    expect(u.payload?.status).toBe('REJECTED');
    expect(u.payload?.rejection_reason).toBe('Template uses non-compliant language.');
  });

  it('falls back to a generic reason when REJECTED has no `reason`', async () => {
    const { stub, calls } = world();
    await handleTemplateWebhookChange(
      status({ event: 'REJECTED', message_template_id: '12345' }),
      stub,
    );
    expect(updatesOf(calls)[0].payload?.rejection_reason).toBe('Rejected by Meta');
  });

  it('maps REINSTATED to APPROVED and clears the old rejection', async () => {
    const { stub, calls } = world();
    await handleTemplateWebhookChange(
      status({ event: 'REINSTATED', message_template_id: '12345' }),
      stub,
    );
    expect(updatesOf(calls)[0].payload).toEqual({
      status: 'APPROVED',
      rejection_reason: null,
      submission_error: null,
    });
  });

  it.each(['FLAGGED', 'LIMIT_EXCEEDED', 'LOCKED', 'ARCHIVED', 'SOMETHING_NEW'])(
    'leaves the row untouched on %s, which is not a status we track',
    async (event) => {
      const { stub, calls } = world();
      await handleTemplateWebhookChange(
        status({ event, message_template_id: '12345' }),
        stub,
      );
      expect(calls).toHaveLength(0);
    },
  );

  it('keeps the rejection reason when a template is paused or disabled', async () => {
    for (const event of ['PAUSED', 'DISABLED', 'IN_APPEAL']) {
      const { stub, calls } = world();
      await handleTemplateWebhookChange(
        status({ event, message_template_id: '12345' }),
        stub,
      );
      expect(updatesOf(calls)[0].payload).toEqual({ status: event });
    }
  });

  it('maps DELETED to PENDING_DELETION', async () => {
    const { stub, calls } = world();
    await handleTemplateWebhookChange(
      status({ event: 'DELETED', message_template_id: '12345' }),
      stub,
    );
    expect(updatesOf(calls)[0].payload).toEqual({ status: 'PENDING_DELETION' });
  });

  it('normalises PENDING_REVIEW → PENDING', async () => {
    const { stub, calls } = world();
    await handleTemplateWebhookChange(
      status({ event: 'PENDING_REVIEW', message_template_id: '12345' }),
      stub,
    );
    expect(updatesOf(calls)[0].payload?.status).toBe('PENDING');
  });

  it('logs and exits when meta_template_id is missing (no query issued)', async () => {
    const { stub, calls } = world();
    await handleTemplateWebhookChange(status({ event: 'APPROVED' }), stub);
    expect(calls).toHaveLength(0);
  });

  it('ignores the event, with no database access, when the entry has no WABA id', async () => {
    const warn = vi.spyOn(console, 'warn');
    const { stub, calls, templates } = world();
    await handleTemplateWebhookChange(
      // Built by hand: `status()` would substitute its default WABA for an
      // explicit `undefined`.
      {
        field: 'message_template_status_update',
        value: { event: 'APPROVED', message_template_id: '12345', message_template_name: 'x' },
      },
      stub,
    );
    expect(calls).toHaveLength(0);
    expect(templates[0].status).toBe('PENDING');
    expect(String(warn.mock.calls[0][0])).toContain('no WABA id');
  });
});

describe('handleTemplateWebhookChange — tenant routing (zero / one / many configurations)', () => {
  beforeEach(quiet);
  const EVENT = { event: 'APPROVED', message_template_id: '900', message_template_name: 'promo', message_template_language: 'en_US' };

  it('ZERO configs: no workspace owns the WABA, so no template is touched even if a row has that id', async () => {
    const warn = vi.spyOn(console, 'warn');
    const { stub, calls, templates } = makeDb({
      config: [cfg('acc-other', 'u9', 'WABA-OTHER')],
      templates: [tmpl('t1', 'acc-other', '900')],
    });
    await handleTemplateWebhookChange(status(EVENT, 'WABA-NOBODY'), stub);
    expect(updatesOf(calls)).toHaveLength(0);
    expect(insertsOf(calls)).toHaveLength(0);
    expect(templates[0].status).toBe('PENDING');
    expect(String(warn.mock.calls[0][0])).toContain('no whatsapp_config rows');
  });

  it('ONE config: the event is applied to that workspace, restricted by account_id', async () => {
    const { stub, calls, templates } = makeDb({
      config: [cfg('acc-1', 'u1')],
      templates: [tmpl('t1', 'acc-1', '900')],
    });
    await handleTemplateWebhookChange(status(EVENT), stub);
    const [u] = updatesOf(calls);
    expect(u.filters).toContainEqual({ kind: 'in', column: 'account_id', value: ['acc-1'] });
    expect(templates[0].status).toBe('APPROVED');
  });

  it('SAME workspace, several config rows (several numbers under one WABA): one tenant, not an ambiguity', async () => {
    const { stub, calls, templates } = makeDb({
      config: [
        cfg('acc-1', 'u-late', WABA, '2026-03-01T00:00:00Z'),
        cfg('acc-1', 'u-early', WABA, '2026-01-01T00:00:00Z'),
      ],
      templates: [tmpl('t1', 'acc-1', '900')],
    });
    await handleTemplateWebhookChange(status(EVENT), stub);
    expect(updatesOf(calls)[0].filters).toContainEqual({ kind: 'in', column: 'account_id', value: ['acc-1'] });
    expect(templates[0].status).toBe('APPROVED');
  });

  it('SAME workspace, several rows, unknown template: a stub is created, owned deterministically by the earliest config', async () => {
    const { stub, calls } = makeDb({
      config: [
        cfg('acc-1', 'u-late', WABA, '2026-03-01T00:00:00Z'),
        cfg('acc-1', 'u-early', WABA, '2026-01-01T00:00:00Z'),
      ],
    });
    await handleTemplateWebhookChange(status(EVENT), stub);
    expect(insertsOf(calls)).toHaveLength(1);
    expect(insertsOf(calls)[0].payload).toMatchObject({ account_id: 'acc-1', user_id: 'u-early' });
  });

  it('MANY workspaces claim the WABA: only their rows update; an unrelated workspace with the same meta id is untouched', async () => {
    const { stub, templates } = makeDb({
      config: [cfg('acc-1', 'u1'), cfg('acc-2', 'u2'), cfg('acc-3', 'u3', 'WABA-ELSEWHERE')],
      templates: [
        tmpl('t1', 'acc-1', '900'),
        tmpl('t2', 'acc-2', '900'),
        tmpl('t3', 'acc-3', '900'), // different WABA's workspace, colliding id
        tmpl('t4', 'acc-4', '900'), // workspace with no config at all
      ],
    });
    await handleTemplateWebhookChange(status(EVENT), stub);
    const state = Object.fromEntries(templates.map((t) => [t.id, t.status]));
    expect(state).toEqual({ t1: 'APPROVED', t2: 'APPROVED', t3: 'PENDING', t4: 'PENDING' });
  });

  it('MANY workspaces claim the WABA and the template is unknown: never guesses an owner, creates no stub', async () => {
    const warn = vi.spyOn(console, 'warn');
    const { stub, calls } = makeDb({
      config: [cfg('acc-1', 'u1'), cfg('acc-2', 'u2')],
    });
    await handleTemplateWebhookChange(status(EVENT), stub);
    expect(insertsOf(calls)).toHaveLength(0);
    expect(String(warn.mock.calls[0][0])).toContain('2 workspaces claim that WABA id');
  });

  it('a row in a workspace that owns a DIFFERENT WABA never receives this WABA’s event', async () => {
    const { stub, templates } = makeDb({
      config: [cfg('acc-1', 'u1'), cfg('acc-2', 'u2', 'WABA-2')],
      templates: [tmpl('mine', 'acc-1', '900'), tmpl('theirs', 'acc-2', '900')],
    });
    await handleTemplateWebhookChange(status(EVENT, 'WABA-2'), stub);
    expect(templates.find((t) => t.id === 'mine')?.status).toBe('PENDING');
    expect(templates.find((t) => t.id === 'theirs')?.status).toBe('APPROVED');
  });

  it('quality events are routed by the same rules', async () => {
    const { stub, templates } = makeDb({
      config: [cfg('acc-1', 'u1'), cfg('acc-2', 'u2', 'WABA-2')],
      templates: [tmpl('mine', 'acc-1', '900'), tmpl('theirs', 'acc-2', '900')],
    });
    await handleTemplateWebhookChange(
      quality({ message_template_id: '900', new_quality_score: 'RED' }),
      stub,
    );
    expect(templates.find((t) => t.id === 'mine')?.quality_score).toBe('RED');
    expect(templates.find((t) => t.id === 'theirs')?.quality_score).toBeUndefined();
  });

  it('does nothing when the owner lookup fails', async () => {
    const error = vi.spyOn(console, 'error');
    const { stub, calls } = makeDb(
      { templates: [tmpl('t1', 'acc-1', '900')] },
      { configError: { message: 'db down' } },
    );
    await handleTemplateWebhookChange(status(EVENT), stub);
    expect(updatesOf(calls)).toHaveLength(0);
    expect(String(error.mock.calls[0].join(' '))).toContain('lookup failed');
  });

  it('logs and stops when the scoped UPDATE itself errors (no stub attempted)', async () => {
    const error = vi.spyOn(console, 'error');
    const { stub, calls } = makeDb(
      { config: [cfg('acc-1', 'u1')] },
      { updateError: { message: 'boom' } },
    );
    await handleTemplateWebhookChange(status(EVENT), stub);
    expect(insertsOf(calls)).toHaveLength(0);
    expect(error).toHaveBeenCalled();
  });
});

describe('handleTemplateWebhookChange — unknown template stub (#534)', () => {
  beforeEach(quiet);
  const CONFIG = cfg('acc-1', 'admin-1');

  it('inserts a stub row for a 0-row status update when exactly one workspace owns the WABA', async () => {
    const { stub, calls } = makeDb({ config: [CONFIG] });
    await handleTemplateWebhookChange(
      status({
        event: 'APPROVED',
        message_template_id: 555,
        message_template_name: 'created_in_meta',
        message_template_language: 'de',
      }),
      stub,
    );

    expect(calls.map((c) => `${c.table}:${c.op}`)).toEqual([
      'whatsapp_config:select', // resolve the owning workspace
      'message_templates:update', // the scoped UPDATE (0 rows)
      'message_templates:insert', // the stub INSERT
    ]);
    expect(calls[0].columns).toBe('account_id, user_id, created_at');
    expect(calls[0].filters).toEqual([{ kind: 'eq', column: 'waba_id', value: WABA }]);
    expect(insertsOf(calls)[0].payload).toEqual({
      account_id: 'acc-1',
      user_id: 'admin-1',
      meta_template_id: '555',
      name: 'created_in_meta',
      language: 'de',
      body_text: '',
      status: 'APPROVED',
      rejection_reason: null,
      submission_error: null,
    });
  });

  it('carries the rejection reason into the stub on REJECTED and defaults language to en_US', async () => {
    const { stub, calls } = makeDb({ config: [CONFIG] });
    await handleTemplateWebhookChange(
      status({
        event: 'REJECTED',
        message_template_id: '556',
        message_template_name: 'spammy',
        reason: 'INVALID_FORMAT',
      }),
      stub,
    );
    expect(insertsOf(calls)[0].payload).toMatchObject({
      status: 'REJECTED',
      rejection_reason: 'INVALID_FORMAT',
      language: 'en_US',
    });
  });

  it('warns with the WABA id and does nothing when no workspace owns it', async () => {
    const warn = vi.spyOn(console, 'warn');
    const { stub, calls } = makeDb({ config: [] });
    await handleTemplateWebhookChange(
      status(
        { event: 'APPROVED', message_template_id: '557', message_template_name: 'orphan' },
        'WABA-NOBODY',
      ),
      stub,
    );
    expect(calls.map((c) => c.op)).toEqual(['select']); // owner lookup only
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain('WABA WABA-NOBODY');
    expect(message).toContain('557');
    expect(message).toContain('no whatsapp_config rows');
  });

  it('refuses to guess the tenant when different workspaces share the WABA id', async () => {
    const warn = vi.spyOn(console, 'warn');
    const { stub, calls } = makeDb({ config: [CONFIG, cfg('acc-2', 'admin-2')] });
    await handleTemplateWebhookChange(
      status({ event: 'APPROVED', message_template_id: '558', message_template_name: 'shared' }),
      stub,
    );
    expect(insertsOf(calls)).toHaveLength(0);
    expect(String(warn.mock.calls[0][0])).toContain('2 workspaces claim that WABA id');
  });

  it('inserts a stub with quality_score (and no status) for a 0-row quality update', async () => {
    const warn = vi.spyOn(console, 'warn');
    const { stub, calls } = makeDb({ config: [CONFIG] });
    await handleTemplateWebhookChange(
      quality({
        message_template_id: '559',
        message_template_name: 'created_in_meta',
        message_template_language: 'en_US',
        previous_quality_score: 'UNKNOWN',
        new_quality_score: 'RED',
      }),
      stub,
    );
    expect(updatesOf(calls)[0].payload).toEqual({ quality_score: 'RED' });
    expect(insertsOf(calls)[0].payload).toEqual({
      account_id: 'acc-1',
      user_id: 'admin-1',
      meta_template_id: '559',
      name: 'created_in_meta',
      language: 'en_US',
      body_text: '',
      quality_score: 'RED',
    });
    // `status` is deliberately absent — the column default applies.
    expect(insertsOf(calls)[0].payload).not.toHaveProperty('status');
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns (with the WABA id) on a 0-row quality update when no workspace owns the WABA', async () => {
    const warn = vi.spyOn(console, 'warn');
    const { stub, calls } = makeDb({ config: [] });
    await handleTemplateWebhookChange(
      quality(
        { message_template_id: '560', message_template_name: 'orphan', new_quality_score: 'GREEN' },
        'WABA-NOBODY',
      ),
      stub,
    );
    expect(insertsOf(calls)).toHaveLength(0);
    expect(String(warn.mock.calls[0][0])).toContain('quality update');
    expect(String(warn.mock.calls[0][0])).toContain('WABA WABA-NOBODY');
  });

  it('retries the (still tenant-scoped) update once when the stub insert hits a unique violation', async () => {
    const warn = vi.spyOn(console, 'warn');
    const { stub, calls, templates } = makeDb(
      { config: [CONFIG] },
      {
        insertError: { message: 'duplicate key', code: '23505' },
        // The racing writer's row lands between our UPDATE and INSERT.
        onInsertError: (rows) => rows.push(tmpl('row-raced', 'acc-1', '561')),
      },
    );
    await handleTemplateWebhookChange(
      status({ event: 'PAUSED', message_template_id: '561', message_template_name: 'raced' }),
      stub,
    );
    const updates = updatesOf(calls);
    expect(updates).toHaveLength(2);
    expect(updates[1].payload).toEqual(updates[0].payload);
    expect(updates[1].filters).toEqual(updates[0].filters);
    expect(updates[1].filters).toContainEqual({ kind: 'in', column: 'account_id', value: ['acc-1'] });
    expect(templates.find((t) => t.id === 'row-raced')?.status).toBe('PAUSED');
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not create a stub when the event has no template name', async () => {
    const warn = vi.spyOn(console, 'warn');
    const { stub, calls } = makeDb({ config: [CONFIG] });
    await handleTemplateWebhookChange(
      status({ event: 'APPROVED', message_template_id: '562' }),
      stub,
    );
    expect(insertsOf(calls)).toHaveLength(0);
    expect(String(warn.mock.calls[0][0])).toContain('no message_template_name');
  });
});

describe('handleTemplateWebhookChange — quality update', () => {
  beforeEach(quiet);
  const world = () => makeDb({ config: [cfg('acc-1', 'u1')], templates: [tmpl('t1', 'acc-1', '99')] });

  it('sets quality_score from new_quality_score', async () => {
    const { stub, calls, templates } = world();
    await handleTemplateWebhookChange(
      quality({ message_template_id: '99', previous_quality_score: 'GREEN', new_quality_score: 'YELLOW' }),
      stub,
    );
    expect(updatesOf(calls)[0].payload).toEqual({ quality_score: 'YELLOW' });
    expect(updatesOf(calls)[0].filters).toContainEqual({
      kind: 'eq',
      column: 'meta_template_id',
      value: '99',
    });
    expect(templates[0].quality_score).toBe('YELLOW');
  });

  it('stores null for unrecognised quality scores', async () => {
    const { stub, calls } = world();
    await handleTemplateWebhookChange(
      quality({ message_template_id: '99', new_quality_score: 'PURPLE' }), // not a real Meta value
      stub,
    );
    expect(updatesOf(calls)[0].payload).toEqual({ quality_score: null });
  });
});

describe('handleTemplateWebhookChange — components update', () => {
  it('is an info-log no-op (does not write to DB)', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { stub, calls } = makeDb();
    await handleTemplateWebhookChange(
      {
        field: 'message_template_components_update',
        value: { message_template_id: '5', message_template_name: 'x' },
      },
      stub,
    );
    expect(calls).toHaveLength(0);
    expect(info).toHaveBeenCalled();
  });
});

describe('handleTemplateWebhookChange — unknown field', () => {
  it('is a defensive no-op', async () => {
    const { stub, calls } = makeDb();
    await handleTemplateWebhookChange(
      // Pretend Meta added a new template_* field we don't know about.
      // The route handler pre-filters via isTemplateWebhookField, but
      // the dispatch should still be safe if the filter is bypassed.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { field: 'message_template_future_field' as any, value: {} },
      stub,
    );
    expect(calls).toHaveLength(0);
  });
});
