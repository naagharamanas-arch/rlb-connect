/* eslint-disable @typescript-eslint/no-require-imports -- a CommonJS preload (node --require): it must run before Next.js starts and cannot be an ES module */
// Preloaded into the APP server process (NODE_OPTIONS=--require …/meta-stub.cjs) by the
// full-stack job, BEFORE Next.js starts, so Next captures this function as its
// underlying fetch.
//
// Purpose: the authorization suites exercise send / template / health routes whose
// handlers call the Meta Graph API. Tests must never reach the real Meta API (or any
// other external host). This stub
//   * answers graph.facebook.com requests with canned responses, and records each one
//     (method, URL, parsed body, whether a bearer token was present) as a JSON line in
//     $FS_META_LOG so tests can assert exactly what an account tried to send;
//   * lets requests to the local stack (127.0.0.1 / localhost) through untouched;
//   * REFUSES every other host (throws), so a stray external call fails loudly.
const fs = require('node:fs')

const LOG = process.env.FS_META_LOG
const realFetch = globalThis.fetch.bind(globalThis)
let counter = 0

function record(entry) {
  if (!LOG) return
  try { fs.appendFileSync(LOG, JSON.stringify(entry) + '\n') } catch { /* best effort */ }
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

globalThis.fetch = async function stubbedFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  let host = ''
  try { host = new URL(url).hostname } catch { /* relative or invalid: let it fail naturally */ }

  if (host === '127.0.0.1' || host === 'localhost' || host === '') return realFetch(input, init)

  if (host === 'graph.facebook.com') {
    let body = null
    try { body = init.body ? JSON.parse(String(init.body)) : null } catch { body = String(init.body).slice(0, 200) }
    const headers = new Headers(init.headers || {})
    record({
      kind: 'meta',
      method: (init.method || 'GET').toUpperCase(),
      url,
      body,
      hasBearer: /^Bearer\s+\S+/.test(headers.get('authorization') || ''),
    })
    // Message sends succeed with a fake id; everything else is a clean, documented refusal.
    if ((init.method || 'GET').toUpperCase() === 'POST' && /\/messages(\?|$)/.test(url)) {
      counter += 1
      return json(200, { messaging_product: 'whatsapp', contacts: [{ input: 'x', wa_id: 'x' }], messages: [{ id: `wamid.FSSTUB${counter}` }] })
    }
    return json(400, { error: { message: 'full-stack test stub: Meta API is not reachable from tests', type: 'OAuthException', code: 100 } })
  }

  record({ kind: 'blocked', url })
  throw new Error(`full-stack test stub: outbound request to ${host} is blocked`)
}
