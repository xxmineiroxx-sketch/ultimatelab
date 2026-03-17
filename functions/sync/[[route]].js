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
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
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

const RESET_CODE_TTL_MS = 15 * 60 * 1000;

function makeNumericCode(len = 6) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let code = '';
  for (const byte of bytes) code += String(byte % 10);
  return code.padEnd(len, '0').slice(0, len);
}

async function kvGet(env, key, fallback) {
  const raw = await env.STORE.get(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

async function kvPut(env, key, value) {
  await env.STORE.put(key, JSON.stringify(value));
}

async function kvDelete(env, key) {
  await env.STORE.delete(key);
}

function orgKey(orgId, type) {
  return `org:${orgId}:${type}`;
}

function passwordResetKey(orgId, email) {
  return `${orgKey(orgId, 'passwordReset')}:${email}`;
}

function passwordResetEmailHtml({ name, code, orgName }) {
  const safeName = name || 'there';
  const safeOrgName = orgName || 'your team';
  return `
    <div style="background:#020617;padding:40px;font-family:sans-serif;color:#F9FAFB;max-width:480px;margin:auto;border-radius:16px">
      <p style="color:#818CF8;font-weight:700;font-size:13px;letter-spacing:1px;text-transform:uppercase;margin:0 0 8px">CineStage™</p>
      <h1 style="font-size:26px;margin:0 0 12px">Reset your password</h1>
      <p style="color:#9CA3AF;margin:0 0 16px">Hi ${safeName}, use this code to reset your Ultimate Playback password for ${safeOrgName}. It expires in 15 minutes.</p>
      <div style="background:#0B1120;border:1px solid #1F2937;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px">
        <span style="font-size:48px;font-weight:900;letter-spacing:12px;color:#818CF8">${code}</span>
      </div>
      <p style="color:#4B5563;font-size:12px;margin:0">If you did not request this reset, you can ignore this email.</p>
    </div>
  `;
}

async function sendPasswordResetEmail(env, { to, name, code, orgName }) {
  const resendApiKey = env.RESEND_API_KEY || '';
  const fromEmail = env.FROM_EMAIL || '';
  const fromName = env.FROM_EMAIL_NAME || 'CineStage';

  if (!resendApiKey || !fromEmail) {
    throw new Error('Password reset email is not configured');
  }

  const subject = `${code} is your Ultimate Playback reset code`;
  const text = [
    `Hi ${name || 'there'},`,
    '',
    `Use this code to reset your Ultimate Playback password for ${orgName || 'your team'}: ${code}`,
    '',
    'This code expires in 15 minutes.',
    '',
    "If you did not request this reset, you can ignore this email.",
  ].join('\n');

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${resendApiKey}`,
    },
    body: JSON.stringify({
      from: `${fromName} <${fromEmail}>`,
      to: [to],
      subject,
      html: passwordResetEmailHtml({ name, code, orgName }),
      text,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    console.log('[sync/auth/forgot-password] resend failed', detail);
    throw new Error('Failed to send password reset email');
  }
}

// ── Identifier resolution (email or phone → canonical email) ──────────────

function normalizePhone(str) {
  return str.replace(/\D/g, '');
}

function isEmail(str) {
  return str.includes('@');
}

/**
 * Resolves a raw login identifier (email or phone number) to a canonical email.
 * Returns { canonicalEmail, phone } where phone may be null.
 * canonicalEmail will be null if a phone was given but not found in people list.
 */
async function resolveIdentifier(env, orgId, raw) {
  const trimmed = raw.trim();
  const people = await kvGet(env, orgKey(orgId, 'people'), []);

  if (isEmail(trimmed)) {
    const canonicalEmail = trimmed.toLowerCase();
    const person = people.find(p => (p.email || '').toLowerCase() === canonicalEmail);
    return {
      canonicalEmail,
      phone: person?.phone ? normalizePhone(person.phone) : null,
      personPhone: person?.phone || null,
      personName: person?.name || null,
    };
  }
  // Phone path: normalize digits and search people list
  const phone = normalizePhone(trimmed);
  if (!phone) return { canonicalEmail: null, phone: null };
  const person = people.find(p => p.phone && normalizePhone(p.phone) === phone);
  return {
    canonicalEmail: person?.email?.toLowerCase() || null,
    phone,
    personPhone: person?.phone || null,
    personName: person?.name || null,
  };
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

  // ── Public: POST /sync/register — create a new organization or branch ────
  if (route === 'register' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const {
      name = 'My Organization',
      city = '',
      language = '',
      isParentOrg = false,
      parentOrgId = null,
      parentSecretKey = null,
    } = body;

    const orgId = makeId(16);
    const secretKey = makeId(32);
    const secretKeyHash = await sha256(secretKey);

    const org = {
      orgId,
      name,
      city,
      language,
      secretKeyHash,
      createdAt: new Date().toISOString(),
      isParentOrg: isParentOrg || false,
      parentOrgId: parentOrgId || null,
    };

    await kvPut(env, `org:${orgId}`, org);

    // If parentOrgId + parentSecretKey provided, link this branch to the parent
    if (parentOrgId && parentSecretKey) {
      const parentOrg = await kvGet(env, `org:${parentOrgId}`, null);
      if (parentOrg) {
        const parentHash = await sha256(parentSecretKey);
        if (parentHash === parentOrg.secretKeyHash) {
          const branches = await kvGet(env, `org:${parentOrgId}:branches`, []);
          branches.push({ branchId: orgId, name, city, language, createdAt: org.createdAt });
          await kvPut(env, `org:${parentOrgId}:branches`, branches);
        }
      }
    }

    // Return secret key ONCE — never stored in plain text
    return json({ ok: true, orgId, secretKey, name, city, language });
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
          id:             member.id || `${svc.id}_${member.personId || norm(member.name).replace(/\s/g, '_')}_${member.role || 'role'}`,
          service_id:     svc.id,
          service_name:   svc.name || svc.title || 'Service',
          service_date:   svc.date || svc.serviceDate || '',
          service_end_at,
          role:           member.role || '',
          notes:          member.notes || plan.notes || '',
          status:         'pending',
          songs:          plan.songs || [],
          org_name:       org.name || '',
          branch_city:    org.city || '',
        });
      }
    }

    // Append pending guest invites (stored globally by email, not per-org)
    if (emailParam) {
      const guestInvites = await kvGet(env, `guestInvites:${emailParam}`, []);
      const pendingInvites = guestInvites
        .filter(i => i.status === 'pending')
        .map(i => ({
          id: i.id,
          type: 'guest_invite',
          service_name: i.serviceName,
          service_date: i.serviceDate,
          service_end_at: null,
          role: i.role,
          notes: i.notes || '',
          org_name: i.invitingOrgName,
          branch_city: i.branchCity,
          invited_by: i.invitedByName,
          invite_id: i.id,
          status: 'pending',
          songs: [],
        }));
      return json([...assignments, ...pendingInvites]);
    }

    return json(assignments);
  }

  // ── GET /sync/setlist ────────────────────────────────────────────────────
  if (route === 'setlist' && method === 'GET') {
    const serviceId = url.searchParams.get('serviceId') || '';
    if (!serviceId) return json({ error: 'serviceId required' }, 400);

    const [plans, songMap] = await Promise.all([
      kvGet(env, orgKey(orgId, 'plans'), {}),
      kvGet(env, orgKey(orgId, 'songLibrary'), {}),
    ]);

    const plan = plans[serviceId] || {};
    const planSongs = plan.songs || [];

    // Enrich each plan song with full library data.
    // Plan songs use s.songId as the library reference; s.id is a plan-item ID ('si_...').
    // We expose id = s.songId so that Playback's vocalAssignment lookup (keyed by songId) works.
    const songs = planSongs.map((s, idx) => {
      const libSong = songMap[s.songId] || {};
      return {
        ...libSong,
        ...s,
        id: s.songId || s.id,         // canonical ID = library songId
        planItemId: s.id,              // preserve original plan item id if needed
        order: idx + 1,               // plan array position (1-based)
        // hasLyrics = true when either dedicated lyrics OR a chord chart (lead sheet) exists
        hasLyrics: !!(
          (s.lyrics || '').trim() || (libSong.lyrics || '').trim() ||
          (s.chordChart || '').trim() || (libSong.chordChart || '').trim()
        ),
        hasChart: !!(
          (s.chordChart || '').trim() || (libSong.chordChart || '').trim()
        ),
      };
    });

    return json(songs);
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

  // ── POST /sync/stems-store ───────────────────────────────────────────────
  // Called by CineStage server after processing to store results in KV.
  // Body: { songId, title, stems, harmonies, key, bpm, jobId }
  if (route === 'stems-store' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const { songId } = body;
    if (!songId) return json({ error: 'songId required' }, 400);
    const existing = await kvGet(env, orgKey(orgId, `stems:${songId}`), {});
    const entry = {
      ...existing,
      ...body,
      updatedAt: new Date().toISOString(),
    };
    await kvPut(env, orgKey(orgId, `stems:${songId}`), entry);
    return json({ ok: true, songId });
  }

  // ── GET /sync/stems-result ───────────────────────────────────────────────
  // Called by iPhone/iPad to retrieve processed stems for a song.
  // Query: ?songId=xxx
  if (route === 'stems-result' && method === 'GET') {
    const songId = url.searchParams.get('songId') || '';
    if (!songId) return json({ error: 'songId required' }, 400);
    const result = await kvGet(env, orgKey(orgId, `stems:${songId}`), null);
    if (!result) return json({ error: 'Not found', songId }, 404);
    return json(result);
  }

  // ── GET /sync/org/profile ────────────────────────────────────────────────
  if (route === 'org/profile' && method === 'GET') {
    return json({ orgId: org.orgId, name: org.name, createdAt: org.createdAt });
  }

  // ── PUT /sync/org/profile — update org name ──────────────────────────────
  if (route === 'org/profile' && method === 'PUT') {
    const body = await request.json().catch(() => ({}));
    if (body.name && typeof body.name === 'string') {
      await kvPut(env, `org:${orgId}`, { ...org, name: body.name.trim() });
    }
    return json({ ok: true });
  }

  // ── GET /sync/role — member role lookup ──────────────────────────────────
  if (route === 'role' && method === 'GET') {
    const emailQ = (url.searchParams.get('email') || '').toLowerCase().trim();
    const [people, rolesMap, grants] = await Promise.all([
      kvGet(env, orgKey(orgId, 'people'), []),
      kvGet(env, orgKey(orgId, 'roles'), {}),
      kvGet(env, orgKey(orgId, 'grants'), {}),
    ]);
    const person = people.find(p => (p.email || '').toLowerCase() === emailQ);
    // Org-hierarchy role (admin / worship_leader — for UM)
    const role = rolesMap[emailQ] || person?.role || 'member';
    // Playback permission grant (md / admin — for UP)
    const grantedRole = grants[emailQ] || null;
    return json({ role, grantedRole, orgName: org.name, branchCity: org.city || '' });
  }

  // ── GET /sync/roles — get all role assignments for the current org ───────
  if (route === 'roles' && method === 'GET') {
    const roles = await kvGet(env, orgKey(orgId, 'roles'), {});
    return json(roles);
  }

  // ── POST /sync/role/set — assign org-hierarchy role to a person ───────────
  if (route === 'role/set' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const email = (body.email || '').toLowerCase().trim();
    const role = body.role || null; // 'worship_leader' | null (branch credentials cannot set 'admin')
    if (!email) return json({ error: 'email required' }, 400);
    // Branch credentials cannot assign or remove admin roles — only root org can
    const isBranch = !!org.parentOrgId;
    if (role === 'admin' && isBranch) return json({ error: 'Admin roles require org owner credentials' }, 403);
    const roles = await kvGet(env, orgKey(orgId, 'roles'), {});
    if (isBranch && roles[email] === 'admin') return json({ error: 'Cannot modify an existing admin — contact org owner' }, 403);
    if (role === null) { delete roles[email]; }
    else { roles[email] = role; }
    await kvPut(env, orgKey(orgId, 'roles'), roles);
    return json({ ok: true, email, role });
  }

  // ── POST /sync/branch/:id/role/set — parent org sets role in a branch ────
  // Org owner can reassign Admin / Worship Leader in any branch without having that branch's credentials.
  if (route.startsWith('branch/') && route.endsWith('/role/set') && method === 'POST') {
    const branchId = route.split('/')[1];
    const branches = await kvGet(env, `org:${orgId}:branches`, []);
    if (!branches.find(b => b.branchId === branchId)) {
      return json({ error: 'Branch not found in this organization' }, 403);
    }
    const body = await request.json().catch(() => ({}));
    const email = (body.email || '').toLowerCase().trim();
    const role  = body.role || null; // 'admin' | 'worship_leader' | null
    if (!email) return json({ error: 'email required' }, 400);
    const roles = await kvGet(env, `org:${branchId}:roles`, {});
    if (role === null) { delete roles[email]; }
    else { roles[email] = role; }
    await kvPut(env, `org:${branchId}:roles`, roles);
    return json({ ok: true, branchId, email, role });
  }

  // ── GET /sync/branch/:id/roles — get all role assignments for a branch ───
  if (route.startsWith('branch/') && route.endsWith('/roles') && method === 'GET') {
    const branchId = route.split('/')[1];
    const branches = await kvGet(env, `org:${orgId}:branches`, []);
    if (!branches.find(b => b.branchId === branchId)) {
      return json({ error: 'Branch not found' }, 403);
    }
    const roles = await kvGet(env, `org:${branchId}:roles`, {});
    return json(roles);
  }

  // ── GET /sync/branches — list all branches (parent org only) ─────────────
  if (route === 'branches' && method === 'GET') {
    const branches = await kvGet(env, `org:${orgId}:branches`, []);
    const withStats = await Promise.all(branches.map(async b => {
      const [people, songMap, services] = await Promise.all([
        kvGet(env, `org:${b.branchId}:people`, []),
        kvGet(env, `org:${b.branchId}:songLibrary`, {}),
        kvGet(env, `org:${b.branchId}:services`, []),
      ]);
      return {
        ...b,
        memberCount: people.length,
        songCount: Object.keys(songMap).length,
        serviceCount: services.length,
      };
    }));
    return json(withStats);
  }

  // ── GET /sync/branch/:id/overview — drill into one branch (parent auth) ──
  if (route.startsWith('branch/') && route.endsWith('/overview') && method === 'GET') {
    const branchId = route.split('/')[1];
    // Verify this branch belongs to this org
    const branches = await kvGet(env, `org:${orgId}:branches`, []);
    if (!branches.find(b => b.branchId === branchId)) {
      return json({ error: 'Branch not found in this organization' }, 403);
    }
    const [people, songMap, services, branchMeta] = await Promise.all([
      kvGet(env, `org:${branchId}:people`, []),
      kvGet(env, `org:${branchId}:songLibrary`, {}),
      kvGet(env, `org:${branchId}:services`, []),
      kvGet(env, `org:${branchId}`, {}),
    ]);
    return json({
      ...branchMeta,
      people,
      songs: Object.values(songMap),
      services: services.slice(-10), // last 10 services
    });
  }

  // ── POST /sync/auth/register — create user account (role-gated) ──────────
  // Accepts email or phone number as identifier.
  // Only succeeds if the resolved email has admin or worship_leader in org:roles.
  if (route === 'auth/register' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const raw = (body.identifier || body.email || '').trim();
    const { password = '', name = '' } = body;
    if (!raw || !password) return json({ error: 'identifier and password required' }, 400);
    const { canonicalEmail, personName, personPhone } = await resolveIdentifier(env, orgId, raw);
    if (!canonicalEmail) return json({ error: 'Phone number not found in this organization. Try registering with your email instead.' }, 404);
    // Must have a role in this org
    const roles = await kvGet(env, orgKey(orgId, 'roles'), {});
    const role = roles[canonicalEmail];
    if (!role) return json({ error: 'Your account is not assigned an Admin or Worship Leader role. Ask your organization owner to assign your role first.' }, 403);
    // Check not already registered
    const users = await kvGet(env, orgKey(orgId, 'users'), {});
    if (users[canonicalEmail]) return json({ error: 'Account already exists. Please sign in.' }, 409);
    const resolvedName = name || personName || canonicalEmail;
    users[canonicalEmail] = { name: resolvedName, passwordHash: await sha256(password), role, createdAt: new Date().toISOString() };
    await kvPut(env, orgKey(orgId, 'users'), users);
    return json({ ok: true, role, name: resolvedName, email: canonicalEmail, phone: personPhone || null, orgName: org.name });
  }

  // ── POST /sync/auth/login — verify credentials, return role ──────────────
  // Accepts email or phone number as identifier.
  if (route === 'auth/login' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const raw = (body.identifier || body.email || '').trim();
    const { password = '' } = body;
    if (!raw || !password) return json({ error: 'identifier and password required' }, 400);
    const { canonicalEmail, personName, personPhone } = await resolveIdentifier(env, orgId, raw);
    if (!canonicalEmail) return json({ error: 'Phone number not found in this organization.' }, 404);
    const users = await kvGet(env, orgKey(orgId, 'users'), {});
    const user = users[canonicalEmail];
    if (!user) return json({ error: 'No account found. Register first.' }, 401);
    const hash = await sha256(password);
    if (hash !== user.passwordHash) return json({ error: 'Incorrect password.' }, 401);
    // Also check current role (may have been updated since registration)
    const roles = await kvGet(env, orgKey(orgId, 'roles'), {});
    const role = roles[canonicalEmail] || user.role;
    return json({
      ok: true,
      role,
      name: user.name || personName || canonicalEmail,
      email: canonicalEmail,
      phone: personPhone || null,
      orgName: org.name,
      branchCity: org.city || '',
    });
  }

  // ── POST /sync/auth/forgot-password — send reset code to account email ──
  if (route === 'auth/forgot-password' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const raw = (body.identifier || body.email || body.phone || '').trim();
    if (!raw) return json({ error: 'identifier required' }, 400);
    if (!env.RESEND_API_KEY || !env.FROM_EMAIL) {
      return json({ error: 'Password reset email is not configured for this workspace.' }, 503);
    }

    const { canonicalEmail, personName } = await resolveIdentifier(env, orgId, raw);
    if (!canonicalEmail) {
      return json({ ok: true });
    }

    const users = await kvGet(env, orgKey(orgId, 'users'), {});
    const user = users[canonicalEmail];
    if (!user) {
      return json({ ok: true });
    }

    const code = makeNumericCode();
    await kvPut(env, passwordResetKey(orgId, canonicalEmail), {
      codeHash: await sha256(code),
      expiresAt: Date.now() + RESET_CODE_TTL_MS,
      createdAt: new Date().toISOString(),
    });

    try {
      await sendPasswordResetEmail(env, {
        to: canonicalEmail,
        name: user.name || personName || canonicalEmail,
        code,
        orgName: org.name,
      });
    } catch (error) {
      await kvDelete(env, passwordResetKey(orgId, canonicalEmail));
      return json({ error: error.message || 'Failed to send password reset email' }, 502);
    }

    return json({ ok: true });
  }

  // ── POST /sync/auth/reset-password — verify reset code and set password ─
  if (route === 'auth/reset-password' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const raw = (body.identifier || body.email || body.phone || '').trim();
    const code = String(body.code || '').trim();
    const newPassword = String(body.newPassword || '');
    if (!raw || !code || !newPassword) {
      return json({ error: 'identifier, code, and newPassword required' }, 400);
    }
    if (newPassword.length < 6) {
      return json({ error: 'New password must be at least 6 characters' }, 400);
    }

    const { canonicalEmail } = await resolveIdentifier(env, orgId, raw);
    if (!canonicalEmail) {
      return json({ error: 'Invalid or expired reset code' }, 400);
    }

    const users = await kvGet(env, orgKey(orgId, 'users'), {});
    const user = users[canonicalEmail];
    if (!user) {
      return json({ error: 'Invalid or expired reset code' }, 400);
    }

    const resetRecord = await kvGet(env, passwordResetKey(orgId, canonicalEmail), null);
    if (!resetRecord || !resetRecord.codeHash || Date.now() > Number(resetRecord.expiresAt || 0)) {
      await kvDelete(env, passwordResetKey(orgId, canonicalEmail));
      return json({ error: 'Invalid or expired reset code' }, 400);
    }

    const submittedCodeHash = await sha256(code);
    if (submittedCodeHash !== resetRecord.codeHash) {
      return json({ error: 'Invalid or expired reset code' }, 400);
    }

    user.passwordHash = await sha256(newPassword);
    user.updatedAt = new Date().toISOString();
    await kvPut(env, orgKey(orgId, 'users'), users);
    await kvDelete(env, passwordResetKey(orgId, canonicalEmail));

    return json({ ok: true, email: canonicalEmail });
  }

  // ── GET /sync/people — return the org's people list ─────────────────────
  if (route === 'people' && method === 'GET') {
    const people = await kvGet(env, orgKey(orgId, 'people'), []);
    return json(people);
  }

  // ── GET /sync/grants — return all Playback grants as array ───────────────
  if (route === 'grants' && method === 'GET') {
    const grants = await kvGet(env, orgKey(orgId, 'grants'), {});
    const arr = Object.entries(grants).map(([email, role]) => ({ email, role }));
    return json(arr);
  }

  // ── GET /sync/grant — read Playback permission grant for email ───────────
  if (route === 'grant' && method === 'GET') {
    const emailQ = (url.searchParams.get('email') || '').toLowerCase().trim();
    const grants = await kvGet(env, orgKey(orgId, 'grants'), {});
    return json({ role: grants[emailQ] || null });
  }

  // ── POST /sync/grant — set Playback permission (md/admin) for email ──────
  if (route === 'grant' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const email = (body.email || '').toLowerCase().trim();
    const role  = body.role || null; // 'md' | 'admin' | null
    if (!email) return json({ error: 'email required' }, 400);
    const grants = await kvGet(env, orgKey(orgId, 'grants'), {});
    if (role === null) { delete grants[email]; }
    else { grants[email] = role; }
    await kvPut(env, orgKey(orgId, 'grants'), grants);
    return json({ ok: true, email, role });
  }

  // ── DELETE /sync/grant — remove Playback permission for email ────────────
  if (route === 'grant' && method === 'DELETE') {
    const body = await request.json().catch(() => ({}));
    const email = (body.email || url.searchParams.get('email') || '').toLowerCase().trim();
    if (!email) return json({ error: 'email required' }, 400);
    const grants = await kvGet(env, orgKey(orgId, 'grants'), {});
    delete grants[email];
    await kvPut(env, orgKey(orgId, 'grants'), grants);
    return json({ ok: true });
  }

  // ── POST /sync/message — team member sends message to admin ─────────────
  if (route === 'message' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const { fromEmail = '', fromName = '', subject = '', message: msgText = '', to = 'admin' } = body;
    const msgs = await kvGet(env, orgKey(orgId, 'messages'), []);
    msgs.push({ id: makeId(), fromEmail, fromName, subject, message: msgText, to, timestamp: new Date().toISOString(), read: false, replies: [] });
    await kvPut(env, orgKey(orgId, 'messages'), msgs);
    return json({ ok: true });
  }

  // ── GET /sync/messages/admin — admin inbox ───────────────────────────────
  if (route === 'messages/admin' && method === 'GET') {
    const msgs = await kvGet(env, orgKey(orgId, 'messages'), []);
    return json(msgs.sort((a, b) => b.timestamp.localeCompare(a.timestamp)));
  }

  // ── GET /sync/messages/replies — user's sent messages + replies ──────────
  if (route === 'messages/replies' && method === 'GET') {
    const emailQ = (url.searchParams.get('email') || '').toLowerCase().trim();
    const msgs = await kvGet(env, orgKey(orgId, 'messages'), []);
    const mine = msgs.filter(m => (m.fromEmail || '').toLowerCase() === emailQ);
    return json(mine.sort((a, b) => b.timestamp.localeCompare(a.timestamp)));
  }

  // ── POST /sync/message/reply — admin replies to a message ───────────────
  if (route === 'message/reply' && method === 'POST') {
    const messageId = url.searchParams.get('messageId') || '';
    const body = await request.json().catch(() => ({}));
    const { from = 'Admin', message: replyText = '' } = body;
    const msgs = await kvGet(env, orgKey(orgId, 'messages'), []);
    const msg = msgs.find(m => m.id === messageId);
    if (!msg) return json({ error: 'Message not found' }, 404);
    msg.read = true;
    msg.replies = msg.replies || [];
    msg.replies.push({ id: makeId(), from, message: replyText, timestamp: new Date().toISOString() });
    await kvPut(env, orgKey(orgId, 'messages'), msgs);
    return json({ ok: true });
  }

  // ── GET /sync/xdirectory — list admins/WLs across sibling branches ───────
  if (route === 'xdirectory' && method === 'GET') {
    const parentId = org.parentOrgId;
    if (!parentId) return json({ error: 'Not part of a multi-branch organization' }, 400);
    const branches = await kvGet(env, `org:${parentId}:branches`, []);
    const directory = [];
    await Promise.all(branches.map(async b => {
      if (b.branchId === orgId) return; // skip own branch
      const branchRoles = await kvGet(env, `org:${b.branchId}:roles`, {});
      const people = await kvGet(env, `org:${b.branchId}:people`, []);
      for (const [email, role] of Object.entries(branchRoles)) {
        if (role === 'admin' || role === 'worship_leader') {
          const person = people.find(p => (p.email || '').toLowerCase() === email);
          directory.push({ email, name: person?.name || email, role, branchId: b.branchId, branchName: b.name, branchCity: b.city || '' });
        }
      }
    }));
    return json(directory);
  }

  // ── POST /sync/xmessage — send cross-branch message ──────────────────────
  if (route === 'xmessage' && method === 'POST') {
    const parentId = org.parentOrgId;
    if (!parentId) return json({ error: 'Not part of a multi-branch organization' }, 400);
    const body = await request.json().catch(() => ({}));
    const { fromEmail = '', fromName = '', toEmail = '', subject = '', message: msgText = '' } = body;
    // Validate sender has a role in this branch
    const senderRoles = await kvGet(env, orgKey(orgId, 'roles'), {});
    const senderRole = senderRoles[fromEmail.toLowerCase()];
    if (!senderRole) return json({ error: 'Only admins and worship leaders can send cross-branch messages' }, 403);
    // Find recipient's branch
    const branches = await kvGet(env, `org:${parentId}:branches`, []);
    let recipientOrgId = null;
    for (const b of branches) {
      const bRoles = await kvGet(env, `org:${b.branchId}:roles`, {});
      if (bRoles[toEmail.toLowerCase()]) { recipientOrgId = b.branchId; break; }
    }
    if (!recipientOrgId) return json({ error: 'Recipient not found in organization network' }, 404);
    const msgs = await kvGet(env, `org:${parentId}:xmessages`, []);
    msgs.push({ id: makeId(), fromEmail, fromName, fromOrgId: orgId, fromRole: senderRole, toEmail, toOrgId: recipientOrgId, subject, message: msgText, timestamp: new Date().toISOString(), readBy: [], replies: [] });
    await kvPut(env, `org:${parentId}:xmessages`, msgs);
    return json({ ok: true });
  }

  // ── GET /sync/xmessages — get cross-branch inbox for email ───────────────
  if (route === 'xmessages' && method === 'GET') {
    const parentId = org.parentOrgId;
    if (!parentId) return json([]);
    const emailQ = (url.searchParams.get('email') || '').toLowerCase().trim();
    const msgs = await kvGet(env, `org:${parentId}:xmessages`, []);
    const mine = msgs.filter(m =>
      (m.toEmail || '').toLowerCase() === emailQ ||
      (m.fromEmail || '').toLowerCase() === emailQ
    );
    return json(mine.sort((a, b) => b.timestamp.localeCompare(a.timestamp)));
  }

  // ── POST /sync/xmessage/reply — reply to a cross-branch message ──────────
  if (route === 'xmessage/reply' && method === 'POST') {
    const parentId = org.parentOrgId;
    if (!parentId) return json({ error: 'Not part of a multi-branch organization' }, 400);
    const messageId = url.searchParams.get('messageId') || '';
    const body = await request.json().catch(() => ({}));
    const { fromEmail = '', fromName = '', message: replyText = '' } = body;
    const msgs = await kvGet(env, `org:${parentId}:xmessages`, []);
    const msg = msgs.find(m => m.id === messageId);
    if (!msg) return json({ error: 'Message not found' }, 404);
    if (!msg.readBy.includes(fromEmail)) msg.readBy.push(fromEmail);
    msg.replies = msg.replies || [];
    msg.replies.push({ id: makeId(), fromEmail, fromName, message: replyText, timestamp: new Date().toISOString() });
    await kvPut(env, `org:${parentId}:xmessages`, msgs);
    return json({ ok: true });
  }

  // ── POST /sync/xinvite — WL/Admin sends guest invite to another branch member ──
  if (route === 'xinvite' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const { fromEmail = '', fromName = '', guestEmail = '', guestName = '', serviceDate = '', serviceName = '', role = '', notes = '' } = body;
    if (!guestEmail) return json({ error: 'guestEmail required' }, 400);
    // Validate sender has a role (admin or worship_leader)
    const senderRoles = await kvGet(env, orgKey(orgId, 'roles'), {});
    const senderRole = senderRoles[fromEmail.toLowerCase()];
    if (!senderRole) return json({ error: 'Only worship leaders and admins can send invitations' }, 403);
    const inviteId = makeId();
    const invite = {
      id: inviteId,
      invitingOrgId: orgId,
      invitingOrgName: org.name,
      branchCity: org.city || '',
      serviceDate,
      serviceName,
      role,
      notes,
      invitedBy: fromEmail,
      invitedByName: fromName,
      timestamp: new Date().toISOString(),
      status: 'pending',
    };
    const existing = await kvGet(env, `guestInvites:${guestEmail.toLowerCase()}`, []);
    existing.push(invite);
    await kvPut(env, `guestInvites:${guestEmail.toLowerCase()}`, existing);
    return json({ ok: true, inviteId });
  }

  // ── POST /sync/xinvite/respond — guest accepts or declines invite ─────────
  if (route === 'xinvite/respond' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const email = (body.email || '').toLowerCase().trim();
    const { inviteId = '', status = '' } = body;
    if (!['accepted', 'declined'].includes(status)) return json({ error: 'status must be accepted or declined' }, 400);
    if (!email || !inviteId) return json({ error: 'email and inviteId required' }, 400);
    const invites = await kvGet(env, `guestInvites:${email}`, []);
    const invite = invites.find(i => i.id === inviteId);
    if (!invite) return json({ error: 'Invite not found' }, 404);
    invite.status = status;
    await kvPut(env, `guestInvites:${email}`, invites);
    return json({ ok: true });
  }

  // ── MIDI (no-op — bridge is local only) ─────────────────────────────────
  if (route === 'midi/command' && method === 'POST') {
    return json({ ok: true, note: 'MIDI bridge is local-only' });
  }

  // ── POST /sync/ai/vocal-parts ────────────────────────────────────────────
  // Calls Anthropic API to generate harmony guidance for each vocal part.
  // Body: { songId, title, key, chordChart, lyrics, mode }
  // mode: 'satb' (default) | 'voice'
  if (route === 'ai/vocal-parts' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const { title = 'Untitled', key = 'C', chordChart = '', lyrics = '', mode = 'satb' } = body;

    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY not configured' }, 503);

    const sourceText = (chordChart || lyrics || '').slice(0, 4000);
    if (!sourceText.trim()) return json({ error: 'No song content provided' }, 400);

    const partList = mode === 'voice'
      ? ['1st Voice', '2nd Voice', '3rd Voice', '4th Voice', '5th Voice']
      : ['Lead Vocal', 'Soprano', 'Mezzo-Soprano', 'Alto', 'Tenor', 'Baritone', 'Bass'];

    const prompt = `You are an expert church worship music arranger. Given the song below, generate concise vocal harmony guidance for each part listed.

Song: "${title}" — Key: ${key}

${sourceText}

For each of these vocal parts: ${partList.join(', ')}

Write 1–3 sentences of practical, singable guidance per part covering:
- Which melody range/register to sing in
- Key harmony intervals or licks (e.g. "sing a 3rd above the lead", "hold root notes on chorus")
- Any specific cue or moment to highlight

Respond ONLY with a JSON object (no markdown, no code block) in this exact shape:
{
  "parts": {
    "Part Name": "guidance text",
    ...
  }
}`;

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text().catch(() => '');
      return json({ error: `Anthropic API error ${anthropicRes.status}`, detail: errText }, 502);
    }

    const aiData = await anthropicRes.json();
    const rawText = aiData?.content?.[0]?.text || '';

    let parts = {};
    try {
      const parsed = JSON.parse(rawText);
      parts = parsed.parts || {};
    } catch {
      // Try to extract JSON from anywhere in the response
      const match = rawText.match(/\{[\s\S]*\}/);
      if (match) {
        try { parts = JSON.parse(match[0]).parts || {}; } catch { /* leave empty */ }
      }
    }

    return json({ ok: true, parts, mode });
  }

  return json({ error: 'Not found', route }, 404);
}
