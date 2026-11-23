/**
 * Runs once when the server starts (before it accepts requests). In
 * production a bad configuration stops the process with a clear list of
 * the offending variable names, instead of failing on the first request.
 * Not invoked during `next build`, so CI builds are unaffected.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  if (process.env.NODE_ENV !== 'production') return
  const { assertEnv } = await import('@/lib/env/validate')
  assertEnv(process.env)
}
