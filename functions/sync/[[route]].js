/**
 * Ultimate Sync API — Cloudflare Pages Function
 * Multi-tenant, auth-protected sync for thousands of organizations.
 *
 * Auth: Every request (except /sync/register, /sync/health) must include:
 *   x-org-id: <orgId>
 *   x-secret-key: <secretKey>
 *
 * KV key structure (per-org isolation):
 *   org:{orgId}:songLibrary    → { [id]: song }
 *   org:{orgId}:people         → [person]
 *   org:{orgId}:services       → [service]
 *   org:{orgId}:plans          → { [serviceId]: plan }
 *   org:{orgId}:vocalAssignments → { [serviceId]: assignments }
 *   org:{orgId}:blockouts      → [blockout]
 *   org:{orgId}:meta           → { orgId, name, createdAt }
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-org-id, x-secret-key',
};

// ── Helpers ────────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function makeId(len = 24) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  for (const b of bytes) id += chars[b % chars.length];
  return id;
}

async function kvGet(env, key, fallback) {
  const raw = await env.STORE.get(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

async function kvPut(env, key, value) {
  await env.STORE.put(key, JSON.stringify(value));
}

function orgKey(orgId, type) {
  return `org:${orgId}:${type}`;
}

// ── Auth ───────────────────────────────────────────────────────────────────

async function verifyAuth(env, request) {
  const orgId = request.headers.get('x-org-id') || '';
  const secret = request.headers.get('x-secret-key') || '';
  if (!orgId || !secret) return null;

  const org = await kvGet(env, `org:${orgId}`, null);
  if (!org) return null;

  const hash = await sha256(secret);
  if (hash !== org.secretKeyHash) return null;
  return org;
}

// ── Main Handler ───────────────────────────────────────────────────────────

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const route = url.pathname.replace(/^\/sync\/?/, '').replace(/\/$/, '');
  const method = request.method;

  // CORS preflight
  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // ── Public: GET /sync/health ─────────────────────────────────────────────
  if (route === 'health' && method === 'GET') {
    return json({ ok: true, ts: new Date().toISOString() });
  }

  // ── Public: POST /sync/register — create a new organization ─────────────
  if (route === 'register' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const { name = 'My Organization' } = body;

    const orgId = makeId(16);
    const secretKey = makeId(32);
    const secretKeyHash = await sha256(secretKey);

    const org = {
      orgId,
      name,
      secretKeyHash,
      createdAt: new Date().toISOString(),
    };

    await kvPut(env, `org:${orgId}`, org);

    // Return secret key ONCE — never stored in plain text
    return json({ ok: true, orgId, secretKey, name });
  }

  // ── All routes below require auth ────────────────────────────────────────
  const org = await verifyAuth(env, request);
  if (!org) {
    return json({ error: 'Unauthorized. Include x-org-id and x-secret-key headers.' }, 401);
  }
  const { orgId } = org;

  // ── GET /sync/debug ──────────────────────────────────────────────────────
  if (route === 'debug' && method === 'GET') {
    const [songMap, people, services, plans, blockouts] = await Promise.all([
      kvGet(env, orgKey(orgId, 'songLibrary'), {}),
      kvGet(env, orgKey(orgId, 'people'), []),
      kvGet(env, orgKey(orgId, 'services'), []),
      kvGet(env, orgKey(orgId, 'plans'), {}),
      kvGet(env, orgKey(orgId, 'blockouts'), []),
    ]);
    return json({
      org: org.name,
      orgId,
      songs: Object.keys(songMap).length,
      people: people.length,
      services: services.length,
      plans: Object.keys(plans).length,
      blockouts: blockouts.length,
      ts: new Date().toISOString(),
    });
  }

  // ── GET /sync/library-pull ───────────────────────────────────────────────
  if (route === 'library-pull' && method === 'GET') {
    const [songMap, people, services, plans, vocalAssignments, blockouts] =
      await Promise.all([
        kvGet(env, orgKey(orgId, 'songLibrary'), {}),
        kvGet(env, orgKey(orgId, 'people'), []),
        kvGet(env, orgKey(orgId, 'services'), []),
        kvGet(env, orgKey(orgId, 'plans'), {}),
        kvGet(env, orgKey(orgId, 'vocalAssignments'), {}),
        kvGet(env, orgKey(orgId, 'blockouts'), []),
      ]);
    return json({
      songs: Object.values(songMap),
      people,
      services,
      plans,
      vocalAssignments,
      blockouts,
    });
  }

  // ── POST /sync/library-push ──────────────────────────────────────────────
  if (route === 'library-push' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const {
      songs = [], people = [], services = [],
      plans = {}, vocalAssignments = {}, blockouts = [],
    } = body;

    const [songMap, existingPeople, existingServices, existingPlans, existingVocals, existingBlockouts] =
      await Promise.all([
        kvGet(env, orgKey(orgId, 'songLibrary'), {}),
        kvGet(env, orgKey(orgId, 'people'), []),
        kvGet(env, orgKey(orgId, 'services'), []),
        kvGet(env, orgKey(orgId, 'plans'), {}),
        kvGet(env, orgKey(orgId, 'vocalAssignments'), {}),
        kvGet(env, orgKey(orgId, 'blockouts'), []),
      ]);

    // Merge songs
    for (const s of songs) {
      if (s?.id) songMap[s.id] = { ...(songMap[s.id] || {}), ...s };
    }

    // Merge people
    const peopleMap = Object.fromEntries(existingPeople.map(p => [p.id, p]));
    for (const p of people) {
      if (p?.id) peopleMap[p.id] = { ...(peopleMap[p.id] || {}), ...p };
    }

    // Merge services
    const servicesMap = Object.fromEntries(existingServices.map(s => [s.id, s]));
    for (const s of services) {
      if (s?.id) servicesMap[s.id] = { ...(servicesMap[s.id] || {}), ...s };
    }

    // Merge plans
    const mergedPlans = { ...existingPlans, ...plans };

    // Merge vocal assignments
    const mergedVocals = { ...existingVocals, ...vocalAssignments };

    // Merge blockouts (deduplicate by email+date)
    const seen = new Set(existingBlockouts.map(b => `${b.email}|${b.date}`));
    const mergedBlockouts = [...existingBlockouts];
    for (const b of blockouts) {
      if (b?.email && b?.date && !seen.has(`${b.email}|${b.date}`)) {
        mergedBlockouts.push(b);
        seen.add(`${b.email}|${b.date}`);
      }
    }

    await Promise.all([
      kvPut(env, orgKey(orgId, 'songLibrary'), songMap),
      kvPut(env, orgKey(orgId, 'people'), Object.values(peopleMap)),
      kvPut(env, orgKey(orgId, 'services'), Object.values(servicesMap)),
      kvPut(env, orgKey(orgId, 'plans'), mergedPlans),
      kvPut(env, orgKey(orgId, 'vocalAssignments'), mergedVocals),
      kvPut(env, orgKey(orgId, 'blockouts'), mergedBlockouts),
    ]);

    return json({
      ok: true,
      songs: Object.keys(songMap).length,
      people: Object.values(peopleMap).length,
      services: Object.values(servicesMap).length,
      plans: Object.keys(mergedPlans).length,
    });
  }

  // ── POST /sync/publish ───────────────────────────────────────────────────
  if (route === 'publish' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const { serviceId, plan, vocalAssignments } = body;
    if (!serviceId) return json({ error: 'serviceId required' }, 400);

    const services = await kvGet(env, orgKey(orgId, 'services'), []);
    const svcIdx = services.findIndex(s => s.id === serviceId);
    const updated = svcIdx >= 0 ? { ...services[svcIdx] } : { id: serviceId };
    updated.plan = plan;
    updated.publishedAt = new Date().toISOString();
    const newServices = services.filter(s => s.id !== serviceId);
    newServices.push(updated);

    const plans = await kvGet(env, orgKey(orgId, 'plans'), {});
    plans[serviceId] = { ...(plans[serviceId] || {}), ...plan, serviceId };

    const writes = [
      kvPut(env, orgKey(orgId, 'services'), newServices),
      kvPut(env, orgKey(orgId, 'plans'), plans),
    ];
    if (vocalAssignments) {
      const vocals = await kvGet(env, orgKey(orgId, 'vocalAssignments'), {});
      vocals[serviceId] = vocalAssignments;
      writes.push(kvPut(env, orgKey(orgId, 'vocalAssignments'), vocals));
    }
    await Promise.all(writes);
    return json({ ok: true, serviceId });
  }

  // ── GET /sync/assignments ────────────────────────────────────────────────
  if (route === 'assignments' && method === 'GET') {
    const serviceIdParam = url.searchParams.get('serviceId');
    const emailParam     = (url.searchParams.get('email') || '').toLowerCase().trim();
    const nameParam      = (url.searchParams.get('name')  || '').toLowerCase().trim();

    const [services, plans, people] = await Promise.all([
      kvGet(env, orgKey(orgId, 'services'), []),
      kvGet(env, orgKey(orgId, 'plans'), {}),
      kvGet(env, orgKey(orgId, 'people'), []),
    ]);

    // Legacy: specific serviceId → return that service object (used by SetlistScreen)
    if (serviceIdParam) {
      return json(services.find(s => s.id === serviceIdParam) || {});
    }

    // No person filter → return raw services (admin/debug)
    if (!emailParam && !nameParam) {
      return json(services);
    }

    // Build a quick id→person map so we can look up emails by personId
    const personById = {};
    for (const p of people) { if (p?.id) personById[p.id] = p; }

    // Normalise a display name for fuzzy matching
    const norm = s => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();

    function memberMatchesPerson(member) {
      const person   = personById[member.personId] || {};
      const mEmail   = norm(person.email  || member.email  || '');
      const mName    = norm(person.name   || member.name   || '');

      // 1. Exact email match
      if (emailParam && mEmail && mEmail === emailParam) return true;

      // 2. Exact or prefix full-name match
      if (nameParam && mName) {
        if (mName === nameParam) return true;
        // first name at least 3 chars
        const firstToken = nameParam.split(' ')[0];
        if (firstToken.length >= 3 && mName.startsWith(firstToken)) return true;
      }

      // 3. Email-username vs stored name (handles "jefferson" email ↔ "Jefferson Nascimento")
      if (emailParam && mName) {
        const user = emailParam.split('@')[0].toLowerCase().replace(/[._\-]/g, '');
        const nameCompact = mName.replace(/\s+/g, '');
        if (nameCompact.startsWith(user) || user.startsWith(nameCompact.split(' ')[0])) return true;
        // e.g. email "jnascimento" vs name "jefferson nascimento" — share first 4 chars
        if (user.length >= 4 && nameCompact.startsWith(user.slice(0, 4))) return true;
      }

      return false;
    }

    const assignments = [];

    for (const svc of services) {
      const plan = plans[svc.id] || svc.plan || {};
      const team = plan.team || [];

      for (const member of team) {
        if (!memberMatchesPerson(member)) continue;

        // Compute service_end_at (service date + time + 2h grace)
        let service_end_at = null;
        const rawDate = svc.date || svc.serviceDate || '';
        const rawTime = svc.time || svc.startTime || '';
        if (rawDate) {
          const localStr = String(rawDate).includes('T') ? rawDate : `${rawDate}T00:00:00`;
          const dt = new Date(localStr);
          if (Number.isFinite(dt.getTime())) {
            const m = String(rawTime).match(/(\d{1,2}):(\d{2})/);
            if (m) dt.setHours(Number(m[1]), Number(m[2]), 0, 0);
            else   dt.setHours(23, 59, 59, 999);
            dt.setHours(dt.getHours() + 2); // 2-hour grace after service
            service_end_at = dt.toISOString();
          }
        }

        assignments.push({
          id:             `${svc.id}_${member.personId || norm(member.name).replace(/\s/g, '_')}`,
          service_id:     svc.id,
          service_name:   svc.name || svc.title || 'Service',
          service_date:   svc.date || svc.serviceDate || '',
          service_end_at,
          role:           member.role || '',
          notes:          member.notes || plan.notes || '',
          status:         'pending',
          songs:          plan.songs || [],
        });
      }
    }

    return json(assignments);
  }

  // ── POST /sync/assignment/respond ────────────────────────────────────────
  if (route === 'assignment/respond' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const { serviceId, personId, response, songId, role } = body;
    if (!serviceId) return json({ error: 'serviceId required' }, 400);
    const services = await kvGet(env, orgKey(orgId, 'services'), []);
    const svcIdx = services.findIndex(s => s.id === serviceId);
    if (svcIdx >= 0) {
      if (!services[svcIdx].assignmentResponses) services[svcIdx].assignmentResponses = {};
      services[svcIdx].assignmentResponses[personId] = { response, songId, role, ts: Date.now() };
      await kvPut(env, orgKey(orgId, 'services'), services);
    }
    return json({ ok: true });
  }

  // ── POST /sync/song/patch ────────────────────────────────────────────────
  if (route === 'song/patch' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const { id, ...patch } = body;
    if (!id) return json({ error: 'id required' }, 400);
    const songMap = await kvGet(env, orgKey(orgId, 'songLibrary'), {});
    songMap[id] = { ...(songMap[id] || {}), ...patch };
    await kvPut(env, orgKey(orgId, 'songLibrary'), songMap);
    return json({ ok: true });
  }

  // ── POST /sync/blockout ──────────────────────────────────────────────────
  if (route === 'blockout' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const email = (body.email || '').trim().toLowerCase();
    if (!email) return json({ error: 'email required' }, 400);
    const blockouts = await kvGet(env, orgKey(orgId, 'blockouts'), []);
    const entry = {
      id: body.id || `blk_${Date.now()}_${makeId(5)}`,
      email, date: body.date, reason: body.reason || '',
      created_at: new Date().toISOString(),
    };
    const filtered = blockouts.filter(b => !(b.email === email && b.date === entry.date));
    filtered.push(entry);
    await kvPut(env, orgKey(orgId, 'blockouts'), filtered);
    return json({ ok: true, id: entry.id });
  }

  // ── DELETE /sync/blockout ────────────────────────────────────────────────
  if (route === 'blockout' && method === 'DELETE') {
    const blkId = url.searchParams.get('id') || '';
    const email = (url.searchParams.get('email') || '').toLowerCase();
    const date = url.searchParams.get('date') || '';
    let blockouts = await kvGet(env, orgKey(orgId, 'blockouts'), []);
    if (blkId) blockouts = blockouts.filter(b => b.id !== blkId);
    else if (email && date) blockouts = blockouts.filter(b => !(b.email === email && b.date === date));
    await kvPut(env, orgKey(orgId, 'blockouts'), blockouts);
    return json({ ok: true });
  }

  // ── GET /sync/blockouts ──────────────────────────────────────────────────
  if (route === 'blockouts' && method === 'GET') {
    let blockouts = await kvGet(env, orgKey(orgId, 'blockouts'), []);
    const dateFilter = url.searchParams.get('date');
    const emailFilter = url.searchParams.get('email');
    if (dateFilter) blockouts = blockouts.filter(b => b.date === dateFilter);
    if (emailFilter) blockouts = blockouts.filter(b => b.email === emailFilter.toLowerCase());
    return json(blockouts);
  }

  // ── MIDI (no-op — bridge is local only) ─────────────────────────────────
  if (route === 'midi/command' && method === 'POST') {
    return json({ ok: true, note: 'MIDI bridge is local-only' });
  }

  return json({ error: 'Not found', route }, 404);
}
