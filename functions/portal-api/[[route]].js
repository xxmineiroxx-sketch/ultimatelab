const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

const SESSION_COOKIE = 'um_portal_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;

const ROUTES = {
  'auth/login': { methods: ['POST'], access: 'public', upstream: true },
  'auth/register': { methods: ['POST'], access: 'public', upstream: true },
  'auth/verify': { methods: ['POST'], access: 'public', upstream: true },
  'auth/resend': { methods: ['POST'], access: 'public', upstream: true },
  'auth/forgot-password': { methods: ['POST'], access: 'public', upstream: true },
  'auth/reset-password': { methods: ['POST'], access: 'public', upstream: true },
  'auth/session': { methods: ['GET'], access: 'session', upstream: false },
  'auth/logout': { methods: ['POST'], access: 'logout', upstream: false },
  'library-pull': { methods: ['GET'], access: 'member', upstream: true },
  'roles': { methods: ['GET'], access: 'member', upstream: true },
  'library-push': { methods: ['POST'], access: 'editor', upstream: true },
  'publish': { methods: ['POST'], access: 'editor', upstream: true },
  'ai/vocal-parts': { methods: ['POST'], access: 'editor', upstream: true },
  'song/patch': { methods: ['POST'], access: 'editor', upstream: true },
  'role/set': { methods: ['POST'], access: 'admin', upstream: true },
};

const EDITOR_ROLES = new Set(['owner', 'admin', 'worship_leader']);
const ADMIN_ROLES = new Set(['owner', 'admin']);

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

function normalizeRoute(pathname) {
  return pathname.replace(/^\/portal-api\/?/, '').replace(/\/$/, '');
}

function normalizeRole(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeString(value) {
  return String(value || '').trim();
}

function parseCookies(cookieHeader) {
  return String(cookieHeader || '')
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .reduce((acc, part) => {
      const idx = part.indexOf('=');
      if (idx === -1) return acc;
      const key = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      acc[key] = value;
      return acc;
    }, {});
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodePayload(value) {
  return bytesToBase64Url(new TextEncoder().encode(value));
}

function decodePayload(value) {
  return new TextDecoder().decode(base64UrlToBytes(value));
}

async function signValue(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(value),
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

function buildSession(data = {}) {
  return {
    email: normalizeString(data.email).toLowerCase(),
    name: normalizeString(data.name || data.email),
    role: normalizeRole(data.role || 'member') || 'member',
    orgName: normalizeString(data.orgName),
    branchCity: normalizeString(data.branchCity),
  };
}

async function encodeSession(secret, session) {
  const now = Date.now();
  const payload = {
    ...buildSession(session),
    issuedAt: now,
    expiresAt: now + SESSION_TTL_SECONDS * 1000,
  };
  const encoded = encodePayload(JSON.stringify(payload));
  const signature = await signValue(secret, encoded);
  return `${encoded}.${signature}`;
}

async function decodeSession(secret, rawCookie) {
  const value = normalizeString(rawCookie);
  if (!value) return null;
  const [encoded, signature] = value.split('.');
  if (!encoded || !signature) return null;
  try {
    const expected = await signValue(secret, encoded);
    if (signature !== expected) return null;
    const payload = JSON.parse(decodePayload(encoded));
    if (Date.now() > Number(payload.expiresAt || 0)) return null;
    if (!payload.email || !payload.orgName) return null;
    return buildSession(payload);
  } catch {
    return null;
  }
}

function sessionCookie(token, maxAge = SESSION_TTL_SECONDS) {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function readPortalConfig(env) {
  const orgId = normalizeString(env.PORTAL_SYNC_ORG_ID);
  const secretKey = normalizeString(env.PORTAL_SYNC_SECRET_KEY);
  const sessionSecret = normalizeString(env.PORTAL_PROXY_SESSION_SECRET);
  if (!orgId || !secretKey || !sessionSecret) return null;
  return { orgId, secretKey, sessionSecret };
}

function canAccessRoute(routeAccess, session) {
  if (routeAccess === 'member') return Boolean(session);
  if (routeAccess === 'editor') return EDITOR_ROLES.has(normalizeRole(session?.role));
  if (routeAccess === 'admin') return ADMIN_ROLES.has(normalizeRole(session?.role));
  if (routeAccess === 'session') return Boolean(session);
  if (routeAccess === 'logout') return true;
  return routeAccess === 'public';
}

function upstreamHeaders(request, config) {
  const headers = new Headers(request.headers);
  headers.set('x-org-id', config.orgId);
  headers.set('x-secret-key', config.secretKey);
  headers.delete('cookie');
  headers.delete('host');
  headers.delete('content-length');
  return headers;
}

async function proxyToSync(request, url, route, config) {
  const upstreamUrl = new URL(`/sync/${route}`, url.origin);
  upstreamUrl.search = url.search;
  return fetch(upstreamUrl.toString(), {
    method: request.method,
    headers: upstreamHeaders(request, config),
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const route = normalizeRoute(url.pathname);
  const routeConfig = ROUTES[route];

  if (!routeConfig) return json({ error: 'Not found', route }, 404);

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        Allow: routeConfig.methods.join(', '),
        'Cache-Control': 'no-store',
      },
    });
  }

  if (!routeConfig.methods.includes(request.method)) {
    return json(
      { error: `Method ${request.method} not allowed for ${route}` },
      405,
      { Allow: routeConfig.methods.join(', ') },
    );
  }

  const config = readPortalConfig(env);
  if (!config) {
    return json({ error: 'Portal proxy is not configured.' }, 503);
  }

  const cookies = parseCookies(request.headers.get('cookie'));
  const session = await decodeSession(config.sessionSecret, cookies[SESSION_COOKIE]);

  if (route === 'auth/logout') {
    return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
  }

  if (route === 'auth/session') {
    if (!session) {
      return json({ error: 'Not signed in.' }, 401, { 'Set-Cookie': clearSessionCookie() });
    }
    const refreshedToken = await encodeSession(config.sessionSecret, session);
    return json({ ok: true, ...session }, 200, { 'Set-Cookie': sessionCookie(refreshedToken) });
  }

  if (routeConfig.access !== 'public' && !session) {
    return json({ error: 'Not signed in.' }, 401, { 'Set-Cookie': clearSessionCookie() });
  }

  if (!canAccessRoute(routeConfig.access, session)) {
    return json({ error: 'Forbidden.' }, 403);
  }

  const upstreamResponse = await proxyToSync(request, url, route, config);
  const proxiedData = await upstreamResponse.clone().json().catch(() => null);
  const headers = new Headers(upstreamResponse.headers);
  headers.set('Cache-Control', 'no-store');

  if (route === 'auth/register') {
    headers.append('Set-Cookie', clearSessionCookie());
  }

  if (route === 'auth/login') {
    if (upstreamResponse.ok && proxiedData?.ok && !proxiedData?.needsVerification) {
      const token = await encodeSession(
        config.sessionSecret,
        buildSession(proxiedData),
      );
      headers.append('Set-Cookie', sessionCookie(token));
    } else {
      headers.append('Set-Cookie', clearSessionCookie());
    }
  }

  if (route === 'auth/verify' && upstreamResponse.ok && proxiedData?.ok) {
    const token = await encodeSession(
      config.sessionSecret,
      buildSession(proxiedData),
    );
    headers.append('Set-Cookie', sessionCookie(token));
  }

  if (routeConfig.access !== 'public' && session) {
    const refreshedToken = await encodeSession(config.sessionSecret, session);
    headers.append('Set-Cookie', sessionCookie(refreshedToken));
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers,
  });
}
