// Private Storage (chat-media, flow-media): signed URLs, cross-tenant rejection and
// expiry, through the real Storage API and the app's /api/media route.
import assert from 'node:assert/strict'
import { describe, it, before } from 'node:test'
import { randomUUID } from 'node:crypto'

import { E, anonClient, assertEphemeral, call, loadWorld, sleep, userClient } from './lib.mjs'

assertEphemeral()
const world = loadWorld()

// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const as = (p) => userClient(world.users[p].session.access_token)
const folderA = `account-${world.accounts.a}`
const folderB = `account-${world.accounts.b}`
const publicUrl = (bucket, path) => `${E.api}/storage/v1/object/public/${bucket}/${path}`

async function upload(client, bucket, path) {
  return client.storage.from(bucket).upload(path, PNG, { contentType: 'image/png', upsert: false })
}

const objects = {}
before(async () => {
  for (const bucket of ['chat-media', 'flow-media']) {
    const path = `${folderA}/${randomUUID().replace(/-/g, '')}-photo.png`
    const { error } = await upload(as('owner'), bucket, path)
    assert.equal(error, null, `positive control: tenant A owner uploads to ${bucket}: ${error?.message}`)
    objects[bucket] = path
  }
})

describe('the buckets are private', () => {
  for (const bucket of ['chat-media', 'flow-media']) {
    it(`${bucket}: the public object URL does not serve the file`, async () => {
      const res = await fetch(publicUrl(bucket, objects[bucket]))
      assert.notEqual(res.status, 200, 'a public URL served a private object')
    })
  }

  it('avatars stay public by design (positive control for the check above)', async () => {
    const path = `${world.users.owner.id}/avatar-${randomUUID()}.png`
    const { error } = await upload(as('owner'), 'avatars', path)
    assert.equal(error, null, error?.message)
    const res = await fetch(publicUrl('avatars', path))
    assert.equal(res.status, 200)
  })
})

describe('signed URLs', () => {
  for (const bucket of ['chat-media', 'flow-media']) {
    it(`${bucket}: a member gets a working signed URL`, async () => {
      for (const p of ['owner', 'viewer']) {
        const { data, error } = await as(p).storage.from(bucket).createSignedUrl(objects[bucket], 60)
        assert.equal(error, null, `${p}: ${error?.message}`)
        const res = await fetch(data.signedUrl)
        assert.equal(res.status, 200, `${p} signed URL -> ${res.status}`)
        assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG)
      }
    })

    it(`${bucket}: another tenant and anon cannot obtain one`, async () => {
      for (const [who, client] of [['tenant B owner', as('otherOwner')], ['anon', anonClient()]]) {
        const { data, error } = await client.storage.from(bucket).createSignedUrl(objects[bucket], 60)
        assert.ok(error || !data?.signedUrl, `${who} got a signed URL for tenant A's object`)
      }
    })

    it(`${bucket}: another tenant and anon cannot download, list, overwrite, delete or plant`, async () => {
      for (const [who, client] of [['tenant B owner', as('otherOwner')], ['anon', anonClient()]]) {
        const dl = await client.storage.from(bucket).download(objects[bucket])
        assert.ok(dl.error && !dl.data, `${who} downloaded tenant A's object`)
        const ls = await client.storage.from(bucket).list(folderA)
        assert.deepEqual(ls.data ?? [], [], `${who} listed tenant A's folder`)
        const up = await upload(client, bucket, `${folderA}/${randomUUID()}-planted.png`)
        assert.ok(up.error, `${who} planted a file in tenant A's folder`)
        const over = await client.storage.from(bucket).upload(objects[bucket], PNG, { upsert: true, contentType: 'image/png' })
        assert.ok(over.error, `${who} overwrote tenant A's object`)
        await client.storage.from(bucket).remove([objects[bucket]])
      }
      const still = await as('owner').storage.from(bucket).download(objects[bucket])
      assert.equal(still.error, null, "tenant A's object disappeared")
    })

    it(`${bucket}: a viewer can read but not write or delete`, async () => {
      const up = await upload(as('viewer'), bucket, `${folderA}/${randomUUID()}-viewer.png`)
      assert.ok(up.error, 'a viewer uploaded')
      await as('viewer').storage.from(bucket).remove([objects[bucket]])
      assert.equal((await as('owner').storage.from(bucket).download(objects[bucket])).error, null, 'a viewer deleted an object')
    })

    it(`${bucket}: an agent can upload into the account folder (positive control)`, async () => {
      const { error } = await upload(as('agent'), bucket, `${folderA}/${randomUUID()}-agent.png`)
      assert.equal(error, null, error?.message)
    })
  }

  it('a signed URL expires', async () => {
    const { data, error } = await as('owner').storage.from('chat-media').createSignedUrl(objects['chat-media'], 2)
    assert.equal(error, null)
    assert.equal((await fetch(data.signedUrl)).status, 200, 'positive control: fresh URL works')
    await sleep(4500)
    assert.notEqual((await fetch(data.signedUrl)).status, 200, 'an expired signed URL still served the object')
  })

  it('a tampered signed URL is refused', async () => {
    const { data } = await as('owner').storage.from('chat-media').createSignedUrl(objects['chat-media'], 60)
    const url = new URL(data.signedUrl)
    const token = url.searchParams.get('token')
    url.searchParams.set('token', token.slice(0, -3) + (token.endsWith('aaa') ? 'bbb' : 'aaa'))
    assert.notEqual((await fetch(url)).status, 200)
  })

  it("a signed URL for one object does not serve another", async () => {
    const { data } = await as('owner').storage.from('chat-media').createSignedUrl(objects['chat-media'], 60)
    const other = data.signedUrl.replace(encodeURIComponent(objects['chat-media']).replace(/%2F/g, '/'), `${folderB}/anything.png`)
    assert.notEqual((await fetch(other)).status, 200)
  })
})

