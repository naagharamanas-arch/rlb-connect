-- ============================================================
-- 070_whatsapp_signup_sessions.sql — Embedded Signup S1 (PROPOSAL, FILE ONLY)
--
-- STATUS: NOT APPLIED ANYWHERE. Do not run `supabase db push` / `db reset`
-- against any hosted project from this file. Staging-first, explicit owner
-- approval required (docs/architecture/09-es-coexistence-build-plan.md §3 S1).
--
-- One row per Embedded Signup attempt: a single-use, short-lived (10 min)
-- server-side session bound to the account and user that STARTED it. `finish`
-- loads the row by state_hash and re-verifies that the same user is still an
-- admin of THAT account; the request body never carries an account id.
--
--   state_hash  SHA-256 (hex) of the opaque `state` handed to the browser. The
--               raw state is never stored. The column is withheld from
--               `authenticated` (column grants below), so a browser can never
--               read it — it is only ever matched server-side (service role).
--   status      pending → exchanging → connected | needs_attention | failed
--   completed_steps  step names only, never payloads, tokens or codes.
--
-- Access model (same shape as 067 / 063):
--   * RLS on; members of the account may SELECT their own account's rows,
--     minus state_hash. No INSERT/UPDATE/DELETE policy and no write grant for
--     `authenticated`: the server writes with the service role.
--   * Nothing for `anon`.
--
-- Holds no business data. Rollback: DROP TABLE public.whatsapp_signup_sessions;
-- (nothing else references it).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.whatsapp_signup_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  state_hash       text NOT NULL UNIQUE,
  mode             text NOT NULL DEFAULT 'new_number'
                     CHECK (mode IN ('new_number', 'coexistence')),
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'exchanging', 'connected', 'needs_attention', 'failed')),
  completed_steps  jsonb NOT NULL DEFAULT '[]'::jsonb,
  consent_at       timestamptz,
  expires_at       timestamptz NOT NULL,
  used_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_signup_sessions_account
  ON public.whatsapp_signup_sessions (account_id, created_at DESC);

ALTER TABLE public.whatsapp_signup_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_signup_sessions_select ON public.whatsapp_signup_sessions;
CREATE POLICY whatsapp_signup_sessions_select ON public.whatsapp_signup_sessions
  FOR SELECT USING (public.is_account_member(account_id, 'viewer'));

-- Least-privilege grants (see 061/063): explicit, column-level for the browser
-- role so state_hash is never readable; no write grant for `authenticated`.
REVOKE ALL ON public.whatsapp_signup_sessions FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, account_id, user_id, mode, status, completed_steps, consent_at, expires_at, used_at, created_at)
  ON public.whatsapp_signup_sessions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_signup_sessions TO service_role;
