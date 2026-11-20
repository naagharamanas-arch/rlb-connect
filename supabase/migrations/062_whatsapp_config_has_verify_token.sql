-- 062_whatsapp_config_has_verify_token — a non-secret "is a verify token stored"
-- flag, so the settings form can show its masked placeholder without reading
-- the verify_token column (which migration 063 makes unreadable to members).
--
-- Additive ("expand" step, ADR A11): a generated column, so nothing can write
-- it and it can never drift from verify_token. Safe to apply before the app
-- change; the app only starts selecting it afterwards.
--
-- ROLLBACK: ALTER TABLE public.whatsapp_config DROP COLUMN has_verify_token;
ALTER TABLE public.whatsapp_config
  ADD COLUMN IF NOT EXISTS has_verify_token boolean
  GENERATED ALWAYS AS (verify_token IS NOT NULL) STORED;