describe('the app media route /api/media/<bucket>/<path>', () => {
  const route = (bucket, path) => `/api/media/${bucket}/${path}`

  for (const bucket of ['chat-media', 'flow-media']) {
    it(`${bucket}: members are redirected to a signed URL that serves the file`, async () => {
      for (const principal of ['viewer', 'agent', 'admin', 'owner']) {
        const r = await call({ world, principal, path: route(bucket, objects[bucket]) })
        assert.equal(r.status, 302, `${principal} -> ${r.status}`)
        assert.match(r.location, /\/storage\/v1\/object\/sign\//)
        const file = await fetch(r.location)
        assert.equal(file.status, 200)
        assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG)
      }
    })

    it(`${bucket}: tenant B and anon are refused and get no location`, async () => {
      const b = await call({ world, principal: 'otherOwner', path: route(bucket, objects[bucket]) })
      assert.equal(b.status, 404)
      assert.equal(b.location, null)
      const a = await call({ world, principal: 'anon', path: route(bucket, objects[bucket]) })
      assert.ok(a.status === 401 || a.status === 403, `anon -> ${a.status}`)
      assert.equal(a.location, null)
      const key = await call({ world, principal: 'apiKey', path: route(bucket, objects[bucket]) })
      assert.ok(key.status === 401 || key.status === 403, `API key -> ${key.status}`)
    })
  }

  it("tenant B cannot reach tenant A's folder by naming its own account or by traversal", async () => {
    const name = objects['chat-media'].split('/')[1]
    const attempts = [
      route('chat-media', `${folderB}/../${folderA}/${name}`),
      route('chat-media', `${folderB}/%2e%2e/${folderA}/${name}`),
      route('chat-media', `${folderB}/${encodeURIComponent('../' + folderA + '/' + name)}`),
      route('chat-media', `${folderA}//${name}`), // Next.js collapses this with a 308 (see below)
    ]
    for (const path of attempts) {
      const final = await followNormalisation('otherOwner', path)
      assert.ok(final.status === 404 || final.status === 400, `${path} ended at ${final.status}: ${final.text.slice(0, 120)}`)
      assert.equal(final.location, null, `${path} produced a redirect to a signed URL`)
      assert.ok(!/\/storage\/v1\/|token=/.test(final.text), `${path} exposed a storage URL`)
    }
  })

  // Next.js collapses `//` in a request path with a 308 to the clean same-origin path
  // BEFORE any route handler (or authentication) runs, so the redirect is identical for every
  // caller. The security property is therefore (1) the redirect itself exposes nothing — a
  // same-origin path, no signed URL, no token — and (2) where it ENDS: the clean path is
  // authorised like any other request.
  async function followNormalisation(principal, path) {
    let r = await call({ world, principal, path })
    for (let hop = 0; r.status === 308 && hop < 2; hop += 1) {
      assert.ok(r.location, `308 without a Location for ${path}`)
      assert.ok(r.location.startsWith('/api/media/'), `308 Location is not the same-origin media path: ${r.location}`)
      assert.ok(!/\/storage\/v1\/|token=|:\/\//.test(r.location), `308 Location exposes a storage URL: ${r.location}`)
      assert.ok(!/\/\//.test(r.location), `308 Location still has a double slash: ${r.location}`)
      assert.ok(!/\/storage\/v1\/|token=/.test(r.text), '308 body exposes a storage URL')
      r = await call({ world, principal, path: r.location })
    }
    return r
  }

  it('the double-slash normalisation redirect is the same for every caller and exposes nothing', async () => {
    const name = objects['chat-media'].split('/')[1]
    const path = route('chat-media', `${folderA}//${name}`)
    const seen = []
    for (const principal of ['anon', 'otherOwner', 'viewer', 'owner']) {
      const r = await call({ world, principal, path })
      assert.equal(r.status, 308, `${principal} -> ${r.status}`)
      seen.push(r.location)
      assert.ok(!/\/storage\/v1\/|token=/.test(`${r.location}${r.text}`), `${principal}: the redirect exposes a storage URL`)
    }
    assert.equal(new Set(seen).size, 1, 'the normalisation redirect must not depend on who asks')
  })

  it('positive control: after normalisation the owner reaches the object, B gets 404, anon gets 401', async () => {
    const name = objects['chat-media'].split('/')[1]
    const path = route('chat-media', `${folderA}//${name}`)
    const owner = await followNormalisation('owner', path)
    assert.equal(owner.status, 302)
    assert.match(owner.location, /\/storage\/v1\/object\/sign\//)
    assert.equal((await followNormalisation('otherOwner', path)).status, 404)
    assert.equal((await followNormalisation('anon', path)).status, 401)
  })

  it('unknown buckets and the public avatars bucket are not served through the route', async () => {
    for (const bucket of ['avatars', 'nope']) {
      const r = await call({ world, principal: 'owner', path: route(bucket, `${folderA}/x.png`) })
      assert.equal(r.status, 404)
    }
  })
})
