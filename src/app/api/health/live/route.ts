/**
 * Liveness: the process is up and serving. No dependencies on purpose —
 * a database outage must not make the orchestrator restart a healthy app.
 */
export const dynamic = 'force-dynamic'

export function GET() {
  return Response.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store' } })
}
