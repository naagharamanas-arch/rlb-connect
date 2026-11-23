/**
 * Runtime environment validation.
 *
 * Pure function: takes an env map, returns problems. Messages name the
 * variable and the rule only — never the value — so a failed start can't
 * leak a secret into logs. `.env.local.example` stays the source of truth
 * for what each variable means.
 */
export type EnvProblem = { name: string; problem: string }

const REQUIRED = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'ENCRYPTION_KEY',
  'META_APP_SECRET',
] as const

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

export function validateEnv(
  env: Record<string, string | undefined>,
): EnvProblem[] {
  const problems: EnvProblem[] = []

  for (const name of REQUIRED) {
    if (!env[name]?.trim()) problems.push({ name, problem: 'is required' })
  }

  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  if (url && !isHttpUrl(url)) {
    problems.push({ name: 'NEXT_PUBLIC_SUPABASE_URL', problem: 'must be an http(s) URL' })
  }

  const site = env.NEXT_PUBLIC_SITE_URL?.trim()
  if (site && (!isHttpUrl(site) || site.endsWith('/'))) {
    problems.push({
      name: 'NEXT_PUBLIC_SITE_URL',
      problem: 'must be an http(s) URL with no trailing slash',
    })
  }

  const key = env.ENCRYPTION_KEY?.trim()
  if (key && !/^[0-9a-fA-F]{64}$/.test(key)) {
    problems.push({ name: 'ENCRYPTION_KEY', problem: 'must be 64 hex characters' })
  }

  const cron = env.AUTOMATION_CRON_SECRET
  if (cron !== undefined && cron.trim().length > 0 && cron.length < 16) {
    problems.push({ name: 'AUTOMATION_CRON_SECRET', problem: 'must be at least 16 characters' })
  }

  return problems
}

/** Throws one error listing every problem; called once at server start. */
export function assertEnv(env: Record<string, string | undefined>): void {
  const problems = validateEnv(env)
  if (problems.length === 0) return
  const lines = problems.map((p) => `  - ${p.name} ${p.problem}`).join('\n')
  throw new Error(`Invalid environment configuration:\n${lines}`)
}
