import { validateEnv } from '@/lib/env/validate'

/**
 * Readiness: configuration is valid and Supabase answers. The body only
 * ever carries variable *names* and a pass/fail — never values.
 */
export const dynamic = 'force-dynamic'

const HEADERS = { 'Cache-Control': 'no-store' }

export async function GET() {
  const problems = validateEnv(process.env)
  if (problems.length > 0) {
    return Response.json(
      { status: 'unready', config: problems.map((p) => p.name) },
      { status: 503, headers: HEADERS },
    )
  }

  try {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/health`,
      {
        headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY! },
        signal: AbortSignal.timeout(3000),
        cache: 'no-store',
      },
    )
    if (!res.ok) throw new Error('supabase unhealthy')
  } catch {
    return Response.json(
      { status: 'unready', supabase: 'unreachable' },
      { status: 503, headers: HEADERS },
    )
  }

  return Response.json({ status: 'ready' }, { headers: HEADERS })
}
