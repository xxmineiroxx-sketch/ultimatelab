/**
 * Ultimate Musician — Real-Time Sync Worker
 * Durable Objects WebSocket rooms — one per serviceId.
 *
 * Routes:
 *   GET  /room/:serviceId/ws        → WebSocket upgrade (clients connect here)
 *   GET  /room/:serviceId/state     → last known position (REST fallback)
 *   POST /room/:serviceId/broadcast → server-side push (e.g. from Pages Function)
 *
 * Message types broadcast between peers:
 *   position  { songIndex, sectionIndex, charOffset }
 *   play      {}
 *   pause     {}
 *   next      {}
 *   prev      {}
 *   goto      { songIndex }
 *   midi      { command, value }
 *   presence  { name, role, action: 'join'|'leave', presenceCount }
 *   ping      {} → pong response to sender only
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-org-id, x-secret-key, Upgrade',
};

const VALID_TYPES = new Set([
  'position', 'play', 'pause', 'next', 'prev', 'goto',
  'midi', 'presence', 'ping',
]);

// ── SyncRoom Durable Object ────────────────────────────────────────────────
export class SyncRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // Map<WebSocket, { name, role, joinedAt }>
    this.sessions = new Map();
    this.lastPosition = null;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      return this._handleWebSocket(request, url);
    }

    // REST: GET /state
    if (request.method === 'GET' && url.pathname.endsWith('/state')) {
      return new Response(
        JSON.stringify({ ok: true, lastPosition: this.lastPosition, presenceCount: this.sessions.size }),
        { headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } },
      );
    }

    // REST: POST /broadcast — server-side push
    if (request.method === 'POST' && url.pathname.endsWith('/broadcast')) {
      const body = await request.json().catch(() => ({}));
      if (body && VALID_TYPES.has(body.type)) {
        body.ts = new Date().toISOString();
        this._broadcast(null, JSON.stringify(body));
        if (['position', 'goto', 'next', 'prev'].includes(body.type)) {
          this.lastPosition = body;
        }
      }
      return new Response(
        JSON.stringify({ ok: true, presenceCount: this.sessions.size }),
        { headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } },
      );
    }

    return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
  }

  _handleWebSocket(request, url) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.state.acceptWebSocket(server);

    const name = (url.searchParams.get('name') || 'Anonymous').slice(0, 80);
    const role = (url.searchParams.get('role') || 'player').slice(0, 40);
    this.sessions.set(server, { name, role, joinedAt: Date.now() });

    // Send current state to the late joiner immediately
    try {
      server.send(JSON.stringify({
        type: 'init',
        lastPosition: this.lastPosition,
        presenceCount: this.sessions.size,
        ts: new Date().toISOString(),
      }));
    } catch (_) {}

    // Announce join to others in the room
    this._broadcast(server, JSON.stringify({
      type: 'presence',
      name,
      role,
      action: 'join',
      presenceCount: this.sessions.size,
      ts: new Date().toISOString(),
    }));

    return new Response(null, { status: 101, webSocket: client });
  }

  // Hibernatable WebSockets API — called by runtime per message
  webSocketMessage(ws, message) {
    let msg;
    try {
      msg = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));
    } catch {
      return;
    }
    if (!msg || !VALID_TYPES.has(msg.type)) return;

    msg.ts = new Date().toISOString();

    if (['position', 'goto', 'next', 'prev'].includes(msg.type)) {
      this.lastPosition = msg;
    }

    if (msg.type === 'ping') {
      try { ws.send(JSON.stringify({ type: 'pong', ts: msg.ts })); } catch (_) {}
      return;
    }

    this._broadcast(ws, JSON.stringify(msg));
  }

  webSocketClose(ws, code) {
    const meta = this.sessions.get(ws);
    this.sessions.delete(ws);
    try { ws.close(code, 'closing'); } catch (_) {}

    if (meta) {
      this._broadcast(null, JSON.stringify({
        type: 'presence',
        name: meta.name,
        role: meta.role,
        action: 'leave',
        presenceCount: this.sessions.size,
        ts: new Date().toISOString(),
      }));
    }
  }

  webSocketError(ws) {
    this.sessions.delete(ws);
    try { ws.close(1011, 'error'); } catch (_) {}
  }

  _broadcast(exclude, serialized) {
    for (const [ws] of this.sessions) {
      if (ws === exclude) continue;
      try {
        ws.send(serialized);
      } catch (_) {
        this.sessions.delete(ws);
      }
    }
  }
}

// ── Default export — routes requests to the correct SyncRoom instance ──────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const match = url.pathname.match(/^\/room\/([^/]+)(\/.*)?$/);
    if (!match) {
      return new Response(
        JSON.stringify({ ok: true, service: 'um-sync-room', ts: new Date().toISOString() }),
        { headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } },
      );
    }

    const serviceId = decodeURIComponent(match[1]);
    if (!serviceId || serviceId.length > 128) {
      return new Response(
        JSON.stringify({ error: 'Invalid serviceId' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } },
      );
    }

    const subPath = match[2] || '/';
    const id = env.SYNC_ROOM.idFromName(serviceId);
    const room = env.SYNC_ROOM.get(id);

    // Rewrite the path for the DO — strip /room/:serviceId prefix
    const internalUrl = new URL(url);
    internalUrl.pathname = subPath;
    return room.fetch(new Request(internalUrl.toString(), request));
  },
};
