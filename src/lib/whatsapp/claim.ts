import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Is this `phone_number_id` already claimed by a DIFFERENT account?
 *
 * Extracted unchanged from POST /api/whatsapp/config so the manual connect and
 * the Embedded Signup flow share one rule (docs/architecture/09, slice S1).
 * wacrm is single-tenant-per-WhatsApp-number: letting two accounts bind the
 * same number makes the webhook's `.single()` lookup throw PGRST116 and drop
 * every inbound message (issue #136). The conflict is between accounts, not
 * users — teammates in one account share one config.
 *
 * `admin` MUST be a service-role client: under RLS a session can't see other
 * accounts' rows, so the conflict would be invisible. Never pass a user client.
 */
export async function findPhoneClaimByOtherAccount(args: {
  admin: Pick<SupabaseClient, 'from'>
  phoneNumberId: string
  accountId: string
}): Promise<{ claimed: boolean; error: unknown }> {
  const { admin, phoneNumberId, accountId } = args
  const { data, error } = await admin
    .from('whatsapp_config')
    .select('account_id')
    .eq('phone_number_id', phoneNumberId)
    .neq('account_id', accountId)
    .maybeSingle()
  if (error) return { claimed: false, error }
  return { claimed: Boolean(data), error: null }
}
