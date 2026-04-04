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

// Verify Stripe webhook signature (HMAC-SHA256, no Node crypto needed)
async function verifyStripeWebhook(rawBody, sigHeader, secret) {
  const parts = sigHeader.split(',').reduce((acc, part) => {
    const [k, v] = part.split('=');
    acc[k] = v;
    return acc;
  }, {});
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) throw new Error('Missing t or v1 in Stripe-Signature');
  const tolerance = 300; // 5 minutes
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > tolerance) {
    throw new Error('Timestamp outside tolerance');
  }
  const payload = `${timestamp}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const expected = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('');
  if (expected !== signature) throw new Error('Signature mismatch');
  return JSON.parse(rawBody);
}

function sanitizeFileName(value, fallback = 'audio.mp3') {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  const cleaned = raw
    .replace(/[/\\?%*:|"<>]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

function sanitizeStemSlot(value, fallback = 'track') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || fallback;
}

function normalizeStemToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const STEM_TYPE_ALIASES = {
  drums: [
    'drums', 'drum', 'kit', 'kick', 'snare', 'tom', 'toms',
    'cymbal', 'cymbals', 'overhead', 'overheads', 'perc', 'percussion', 'bateria',
  ],
  bass: ['bass', 'baixo', 'subbass', 'sub_bass'],
  guitars: [
    'guitar', 'guitars', 'gtr', 'lead_guitar', 'rhythm_guitar',
    'electric_guitar', 'acoustic_guitar', 'violao',
  ],
  keys: [
    'keys', 'key', 'keyboard', 'keyboardist', 'teclas',
    'piano', 'rhodes', 'synth', 'synthpad', 'synth_pad', 'organ',
  ],
  vocals: ['vocals', 'vocal', 'vox', 'voice', 'voz', 'lead_vocal', 'lead_vox'],
  strings: ['strings', 'string', 'cordas'],
  click: ['click', 'metronome'],
  guide: ['guide', 'guia', 'voice_guide', 'voiceguide', 'cue', 'ensaio', 'voz_ensaio'],
  pad: ['pad', 'pads', 'drone', 'ambient'],
  full_mix: ['full_mix', 'fullmix', 'stereo_mix', 'stereomix', 'master', 'instrumental', 'playback'],
  loop: ['loop', 'loops'],
  arpeggio: ['arpeggio', 'arp', 'arpej'],
  harmony_soprano: ['harmony_soprano', 'soprano', 'voice1', 'bgv1'],
  harmony_alto: ['harmony_alto', 'alto', 'contralto', 'voice2', 'bgv2'],
  harmony_tenor: ['harmony_tenor', 'tenor', 'voice3', 'bgv3'],
  harmony_bgv: ['harmony_bgv', 'harmony', 'harmonies', 'backing_vocal', 'backing_vocals', 'choir', 'bgv'],
};

const STEM_TYPE_ALIAS_LOOKUP = Object.fromEntries(
  Object.entries(STEM_TYPE_ALIASES).flatMap(([canonical, aliases]) =>
    aliases.map((alias) => [normalizeStemToken(alias), canonical])),
);

function inferCanonicalStemType(...values) {
  const tokens = new Set();
  values.forEach((value) => {
    const normalized = normalizeStemToken(value);
    if (!normalized) return;
    tokens.add(normalized);
    normalized.split(/_+/).forEach((part) => {
      if (part) tokens.add(part);
    });
  });
  for (const token of tokens) {
    if (STEM_TYPE_ALIAS_LOOKUP[token]) return STEM_TYPE_ALIAS_LOOKUP[token];
  }
  return '';
}

function canonicalizeStemType(rawType, ...hints) {
  const inferred = inferCanonicalStemType(rawType, ...hints);
  if (inferred) return inferred;
  const normalized = sanitizeStemSlot(rawType, 'other');
  if (normalized === 'percussion') return 'drums';
  if (['piano', 'synth', 'organ'].includes(normalized)) return 'keys';
  return normalized;
}

function stemValueUrl(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value !== 'object') return '';
  return String(
    value.url
    || value.uri
    || value.localUri
    || value.file_url
    || value.fileUrl
    || value.downloadUrl
    || value.streamUrl
    || '',
  ).trim();
}

function humanizeStemLabel(value) {
  const raw = String(value || '')
    .replace(/^harmony_/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return 'Track';
  return raw.replace(/\b\w/g, (char) => char.toUpperCase());
}

function makeUniqueStemKey(base, used = new Set()) {
  const seed = sanitizeStemSlot(base, 'track');
  let key = seed;
  let suffix = 2;
  while (used.has(key)) {
    key = `${seed}_${suffix}`;
    suffix += 1;
  }
  used.add(key);
  return key;
}

function harmonyPartFromStemType(type) {
  switch (type) {
    case 'harmony_soprano': return 'soprano';
    case 'harmony_alto': return 'alto';
    case 'harmony_tenor': return 'tenor';
    case 'harmony_bgv': return 'bgv';
    default: return '';
  }
}

function normalizeHarmonyPart(value) {
  const canonical = canonicalizeStemType(value);
  if (canonical.startsWith('harmony_')) {
    return canonical.replace(/^harmony_/, '');
  }
  const normalized = normalizeStemToken(value);
  return normalized ? normalized.replace(/^harmony_/, '') : '';
}

function normalizeStemPayload(input = {}) {
  const payload = input && typeof input === 'object' ? { ...input } : {};
  const usedStemKeys = new Set();
  const normalizedStems = {};
  const normalizedHarmonies = {};
  let hasStemEntries = false;

  const pushStem = (rawKey, rawValue, options = {}) => {
    const { mirrorHarmony = true } = options;
    const url = stemValueUrl(rawValue);
    if (!url) return;

    const rawLabel = clipText(
      rawValue && typeof rawValue === 'object' ? rawValue.label : '',
      160,
    );
    const rawType = rawValue && typeof rawValue === 'object' ? rawValue.type : rawKey;
    const type = canonicalizeStemType(rawType || rawKey, rawLabel, rawKey);
    const label = rawLabel || humanizeStemLabel(rawKey || type);

    if (type === 'click' && !payload.click_track) payload.click_track = url;
    if (type === 'guide' && !payload.voice_guide) payload.voice_guide = url;
    if (type === 'pad' && !payload.pad_track) payload.pad_track = url;
    if (type === 'full_mix') {
      payload.full_mix = url;
      payload.fullMix = url;
    }

    const harmonyPart = harmonyPartFromStemType(type);
    if (mirrorHarmony && harmonyPart && !normalizedHarmonies[harmonyPart]) {
      normalizedHarmonies[harmonyPart] = url;
    }

    const stemKey = makeUniqueStemKey(type || rawKey || 'track', usedStemKeys);
    normalizedStems[stemKey] = rawValue && typeof rawValue === 'object'
      ? { ...rawValue, type, label, url }
      : { type, label, url };
    hasStemEntries = true;
  };

  if (Array.isArray(payload.stems)) {
    payload.stems.forEach((entry, index) => {
      pushStem(entry?.id || entry?.key || `stem_${index}`, entry);
    });
  } else if (payload.stems && typeof payload.stems === 'object') {
    Object.entries(payload.stems).forEach(([rawKey, rawValue]) => {
      pushStem(rawKey, rawValue);
    });
  }

  if (payload.harmonies && typeof payload.harmonies === 'object') {
    Object.entries(payload.harmonies).forEach(([rawPart, rawValue]) => {
      const url = stemValueUrl(rawValue);
      if (!url) return;
      const part = normalizeHarmonyPart(
        rawPart
        || (rawValue && typeof rawValue === 'object' ? rawValue.type : '')
        || (rawValue && typeof rawValue === 'object' ? rawValue.label : ''),
      );
      if (!part) return;
      normalizedHarmonies[part] = url;
      const harmonyType = `harmony_${part}`;
      const duplicate = Object.values(normalizedStems).some((entry) =>
        entry?.type === harmonyType && stemValueUrl(entry) === url);
      if (!duplicate) {
        pushStem(
          harmonyType,
          {
            type: harmonyType,
            label: rawValue && typeof rawValue === 'object'
              ? rawValue.label || humanizeStemLabel(part)
              : humanizeStemLabel(part),
            url,
          },
          { mirrorHarmony: false },
        );
      }
    });
  }

  const clickTrack = stemValueUrl(payload.click_track);
  if (clickTrack) payload.click_track = clickTrack;
  const voiceGuide = stemValueUrl(payload.voice_guide);
  if (voiceGuide) payload.voice_guide = voiceGuide;
  const padTrack = stemValueUrl(payload.pad_track);
  if (padTrack) payload.pad_track = padTrack;
  const fullMix = stemValueUrl(payload.full_mix || payload.fullMix);
  if (fullMix) {
    payload.full_mix = fullMix;
    payload.fullMix = fullMix;
  }

  if (hasStemEntries) payload.stems = normalizedStems;
  if (Object.keys(normalizedHarmonies).length) payload.harmonies = normalizedHarmonies;
  return payload;
}

function summarizeStemPayload(input = {}) {
  const normalized = normalizeStemPayload(input);
  const stemTypes = new Set();
  const harmonies = normalized.harmonies && typeof normalized.harmonies === 'object'
    ? normalized.harmonies
    : {};

  if (normalized.stems && typeof normalized.stems === 'object') {
    Object.entries(normalized.stems).forEach(([rawKey, rawValue]) => {
      const url = stemValueUrl(rawValue);
      if (!url) return;
      const rawType = rawValue && typeof rawValue === 'object' ? rawValue.type : rawKey;
      const rawLabel = rawValue && typeof rawValue === 'object' ? rawValue.label : '';
      const canonical = canonicalizeStemType(rawType || rawKey, rawLabel, rawKey);
      if (canonical) stemTypes.add(canonical);
    });
  }

  const harmonyCount = Object.values(harmonies)
    .map((value) => stemValueUrl(value))
    .filter(Boolean)
    .length;

  return {
    normalized,
    stemTypes,
    harmonyCount,
  };
}

function evaluateStemPayloadForReuse(input = {}, options = {}) {
  const summary = summarizeStemPayload(input);
  const { stemTypes, harmonyCount } = summary;
  const needsAdvanced = options.enhanceInstrumentStems !== false;
  const needsHarmonies = options.separateHarmonies !== false;

  const hasBaseStems = (
    stemTypes.has('drums')
    && stemTypes.has('bass')
    && stemTypes.has('vocals')
  );
  const hasAdvancedStems = !needsAdvanced || (
    stemTypes.has('keys')
    && stemTypes.has('guitars')
  );
  const hasRequestedHarmonies = !needsHarmonies || harmonyCount > 0;

  return {
    ...summary,
    usable: hasBaseStems && hasAdvancedStems && hasRequestedHarmonies,
  };
}

function pickReusableStemCandidate(candidates = [], options = {}) {
  const usableCandidates = candidates
    .filter(Boolean)
    .map((candidate) => {
      const evaluation = evaluateStemPayloadForReuse(candidate.payload || {}, options);
      return {
        ...candidate,
        evaluation,
        updatedAt: (
          candidate.updatedAt
          || candidate.payload?.updatedAt
          || candidate.payload?.completedAt
          || candidate.payload?.createdAt
          || ''
        ),
      };
    })
    .filter((candidate) => {
      const status = String(candidate.status || '').toUpperCase();
      return status !== 'FAILED' && candidate.evaluation.usable;
    })
    .sort((a, b) => (
      new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime()
    ));

  return usableCandidates[0] || null;
}

async function findReusableStemCandidateForSong(env, orgId, songId, options = {}) {
  const resolvedSongId = String(songId || '').trim();
  if (!resolvedSongId) return null;

  const candidates = [];
  const existingStemEntry = await kvGet(env, orgKey(orgId, `stems:${resolvedSongId}`), null);
  if (existingStemEntry && typeof existingStemEntry === 'object') {
    candidates.push({
      source: 'stems_store',
      updatedAt: existingStemEntry.updatedAt || existingStemEntry.createdAt,
      payload: existingStemEntry,
    });
  }

  const songMap = await kvGet(env, orgKey(orgId, 'songLibrary'), {});
  const songEntry = songMap && typeof songMap === 'object'
    ? songMap[resolvedSongId]
    : null;
  const latestJob = songEntry?.latestStemsJob && typeof songEntry.latestStemsJob === 'object'
    ? songEntry.latestStemsJob
    : null;

  if (latestJob?.result && typeof latestJob.result === 'object') {
    candidates.push({
      source: latestJob.source || 'song_library',
      status: latestJob.status,
      updatedAt: latestJob.updatedAt || latestJob.completedAt || songEntry?.updatedAt,
      payload: {
        ...latestJob.result,
        title: songEntry?.title,
        artist: songEntry?.artist,
        key: latestJob.key ?? latestJob.result.key,
        bpm: latestJob.bpm ?? latestJob.result.bpm,
        updatedAt: latestJob.updatedAt || songEntry?.updatedAt,
        completedAt: latestJob.completedAt,
        jobId: latestJob.jobId || latestJob.id,
      },
    });
  }

  return pickReusableStemCandidate(candidates, options);
}

function stemObjectPublicUrl(origin, key) {
  return `${origin}/sync/stems/source/${encodeURIComponent(key)}`;
}

function stemSourcePublicUrl(origin, key) {
  return stemObjectPublicUrl(origin, key);
}

function clipText(value, max = 12000) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

const MUSIC_KEY_PITCH_CLASS = {
  C: 0,
  'B#': 0,
  'C#': 1,
  Db: 1,
  D: 2,
  'D#': 3,
  Eb: 3,
  E: 4,
  Fb: 4,
  F: 5,
  'E#': 5,
  'F#': 6,
  Gb: 6,
  G: 7,
  'G#': 8,
  Ab: 8,
  A: 9,
  'A#': 10,
  Bb: 10,
  B: 11,
  Cb: 11,
};

function parseMusicKey(value) {
  const raw = String(value || '')
    .replace(/♯/g, '#')
    .replace(/♭/g, 'b')
    .trim();
  if (!raw) return { raw: '', tonic: '', pitchClass: null, mode: '' };
  const match = raw.match(/^([A-Ga-g])([#b]?)(.*)$/);
  if (!match) return { raw, tonic: raw, pitchClass: null, mode: '' };
  const tonic = `${match[1].toUpperCase()}${match[2] || ''}`;
  const tail = String(match[3] || '').trim().toLowerCase();
  const mode = /\bmin(or)?\b/.test(tail) || /^m\b/.test(tail) || /m$/.test(raw.toLowerCase())
    ? 'minor'
    : 'major';
  return {
    raw,
    tonic,
    pitchClass: Object.prototype.hasOwnProperty.call(MUSIC_KEY_PITCH_CLASS, tonic)
      ? MUSIC_KEY_PITCH_CLASS[tonic]
      : null,
    mode,
  };
}

function normalizeRecommendationSong(song = {}) {
  return {
    id: clipText(String(song.id || ''), 80),
    title: clipText(String(song.title || song.name || ''), 120),
    artist: clipText(String(song.artist || ''), 120),
    key: clipText(String(song.key || song.originalKey || ''), 12),
    bpm: Number.isFinite(Number(song.bpm)) ? Number(song.bpm) : null,
    tags: Array.isArray(song.tags) ? song.tags.filter(Boolean).map((tag) => String(tag)) : [],
  };
}

function recommendationSongKey(song) {
  return `${normalizeLower(song?.title)}::${normalizeLower(song?.artist)}`;
}

function scoreRecommendationCandidate(candidate, currentSong = {}) {
  let score = 0;
  const reasons = [];

  const currentKey = parseMusicKey(currentSong.key);
  const candidateKey = parseMusicKey(candidate.key);
  if (currentKey.pitchClass != null && candidateKey.pitchClass != null) {
    const diff = Math.abs(currentKey.pitchClass - candidateKey.pitchClass);
    const wrappedDiff = Math.min(diff, 12 - diff);
    if (wrappedDiff === 0) {
      score += currentKey.mode === candidateKey.mode ? 5 : 4;
      reasons.push('same key center');
    } else if (wrappedDiff === 5 || wrappedDiff === 7) {
      score += 4;
      reasons.push('strong key transition');
    } else if (wrappedDiff <= 2) {
      score += 2;
      reasons.push('close harmonic move');
    }
  }

  const currentBpm = Number.isFinite(Number(currentSong.bpm)) ? Number(currentSong.bpm) : null;
  if (currentBpm != null && candidate.bpm != null) {
    const bpmDiff = Math.abs(candidate.bpm - currentBpm);
    if (bpmDiff <= 4) {
      score += 3;
      reasons.push('tempo matches closely');
    } else if (bpmDiff <= 10) {
      score += 2;
      reasons.push('tempo stays comfortable');
    } else if (bpmDiff <= 18) {
      score += 1;
      reasons.push('manageable tempo shift');
    } else if (bpmDiff >= 35) {
      score -= 2;
    }
  }

  const lowerTags = Array.isArray(candidate.tags) ? candidate.tags.map(normalizeLower) : [];
  if (lowerTags.some((tag) => ['worship', 'service', 'setlist'].includes(tag))) {
    score += 1;
  }

  return {
    ...candidate,
    score,
    reasonSummary: reasons.length > 0 ? reasons.join(', ') : 'good worship set transition',
  };
}

function collectRecommendationCandidates(songMap = {}, songPool = [], currentSong = {}, setlistContext = []) {
  const pool = [];
  const seen = new Set();
  const blocked = new Set([
    normalizeLower(currentSong?.title),
    ...((Array.isArray(setlistContext) ? setlistContext : []).map((song) => normalizeLower(song?.title))),
  ]);

  const sources = [
    ...Object.values(songMap || {}),
    ...(Array.isArray(songPool) ? songPool : []),
  ];

  for (const rawSong of sources) {
    const song = normalizeRecommendationSong(rawSong);
    if (!song.title) continue;
    if (blocked.has(normalizeLower(song.title))) continue;
    const key = recommendationSongKey(song);
    if (seen.has(key)) continue;
    seen.add(key);
    pool.push(song);
  }

  return pool
    .map((song) => scoreRecommendationCandidate(song, currentSong))
    .sort((a, b) => (b.score - a.score) || a.title.localeCompare(b.title));
}

function normalizeAiRecommendations(aiItems = [], candidates = [], currentKey = '') {
  if (!Array.isArray(aiItems) || aiItems.length === 0) return [];
  const byTitle = new Map(candidates.map((candidate) => [normalizeLower(candidate.title), candidate]));
  const picked = [];
  const seen = new Set();
  for (const item of aiItems) {
    const title = clipText(String(item?.title || ''), 120);
    if (!title) continue;
    const matched = byTitle.get(normalizeLower(title));
    const dedupeKey = recommendationSongKey({ title, artist: matched?.artist || item?.artist || '' });
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    picked.push({
      title: matched?.title || title,
      artist: clipText(String(matched?.artist || item?.artist || ''), 120),
      reason: clipText(String(item?.reason || matched?.reasonSummary || 'Flows well with the current song.'), 300),
      suggestedKey: clipText(String(item?.suggestedKey || matched?.key || currentKey), 12),
    });
    if (picked.length >= 3) break;
  }
  return picked;
}

function buildFallbackRecommendations(candidates = [], currentKey = '') {
  return candidates.slice(0, 3).map((candidate) => ({
    title: candidate.title,
    artist: candidate.artist,
    reason: clipText(
      `${candidate.reasonSummary.charAt(0).toUpperCase()}${candidate.reasonSummary.slice(1)}.`,
      300,
    ),
    suggestedKey: clipText(String(candidate.key || currentKey), 12),
  }));
}

const RESET_CODE_TTL_MS = 15 * 60 * 1000;
const VERIFICATION_CODE_TTL_MS = 10 * 60 * 1000;
const MAX_TRUSTED_DEVICES = 8;
const DEFAULT_BIRTHDAY_TIME_ZONE = 'America/New_York';
const AUTH_ALWAYS_VERIFY_ROLES = new Set([
  'admin',
  'manager',
  'md',
  'music_director',
  'worship_leader',
  'leader',
]);
const INVITE_LANDING_BASE_URL = 'https://www.ultimatelabs.co/invite';
const PLAYBACK_IOS_URL = 'https://apps.apple.com/app/ultimate-playback';
const PLAYBACK_ANDROID_URL = 'https://play.google.com/store/apps/details?id=com.ultimatemusician.playback';
const PLAYBACK_DESKTOP_URL = 'https://www.ultimatelabs.co/portal';

function makeNumericCode(len = 6) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let code = '';
  for (const byte of bytes) code += String(byte % 10);
  return code.padEnd(len, '0').slice(0, len);
}

function normalizeLower(str) {
  return String(str || '').trim().toLowerCase();
}

function normalizeRoleKey(str) {
  return normalizeLower(str)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function sanitizeDeviceId(value) {
  const raw = String(value || '').trim();
  return raw ? raw.slice(0, 128) : '';
}

function normalizeVerificationPurpose(value) {
  const normalized = normalizeRoleKey(value);
  if (normalized === 'signup' || normalized === 'register') return 'signup';
  if (normalized === 'login' || normalized === 'signin' || normalized === 'sign_in') return 'login';
  return '';
}

function isUserVerified(user) {
  if (!user || typeof user !== 'object') return false;
  // Legacy accounts existed before verification and should continue to work.
  if (!hasOwn(user, 'verifiedAt')) return true;
  return Boolean(user.verifiedAt);
}

function shouldAlwaysVerifyAuth(role, grantedRole) {
  return [role, grantedRole].some(candidate =>
    AUTH_ALWAYS_VERIFY_ROLES.has(normalizeRoleKey(candidate))
  );
}

function hasTrustedDevice(user, deviceId) {
  const normalized = sanitizeDeviceId(deviceId);
  if (!normalized) return false;
  return Array.isArray(user?.trustedDevices)
    && user.trustedDevices.some(device => device?.id === normalized);
}

function rememberTrustedDevice(user, deviceId) {
  const normalized = sanitizeDeviceId(deviceId);
  if (!normalized) return;
  const now = new Date().toISOString();
  const devices = Array.isArray(user?.trustedDevices)
    ? user.trustedDevices.filter(device => device?.id)
    : [];
  const existing = devices.find(device => device.id === normalized);
  if (existing) {
    existing.lastSeenAt = now;
  } else {
    devices.unshift({ id: normalized, createdAt: now, lastSeenAt: now });
  }
  user.trustedDevices = devices.slice(0, MAX_TRUSTED_DEVICES);
}

function clearUserVerification(user) {
  if (user && user.verification) delete user.verification;
}

async function setUserVerification(user, { purpose, deviceId = '' }) {
  const code = makeNumericCode();
  user.verification = {
    purpose,
    codeHash: await sha256(code),
    expiresAt: Date.now() + VERIFICATION_CODE_TTL_MS,
    deviceId: sanitizeDeviceId(deviceId) || null,
    sentAt: new Date().toISOString(),
  };
  return code;
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

// ── Analytics Engine ──────────────────────────────────────────────────────
// Fire-and-forget. Never throws. Safe to call anywhere.
function trackEvent(env, orgId, event, metadata = {}) {
  if (!env.UM_ANALYTICS) return;
  try {
    env.UM_ANALYTICS.writeDataPoint({
      blobs: [orgId || '', event, JSON.stringify(metadata).slice(0, 512)],
      doubles: [Date.now()],
      indexes: [orgId || ''],
    });
  } catch (err) {
    console.log('[analytics] writeDataPoint failed:', err?.message);
  }
}

// ── Cloudflare Turnstile ──────────────────────────────────────────────────
// Skips gracefully when TURNSTILE_SECRET is not set (local dev / preview).
async function verifyTurnstile(env, token, ip = '') {
  const secret = env.TURNSTILE_SECRET || '';
  if (!secret) return { success: true, skipped: true };
  if (!token) return { success: false, error: 'Human verification token required. Please refresh and try again.' };
  try {
    const form = new FormData();
    form.append('secret', secret);
    form.append('response', token);
    if (ip) form.append('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    if (!res.ok) return { success: true, skipped: true }; // fail open on Turnstile outage
    const data = await res.json();
    if (data.success) return { success: true };
    const code = (data['error-codes'] || [])[0] || 'verification-failed';
    return { success: false, error: `Verification failed (${code}). Please try again.` };
  } catch {
    return { success: true, skipped: true }; // fail open on network error
  }
}

// ── Rate Limiting ─────────────────────────────────────────────────────────
// KV-based sliding window counter. Fails open on KV error.
// key:    e.g. 'login' or 'register' — combined with IP + time window
// max:    max attempts allowed in the window
// windowSeconds: window size in seconds
async function checkRateLimit(env, ip, key, max, windowSeconds) {
  if (!env.STORE || !ip) return { limited: false };
  const window = Math.floor(Date.now() / (windowSeconds * 1000));
  const rlKey = `rl:${key}:${ip.replace(/:/g, '_')}:${window}`;
  try {
    const current = parseInt((await env.STORE.get(rlKey)) || '0', 10);
    if (current >= max) {
      return { limited: true, retryAfter: windowSeconds };
    }
    env.STORE.put(rlKey, String(current + 1), { expirationTtl: windowSeconds + 60 }).catch(() => {});
    return { limited: false };
  } catch {
    return { limited: false }; // fail open
  }
}

// ── D1 Write-Through Helpers ──────────────────────────────────────────────
// All writes are fire-and-forget so they never block KV latency.
function _d1Run(env, stmt) {
  if (!env.UM_DB) return;
  Promise.resolve().then(() => stmt.run()).catch(err => {
    console.log('[d1] write-through error:', err?.message || String(err));
  });
}

function d1UpsertOrg(env, org) {
  if (!org?.orgId) return;
  _d1Run(env, env.UM_DB?.prepare(
    `INSERT INTO orgs (orgId, name, city, secretKeyHash, createdAt, parentOrgId)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(orgId) DO UPDATE SET
       name=excluded.name, city=excluded.city,
       secretKeyHash=excluded.secretKeyHash, parentOrgId=excluded.parentOrgId`
  ).bind(org.orgId, org.name||'', org.city||'', org.secretKeyHash||'',
    org.createdAt||new Date().toISOString(), org.parentOrgId||null));
}

function d1UpsertService(env, orgId, svc) {
  if (!svc?.id) return;
  _d1Run(env, env.UM_DB?.prepare(
    `INSERT INTO services (id, orgId, name, date, time, type, locked, publishedAt, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, date=excluded.date, time=excluded.time,
       type=excluded.type, locked=excluded.locked, publishedAt=excluded.publishedAt`
  ).bind(svc.id, orgId, svc.name||svc.title||'',
    svc.date||svc.serviceDate||'', svc.time||svc.startTime||'',
    svc.type||'standard', svc.locked?1:0, svc.publishedAt||null,
    svc.createdAt||new Date().toISOString()));
}

function d1UpsertPerson(env, orgId, p) {
  if (!p?.id) return;
  _d1Run(env, env.UM_DB?.prepare(
    `INSERT INTO people (id, orgId, email, name, phone, role, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       email=excluded.email, name=excluded.name,
       phone=excluded.phone, role=excluded.role`
  ).bind(p.id, orgId, normalizeLower(p.email||''), p.name||'',
    p.phone||'', p.role||(p.roles?.[0])||'',
    p.createdAt||new Date().toISOString()));
}

function d1UpsertSong(env, orgId, s) {
  if (!s?.id) return;
  _d1Run(env, env.UM_DB?.prepare(
    `INSERT INTO songs (id, orgId, title, artist, key, bpm, tags, notes, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title=excluded.title, artist=excluded.artist, key=excluded.key,
       bpm=excluded.bpm, tags=excluded.tags, notes=excluded.notes`
  ).bind(s.id, orgId, s.title||'', s.artist||'', s.key||'',
    Number.isFinite(Number(s.bpm)) ? Number(s.bpm) : null,
    JSON.stringify(Array.isArray(s.tags) ? s.tags : []),
    s.notes||s.chordChart||'', s.createdAt||new Date().toISOString()));
}

function d1UpsertAssignmentResponse(env, orgId, serviceId, { personEmail, personId, role, status, note, respondedAt }) {
  _d1Run(env, env.UM_DB?.prepare(
    `INSERT INTO assignment_responses (id, orgId, serviceId, personEmail, personId, role, status, note, respondedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`
  ).bind(makeId(16), orgId, serviceId,
    normalizeLower(personEmail||''), normalizeLower(personId||''),
    role||'', status||'pending', note||'',
    respondedAt||new Date().toISOString()));
}

function d1InsertMessage(env, orgId, msg) {
  if (!msg?.id) return;
  _d1Run(env, env.UM_DB?.prepare(
    `INSERT OR IGNORE INTO messages (id, orgId, fromEmail, toEmail, subject, body, read, messageType, serviceId, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(msg.id, orgId, normalizeLower(msg.fromEmail||''),
    normalizeLower(msg.to||''), msg.subject||'',
    msg.message||msg.body||'', msg.read?1:0,
    msg.messageType||'general', msg.serviceId||null,
    msg.timestamp||msg.createdAt||new Date().toISOString()));
}

function d1InsertReminderSent(env, orgId, serviceId, daysOut, memberEmail) {
  if (!orgId || !serviceId || !memberEmail) return;
  _d1Run(env, env.UM_DB?.prepare(
    `INSERT OR IGNORE INTO reminder_sent (orgId, serviceId, daysOut, memberEmail, sentAt)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(orgId, serviceId, daysOut, normalizeLower(memberEmail),
    new Date().toISOString()));
}

function pickDefinedStemFields(value = {}) {
  const next = {};
  const fields = [
    'stems',
    'harmonies',
    'click_track',
    'voice_guide',
    'pad_track',
    'fullMix',
    'full_mix',
    'lyrics',
    'chordChart',
    'chord_chart',
    'sections',
    'waveformPeaks',
    'waveform_peaks',
    'durationSec',
    'duration_sec',
    'timeSig',
    'time_signature',
    'key',
    'bpm',
    'tempo',
  ];

  for (const field of fields) {
    if (
      Object.prototype.hasOwnProperty.call(value || {}, field)
      && value[field] !== undefined
      && value[field] !== null
      && value[field] !== ''
    ) {
      next[field] = value[field];
    }
  }

  return next;
}

async function syncSongLibraryStemSnapshot(env, orgId, songId, stemEntry = {}, songPatch = {}) {
  const resolvedSongId = String(songId || '').trim();
  if (!resolvedSongId) return null;

  const songMap = await kvGet(env, orgKey(orgId, 'songLibrary'), {});
  const previousSong = songMap[resolvedSongId] && typeof songMap[resolvedSongId] === 'object'
    ? songMap[resolvedSongId]
    : { id: resolvedSongId };
  const previousJob = previousSong.latestStemsJob && typeof previousSong.latestStemsJob === 'object'
    ? previousSong.latestStemsJob
    : {};
  const previousResult = previousJob.result && typeof previousJob.result === 'object'
    ? previousJob.result
    : {};
  const nextUpdatedAt = stemEntry.updatedAt || new Date().toISOString();
  const nextResult = {
    ...previousResult,
    ...pickDefinedStemFields(stemEntry),
  };

  const nextSong = {
    ...previousSong,
    id: resolvedSongId,
    createdAt: previousSong.createdAt || nextUpdatedAt,
    updatedAt: nextUpdatedAt,
  };

  if (songPatch.title != null) {
    const title = String(songPatch.title || '').trim();
    if (title) nextSong.title = title;
  } else if (!nextSong.title && stemEntry.title) {
    nextSong.title = String(stemEntry.title || '').trim();
  }

  if (songPatch.artist != null) {
    const artist = String(songPatch.artist || '').trim();
    if (artist) nextSong.artist = artist;
  } else if (!nextSong.artist && stemEntry.artist) {
    nextSong.artist = String(stemEntry.artist || '').trim();
  }

  if (songPatch.youtubeLink != null) {
    const youtubeLink = String(songPatch.youtubeLink || '').trim();
    if (youtubeLink) nextSong.youtubeLink = youtubeLink;
  }

  const nextKey = String(stemEntry.key || '').trim();
  if (nextKey) {
    nextSong.key = nextKey;
    nextSong.originalKey = nextKey;
  }

  const nextBpm = Number(stemEntry.bpm);
  if (Number.isFinite(nextBpm) && nextBpm > 0) {
    nextSong.bpm = nextBpm;
  }

  nextSong.latestStemsJob = {
    ...previousJob,
    id: String(stemEntry.jobId || previousJob.id || `manual_${makeId(12)}`),
    jobId: String(stemEntry.jobId || previousJob.jobId || '').trim(),
    status: 'COMPLETED',
    source: String(stemEntry.source || previousJob.source || 'desktop_upload').trim(),
    key: stemEntry.key ?? previousJob.key ?? nextResult.key ?? null,
    bpm: stemEntry.bpm ?? previousJob.bpm ?? nextResult.bpm ?? null,
    updatedAt: nextUpdatedAt,
    completedAt: nextUpdatedAt,
    result: nextResult,
  };

  songMap[resolvedSongId] = nextSong;
  await kvPut(env, orgKey(orgId, 'songLibrary'), songMap);
  return nextSong;
}

function globalMemberBlockoutsKey(email) {
  return `memberBlockouts:${normalizeLower(email)}`;
}

function acceptedAssignmentsIndexKey(email) {
  return `acceptedAssignments:${normalizeLower(email)}`;
}

function normalizeDateKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return '';
  return [
    parsed.getFullYear(),
    String(parsed.getMonth() + 1).padStart(2, '0'),
    String(parsed.getDate()).padStart(2, '0'),
  ].join('-');
}

function normalizeTimeKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const match = raw.match(/(\d{1,2}):(\d{2})/);
  if (!match) return '';
  return `${String(Number(match[1]) || 0).padStart(2, '0')}:${match[2]}`;
}

function buildServiceTimeSlot(serviceDate, serviceTime) {
  const dateKey = normalizeDateKey(serviceDate);
  const timeKey = normalizeTimeKey(serviceTime);
  if (!dateKey || !timeKey) return '';
  return `${dateKey} ${timeKey}`;
}

function normalizeBlockoutEntry(value = {}, fallback = {}) {
  const email = normalizeLower(value.email || fallback.email || '');
  const date = normalizeDateKey(value.date || fallback.date || '');
  if (!email || !date) return null;

  const createdAt =
    value.created_at
    || value.createdAt
    || fallback.created_at
    || fallback.createdAt
    || new Date().toISOString();

  return {
    id: String(value.id || fallback.id || `blk_${Date.now()}_${makeId(5)}`).trim(),
    email,
    date,
    reason: clipText(value.reason || fallback.reason, 280),
    name: clipText(value.name || fallback.name, 160),
    phone: String(value.phone || fallback.phone || '').trim(),
    personId: String(value.personId || fallback.personId || '').trim(),
    created_at: createdAt,
    updated_at:
      value.updated_at
      || value.updatedAt
      || fallback.updated_at
      || fallback.updatedAt
      || createdAt,
  };
}

function mergeBlockoutEntries(...lists) {
  const merged = new Map();

  for (const list of lists) {
    for (const rawEntry of Array.isArray(list) ? list : []) {
      const entry = normalizeBlockoutEntry(rawEntry);
      if (!entry) continue;
      const key = `${entry.email}:${entry.date}`;
      const current = merged.get(key);
      merged.set(key, {
        ...(current || {}),
        ...entry,
        created_at: current?.created_at || entry.created_at,
      });
    }
  }

  return Array.from(merged.values()).sort((left, right) => {
    return `${left.date}:${left.email}`.localeCompare(`${right.date}:${right.email}`);
  });
}

function removeBlockoutEntries(list = [], { id = '', email = '', date = '' } = {}) {
  const normalizedId = String(id || '').trim();
  const normalizedEmail = normalizeLower(email);
  const normalizedDate = normalizeDateKey(date);

  return mergeBlockoutEntries(list).filter((entry) => {
    if (normalizedId && entry.id === normalizedId) return false;
    if (normalizedEmail && normalizedDate) {
      return !(entry.email === normalizedEmail && entry.date === normalizedDate);
    }
    if (normalizedEmail && !normalizedDate && !normalizedId) {
      return entry.email !== normalizedEmail;
    }
    return true;
  });
}

function syncPeopleBlockoutDates(people = [], email, nextBlockouts = []) {
  const normalizedEmail = normalizeLower(email);
  if (!normalizedEmail) {
    return { didUpdate: false, nextPeople: Array.isArray(people) ? people : [] };
  }

  const normalizedBlockouts = mergeBlockoutEntries(nextBlockouts)
    .filter((entry) => entry.email === normalizedEmail)
    .map((entry) => ({
      id: entry.id,
      date: entry.date,
      reason: entry.reason || '',
      name: entry.name || '',
      email: entry.email,
      created_at: entry.created_at || null,
      updated_at: entry.updated_at || null,
    }));

  let didUpdate = false;
  const nextPeople = (Array.isArray(people) ? people : []).map((person) => {
    if (normalizeLower(person?.email || '') !== normalizedEmail) return person;
    didUpdate = true;
    return {
      ...person,
      blockout_dates: normalizedBlockouts,
      updatedAt: new Date().toISOString(),
    };
  });

  return { didUpdate, nextPeople };
}

function normalizeAcceptedAssignmentEntry(value = {}) {
  const email = normalizeLower(value.email || value.personEmail || '');
  const orgId = String(value.orgId || '').trim();
  const serviceId = String(value.serviceId || '').trim();
  if (!email || !orgId || !serviceId) return null;

  const serviceDate = normalizeDateKey(value.serviceDate || value.date || '');
  const serviceTime = normalizeTimeKey(value.serviceTime || value.time || '');

  return {
    email,
    orgId,
    orgName: String(value.orgName || '').trim(),
    serviceId,
    serviceName: String(value.serviceName || '').trim(),
    serviceDate,
    serviceTime,
    slot: buildServiceTimeSlot(serviceDate, serviceTime),
    respondedAt:
      value.respondedAt
      || value.responded_at
      || value.timestamp
      || new Date().toISOString(),
  };
}

function acceptedAssignmentIdentityKey(entry = {}) {
  return `${String(entry.orgId || '').trim()}:${String(entry.serviceId || '').trim()}`;
}

function findAcceptedAssignmentConflict(entries = [], candidateValue = {}) {
  const candidate = normalizeAcceptedAssignmentEntry(candidateValue);
  if (!candidate?.slot) return null;

  for (const rawEntry of Array.isArray(entries) ? entries : []) {
    const entry = normalizeAcceptedAssignmentEntry(rawEntry);
    if (!entry?.slot) continue;
    if (acceptedAssignmentIdentityKey(entry) === acceptedAssignmentIdentityKey(candidate)) {
      continue;
    }
    if (entry.slot === candidate.slot) {
      return entry;
    }
  }

  return null;
}

function passwordResetKey(orgId, email) {
  return `${orgKey(orgId, 'passwordReset')}:${email}`;
}

function oneTimeCodeEmailHtml({ title, intro, code, footer }) {
  return `
    <div style="background:#020617;padding:40px;font-family:sans-serif;color:#F9FAFB;max-width:480px;margin:auto;border-radius:16px">
      <p style="color:#818CF8;font-weight:700;font-size:13px;letter-spacing:1px;text-transform:uppercase;margin:0 0 8px">CineStage™</p>
      <h1 style="font-size:26px;margin:0 0 12px">${title}</h1>
      <p style="color:#9CA3AF;margin:0 0 16px">${intro}</p>
      <div style="background:#0B1120;border:1px solid #1F2937;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px">
        <span style="font-size:48px;font-weight:900;letter-spacing:12px;color:#818CF8">${code}</span>
      </div>
      <p style="color:#4B5563;font-size:12px;margin:0">${footer}</p>
    </div>
  `;
}

async function sendOneTimeCodeEmail(env, {
  to,
  subject,
  title,
  intro,
  footer,
  code,
  logTag = 'sync/auth/email',
  missingConfigMessage = 'Email delivery is not configured',
  failureMessage = 'Failed to send email',
}) {
  const resendApiKey = env.RESEND_API_KEY || '';
  const fromEmail = env.FROM_EMAIL || '';
  const fromName = env.FROM_EMAIL_NAME || 'CineStage';

  if (!resendApiKey || !fromEmail) {
    throw new Error(missingConfigMessage);
  }

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
      html: oneTimeCodeEmailHtml({ title, intro, code, footer }),
      text: [intro, '', `Code: ${code}`, '', footer].join('\n'),
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    console.log(`[${logTag}] resend failed`, detail);
    throw new Error(failureMessage);
  }
}

async function sendPasswordResetEmail(env, { to, name, code, orgName }) {
  const safeName = name || 'there';
  const safeOrgName = orgName || 'your team';
  return sendOneTimeCodeEmail(env, {
    to,
    subject: `${code} is your Ultimate Playback reset code`,
    title: 'Reset your password',
    intro: `Hi ${safeName}, use this code to reset your Ultimate Playback password for ${safeOrgName}. It expires in 15 minutes.`,
    footer: 'If you did not request this reset, you can ignore this email.',
    code,
    logTag: 'sync/auth/forgot-password',
    missingConfigMessage: 'Password reset email is not configured',
    failureMessage: 'Failed to send password reset email',
  });
}

async function sendSignupVerificationEmail(env, { to, name, code, orgName }) {
  const safeName = name || 'there';
  const safeOrgName = orgName || 'your team';
  return sendOneTimeCodeEmail(env, {
    to,
    subject: `${code} is your Ultimate Playback verification code`,
    title: 'Verify your account',
    intro: `Hi ${safeName}, use this code to finish creating your Ultimate Playback account for ${safeOrgName}. It expires in 10 minutes.`,
    footer: 'If you did not create this account, you can ignore this email.',
    code,
    logTag: 'sync/auth/register',
    missingConfigMessage: 'Account verification email is not configured',
    failureMessage: 'Failed to send verification email',
  });
}

async function sendLoginVerificationEmail(env, { to, name, code, orgName }) {
  const safeName = name || 'there';
  const safeOrgName = orgName || 'your team';
  return sendOneTimeCodeEmail(env, {
    to,
    subject: `${code} is your Ultimate Playback sign-in code`,
    title: 'Approve this sign in',
    intro: `Hi ${safeName}, use this code to finish signing in to Ultimate Playback for ${safeOrgName}. It expires in 10 minutes.`,
    footer: 'If this sign-in was not you, change your password and tell your admin or manager.',
    code,
    logTag: 'sync/auth/login',
    missingConfigMessage: 'Login verification email is not configured',
    failureMessage: 'Failed to send sign-in verification email',
  });
}

function birthdayEmailHtml({ recipientName, orgName }) {
  const safeRecipientName = escapeHtml(recipientName || 'there');
  const safeOrgName = escapeHtml(orgName || 'your worship team');

  return `
    <div style="background:#020617;padding:32px 20px;font-family:Arial,sans-serif;color:#F8FAFC">
      <div style="max-width:560px;margin:0 auto;background:linear-gradient(180deg,#0B1120 0%,#0F172A 100%);border:1px solid #1F2937;border-radius:28px;overflow:hidden;box-shadow:0 20px 60px rgba(2,6,23,0.45)">
        <div style="padding:32px 32px 20px;background:radial-gradient(circle at top left,rgba(99,102,241,0.22),transparent 55%),radial-gradient(circle at top right,rgba(16,185,129,0.18),transparent 40%)">
          <p style="margin:0 0 10px;color:#A5B4FC;font-size:12px;font-weight:800;letter-spacing:1.4px;text-transform:uppercase">Ultimate Playback</p>
          <h1 style="margin:0 0 12px;font-size:30px;line-height:1.1;color:#FFFFFF">Happy Birthday, ${safeRecipientName}!</h1>
          <p style="margin:0;color:#CBD5E1;font-size:15px;line-height:1.7">
            Your worship family at ${safeOrgName} is celebrating you today. We are grateful for your heart, your service, and the way you strengthen the team.
          </p>
        </div>

        <div style="padding:0 32px 32px">
          <div style="margin:20px 0 24px;padding:20px;border:1px solid #1E293B;border-radius:20px;background:#020617">
            <p style="margin:0;color:#F8FAFC;font-size:16px;line-height:1.8">
              Praying that this new year brings joy, favor, strength, and fresh grace for everything ahead.
            </p>
          </div>

          <div style="padding:18px 20px;border:1px solid #1F2937;border-radius:18px;background:rgba(15,23,42,0.88)">
            <p style="margin:0;color:#E2E8F0;font-size:14px;font-weight:700">
              With love from the worship team at ${safeOrgName}
            </p>
            <p style="margin:10px 0 0;color:#94A3B8;font-size:13px;line-height:1.7">
              This birthday note was sent from your Ultimate Playback team workspace.
            </p>
          </div>
        </div>
      </div>
    </div>
  `;
}

async function sendBirthdayGreetingEmail(env, { to, name, orgName }) {
  const resendApiKey = env.RESEND_API_KEY || '';
  const fromEmail = env.FROM_EMAIL || '';
  const fromName = orgName || env.FROM_EMAIL_NAME || 'CineStage';

  if (!resendApiKey || !fromEmail || !to) return false;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${resendApiKey}`,
    },
    body: JSON.stringify({
      from: `${fromName} <${fromEmail}>`,
      to: [to],
      subject: `Happy Birthday from ${orgName || 'your worship team'}`,
      html: birthdayEmailHtml({
        recipientName: name,
        orgName,
      }),
      text: [
        `Happy Birthday, ${name || 'there'}!`,
        '',
        `Your worship family at ${orgName || 'your worship team'} is celebrating you today.`,
        'We are grateful for your heart, your service, and the way you strengthen the team.',
        '',
        `With love from the worship team at ${orgName || 'your organization'}.`,
      ].join('\n'),
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    console.log('[sync/birthday/email] resend failed', detail);
    throw new Error('Failed to send birthday email');
  }

  return true;
}

const EXPO_PUSH_API_URL = 'https://exp.host/--/api/v2/push/send';
const PUSH_ADMIN_ROLES = new Set([
  'admin',
  'md',
  'music_director',
  'worship_leader',
  'leader',
]);

function normalizePushPreferences(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    assignments: source.assignments !== false,
    messages: source.messages !== false,
    reminders: source.reminders !== false,
  };
}

function normalizePushDeviceRecord(record = {}) {
  const token = String(record.token || '').trim();
  if (!token) return null;

  const now = new Date().toISOString();
  return {
    token,
    email: normalizeLower(record.email || ''),
    name: clipText(record.name || '', 120),
    platform: normalizeLower(record.platform || ''),
    deviceId: sanitizeDeviceId(record.deviceId || ''),
    app: normalizeRoleKey(record.app || 'ultimate_playback') || 'ultimate_playback',
    grantedRole: normalizeRoleKey(record.grantedRole || record.role || ''),
    preferences: normalizePushPreferences(
      record.preferences || record.notificationPreferences || {},
    ),
    createdAt: record.createdAt || now,
    updatedAt: now,
  };
}

async function getPushDevices(env, orgId) {
  return kvGet(env, orgKey(orgId, 'pushDevices'), []);
}

async function savePushDevices(env, orgId, devices = []) {
  const nextDevices = [];
  const seenTokens = new Set();

  for (const rawDevice of Array.isArray(devices) ? devices : []) {
    const normalized = normalizePushDeviceRecord(rawDevice);
    if (!normalized) continue;
    if (seenTokens.has(normalized.token)) continue;
    seenTokens.add(normalized.token);
    nextDevices.push(normalized);
  }

  await kvPut(env, orgKey(orgId, 'pushDevices'), nextDevices);
  return nextDevices;
}

async function registerPushDevice(env, orgId, record = {}) {
  const normalized = normalizePushDeviceRecord(record);
  if (!normalized) return null;

  const currentDevices = await getPushDevices(env, orgId);
  const nextDevices = [];
  let didReplace = false;

  for (const existing of Array.isArray(currentDevices) ? currentDevices : []) {
    if (!existing?.token) continue;

    const sameToken = existing.token === normalized.token;
    const sameDevice =
      normalized.deviceId
      && sanitizeDeviceId(existing.deviceId || '') === normalized.deviceId
      && normalizeRoleKey(existing.app || 'ultimate_playback') === normalized.app;

    if (sameToken || sameDevice) {
      if (!didReplace) {
        nextDevices.push({
          ...existing,
          ...normalized,
          createdAt: existing.createdAt || normalized.createdAt,
        });
        didReplace = true;
      }
      continue;
    }

    nextDevices.push(existing);
  }

  if (!didReplace) nextDevices.push(normalized);
  await savePushDevices(env, orgId, nextDevices);
  return normalized;
}

async function unregisterPushDevice(env, orgId, {
  token = '',
  email = '',
  deviceId = '',
  app = 'ultimate_playback',
} = {}) {
  const normalizedToken = String(token || '').trim();
  const normalizedEmail = normalizeLower(email || '');
  const normalizedDeviceId = sanitizeDeviceId(deviceId || '');
  const normalizedApp = normalizeRoleKey(app || 'ultimate_playback') || 'ultimate_playback';

  const currentDevices = await getPushDevices(env, orgId);
  const nextDevices = (Array.isArray(currentDevices) ? currentDevices : []).filter((device) => {
    if (!device?.token) return false;

    const sameApp =
      normalizeRoleKey(device.app || 'ultimate_playback') === normalizedApp;
    if (!sameApp) return true;

    if (normalizedToken && device.token === normalizedToken) return false;

    if (
      !normalizedToken
      && normalizedEmail
      && normalizedDeviceId
      && normalizeLower(device.email || '') === normalizedEmail
      && sanitizeDeviceId(device.deviceId || '') === normalizedDeviceId
    ) {
      return false;
    }

    return true;
  });

  await savePushDevices(env, orgId, nextDevices);
  return nextDevices.length !== currentDevices.length;
}

function isPushAdminRole(role = '') {
  return PUSH_ADMIN_ROLES.has(normalizeRoleKey(role));
}

function filterPushDevices(devices, {
  emails = null,
  adminOnly = false,
  preferenceKey = '',
  excludeEmails = [],
} = {}) {
  const emailSet = emails
    ? new Set((Array.isArray(emails) ? emails : [emails]).map(normalizeLower).filter(Boolean))
    : null;
  const excludedEmails = new Set(
    (Array.isArray(excludeEmails) ? excludeEmails : [excludeEmails])
      .map(normalizeLower)
      .filter(Boolean),
  );
  const seenTokens = new Set();
  const filtered = [];

  for (const device of Array.isArray(devices) ? devices : []) {
    const token = String(device?.token || '').trim();
    if (!token || seenTokens.has(token)) continue;

    const deviceEmail = normalizeLower(device?.email || '');
    if (deviceEmail && excludedEmails.has(deviceEmail)) continue;
    if (emailSet && (!deviceEmail || !emailSet.has(deviceEmail))) continue;
    if (adminOnly && !isPushAdminRole(device?.grantedRole || '')) continue;
    if (preferenceKey && device?.preferences?.[preferenceKey] === false) continue;

    seenTokens.add(token);
    filtered.push(device);
  }

  return filtered;
}

async function sendExpoPushMessages(messages = []) {
  const stableMessages = (Array.isArray(messages) ? messages : []).filter((message) =>
    String(message?.to || '').trim()
  );
  if (stableMessages.length === 0) return [];

  const results = [];
  for (let index = 0; index < stableMessages.length; index += 100) {
    const chunk = stableMessages.slice(index, index + 100);
    const response = await fetch(EXPO_PUSH_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Accept-encoding': 'gzip, deflate',
      },
      body: JSON.stringify(chunk),
    });

    const raw = await response.text();
    if (!response.ok) {
      console.log('[sync/push] expo push failed', raw);
      results.push({ ok: false, status: response.status, body: raw });
      continue;
    }

    try {
      results.push(JSON.parse(raw));
    } catch {
      results.push({ ok: true, body: raw });
    }
  }

  return results;
}

async function sendPushToDevices(devices, {
  title = '',
  body = '',
  data = {},
  sound = 'default',
} = {}, preferenceKey = 'messages') {
  const targetDevices = filterPushDevices(devices, { preferenceKey });
  if (targetDevices.length === 0) return { ok: true, count: 0 };

  const payloads = targetDevices.map((device) => ({
    to: device.token,
    sound,
    title: clipText(title, 80),
    body: clipText(body, 200),
    data: {
      ...data,
      targetEmail: device.email || '',
    },
    priority: 'high',
    channelId: preferenceKey || 'default',
  }));

  await sendExpoPushMessages(payloads);
  return { ok: true, count: payloads.length };
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildInviteLandingUrl(token) {
  return `${INVITE_LANDING_BASE_URL}?token=${encodeURIComponent(String(token || '').trim())}`;
}

function buildInviteAppOpenUrl(invite) {
  const params = new URLSearchParams();
  if (invite?.token) params.set('token', invite.token);
  if (invite?.email) params.set('email', invite.email);
  if (invite?.phone) params.set('phone', invite.phone);
  if (invite?.orgName) params.set('orgName', invite.orgName);
  if (invite?.name) params.set('name', invite.name);
  return `ultimateplayback://invite?${params.toString()}`;
}

function buildInviteDownloadLinks(invite) {
  return {
    landing: buildInviteLandingUrl(invite?.token),
    openApp: buildInviteAppOpenUrl(invite),
    ios: PLAYBACK_IOS_URL,
    android: PLAYBACK_ANDROID_URL,
    desktop: PLAYBACK_DESKTOP_URL,
  };
}

function maskEmail(email) {
  const normalized = normalizeLower(email);
  if (!normalized.includes('@')) return '';
  const [localPart, domain] = normalized.split('@');
  if (!localPart || !domain) return normalized;
  const visible = localPart.length <= 2
    ? `${localPart[0] || ''}*`
    : `${localPart.slice(0, 2)}${'*'.repeat(Math.max(1, localPart.length - 2))}`;
  return `${visible}@${domain}`;
}

function maskPhone(phone) {
  const digits = normalizePhone(phone || '');
  if (!digits) return '';
  if (digits.length <= 4) return digits;
  return `••• ••• ${digits.slice(-4)}`;
}

function normalizeInviteRecord(invite) {
  return {
    token: String(invite?.token || '').trim(),
    orgId: String(invite?.orgId || '').trim(),
    orgName: String(invite?.orgName || 'Worship Team').trim() || 'Worship Team',
    name: String(invite?.name || '').trim(),
    email: normalizeLower(invite?.email || ''),
    phone: String(invite?.phone || '').trim(),
    status: String(invite?.status || 'pending').trim() || 'pending',
    createdAt: invite?.createdAt || new Date().toISOString(),
    acceptedAt: invite?.acceptedAt || null,
    registeredAt: invite?.registeredAt || null,
    invitedByName: String(invite?.invitedByName || '').trim(),
  };
}

const INVITE_STATUS_RANK = {
  '': 0,
  ready: 1,
  pending: 2,
  accepted: 3,
  registered: 4,
};

function normalizeInviteStatus(value) {
  return String(value || '').trim().toLowerCase();
}

function isPortablePhotoUrl(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return (
    normalized.startsWith('data:image/')
    || normalized.startsWith('http://')
    || normalized.startsWith('https://')
  );
}

function pickPreferredPhotoUrl(...values) {
  for (const value of values) {
    if (isPortablePhotoUrl(value)) return String(value || '').trim();
  }
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (normalized) return normalized;
  }
  return null;
}

function getEffectiveInviteStatus(person = {}) {
  const baseStatus = normalizeInviteStatus(person?.inviteStatus || person?.status || '');
  const isRegistered =
    person?.playbackRegistered === true
    || Boolean(person?.playbackRegisteredAt)
    || Boolean(person?.inviteRegisteredAt)
    || Boolean(person?.registeredAt);

  if (isRegistered || baseStatus === 'registered') return 'registered';
  if (Boolean(person?.inviteAcceptedAt) || Boolean(person?.acceptedAt)) {
    return INVITE_STATUS_RANK[baseStatus] >= INVITE_STATUS_RANK.accepted
      ? baseStatus
      : 'accepted';
  }
  return baseStatus;
}

function pickHighestInviteStatus(...records) {
  let bestStatus = '';
  let bestRank = -1;

  for (const record of records) {
    const status = getEffectiveInviteStatus(record);
    const rank = INVITE_STATUS_RANK[status] ?? 0;
    if (rank >= bestRank) {
      bestStatus = status;
      bestRank = rank;
    }
  }

  return bestStatus;
}

const ASSIGNMENT_STATUS_RANK = {
  '': 0,
  pending: 1,
  accepted: 2,
  declined: 2,
};

function normalizeAssignmentStatus(value) {
  return String(value || '').trim().toLowerCase();
}

function pickPreferredAssignmentStatus(currentValue, nextValue) {
  const current = normalizeAssignmentStatus(
    typeof currentValue === 'object' && currentValue !== null
      ? currentValue.status || currentValue.response
      : currentValue,
  );
  const next = normalizeAssignmentStatus(
    typeof nextValue === 'object' && nextValue !== null
      ? nextValue.status || nextValue.response
      : nextValue,
  );

  const currentRank = ASSIGNMENT_STATUS_RANK[current] ?? 0;
  const nextRank = ASSIGNMENT_STATUS_RANK[next] ?? 0;

  if (nextRank > currentRank) return next;
  if (currentRank > nextRank) return current;
  if (next && next !== current && next !== 'pending') return next;
  return current || next || 'pending';
}

function buildPeopleIndexes(people = []) {
  const byId = {};
  const byEmail = {};
  for (const person of Array.isArray(people) ? people : []) {
    const id = String(person?.id || '').trim();
    const email = normalizeLower(person?.email || '');
    if (id) byId[id] = person;
    if (email) byEmail[email] = person;
  }
  return { byId, byEmail };
}

function getLinkedTeamMemberPerson(member = {}, peopleById = {}, peopleByEmail = {}) {
  const personId = String(member?.personId || '').trim();
  if (personId) {
    const linkedById = peopleById[personId] || peopleById[normalizeLower(personId)] || null;
    if (linkedById) return linkedById;
  }

  const directEmail = normalizeLower(member?.email || '');
  if (directEmail && peopleByEmail[directEmail]) {
    return peopleByEmail[directEmail];
  }

  return null;
}

function getAssignmentResponseLookupKeys(member = {}, peopleById = {}) {
  const keys = [];
  const email = normalizeLower(member?.email || '');
  const personId = normalizeLower(member?.personId || '');
  const linkedPerson = personId ? (peopleById[member.personId] || peopleById[personId] || null) : null;
  const linkedEmail = normalizeLower(linkedPerson?.email || '');

  if (email) keys.push(email);
  if (personId) keys.push(personId);
  if (linkedEmail) keys.push(linkedEmail);

  return [...new Set(keys.filter(Boolean))];
}

function normalizeAssignmentResponseEntry(value = {}) {
  if (!value || typeof value !== 'object') {
    return {
      response: 'pending',
      status: 'pending',
      role: '',
      declineReason: '',
      responded_at: null,
      ts: 0,
    };
  }

  const status = pickPreferredAssignmentStatus(value.status, value.response);
  const respondedAt =
    value.responded_at
    || value.respondedAt
    || value.timestamp
    || null;
  const tsCandidate =
    Number(value.ts)
    || Date.parse(respondedAt || '')
    || Date.parse(value.timestamp || '')
    || 0;

  return {
    ...value,
    response: status,
    status,
    role: String(value.role || '').trim(),
    declineReason: status === 'declined' ? String(value.declineReason || '').trim() : '',
    responded_at: respondedAt || null,
    ts: Number.isFinite(tsCandidate) ? tsCandidate : 0,
  };
}

function mergeAssignmentResponseEntries(currentValue, nextValue) {
  const current = normalizeAssignmentResponseEntry(currentValue);
  const next = normalizeAssignmentResponseEntry(nextValue);
  const mergedStatus = pickPreferredAssignmentStatus(current, next);
  const currentTs = Number(current.ts) || 0;
  const nextTs = Number(next.ts) || 0;
  const preferNextMeta =
    mergedStatus === next.status
      ? (
          mergedStatus !== current.status
          || nextTs > currentTs
          || (nextTs === currentTs && Boolean(next.responded_at) && !current.responded_at)
        )
      : false;
  const primary = preferNextMeta ? next : current;
  const secondary = preferNextMeta ? current : next;

  return {
    ...secondary,
    ...primary,
    response: mergedStatus,
    status: mergedStatus,
    role: primary.role || secondary.role || '',
    declineReason:
      mergedStatus === 'declined'
        ? (primary.declineReason || secondary.declineReason || '')
        : '',
    responded_at: primary.responded_at || secondary.responded_at || null,
    ts: Math.max(currentTs, nextTs),
  };
}

function mergeAssignmentResponseMaps(...maps) {
  const merged = {};
  for (const map of maps) {
    if (!map || typeof map !== 'object') continue;
    for (const [rawKey, rawValue] of Object.entries(map)) {
      const key = normalizeLower(rawKey || '');
      if (!key) continue;
      merged[key] = merged[key]
        ? mergeAssignmentResponseEntries(merged[key], rawValue)
        : normalizeAssignmentResponseEntry(rawValue);
    }
  }
  return merged;
}

function buildAssignmentResponsesFromMessages(messages = []) {
  const responsesByService = {};

  for (const message of Array.isArray(messages) ? messages : []) {
    const metadata = message?.metadata && typeof message.metadata === 'object'
      ? message.metadata
      : {};
    const serviceId = String(metadata.serviceId || '').trim();
    const status = normalizeAssignmentStatus(metadata.status || message?.status || '');
    const personEmail = normalizeLower(metadata.personEmail || message?.fromEmail || '');
    const personId = normalizeLower(metadata.personId || '');

    if (!serviceId || !['accepted', 'declined'].includes(status)) continue;

    const responseEntry = normalizeAssignmentResponseEntry({
      response: status,
      status,
      role: metadata.role || '',
      declineReason: metadata.declineReason || '',
      responded_at: metadata.responded_at || message?.timestamp || null,
      timestamp: message?.timestamp || null,
      ts: metadata.ts || Date.parse(message?.timestamp || '') || 0,
    });

    if (!responsesByService[serviceId]) responsesByService[serviceId] = {};
    for (const key of [personEmail, personId].filter(Boolean)) {
      responsesByService[serviceId][key] = responsesByService[serviceId][key]
        ? mergeAssignmentResponseEntries(responsesByService[serviceId][key], responseEntry)
        : responseEntry;
    }
  }

  return responsesByService;
}

function getPlanTeamEntryIdentityKeys(entry = {}) {
  const role = normalizeLower(entry?.role || '');
  const keys = [];
  const id = String(entry?.id || '').trim();
  const personId = normalizeLower(entry?.personId || '');
  const email = normalizeLower(entry?.email || '');
  const name = normalizeLower(entry?.name || '');

  if (id) keys.push(`id:${id}`);
  if (personId && role) keys.push(`person:${personId}|${role}`);
  if (email && role) keys.push(`email:${email}|${role}`);
  if (name && role) keys.push(`name:${name}|${role}`);

  return keys;
}

function mergePlanTeamEntries(existingTeam = [], incomingTeam = []) {
  const existingByKey = new Map();
  const stableExistingTeam = Array.isArray(existingTeam) ? existingTeam : [];
  const stableIncomingTeam = Array.isArray(incomingTeam) ? incomingTeam : [];

  stableExistingTeam.forEach((entry, index) => {
    getPlanTeamEntryIdentityKeys(entry).forEach((key) => existingByKey.set(key, index));
  });

  return stableIncomingTeam.map((sourceEntry) => {
    const incomingEntry = {
      ...sourceEntry,
      email: normalizeLower(sourceEntry?.email || ''),
    };

    let existingEntry = null;
    for (const key of getPlanTeamEntryIdentityKeys(incomingEntry)) {
      const existingIndex = existingByKey.get(key);
      if (existingIndex !== undefined) {
        existingEntry = stableExistingTeam[existingIndex];
        break;
      }
    }

    if (!existingEntry) {
      const status = normalizeAssignmentStatus(incomingEntry.status) || 'pending';
      return {
        ...incomingEntry,
        status,
        declineReason: status === 'declined' ? (incomingEntry.declineReason || '') : '',
      };
    }

    const status = pickPreferredAssignmentStatus(existingEntry, incomingEntry);
    const incomingStatus = normalizeAssignmentStatus(incomingEntry.status);
    const declineReason =
      status === 'declined'
        ? (
            incomingStatus === 'declined'
              ? (incomingEntry.declineReason || existingEntry.declineReason || '')
              : (existingEntry.declineReason || incomingEntry.declineReason || '')
          )
        : '';

    return {
      ...existingEntry,
      ...incomingEntry,
      id: existingEntry.id || incomingEntry.id || `ta_${makeId(12)}`,
      personId: existingEntry.personId || incomingEntry.personId || '',
      email: incomingEntry.email || normalizeLower(existingEntry.email || ''),
      name: incomingEntry.name || existingEntry.name || '',
      role: incomingEntry.role || existingEntry.role || '',
      status,
      declineReason,
      responded_at:
        incomingStatus === status
          ? (
              incomingEntry.responded_at
              || incomingEntry.respondedAt
              || existingEntry.responded_at
              || existingEntry.respondedAt
              || null
            )
          : (
              existingEntry.responded_at
              || existingEntry.respondedAt
              || incomingEntry.responded_at
              || incomingEntry.respondedAt
              || null
            ),
    };
  });
}

function getTeamMemberEmail(member = {}, peopleById = {}, peopleByEmail = {}) {
  const directEmail = normalizeLower(member?.email || '');
  if (directEmail) return directEmail;

  const linkedPerson = getLinkedTeamMemberPerson(member, peopleById, peopleByEmail);
  return normalizeLower(linkedPerson?.email || '');
}

function getTeamMemberName(member = {}, peopleById = {}, peopleByEmail = {}) {
  const directName = String(member?.name || '').trim();
  if (directName) return directName;

  const linkedPerson = getLinkedTeamMemberPerson(member, peopleById, peopleByEmail);
  return String(linkedPerson?.name || '').trim();
}

function buildTeamEntryLookup(team = []) {
  const lookup = new Map();
  for (const member of Array.isArray(team) ? team : []) {
    for (const key of getPlanTeamEntryIdentityKeys(member)) {
      if (!lookup.has(key)) lookup.set(key, member);
    }
  }
  return lookup;
}

function collectNewPendingAssignments(previousTeam = [], nextTeam = [], peopleById = {}, peopleByEmail = {}) {
  const previousLookup = buildTeamEntryLookup(previousTeam);
  const seen = new Set();
  const results = [];

  for (const member of Array.isArray(nextTeam) ? nextTeam : []) {
    let previousMember = null;
    for (const key of getPlanTeamEntryIdentityKeys(member)) {
      if (previousLookup.has(key)) {
        previousMember = previousLookup.get(key);
        break;
      }
    }

    const nextStatus = normalizeAssignmentStatus(member?.status) || 'pending';
    const previousStatus = normalizeAssignmentStatus(previousMember?.status) || '';

    if (nextStatus !== 'pending' || previousStatus === 'pending') continue;

    const linkedPerson = getLinkedTeamMemberPerson(member, peopleById, peopleByEmail);
    if (!linkedPerson) continue;
    const effectiveInviteStatus = getEffectiveInviteStatus(linkedPerson || {});
    if (effectiveInviteStatus !== 'registered') continue;

    const email = getTeamMemberEmail(member, peopleById, peopleByEmail);
    if (!email) continue;

    const identityKey = `${email}|${normalizeRoleKey(member?.role || '')}`;
    if (seen.has(identityKey)) continue;
    seen.add(identityKey);

    results.push({
      email,
      personId: String(member?.personId || '').trim(),
      name: getTeamMemberName(member, peopleById, peopleByEmail),
      role: String(member?.role || '').trim(),
    });
  }

  return results;
}

function mergeStoredPlans(existingPlans = {}, incomingPlans = {}) {
  const mergedPlans = { ...existingPlans };

  for (const [planId, rawIncomingPlan] of Object.entries(incomingPlans || {})) {
    const incomingPlan =
      rawIncomingPlan && typeof rawIncomingPlan === 'object'
        ? rawIncomingPlan
        : {};
    const currentPlan =
      mergedPlans[planId] && typeof mergedPlans[planId] === 'object'
        ? mergedPlans[planId]
        : {};
    const hasIncomingTeam = Array.isArray(incomingPlan.team);

    mergedPlans[planId] = {
      ...currentPlan,
      ...incomingPlan,
      team: hasIncomingTeam
        ? mergePlanTeamEntries(currentPlan.team || [], incomingPlan.team || [])
        : (currentPlan.team || []),
    };
  }

  return mergedPlans;
}

function getAssignmentResponseForMember(responseMap = {}, member = {}, peopleById = {}) {
  if (!responseMap || typeof responseMap !== 'object') return null;
  for (const key of getAssignmentResponseLookupKeys(member, peopleById)) {
    if (responseMap[key]) return responseMap[key];
  }
  return null;
}

function teamMemberMatchesResponse(member = {}, personId = '', personUUID = '', role = '') {
  const normalizedPersonId = normalizeLower(personId || '');
  const normalizedUUID = String(personUUID || '').trim();
  const normalizedRole = normalizeLower(role || '');
  const memberEmail = normalizeLower(member?.email || '');
  const memberPersonId = String(member?.personId || '').trim();

  const matchesIdentity =
    (memberEmail && normalizedPersonId && memberEmail === normalizedPersonId)
    || (memberPersonId && normalizedPersonId && memberPersonId.toLowerCase() === normalizedPersonId)
    || (normalizedUUID && memberPersonId === normalizedUUID);

  if (!matchesIdentity) return false;
  if (!normalizedRole) return true;

  const memberRole = normalizeLower(member?.role || '');
  return !memberRole || memberRole === normalizedRole;
}

function applyResponsesToTeamEntries(team = [], responseMap = {}, peopleById = {}) {
  const stableTeam = Array.isArray(team) ? team : [];
  return stableTeam.map((member) => {
    const response = getAssignmentResponseForMember(responseMap, member, peopleById);
    if (!response) return member;

    const status = pickPreferredAssignmentStatus(member.status, response);
    return {
      ...member,
      status,
      declineReason: status === 'declined'
        ? (response.declineReason || member.declineReason || '')
        : '',
      responded_at:
        response.responded_at
        || response.respondedAt
        || member.responded_at
        || member.respondedAt
        || null,
    };
  });
}

function hydrateLibraryDataWithAssignmentResponses(services = [], plans = {}, people = [], messages = []) {
  const hydratedPlans = { ...plans };
  const { byId: peopleById } = buildPeopleIndexes(people);
  const derivedResponsesByService = buildAssignmentResponsesFromMessages(messages);
  const hydratedServices = (Array.isArray(services) ? services : []).map((service) => {
    if (!service?.id) return service;

    const responseMap = mergeAssignmentResponseMaps(
      service.assignmentResponses || {},
      derivedResponsesByService[service.id] || {},
    );
    const storedPlan =
      hydratedPlans[service.id] && typeof hydratedPlans[service.id] === 'object'
        ? hydratedPlans[service.id]
        : {};
    const servicePlan =
      service.plan && typeof service.plan === 'object'
        ? service.plan
        : {};
    const basePlan =
      Object.keys(storedPlan).length > 0
        ? storedPlan
        : servicePlan;

    const hydratedTeam = applyResponsesToTeamEntries(
      basePlan.team || servicePlan.team || [],
      responseMap,
      peopleById,
    );
    const hydratedPlan = {
      ...servicePlan,
      ...basePlan,
      team: hydratedTeam,
    };

    hydratedPlans[service.id] = hydratedPlan;

    return {
      ...service,
      assignmentResponses: responseMap,
      ...(Array.isArray(service.team)
        ? { team: applyResponsesToTeamEntries(service.team, responseMap, peopleById) }
        : {}),
      plan: hydratedPlan,
    };
  });

  return {
    services: hydratedServices,
    plans: hydratedPlans,
  };
}

function getOrgTimeZone(org = {}, env = {}) {
  const candidate = String(
    org?.timeZone
    || org?.timezone
    || env.DEFAULT_TIME_ZONE
    || DEFAULT_BIRTHDAY_TIME_ZONE,
  ).trim();

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return DEFAULT_BIRTHDAY_TIME_ZONE;
  }
}

function getDatePartsInTimeZone(timeZone, date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});

  return {
    year: parts.year || '0000',
    month: parts.month || '00',
    day: parts.day || '00',
    dateKey: `${parts.year || '0000'}-${parts.month || '00'}-${parts.day || '00'}`,
  };
}

function parseBirthdayMonthDay(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const isoMatch = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (isoMatch) {
    return {
      month: String(Number(isoMatch[2])).padStart(2, '0'),
      day: String(Number(isoMatch[3])).padStart(2, '0'),
    };
  }

  const usMatch = raw.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/);
  if (usMatch) {
    return {
      month: String(Number(usMatch[1])).padStart(2, '0'),
      day: String(Number(usMatch[2])).padStart(2, '0'),
    };
  }

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return {
      month: String(parsed.getUTCMonth() + 1).padStart(2, '0'),
      day: String(parsed.getUTCDate()).padStart(2, '0'),
    };
  }

  return null;
}

function getPersonDisplayName(person = {}) {
  const firstName = String(person?.name || '').trim();
  const lastName = String(person?.lastName || '').trim();
  if (
    firstName
    && lastName
    && !firstName.toLowerCase().endsWith(lastName.toLowerCase())
  ) {
    return `${firstName} ${lastName}`.trim();
  }
  return firstName || lastName || normalizeLower(person?.email || '') || 'Team member';
}

function getBirthdayPersonKey(person = {}) {
  const id = String(person?.id || '').trim();
  if (id) return `id:${id}`;
  const email = normalizeLower(person?.email || '');
  if (email) return `email:${email}`;
  const phone = normalizePhone(person?.phone || '');
  if (phone) return `phone:${phone}`;
  return '';
}

function birthdayAutomationKey(orgId, dateKey) {
  return `${orgKey(orgId, 'birthdayAutomation')}:${dateKey}`;
}

async function ensureBirthdayMessages(env, orgId, org) {
  const rawPeople = await kvGet(env, orgKey(orgId, 'people'), []);
  const people = mergeStoredPeople([], Array.isArray(rawPeople) ? rawPeople : []);
  if (people.length === 0) return;

  const timeZone = getOrgTimeZone(org, env);
  const today = getDatePartsInTimeZone(timeZone);
  const logKey = birthdayAutomationKey(orgId, today.dateKey);
  const birthdayLog = await kvGet(env, logKey, {});
  const logEntries =
    birthdayLog && typeof birthdayLog === 'object' && !Array.isArray(birthdayLog)
      ? { ...birthdayLog }
      : {};
  const messages = await kvGet(env, orgKey(orgId, 'messages'), []);
  const nextMessages = Array.isArray(messages) ? [...messages] : [];
  const organizationName = String(org?.name || '').trim() || 'your organization';
  const teamSenderName = /(worship|team|ministry)/i.test(organizationName)
    ? organizationName
    : `${organizationName} Worship Team`;
  let messagesChanged = false;
  let logChanged = false;

  for (const person of people) {
    const birthday = parseBirthdayMonthDay(person?.dateOfBirth);
    if (!birthday) continue;
    if (birthday.month !== today.month || birthday.day !== today.day) continue;

    const personKey = getBirthdayPersonKey(person);
    if (!personKey) continue;

    const displayName = getPersonDisplayName(person);
    const normalizedEmail = normalizeLower(person?.email || '');
    const existingLog = logEntries[personKey] || {};
    const adminMessageKey = `birthday:admin:${today.dateKey}:${personKey}`;
    const userMessageKey = `birthday:user:${today.dateKey}:${personKey}`;

    if (!nextMessages.some(message => message?.messageKey === adminMessageKey)) {
      nextMessages.unshift({
        id: makeId(),
        fromEmail: normalizedEmail || 'system@local',
        fromName: displayName,
        subject: `${displayName} has a birthday today`,
        message:
          `${displayName} has a birthday today. Send them a note from ${teamSenderName}.`,
        to: 'admin',
        timestamp: new Date().toISOString(),
        read: false,
        replies: [],
        hiddenFor: [],
        visibility: 'admin_only',
        messageType: 'birthday_reminder',
        isSystemMsg: true,
        messageKey: adminMessageKey,
        birthdayDate: today.dateKey,
      });
      messagesChanged = true;
      logEntries[personKey] = {
        ...existingLog,
        adminMessageKey,
      };
      logChanged = true;
    }

    if (
      normalizedEmail
      && !nextMessages.some(message => message?.messageKey === userMessageKey)
    ) {
      nextMessages.unshift({
        id: makeId(),
        fromEmail: 'team@system.local',
        fromName: teamSenderName,
        subject: `Happy Birthday, ${displayName}!`,
        message:
          `Happy Birthday, ${displayName}! Your worship family at ${organizationName} is celebrating you today and thanking God for your life.`,
        to: normalizedEmail,
        timestamp: new Date().toISOString(),
        read: false,
        replies: [],
        hiddenFor: [],
        visibility: 'conversation',
        messageType: 'birthday_greeting',
        audience: 'member',
        messageKey: userMessageKey,
        birthdayDate: today.dateKey,
      });
      messagesChanged = true;
      logEntries[personKey] = {
        ...(logEntries[personKey] || existingLog),
        userMessageKey,
      };
      logChanged = true;
    }

    if (normalizedEmail && !existingLog.emailSentAt) {
      try {
        await sendBirthdayGreetingEmail(env, {
          to: normalizedEmail,
          name: displayName,
          orgName: organizationName,
        });
        logEntries[personKey] = {
          ...(logEntries[personKey] || existingLog),
          emailSentAt: new Date().toISOString(),
        };
        logChanged = true;
      } catch (error) {
        console.log('[sync/birthday/email] failed', error?.message || error);
      }
    }
  }

  if (messagesChanged) {
    await kvPut(env, orgKey(orgId, 'messages'), nextMessages);
  }

  if (logChanged) {
    await kvPut(env, logKey, logEntries);
  }
}

function publicInvitePayload(invite) {
  const normalized = normalizeInviteRecord(invite);
  return {
    token: normalized.token,
    orgName: normalized.orgName,
    name: normalized.name,
    email: normalized.email,
    phone: normalized.phone,
    status: normalized.status,
    createdAt: normalized.createdAt,
    acceptedAt: normalized.acceptedAt,
    registeredAt: normalized.registeredAt,
    invitedByName: normalized.invitedByName,
    contactHint:
      maskEmail(normalized.email)
      || maskPhone(normalized.phone)
      || '',
    downloadLinks: buildInviteDownloadLinks(normalized),
  };
}

function buildOrgTeamLabel(orgName = '') {
  const normalized = String(orgName || '').trim() || 'your organization';
  return /(worship|team|ministry)/i.test(normalized)
    ? normalized
    : `${normalized} Worship Team`;
}

function buildInviteShareText(invite) {
  const normalized = normalizeInviteRecord(invite);
  const teamLabel = buildOrgTeamLabel(normalized.orgName);
  const landingUrl = buildInviteLandingUrl(normalized.token);
  const contactBits = [];
  if (normalized.email) contactBits.push(normalized.email);
  if (normalized.phone) contactBits.push(normalized.phone);

  return [
    `You've been invited to join ${teamLabel} on Ultimate Playback.`,
    normalized.name ? `Invitation for: ${normalized.name}` : '',
    `Accept your invitation: ${landingUrl}`,
    contactBits.length > 0
      ? `After you accept, register in Ultimate Playback with ${contactBits.join(' or ')}.`
      : 'After you accept, register in Ultimate Playback with the contact info on your team profile.',
    'Account registration is protected by a 6-digit confirmation code sent by email.',
  ].filter(Boolean).join('\n\n');
}

function formatDisplayServiceDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const datePart = raw.includes('T') ? raw.split('T')[0] : raw;
  const match = datePart.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return raw;

  const [, year, month, day] = match;
  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const monthLabel = monthNames[Math.max(0, Number(month) - 1)] || month;
  return `${monthLabel} ${Number(day)}, ${year}`;
}

function formatDisplayServiceTime(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return raw;

  let hour = Number(match[1]);
  const minute = match[2];
  const suffix = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12 || 12;
  return `${hour}:${minute} ${suffix}`;
}

function buildServiceScheduleLabel(dateValue, timeValue) {
  const dateLabel = formatDisplayServiceDate(dateValue);
  const timeLabel = formatDisplayServiceTime(timeValue);
  if (dateLabel && timeLabel) return `${dateLabel} at ${timeLabel}`;
  return dateLabel || timeLabel || 'Date and time to be confirmed';
}

function buildServiceReminderContent({
  service = {},
  orgName = 'Your Church',
  memberName = '',
  roles = [],
  songs = [],
  diffDays = 1,
}) {
  const serviceName = String(service?.name || service?.title || 'Service').trim() || 'Service';
  const normalizedOrgName = String(orgName || 'Your Church').trim() || 'Your Church';
  const dayLabel = diffDays === 1 ? 'tomorrow' : 'in 3 days';
  const subjectPrefix = diffDays === 1 ? 'Reminder for tomorrow' : 'Reminder for this week';
  const serviceDate = String(service?.date || service?.serviceDate || '').trim();
  const serviceTime = String(service?.time || service?.startTime || '').trim();
  const rehearsalTime = String(
    service?.rehearsalTime
    || service?.callTime
    || service?.arrivalTime
    || service?.soundcheckTime
    || '',
  ).trim();
  const scheduleLabel = buildServiceScheduleLabel(serviceDate, serviceTime);
  const rehearsalLabel = formatDisplayServiceTime(rehearsalTime);
  const locationLabel = String(
    service?.location
    || service?.campus
    || service?.venue
    || service?.city
    || '',
  ).trim();
  const songsLabel = Array.isArray(songs) && songs.length > 0
    ? songs.join(', ')
    : '';
  const roleLabel = roles.length === 1 ? 'Role' : 'Roles';
  const greetingName = String(memberName || '').trim() || 'there';
  const rehearsalText = rehearsalLabel
    ? `Rehearsal / call time: ${rehearsalLabel}.`
    : 'Rehearsal / call time: follow the normal team schedule unless your worship leader shares a change.';
  const textBody = [
    `Hi ${greetingName},`,
    '',
    `${serviceName} at ${normalizedOrgName} is ${dayLabel}.`,
    `When: ${scheduleLabel}`,
    roles.length > 0 ? `${roleLabel}: ${roles.join(', ')}` : '',
    rehearsalText,
    locationLabel ? `Location: ${locationLabel}` : '',
    songsLabel ? `Songs: ${songsLabel}` : 'Songs: Please review the current service plan in Ultimate Playback.',
    '',
    'Please make sure you:',
    '• Have the right songs and arrangements ready',
    '• Review your part before the service',
    '• Confirm your availability in Ultimate Playback → Assignments',
    '• Be there on time',
    '',
    diffDays === 1 ? 'See you tomorrow.' : 'See you soon.',
  ].filter(Boolean).join('\n');

  const htmlBody = `
    <div style="background:#020617;padding:32px 20px;font-family:Arial,sans-serif;color:#F8FAFC">
      <div style="max-width:560px;margin:0 auto;background:linear-gradient(180deg,#0B1120 0%,#0F172A 100%);border:1px solid #1F2937;border-radius:28px;overflow:hidden;box-shadow:0 20px 60px rgba(2,6,23,0.45)">
        <div style="padding:32px 32px 18px;background:radial-gradient(circle at top left,rgba(99,102,241,0.22),transparent 55%),radial-gradient(circle at top right,rgba(245,158,11,0.12),transparent 40%)">
          <p style="margin:0 0 10px;color:#FCD34D;font-size:12px;font-weight:800;letter-spacing:1.4px;text-transform:uppercase">Service Reminder</p>
          <h1 style="margin:0 0 12px;font-size:28px;line-height:1.1;color:#FFFFFF">${escapeHtml(serviceName)} is ${escapeHtml(dayLabel)}</h1>
          <p style="margin:0;color:#CBD5E1;font-size:15px;line-height:1.7">
            Hi ${escapeHtml(greetingName)}, this is a reminder from <strong style="color:#FFFFFF">${escapeHtml(normalizedOrgName)}</strong>.
          </p>
        </div>
        <div style="padding:0 32px 32px">
          <div style="margin:18px 0 24px;padding:18px 20px;border:1px solid #1E293B;border-radius:20px;background:#020617">
            <p style="margin:0 0 6px;color:#94A3B8;font-size:11px;font-weight:800;letter-spacing:1px;text-transform:uppercase">Service Details</p>
            <p style="margin:0 0 10px;color:#F8FAFC;font-size:20px;font-weight:700">${escapeHtml(serviceName)}</p>
            <p style="margin:0;color:#CBD5E1;font-size:14px;line-height:1.7"><strong style="color:#FFFFFF">When:</strong> ${escapeHtml(scheduleLabel)}</p>
            ${roles.length > 0 ? `<p style="margin:0;color:#CBD5E1;font-size:14px;line-height:1.7"><strong style="color:#FFFFFF">${escapeHtml(roleLabel)}:</strong> ${escapeHtml(roles.join(', '))}</p>` : ''}
            <p style="margin:0;color:#CBD5E1;font-size:14px;line-height:1.7"><strong style="color:#FFFFFF">Rehearsal / call:</strong> ${rehearsalLabel ? escapeHtml(rehearsalLabel) : 'Follow the schedule shared by your worship leader unless it changes.'}</p>
            ${locationLabel ? `<p style="margin:0;color:#CBD5E1;font-size:14px;line-height:1.7"><strong style="color:#FFFFFF">Location:</strong> ${escapeHtml(locationLabel)}</p>` : ''}
            <p style="margin:0;color:#CBD5E1;font-size:14px;line-height:1.7"><strong style="color:#FFFFFF">Songs:</strong> ${songsLabel ? escapeHtml(songsLabel) : 'Please review the current service plan in Ultimate Playback.'}</p>
          </div>
          <div style="padding:18px 20px;border:1px solid #1F2937;border-radius:18px;background:rgba(15,23,42,0.88)">
            <p style="margin:0 0 8px;color:#E2E8F0;font-size:14px;font-weight:700">Please make sure you:</p>
            <ul style="margin:0;padding-left:20px;color:#94A3B8;font-size:13px;line-height:2">
              <li>Have the right songs and arrangements ready</li>
              <li>Review your part before the service</li>
              <li>Confirm your availability in <strong style="color:#A5B4FC">Ultimate Playback → Assignments</strong></li>
              <li>Be there on time</li>
            </ul>
            <p style="margin:12px 0 0;color:#E2E8F0;font-size:13px;line-height:1.8">${diffDays === 1 ? 'See you tomorrow.' : 'See you soon.'}</p>
          </div>
        </div>
      </div>
    </div>`;

  return {
    dayLabel,
    subjectPrefix,
    emailSubject: `${subjectPrefix}: ${serviceName} — ${normalizedOrgName}`,
    htmlBody,
    textBody,
    inAppSubject: `Reminder: ${serviceName} is ${dayLabel}`,
    inAppMessage: [
      `Hi ${greetingName}, ${serviceName} at ${normalizedOrgName} is ${dayLabel}.`,
      `When: ${scheduleLabel}`,
      roles.length > 0 ? `${roleLabel}: ${roles.join(', ')}` : '',
      rehearsalText,
      locationLabel ? `Location: ${locationLabel}` : '',
      songsLabel ? `Songs: ${songsLabel}` : 'Songs: Please review the current service plan in Ultimate Playback.',
      '',
      'Please make sure you have the right songs, review your part, confirm your availability, and be there on time.',
      diffDays === 1 ? 'See you tomorrow.' : 'See you soon.',
    ].filter(Boolean).join('\n'),
    pushTitle: `${diffDays === 1 ? 'Tomorrow' : 'This week'}: ${serviceName}`,
    pushBody: `${scheduleLabel}. Review your songs and be ready on time.`,
  };
}

function isMemberOnlySystemMessage(message = {}) {
  const audience = String(message?.audience || '').trim().toLowerCase();
  const messageType = String(message?.messageType || '').trim().toLowerCase();
  return audience === 'member' || messageType === 'reminder' || messageType === 'birthday_greeting';
}

function isServicePublished(service = {}) {
  return Boolean(
    String(
      service?.publishedAt ||
      service?.published_at ||
      '',
    ).trim(),
  );
}

function buildReminderRecipients(team = [], emailById = {}) {
  const recipientsByEmail = {};

  for (const member of Array.isArray(team) ? team : []) {
    let memberEmail = normalizeLower(member?.email || '');
    let memberName = String(member?.name || '').trim();

    if (!memberEmail && member?.personId) {
      const linked = emailById[normalizeLower(member.personId)] || null;
      if (linked) {
        memberEmail = normalizeLower(linked.email || '');
        memberName = memberName || String(linked.name || '').trim();
      }
    }
    if (!memberEmail) continue;

    const existing = recipientsByEmail[memberEmail] || {
      email: memberEmail,
      name: memberName,
      roles: [],
    };
    if (!existing.name && memberName) existing.name = memberName;

    const nextRoles = new Set(existing.roles);
    const singleRole = String(member?.role || '').trim();
    if (singleRole) nextRoles.add(singleRole);
    for (const role of Array.isArray(member?.roles) ? member.roles : []) {
      const normalizedRole = String(role || '').trim();
      if (normalizedRole) nextRoles.add(normalizedRole);
    }
    existing.roles = [...nextRoles];
    recipientsByEmail[memberEmail] = existing;
  }

  return Object.values(recipientsByEmail);
}

function buildAssignmentAppLink(serviceId, decision = '') {
  const params = new URLSearchParams();
  const normalizedServiceId = String(serviceId || '').trim();
  const normalizedDecision = String(decision || '').trim().toLowerCase();

  if (normalizedServiceId) params.set('serviceId', normalizedServiceId);
  if (normalizedDecision) params.set('decision', normalizedDecision);

  const query = params.toString();
  return query
    ? `ultimateplayback://assignments?${query}`
    : 'ultimateplayback://assignments';
}

function normalizeAssignmentEmailPayload(assignment = {}) {
  const roles = Array.isArray(assignment.roles)
    ? assignment.roles.map((role) => String(role || '').trim()).filter(Boolean)
    : String(assignment.role || '').trim()
      ? [String(assignment.role || '').trim()]
      : [];

  return {
    orgName: String(assignment.orgName || 'Worship Team').trim() || 'Worship Team',
    branchCity: String(assignment.branchCity || '').trim(),
    recipientName: String(assignment.recipientName || assignment.name || '').trim(),
    serviceId: String(assignment.serviceId || '').trim(),
    serviceName: String(assignment.serviceName || assignment.serviceId || 'Service').trim() || 'Service',
    serviceDate: String(assignment.serviceDate || '').trim(),
    serviceTime: String(assignment.serviceTime || '').trim(),
    roles,
  };
}

function buildAssignmentAlertText(assignment) {
  const normalized = normalizeAssignmentEmailPayload(assignment);
  const schedule = buildServiceScheduleLabel(
    normalized.serviceDate,
    normalized.serviceTime,
  );
  const roleLabel = normalized.roles.length === 1 ? 'Role' : 'Roles';
  const acceptLink = buildAssignmentAppLink(normalized.serviceId, 'accept');
  const declineLink = buildAssignmentAppLink(normalized.serviceId, 'decline');

  return [
    `You've been assigned to ${normalized.serviceName} in ${normalized.orgName}.`,
    `When: ${schedule}`,
    normalized.roles.length > 0 ? `${roleLabel}: ${normalized.roles.join(', ')}` : '',
    normalized.branchCity ? `Location: ${normalized.branchCity}` : '',
    'Open Ultimate Playback on the Assignments screen to review and respond to this assignment.',
    `Accept in app: ${acceptLink}`,
    `Decline in app: ${declineLink}`,
    normalized.serviceId ? `Service ID: ${normalized.serviceId}` : '',
  ].filter(Boolean).join('\n\n');
}

function assignmentAlertEmailHtml(assignment) {
  const normalized = normalizeAssignmentEmailPayload(assignment);
  const links = {
    openApp: buildAssignmentAppLink(normalized.serviceId),
    accept: buildAssignmentAppLink(normalized.serviceId, 'accept'),
    decline: buildAssignmentAppLink(normalized.serviceId, 'decline'),
    ios: PLAYBACK_IOS_URL,
    android: PLAYBACK_ANDROID_URL,
    desktop: PLAYBACK_DESKTOP_URL,
  };
  const orgName = escapeHtml(normalized.orgName);
  const recipientName = escapeHtml(normalized.recipientName || 'there');
  const serviceName = escapeHtml(normalized.serviceName);
  const schedule = escapeHtml(
    buildServiceScheduleLabel(normalized.serviceDate, normalized.serviceTime),
  );
  const roleLabel = normalized.roles.length === 1 ? 'Role' : 'Roles';
  const roles = normalized.roles.length > 0
    ? escapeHtml(normalized.roles.join(', '))
    : 'To be confirmed';
  const branchCity = escapeHtml(normalized.branchCity);
  const serviceId = escapeHtml(normalized.serviceId);

  return `
    <div style="background:#020617;padding:32px 20px;font-family:Arial,sans-serif;color:#F8FAFC">
      <div style="max-width:560px;margin:0 auto;background:linear-gradient(180deg,#0B1120 0%,#0F172A 100%);border:1px solid #1F2937;border-radius:28px;overflow:hidden;box-shadow:0 20px 60px rgba(2,6,23,0.45)">
        <div style="padding:32px 32px 18px;background:radial-gradient(circle at top left,rgba(99,102,241,0.22),transparent 55%),radial-gradient(circle at top right,rgba(16,185,129,0.12),transparent 40%)">
          <p style="margin:0 0 10px;color:#A5B4FC;font-size:12px;font-weight:800;letter-spacing:1.4px;text-transform:uppercase">Ultimate Playback</p>
          <h1 style="margin:0 0 12px;font-size:30px;line-height:1.1;color:#FFFFFF">New assignment from ${orgName}</h1>
          <p style="margin:0;color:#CBD5E1;font-size:15px;line-height:1.7">
            Hi ${recipientName}, you were assigned to <strong style="color:#FFFFFF">${serviceName}</strong> in Ultimate Playback.
          </p>
        </div>

        <div style="padding:0 32px 32px">
          <div style="margin:18px 0 24px;padding:18px 20px;border:1px solid #1E293B;border-radius:20px;background:#020617">
            <p style="margin:0 0 6px;color:#94A3B8;font-size:11px;font-weight:800;letter-spacing:1px;text-transform:uppercase">Assignment Details</p>
            <p style="margin:0 0 10px;color:#F8FAFC;font-size:20px;font-weight:700">${serviceName}</p>
            <p style="margin:0;color:#CBD5E1;font-size:14px;line-height:1.7"><strong style="color:#FFFFFF">Organization:</strong> ${orgName}</p>
            <p style="margin:0;color:#CBD5E1;font-size:14px;line-height:1.7"><strong style="color:#FFFFFF">When:</strong> ${schedule}</p>
            <p style="margin:0;color:#CBD5E1;font-size:14px;line-height:1.7"><strong style="color:#FFFFFF">${roleLabel}:</strong> ${roles}</p>
            ${branchCity ? `<p style="margin:0;color:#CBD5E1;font-size:14px;line-height:1.7"><strong style="color:#FFFFFF">Location:</strong> ${branchCity}</p>` : ''}
            ${serviceId ? `<p style="margin:10px 0 0;color:#64748B;font-size:12px;line-height:1.6">Service ID: ${serviceId}</p>` : ''}
          </div>

          <div style="margin-bottom:18px">
            <div style="text-align:center;margin-bottom:10px">
              <a href="${links.accept}" style="display:inline-block;background:linear-gradient(135deg,#10B981 0%,#059669 100%);color:#FFFFFF;text-decoration:none;font-weight:800;font-size:16px;padding:15px 28px;border-radius:16px;box-shadow:0 10px 30px rgba(16,185,129,0.28);margin-right:8px">
                Accept in App
              </a>
              <a href="${links.decline}" style="display:inline-block;background:linear-gradient(135deg,#EF4444 0%,#DC2626 100%);color:#FFFFFF;text-decoration:none;font-weight:800;font-size:16px;padding:15px 28px;border-radius:16px;box-shadow:0 10px 30px rgba(239,68,68,0.24);margin-left:8px">
                Decline in App
              </a>
            </div>
            <p style="margin:0;text-align:center;color:#94A3B8;font-size:12px;line-height:1.7">
              Both buttons open Ultimate Playback on the Assignments screen so you can confirm your decision there.
            </p>
          </div>

          <div style="padding:18px 20px;border:1px solid #1F2937;border-radius:18px;background:rgba(15,23,42,0.88)">
            <p style="margin:0 0 10px;color:#E2E8F0;font-size:14px;font-weight:700">Need the app?</p>
            <p style="margin:0 0 12px;color:#94A3B8;font-size:13px;line-height:1.8">
              Review the assignment and respond in Ultimate Playback on the Assignments screen.
            </p>
            <p style="margin:0 0 12px;color:#CBD5E1;font-size:13px;line-height:1.8">
              <a href="${links.openApp}" style="color:#A5B4FC;text-decoration:none">Open Assignments</a>
            </p>
            <p style="margin:0;color:#CBD5E1;font-size:13px;line-height:1.8">
              <a href="${links.ios}" style="color:#A5B4FC;text-decoration:none">iPhone</a>
              &nbsp;•&nbsp;
              <a href="${links.android}" style="color:#A5B4FC;text-decoration:none">Android</a>
              &nbsp;•&nbsp;
              <a href="${links.desktop}" style="color:#A5B4FC;text-decoration:none">Desktop</a>
            </p>
          </div>
        </div>
      </div>
    </div>
  `;
}

function inviteEmailHtml(invite) {
  const normalized = normalizeInviteRecord(invite);
  const orgName = escapeHtml(normalized.orgName);
  const teamLabel = escapeHtml(buildOrgTeamLabel(normalized.orgName));
  const recipientName = escapeHtml(normalized.name || 'there');
  const invitedByName = escapeHtml(normalized.invitedByName || 'your team admin');
  const landingUrl = buildInviteLandingUrl(normalized.token);
  const contactHint = normalized.email
    ? escapeHtml(normalized.email)
    : normalized.phone
      ? escapeHtml(normalized.phone)
      : 'your invited contact';

  return `
    <div style="background:#020617;padding:32px 20px;font-family:Arial,sans-serif;color:#F8FAFC">
      <div style="max-width:560px;margin:0 auto;background:linear-gradient(180deg,#0B1120 0%,#0F172A 100%);border:1px solid #1F2937;border-radius:28px;overflow:hidden;box-shadow:0 20px 60px rgba(2,6,23,0.45)">
        <div style="padding:32px 32px 18px;background:radial-gradient(circle at top left,rgba(99,102,241,0.22),transparent 55%),radial-gradient(circle at top right,rgba(16,185,129,0.12),transparent 40%)">
          <p style="margin:0 0 10px;color:#A5B4FC;font-size:12px;font-weight:800;letter-spacing:1.4px;text-transform:uppercase">Ultimate Playback</p>
          <h1 style="margin:0 0 12px;font-size:30px;line-height:1.1;color:#FFFFFF">You're invited to join ${teamLabel}</h1>
          <p style="margin:0;color:#CBD5E1;font-size:15px;line-height:1.7">
            Hi ${recipientName}, ${invitedByName} invited you to join ${teamLabel} in Ultimate Playback as a new team member so you can receive assignments, setlists, practice materials, and team updates.
          </p>
        </div>

        <div style="padding:0 32px 32px">
          <div style="margin:18px 0 24px;padding:18px 20px;border:1px solid #1E293B;border-radius:20px;background:#020617">
            <p style="margin:0 0 6px;color:#94A3B8;font-size:11px;font-weight:800;letter-spacing:1px;text-transform:uppercase">Organization</p>
            <p style="margin:0 0 14px;color:#F8FAFC;font-size:18px;font-weight:700">${orgName}</p>
            <p style="margin:0 0 6px;color:#94A3B8;font-size:11px;font-weight:800;letter-spacing:1px;text-transform:uppercase">Register With</p>
            <p style="margin:0;color:#F8FAFC;font-size:18px;font-weight:700">${contactHint}</p>
            <p style="margin:10px 0 0;color:#94A3B8;font-size:13px;line-height:1.6">
              After you accept, you'll see links for iPhone, Android, and Mac/Desktop. Registration is protected by a 6-digit confirmation code sent by email.
            </p>
          </div>

          <div style="text-align:center;margin-bottom:24px">
            <a href="${landingUrl}" style="display:inline-block;background:linear-gradient(135deg,#6366F1 0%,#8B5CF6 100%);color:#FFFFFF;text-decoration:none;font-weight:800;font-size:16px;padding:15px 28px;border-radius:16px;box-shadow:0 10px 30px rgba(99,102,241,0.35)">
              Accept Invitation
            </a>
          </div>

          <div style="padding:18px 20px;border:1px solid #1F2937;border-radius:18px;background:rgba(15,23,42,0.88)">
            <p style="margin:0 0 10px;color:#E2E8F0;font-size:14px;font-weight:700">What happens next</p>
            <ol style="margin:0;padding-left:18px;color:#94A3B8;font-size:13px;line-height:1.8">
              <li>Accept this invitation.</li>
              <li>Download or open Ultimate Playback.</li>
              <li>Create your account with your invited contact info.</li>
              <li>Enter the confirmation code emailed to you.</li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  `;
}

async function sendTeamInviteEmail(env, { to, invite }) {
  const resendApiKey = env.RESEND_API_KEY || '';
  const fromEmail =
    env.INVITE_FROM_EMAIL
    || env.ULTIMATE_MUSICIAN_FROM_EMAIL
    || 'ultimatemusician@ultimatelabs.co';
  const fromName =
    env.INVITE_FROM_NAME
    || env.ULTIMATE_MUSICIAN_FROM_NAME
    || 'Ultimate Musician';
  if (!resendApiKey || !fromEmail) {
    throw new Error('Invitation email is not configured');
  }

  const normalized = normalizeInviteRecord(invite);
  const teamLabel = buildOrgTeamLabel(normalized.orgName);
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${resendApiKey}`,
    },
    body: JSON.stringify({
      from: `${fromName} <${fromEmail}>`,
      to: [to],
      subject: `You're invited to join ${teamLabel}`,
      html: inviteEmailHtml(normalized),
      text: buildInviteShareText(normalized),
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    console.log('[sync/invite/create] resend failed', detail);
    throw new Error('Failed to send invitation email');
  }
}

async function sendAssignmentAlertEmail(env, { to, assignment }) {
  const resendApiKey = env.RESEND_API_KEY || '';
  const fromEmail =
    env.ASSIGNMENT_FROM_EMAIL
    || env.INVITE_FROM_EMAIL
    || env.ULTIMATE_MUSICIAN_FROM_EMAIL
    || 'ultimatemusician@ultimatelabs.co';
  const fromName =
    env.ASSIGNMENT_FROM_NAME
    || env.INVITE_FROM_NAME
    || env.ULTIMATE_MUSICIAN_FROM_NAME
    || 'Ultimate Musician';

  if (!resendApiKey || !fromEmail) {
    throw new Error('Assignment email is not configured');
  }

  const normalized = normalizeAssignmentEmailPayload(assignment);
  const schedule = buildServiceScheduleLabel(
    normalized.serviceDate,
    normalized.serviceTime,
  );
  const subjectParts = [
    normalized.orgName,
    `assignment for ${normalized.serviceName}`,
    schedule && schedule !== 'Date and time to be confirmed' ? schedule : '',
  ].filter(Boolean);
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${resendApiKey}`,
    },
    body: JSON.stringify({
      from: `${fromName} <${fromEmail}>`,
      to: [to],
      subject: subjectParts.join(' • '),
      html: assignmentAlertEmailHtml(normalized),
      text: buildAssignmentAlertText(normalized),
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    console.log('[sync/publish] resend failed', detail);
    throw new Error('Failed to send assignment email');
  }
}

async function getOrgTeamInvites(env, orgId) {
  return kvGet(env, orgKey(orgId, 'teamInvites'), []);
}

async function saveInviteRecord(env, invite) {
  const normalized = normalizeInviteRecord(invite);
  await kvPut(env, `invite:${normalized.token}`, normalized);

  if (normalized.orgId) {
    const invites = await getOrgTeamInvites(env, normalized.orgId);
    const nextInvites = Array.isArray(invites) ? [...invites] : [];
    const idx = nextInvites.findIndex((item) => item?.token === normalized.token);
    if (idx >= 0) nextInvites[idx] = { ...nextInvites[idx], ...normalized };
    else nextInvites.unshift(normalized);
    await kvPut(env, orgKey(normalized.orgId, 'teamInvites'), nextInvites);
  }

  return normalized;
}

async function markInviteRegistered(env, orgId, { email = '', phone = '', name = '' }) {
  const invites = await getOrgTeamInvites(env, orgId);
  if (!Array.isArray(invites) || invites.length === 0) return null;

  const normalizedEmail = normalizeLower(email);
  const normalizedPhone = normalizePhone(phone || '');
  let bestIndex = -1;
  let bestCreatedAt = '';

  for (let i = 0; i < invites.length; i += 1) {
    const invite = normalizeInviteRecord(invites[i]);
    const emailMatch = normalizedEmail && invite.email === normalizedEmail;
    const phoneMatch = normalizedPhone && normalizePhone(invite.phone || '') === normalizedPhone;
    if (!emailMatch && !phoneMatch) continue;
    const createdAt = String(invite.createdAt || '');
    if (bestIndex === -1 || createdAt > bestCreatedAt) {
      bestIndex = i;
      bestCreatedAt = createdAt;
    }
  }

  if (bestIndex === -1) return null;

  const updatedInvite = normalizeInviteRecord({
    ...invites[bestIndex],
    name: name || invites[bestIndex]?.name || '',
    status: 'registered',
    acceptedAt: invites[bestIndex]?.acceptedAt || new Date().toISOString(),
    registeredAt: invites[bestIndex]?.registeredAt || new Date().toISOString(),
  });

  const nextInvites = [...invites];
  nextInvites[bestIndex] = updatedInvite;
  await kvPut(env, orgKey(orgId, 'teamInvites'), nextInvites);
  await kvPut(env, `invite:${updatedInvite.token}`, updatedInvite);
  return updatedInvite;
}

async function markPersonAsPlaybackRegistered(env, orgId, { email = '', phone = '' }) {
  const people = await kvGet(env, orgKey(orgId, 'people'), []);
  if (!Array.isArray(people) || people.length === 0) return null;

  const normalizedEmail = normalizeLower(email);
  const normalizedPhone = normalizePhone(phone || '');
  const personIndex = people.findIndex((person) => {
    const personEmail = normalizeLower(person?.email || '');
    const personPhone = normalizePhone(person?.phone || '');
    return (
      (normalizedEmail && personEmail === normalizedEmail)
      || (normalizedPhone && personPhone === normalizedPhone)
    );
  });

  if (personIndex === -1) return null;

  const nextPeople = [...people];
  nextPeople[personIndex] = {
    ...nextPeople[personIndex],
    inviteStatus: 'registered',
    inviteAcceptedAt:
      nextPeople[personIndex]?.inviteAcceptedAt || new Date().toISOString(),
    inviteRegisteredAt:
      nextPeople[personIndex]?.inviteRegisteredAt || new Date().toISOString(),
    playbackRegistered: true,
    playbackRegisteredAt:
      nextPeople[personIndex]?.playbackRegisteredAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await kvPut(env, orgKey(orgId, 'people'), nextPeople);
  return nextPeople[personIndex];
}

async function updatePersonInviteState(
  env,
  orgId,
  { email = '', phone = '', patch = {} } = {},
) {
  const people = await kvGet(env, orgKey(orgId, 'people'), []);
  if (!Array.isArray(people) || people.length === 0) return null;

  const normalizedEmail = normalizeLower(email);
  const normalizedPhone = normalizePhone(phone || '');
  const personIndex = people.findIndex((person) => {
    const personEmail = normalizeLower(person?.email || '');
    const personPhone = normalizePhone(person?.phone || '');
    return (
      (normalizedEmail && personEmail === normalizedEmail)
      || (normalizedPhone && personPhone === normalizedPhone)
    );
  });

  if (personIndex === -1) return null;

  const nextPeople = [...people];
  nextPeople[personIndex] = {
    ...nextPeople[personIndex],
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await kvPut(env, orgKey(orgId, 'people'), nextPeople);
  return nextPeople[personIndex];
}

// ── Chart metadata extraction (shared by song/patch and proposal/approve) ──
const SEEDABLE_INSTRUMENTS = ['Keys', 'Electric Guitar', 'Acoustic Guitar', 'Bass', 'Synth/Pad', 'Drums'];
const PRIVILEGED_ROLES     = ['admin','md','worship_leader','Worship Leader','Leader','music_director','Music Director'];

function extractMetaFromChart(text) {
  const m = {};
  const bpm = text.match(/\b(\d{2,3})\s*(?:BPM|bpm)\b|(?:BPM|Tempo)[:\s]+(\d{2,3})/i);
  if (bpm) m.bpm = parseInt(bpm[1] || bpm[2], 10);
  const key = text.match(/(?:Tom|Key|Tonalidade|Chave)[:\s]+([A-G][#b]?(?:\/[A-G][#b]?)?(?:\s*m(?:in)?)?)/i);
  if (key) m.key = key[1].split('/')[0].trim().replace(/\s*min$/i, 'm');
  const ts = text.match(/\b([2-9]\/[2-9](?:6?8?)?)\b/);
  if (ts) m.timeSig = ts[1];
  const title = text.match(/(?:Song|Title|Música)\s*:\s*(.+)/i);
  if (title) m.title = title[1].trim();
  const artist = text.match(/(?:Artist|Artista|By)\s*:\s*(.+)/i);
  if (artist) m.artist = artist[1].trim();
  return m;
}

// Applies a chart value to a song object following the seeding protocol:
// - instrumentNotes[noteKey] updated
// - master chordChart promoted/overridden per privilege level
// - empty instrument slots seeded from master
// - empty song metadata auto-filled from chart text
// Returns detected metadata object.
function applyChartToSong(song, { field, value, instrument, keyboardRigs, isPrivileged }) {
  const noteKey = instrument === 'Synth/Pad' ? 'Keys' : instrument;
  if (field === 'instrumentNotes' && noteKey) {
    if (!song.instrumentNotes) song.instrumentNotes = {};
    song.instrumentNotes[noteKey] = value;
    if (Array.isArray(keyboardRigs) && keyboardRigs.length) {
      const existing = Array.isArray(song.keyboardRigs) ? song.keyboardRigs : [];
      song.keyboardRigs = [...new Set([...existing, ...keyboardRigs])];
    }
    // Privileged users always override master; others only if master is empty
    if (isPrivileged || !song.chordChart) {
      song.chordChart = value;
      song.chordSheet = value;
      // Seed other empty instrument slots from this new master
      if (!song.instrumentNotes) song.instrumentNotes = {};
      for (const instr of SEEDABLE_INSTRUMENTS) {
        if (instr !== noteKey && !song.instrumentNotes[instr]) {
          song.instrumentNotes[instr] = value;
        }
      }
    }
  } else if (field === 'lyrics') {
    song.lyrics = value;
  } else {
    // Master chord chart — seed all empty instrument slots
    song.chordChart = value;
    song.chordSheet = value;
    if (!song.instrumentNotes) song.instrumentNotes = {};
    for (const instr of SEEDABLE_INSTRUMENTS) {
      if (!song.instrumentNotes[instr]) song.instrumentNotes[instr] = value;
    }
  }
  // Auto-populate empty song metadata from chart text
  const detected = extractMetaFromChart(value || '');
  if (detected.key    && !song.key)      song.key     = detected.key;
  if (detected.bpm    && !song.bpm)      song.bpm     = detected.bpm;
  if (detected.timeSig && !song.timeSig) song.timeSig = detected.timeSig;
  if (detected.title  && !song.title)    song.title   = detected.title;
  if (detected.artist && !song.artist)   song.artist  = detected.artist;
  return detected;
}

// ── Identifier resolution (email or phone → canonical email) ──────────────

function normalizePhone(str) {
  return String(str || '').replace(/\D/g, '');
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
      personExists: !!person,
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
    personExists: !!person,
  };
}

async function loadAuthAccess(env, orgId, canonicalEmail, user) {
  const [roles, grants] = await Promise.all([
    kvGet(env, orgKey(orgId, 'roles'), {}),
    kvGet(env, orgKey(orgId, 'grants'), {}),
  ]);
  return {
    role: roles[canonicalEmail] || user?.role || 'member',
    grantedRole: grants[canonicalEmail] || null,
  };
}

function buildAuthResponse({
  user,
  canonicalEmail,
  personName,
  personPhone,
  org,
  role,
  grantedRole,
  extra = {},
}) {
  return {
    ok: true,
    role,
    grantedRole: grantedRole || null,
    name: user?.name || personName || canonicalEmail,
    email: canonicalEmail,
    phone: personPhone || null,
    orgName: org.name,
    branchCity: org.city || '',
    ...extra,
  };
}

function normalizeStoredPerson(person = {}) {
  const normalizedRoles = Array.isArray(person.roles)
    ? person.roles.filter(Boolean)
    : [];
  const blockoutDates = Array.isArray(person.blockout_dates)
    ? person.blockout_dates
    : [];
  const inviteStatus = getEffectiveInviteStatus(person);
  const roleSyncSource = String(person.roleSyncSource || '').trim().toLowerCase();
  const playbackRegistered =
    person.playbackRegistered === true
    || Boolean(person.playbackRegisteredAt)
    || Boolean(person.inviteRegisteredAt);

  return {
    ...person,
    id: String(person.id || '').trim(),
    name: String(person.name || '').trim(),
    lastName: String(person.lastName || '').trim(),
    email: normalizeLower(person.email || ''),
    phone: String(person.phone || '').trim(),
    dateOfBirth: String(person.dateOfBirth || '').trim(),
    photo_url: pickPreferredPhotoUrl(person.photo_url),
    roles: normalizedRoles,
    roleAssignments:
      String(person.roleAssignments || '').trim()
      || normalizedRoles.join(', '),
    roleSyncSource,
    roleSyncUpdatedAt: person.roleSyncUpdatedAt || null,
    blockout_dates: blockoutDates,
    inviteStatus,
    inviteToken: String(person.inviteToken || '').trim(),
    inviteCreatedAt: person.inviteCreatedAt || null,
    inviteSentAt: person.inviteSentAt || null,
    inviteAcceptedAt: person.inviteAcceptedAt || null,
    inviteRegisteredAt: person.inviteRegisteredAt || null,
    playbackRegistered,
    playbackRegisteredAt:
      person.playbackRegisteredAt || person.inviteRegisteredAt || null,
    updatedAt: person.updatedAt || new Date().toISOString(),
    createdAt: person.createdAt || new Date().toISOString(),
  };
}

function getPersonIdentityKeys(person) {
  const normalized = normalizeStoredPerson(person);
  const keys = [];
  if (normalized.id) keys.push(`id:${normalized.id}`);
  if (normalized.email) keys.push(`email:${normalized.email}`);
  const phoneDigits = normalizePhone(normalized.phone);
  if (phoneDigits) keys.push(`phone:${phoneDigits}`);
  return keys;
}

function mergeStoredPeople(existingPeople = [], incomingPeople = []) {
  const merged = [];
  const identityMap = new Map();

  const registerIdentities = (person, index) => {
    for (const key of getPersonIdentityKeys(person)) {
      identityMap.set(key, index);
    }
  };

  for (const sourcePerson of [...existingPeople, ...incomingPeople]) {
    const person = normalizeStoredPerson(sourcePerson);
    if (!person.id && !person.email && !normalizePhone(person.phone) && !person.name) {
      continue;
    }

    const identities = getPersonIdentityKeys(person);
    let existingIndex = -1;
    for (const key of identities) {
      if (identityMap.has(key)) {
        existingIndex = identityMap.get(key);
        break;
      }
    }

    if (existingIndex === -1) {
      const nextPerson = {
        ...person,
        id: person.id || `person_${makeId(12)}`,
      };
      const nextIndex = merged.push(nextPerson) - 1;
      registerIdentities(nextPerson, nextIndex);
      continue;
    }

    const current = merged[existingIndex];
    const shouldReplaceRoles =
      person.roleSyncSource === 'playback_profile'
      && Array.isArray(person.roles)
      && person.roles.length > 0;
    const nextInviteStatus = pickHighestInviteStatus(current, person);
    const nextPlaybackRegistered =
      person.playbackRegistered === true
      || current.playbackRegistered === true
      || Boolean(person.playbackRegisteredAt)
      || Boolean(current.playbackRegisteredAt)
      || Boolean(person.inviteRegisteredAt)
      || Boolean(current.inviteRegisteredAt);
    const mergedRoles = Array.from(
      new Set(
        shouldReplaceRoles
          ? [...(person.roles || [])]
          : [...(current.roles || []), ...(person.roles || [])],
      ),
    );
    const nextPerson = {
      ...current,
      ...person,
      id: current.id || person.id || `person_${makeId(12)}`,
      name: person.name || current.name || '',
      lastName: person.lastName || current.lastName || '',
      email: person.email || current.email || '',
      phone: person.phone || current.phone || '',
      dateOfBirth: person.dateOfBirth || current.dateOfBirth || '',
      photo_url: pickPreferredPhotoUrl(person.photo_url, current.photo_url),
      roles: mergedRoles,
      roleAssignments:
        shouldReplaceRoles
          ? (person.roleAssignments || mergedRoles.join(', '))
          : (
            person.roleAssignments
            || current.roleAssignments
            || mergedRoles.join(', ')
          ),
      roleSyncSource: person.roleSyncSource || current.roleSyncSource || '',
      roleSyncUpdatedAt:
        person.roleSyncUpdatedAt || current.roleSyncUpdatedAt || null,
      blockout_dates:
        Array.isArray(person.blockout_dates) && person.blockout_dates.length > 0
          ? person.blockout_dates
          : current.blockout_dates || [],
      inviteStatus: nextInviteStatus,
      inviteToken: person.inviteToken || current.inviteToken || '',
      inviteCreatedAt:
        person.inviteCreatedAt || current.inviteCreatedAt || null,
      inviteSentAt: person.inviteSentAt || current.inviteSentAt || null,
      inviteAcceptedAt:
        person.inviteAcceptedAt || current.inviteAcceptedAt || null,
      inviteRegisteredAt:
        person.inviteRegisteredAt || current.inviteRegisteredAt || null,
      playbackRegistered: nextPlaybackRegistered,
      playbackRegisteredAt:
        person.playbackRegisteredAt
        || current.playbackRegisteredAt
        || person.inviteRegisteredAt
        || current.inviteRegisteredAt
        || null,
      createdAt: current.createdAt || person.createdAt || new Date().toISOString(),
      updatedAt: person.updatedAt || new Date().toISOString(),
    };
    merged[existingIndex] = nextPerson;
    registerIdentities(nextPerson, existingIndex);
  }

  return merged;
}

// ── Auth ───────────────────────────────────────────────────────────────────

async function verifyAuth(env, request) {
  const url = new URL(request.url);
  // Accept auth via headers (standard) OR query params (needed for browser WebSocket upgrades
  // where custom headers can't be set — e.g. Electron MIDI bridge, SetlistRunner)
  const orgId  = request.headers.get('x-org-id')     || url.searchParams.get('orgId')  || '';
  const secret = request.headers.get('x-secret-key') || url.searchParams.get('sk')     || '';
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

  // ── Public: GET /sync/audio/* — serve audio files from R2 ───────────────
  if (route.startsWith('audio/') && method === 'GET') {
    const key = decodeURIComponent(route); // R2 keys use literal spaces, not %20
    if (!env.STEMS_R2) return json({ error: 'Storage not configured' }, 503);
    try {
      const obj = await env.STEMS_R2.get(key);
      if (!obj) return new Response('Not found', { status: 404, headers: CORS_HEADERS });
      const ext = key.split('.').pop().toLowerCase();
      const mimeMap = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4' };
      const contentType = mimeMap[ext] || 'application/octet-stream';
      const headers = {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400',
        'Accept-Ranges': 'bytes',
        ...CORS_HEADERS,
      };
      if (obj.size) headers['Content-Length'] = String(obj.size);
      return new Response(obj.body, { status: 200, headers });
    } catch (err) {
      return json({ error: 'Storage error', detail: err?.message }, 500);
    }
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
      adminName = null,
      adminEmail = null,
      adminRole = 'Pastor',
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
          branches.push({
            branchId: orgId, name, city, language, createdAt: org.createdAt,
            adminName: adminName || null,
            adminEmail: adminEmail || null,
            adminRole: adminRole || 'Pastor',
          });
          await kvPut(env, `org:${parentOrgId}:branches`, branches);
        }
      }
    }

    // D1 write-through + analytics
    d1UpsertOrg(env, org);
    trackEvent(env, orgId, 'register_org', { name, city });

    // Return secret key ONCE — never stored in plain text
    return json({ ok: true, orgId, secretKey, name, city, language });
  }

  // ── Public: GET /sync/invite/resolve?token=... — landing page uses this ──
  if (route === 'invite/resolve' && method === 'GET') {
    const token = url.searchParams.get('token') || '';
    if (!token) return json({ error: 'token required' }, 400);
    const invite = await kvGet(env, `invite:${token}`, null);
    if (!invite) return json({ error: 'Invite not found' }, 404);
    return json({ ok: true, ...publicInvitePayload(invite) });
  }

  // ── Public: POST /sync/invite/accept — mark invite accepted ──────────────
  if (route === 'invite/accept' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const token = String(body.token || '').trim();
    if (!token) return json({ error: 'token required' }, 400);
    const invite = await kvGet(env, `invite:${token}`, null);
    if (!invite) return json({ error: 'Invite not found' }, 404);

    const updatedInvite = normalizeInviteRecord({
      ...invite,
      status: invite.status === 'registered' ? 'registered' : 'accepted',
      acceptedAt: invite.acceptedAt || new Date().toISOString(),
    });
    await saveInviteRecord(env, updatedInvite);
    if (updatedInvite.orgId) {
      await updatePersonInviteState(env, updatedInvite.orgId, {
        email: updatedInvite.email,
        phone: updatedInvite.phone,
        patch: {
          inviteStatus: updatedInvite.status,
          inviteToken: updatedInvite.token,
          inviteAcceptedAt:
            updatedInvite.acceptedAt || new Date().toISOString(),
          inviteRegisteredAt: updatedInvite.registeredAt || null,
        },
      });
    }
    return json({ ok: true, ...publicInvitePayload(updatedInvite) });
  }

  // ── Public: GET /sync/stems/source/:key — fetch uploaded source audio ────
  if (route.startsWith('stems/source/') && method === 'GET') {
    const encodedKey = route.slice('stems/source/'.length);
    const key = decodeURIComponent(encodedKey || '').trim();
    if (!key) return json({ error: 'source key required' }, 400);
    const object = await env.STEMS_R2?.get(key);
    if (!object) {
      return new Response('Not found', { status: 404, headers: CORS_HEADERS });
    }
    const headers = new Headers(CORS_HEADERS);
    headers.set(
      'Content-Type',
      object.httpMetadata?.contentType || 'application/octet-stream',
    );
    headers.set('Cache-Control', 'public, max-age=86400');
    headers.set('Accept-Ranges', 'bytes');
    return new Response(object.body, { headers });
  }

  // ── Public: GET /sync/cron/reminders — daily cron (CRON_SECRET protected) ─
  // Separate from the per-org handler below; runs across ALL orgs in one call.
  // Optional ?daysOut=3 or ?daysOut=1 to restrict which reminder window to fire.
  if (route === 'cron/reminders' && method === 'GET') {
    const cronSecret = env.CRON_SECRET || '';
    const providedSecret = request.headers.get('x-cron-secret') || url.searchParams.get('secret') || '';
    if (!cronSecret || providedSecret !== cronSecret) {
      return new Response('Unauthorized', { status: 401, headers: CORS_HEADERS });
    }

    // Optional filter: only send reminders for a specific days-out window
    const daysOutParam = url.searchParams.get('daysOut');
    const TARGET_DAYS = daysOutParam
      ? [parseInt(daysOutParam, 10)].filter(n => n > 0 && n < 30)
      : [3, 1];

    // List all org meta keys to discover org IDs
    let orgIds = [];
    try {
      let cursor = undefined;
      do {
        const listResult = await env.STORE.list({ prefix: 'org:', cursor, limit: 1000 });
        for (const key of listResult.keys) {
          // Org root records are stored as "org:{orgId}" (exactly 2 colon-separated parts)
          const parts = key.name.split(':');
          if (parts.length === 2 && parts[0] === 'org') orgIds.push(parts[1]);
        }
        cursor = listResult.list_complete ? undefined : listResult.cursor;
      } while (cursor);
    } catch (err) {
      console.log('[cron/reminders] KV list error', err?.message || String(err));
    }
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const results = [];

    for (const oid of orgIds) {
      try {
        const orgMeta = await kvGet(env, `org:${oid}`, null);
        if (!orgMeta || !orgMeta.orgId) continue;

        const [services, plans, people, pushDevices] = await Promise.all([
          kvGet(env, orgKey(oid, 'services'), []),
          kvGet(env, orgKey(oid, 'plans'), {}),
          kvGet(env, orgKey(oid, 'people'), []),
          getPushDevices(env, oid),
        ]);

        const emailById = {};
        for (const p of (Array.isArray(people) ? people : [])) {
          if (p.id) emailById[normalizeLower(p.id)] = { email: normalizeLower(p.email || ''), name: p.name || '' };
        }

        const sentKey = orgKey(oid, 'remindersSent');
        const remindersSent = await kvGet(env, sentKey, {});
        const newlySent = {};
        let emailSent = 0, msgCreated = 0, pushSent = 0;

        for (const service of (Array.isArray(services) ? services : [])) {
          if (!isServicePublished(service)) continue;
          const rawDate = service.date || service.serviceDate || '';
          if (!rawDate) continue;
          const serviceDate = rawDate.slice(0, 10);
          const diffMs = new Date(serviceDate + 'T00:00:00Z') - new Date(todayStr + 'T00:00:00Z');
          const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
          if (!TARGET_DAYS.includes(diffDays)) continue;

          const plan = plans[service.id] || {};
          const team = Array.isArray(plan.team) ? plan.team : Array.isArray(service.team) ? service.team : [];
          if (team.length === 0) continue;

          const serviceName = service.name || service.title || 'Service';
          const orgName = orgMeta.name || 'Your Church';
          const songs = Array.isArray(plan.songs) ? plan.songs.map(s => s.title || s.name || '').filter(Boolean) : [];

          const recipients = buildReminderRecipients(team, emailById);
          for (const recipient of recipients) {
            const memberEmail = recipient.email;
            const memberName = recipient.name;
            const dupKey = `${service.id}::${diffDays}d::${memberEmail}`;
            if (remindersSent[dupKey] || newlySent[dupKey]) continue;

            const reminderContent = buildServiceReminderContent({
              service,
              orgName,
              memberName,
              roles: recipient.roles,
              songs,
              diffDays,
            });

            // Email
            const resendApiKey = env.RESEND_API_KEY || '';
            if (resendApiKey) {
              try {
                const fromEmail = env.ASSIGNMENT_FROM_EMAIL || env.INVITE_FROM_EMAIL || 'ultimatemusician@ultimatelabs.co';
                const fromName = env.ASSIGNMENT_FROM_NAME || env.INVITE_FROM_NAME || 'Ultimate Musician';
                const emailRes = await fetch('https://api.resend.com/emails', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendApiKey}` },
                  body: JSON.stringify({
                    from: `${fromName} <${fromEmail}>`,
                    to: [memberEmail],
                    subject: reminderContent.emailSubject,
                    html: reminderContent.htmlBody,
                    text: reminderContent.textBody,
                  }),
                });
                if (emailRes.ok) emailSent++;
                else console.log('[cron/reminders] email fail', oid, memberEmail, await emailRes.text());
              } catch (e) { console.log('[cron/reminders] email err', oid, memberEmail, e?.message); }
            }

            // In-app message
            try {
              const msgs = await kvGet(env, orgKey(oid, 'messages'), []);
              msgs.unshift({
                id: makeId(),
                fromEmail: 'system@ultimatelabs.co',
                fromName: orgName,
                subject: reminderContent.inAppSubject,
                message: reminderContent.inAppMessage,
                to: memberEmail,
                timestamp: new Date().toISOString(),
                read: false,
                replies: [],
                hiddenFor: [],
                visibility: 'conversation',
                messageType: 'reminder',
                audience: 'member',
                isSystemMsg: false,
                serviceId: service.id,
              });
              await kvPut(env, orgKey(oid, 'messages'), msgs);
              msgCreated++;
            } catch (e) { console.log('[cron/reminders] msg err', oid, e?.message); }

            // Push
            try {
              const targets = filterPushDevices(pushDevices, { emails: [memberEmail], preferenceKey: 'messages' });
              if (targets.length > 0) {
                await sendPushToDevices(targets, {
                  title: reminderContent.pushTitle,
                  body: reminderContent.pushBody,
                  data: { type: 'reminder', screen: 'AssignmentsTab', serviceId: service.id },
                }, 'messages');
                pushSent += targets.length;
              }
            } catch (e) { console.log('[cron/reminders] push err', oid, e?.message); }

            newlySent[dupKey] = new Date().toISOString();
            d1InsertReminderSent(env, oid, service.id, diffDays, memberEmail); // D1 dedup write
          }
        }

        // Persist dedup log with 8-day TTL cleanup
        const merged = { ...remindersSent, ...newlySent };
        const cutoff = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
        for (const k of Object.keys(merged)) { if (merged[k] < cutoff) delete merged[k]; }
        await kvPut(env, sentKey, merged);

        results.push({ orgId: oid, emailSent, msgCreated, pushSent, newReminders: Object.keys(newlySent).length });
      } catch (orgErr) {
        results.push({ orgId: oid, error: orgErr?.message || String(orgErr) });
      }
    }

    return json({ ok: true, orgsProcessed: orgIds.length, results });
  }

  // ── Public: POST /sync/stripe/webhook — Stripe payment events ────────────
  // Stripe sends raw body with Stripe-Signature header — must be unauthenticated.
  if (route === 'stripe/webhook' && method === 'POST') {
    if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
      return json({ error: 'Stripe not configured' }, 503);
    }
    const rawBody = await request.text();
    const sig = request.headers.get('stripe-signature') || '';
    // Verify Stripe signature using HMAC-SHA256
    let event;
    try {
      event = await verifyStripeWebhook(rawBody, sig, env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('[stripe/webhook] signature verification failed:', err.message);
      return new Response('Webhook signature invalid', { status: 400 });
    }
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const orgId = session.metadata?.orgId;
      const planType = session.metadata?.plan || 'pro';
      const subId = session.subscription || null;
      const customerId = session.customer || null;
      if (orgId && env.UM_DB) {
        try {
          // Set plan = 'pro', store stripe IDs, set 1-year expiry for one-time payments
          const expiresAt = subId ? null : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
          await env.UM_DB.prepare(
            `UPDATE orgs SET plan = ?, stripeCustomerId = ?, stripeSubId = ?, planExpiresAt = ? WHERE orgId = ?`
          ).bind(planType, customerId, subId, expiresAt, orgId).run();
          console.log(`[stripe/webhook] org ${orgId} upgraded to ${planType}`);
        } catch (dbErr) {
          console.error('[stripe/webhook] D1 update failed:', dbErr.message);
        }
      }
    }
    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const customerId = sub.customer;
      if (customerId && env.UM_DB) {
        try {
          await env.UM_DB.prepare(
            `UPDATE orgs SET plan = 'free' WHERE stripeCustomerId = ?`
          ).bind(customerId).run();
          console.log(`[stripe/webhook] subscription cancelled for customer ${customerId}`);
        } catch (_) {}
      }
    }
    return json({ received: true });
  }

  // ── All routes below require auth ────────────────────────────────────────
  const org = await verifyAuth(env, request);
  if (!org) {
    return json({ error: 'Unauthorized. Include x-org-id and x-secret-key headers.' }, 401);
  }
  const { orgId } = org;
  await ensureBirthdayMessages(env, orgId, org).catch((error) => {
    console.log('[sync/birthday] failed', error?.message || error);
  });

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

  // ── POST /sync/stems/upload — upload local source audio to R2 ────────────
  if (route === 'stems/upload' && method === 'POST') {
    if (!env.STEMS_R2) {
      return json({ error: 'Source upload storage is not configured.' }, 503);
    }
    if (!request.body) return json({ error: 'audio body required' }, 400);

    const uploadId = clipText(url.searchParams.get('uploadId') || makeId(12), 120)
      .replace(/[^a-zA-Z0-9._-]+/g, '_');
    const fileName = sanitizeFileName(
      url.searchParams.get('filename')
        || request.headers.get('x-file-name')
        || `audio_${Date.now()}.mp3`,
    );
    const contentType = clipText(
      request.headers.get('Content-Type') || 'application/octet-stream',
      120,
    ) || 'application/octet-stream';
    const key = `source-audio/${orgId}/${uploadId}/${fileName}`;

    await env.STEMS_R2.put(key, request.body, {
      httpMetadata: { contentType },
    });

    return json({
      ok: true,
      key,
      fileUrl: stemSourcePublicUrl(url.origin, key),
    });
  }

  // ── POST /sync/stems/upload-file — upload finished stem/media file to R2 ─
  if (route === 'stems/upload-file' && method === 'POST') {
    if (!env.STEMS_R2) {
      return json({ error: 'Stem upload storage is not configured.' }, 503);
    }
    if (!request.body) return json({ error: 'file body required' }, 400);

    const songId = clipText(url.searchParams.get('songId') || '', 160)
      .replace(/[^a-zA-Z0-9._-]+/g, '_');
    if (!songId) return json({ error: 'songId required' }, 400);

    const uploadId = clipText(url.searchParams.get('uploadId') || makeId(12), 120)
      .replace(/[^a-zA-Z0-9._-]+/g, '_');
    const stemType = sanitizeStemSlot(
      url.searchParams.get('stemType') || request.headers.get('x-stem-type') || 'track',
      'track',
    );
    const fileName = sanitizeFileName(
      url.searchParams.get('filename')
        || request.headers.get('x-file-name')
        || `${stemType}_${Date.now()}.m4a`,
    );
    const contentType = clipText(
      request.headers.get('Content-Type') || 'application/octet-stream',
      120,
    ) || 'application/octet-stream';
    const key = `processed-stems/${orgId}/${songId}/${uploadId}/${stemType}_${fileName}`;

    await env.STEMS_R2.put(key, request.body, {
      httpMetadata: { contentType },
    });

    return json({
      ok: true,
      songId,
      stemType,
      key,
      fileUrl: stemObjectPublicUrl(url.origin, key),
    });
  }

  // ── GET /sync/songs/search?q=...&limit=20 — server-side song search ─────
  // Returns songs whose title or artist contain the query string.
  if (route === 'songs/search' && method === 'GET') {
    const q = (url.searchParams.get('q') || '').toLowerCase().trim();
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 100);
    if (!q) return json({ ok: true, songs: [] });
    const songMap = await kvGet(env, orgKey(orgId, 'songLibrary'), {});
    const results = Object.values(songMap)
      .filter(s => {
        const title  = (s.title  || '').toLowerCase();
        const artist = (s.artist || '').toLowerCase();
        const tags   = (s.tags   || '').toLowerCase();
        return title.includes(q) || artist.includes(q) || tags.includes(q);
      })
      .slice(0, limit)
      .map(s => ({ id: s.id, title: s.title, artist: s.artist, key: s.key, bpm: s.bpm, tags: s.tags }));
    return json({ ok: true, songs: results, total: results.length });
  }

  // ── POST /sync/songs/vectorize — embed all org songs into Vectorize ──────
  // Call once (or after bulk edits) to index the library for semantic search.
  if (route === 'songs/vectorize' && method === 'POST') {
    if (!env.AI || !env.VECTORIZE) return json({ error: 'AI or Vectorize not bound' }, 503);
    const songMap = await kvGet(env, orgKey(orgId, 'songLibrary'), {});
    const songs = Object.values(songMap);
    if (songs.length === 0) return json({ ok: true, indexed: 0 });
    let indexed = 0;
    const BATCH = 20;
    for (let i = 0; i < songs.length; i += BATCH) {
      const batch = songs.slice(i, i + BATCH);
      const texts = batch.map(s =>
        `${s.title || ''} ${s.artist || ''} ${s.key || ''} ${s.tags || ''} ${s.notes || ''}`.trim()
      );
      try {
        const resp = await env.AI.run('@cf/baai/bge-small-en-v1.5', { text: texts });
        const embeddings = resp?.data || [];
        const vectors = batch.map((s, j) => ({
          id: `${orgId}:${s.id}`,
          values: embeddings[j] || [],
          metadata: { orgId, songId: s.id, title: s.title || '', artist: s.artist || '', key: s.key || '' },
        }));
        await env.VECTORIZE.upsert(vectors);
        indexed += vectors.length;
      } catch (e) {
        console.warn('[vectorize] batch failed', e?.message);
      }
    }
    return json({ ok: true, indexed });
  }

  // ── GET /sync/songs/similar?q=...&limit=10 — semantic song search ─────────
  if (route === 'songs/similar' && method === 'GET') {
    if (!env.AI || !env.VECTORIZE) return json({ error: 'AI or Vectorize not bound' }, 503);
    const q = (url.searchParams.get('q') || '').trim();
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '10', 10), 50);
    if (!q) return json({ ok: true, songs: [] });
    try {
      const embResp = await env.AI.run('@cf/baai/bge-small-en-v1.5', { text: [q] });
      const queryVec = embResp?.data?.[0];
      if (!queryVec) return json({ ok: true, songs: [] });
      const results = await env.VECTORIZE.query(queryVec, {
        topK: limit,
        filter: { orgId },
        returnMetadata: true,
      });
      const songs = (results?.matches || []).map(m => ({
        id: m.metadata?.songId,
        title: m.metadata?.title,
        artist: m.metadata?.artist,
        key: m.metadata?.key,
        score: m.score,
      }));
      return json({ ok: true, songs });
    } catch (e) {
      return json({ error: 'Vectorize query failed', detail: e?.message }, 500);
    }
  }

  // ── GET /sync/library-pull ───────────────────────────────────────────────
  if (route === 'library-pull' && method === 'GET') {
    const [songMap, people, services, plans, vocalAssignments, blockouts, messages] =
      await Promise.all([
        kvGet(env, orgKey(orgId, 'songLibrary'), {}),
        kvGet(env, orgKey(orgId, 'people'), []),
        kvGet(env, orgKey(orgId, 'services'), []),
        kvGet(env, orgKey(orgId, 'plans'), {}),
        kvGet(env, orgKey(orgId, 'vocalAssignments'), {}),
        kvGet(env, orgKey(orgId, 'blockouts'), []),
        kvGet(env, orgKey(orgId, 'messages'), []),
      ]);
    const hydratedLibrary = hydrateLibraryDataWithAssignmentResponses(
      services,
      plans,
      people,
      messages,
    );
    return json({
      songs: Object.values(songMap),
      people,
      services: hydratedLibrary.services,
      plans: hydratedLibrary.plans,
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
      deletedServices = [],
      replacePeopleSnapshot = false,
      replaceServicesSnapshot = false,
      replacePlansSnapshot = false,
      replaceVocalAssignmentsSnapshot = false,
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

    // Merge people by id, email, and phone so invites/auth stay stable
    const mergedPeople = replacePeopleSnapshot === true
      ? mergeStoredPeople([], people)
      : mergeStoredPeople(existingPeople, people);

    // Merge services
    const deletedServiceIds = new Set(
      (Array.isArray(deletedServices) ? deletedServices : [])
        .map((id) => String(id || '').trim())
        .filter(Boolean),
    );
    const servicesMap = Object.fromEntries(
      (replaceServicesSnapshot === true ? [] : existingServices)
        .filter((service) => service?.id && !deletedServiceIds.has(service.id))
        .map((service) => [service.id, service]),
    );
    for (const s of services) {
      if (!s?.id) continue;
      const currentService = servicesMap[s.id] || {};
      const hasIncomingPlan = s.plan && typeof s.plan === 'object';
      const mergedServicePlan = hasIncomingPlan
        ? {
            ...(replaceServicesSnapshot === true ? {} : (currentService.plan || {})),
            ...s.plan,
            team: Array.isArray(s.plan?.team)
              ? mergePlanTeamEntries(
                  (replaceServicesSnapshot === true ? [] : (currentService.plan?.team || [])),
                  s.plan.team || [],
                )
              : (replaceServicesSnapshot === true ? [] : (currentService.plan?.team || [])),
          }
        : currentService.plan;
      servicesMap[s.id] = {
        ...(replaceServicesSnapshot === true ? {} : currentService),
        ...s,
        assignmentResponses: mergeAssignmentResponseMaps(
          currentService.assignmentResponses || {},
          s.assignmentResponses || {},
        ),
        ...(hasIncomingPlan ? { plan: mergedServicePlan } : {}),
      };
    }

    // Merge plans while preserving newer accepted/declined statuses.
    const mergedPlans = replacePlansSnapshot === true
      ? Object.fromEntries(
          Object.entries(plans || {}).map(([planId, rawIncomingPlan]) => {
            const incomingPlan =
              rawIncomingPlan && typeof rawIncomingPlan === 'object'
                ? rawIncomingPlan
                : {};
            const currentPlan =
              existingPlans[planId] && typeof existingPlans[planId] === 'object'
                ? existingPlans[planId]
                : {};
            return [planId, {
              ...incomingPlan,
              serviceId: incomingPlan.serviceId || planId,
              team: Array.isArray(incomingPlan.team)
                ? mergePlanTeamEntries(currentPlan.team || [], incomingPlan.team || [])
                : [],
            }];
          }),
        )
      : mergeStoredPlans(existingPlans, plans);
    deletedServiceIds.forEach((serviceId) => {
      delete mergedPlans[serviceId];
    });

    // Merge vocal assignments
    const mergedVocals = replaceVocalAssignmentsSnapshot === true
      ? { ...(vocalAssignments || {}) }
      : { ...existingVocals, ...vocalAssignments };
    deletedServiceIds.forEach((serviceId) => {
      delete mergedVocals[serviceId];
    });

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
      kvPut(env, orgKey(orgId, 'people'), mergedPeople),
      kvPut(env, orgKey(orgId, 'services'), Object.values(servicesMap)),
      kvPut(env, orgKey(orgId, 'plans'), mergedPlans),
      kvPut(env, orgKey(orgId, 'vocalAssignments'), mergedVocals),
      kvPut(env, orgKey(orgId, 'blockouts'), mergedBlockouts),
    ]);

    // D1 write-through — sync all changed records
    for (const s of Object.values(songMap)) d1UpsertSong(env, orgId, s);
    for (const p of mergedPeople) d1UpsertPerson(env, orgId, p);
    for (const svc of Object.values(servicesMap)) d1UpsertService(env, orgId, svc);
    trackEvent(env, orgId, 'library_push', {
      songs: Object.keys(songMap).length,
      people: mergedPeople.length,
      services: Object.values(servicesMap).length,
    });

    // Vectorize — index new/updated songs (fire-and-forget)
    if (env.AI && env.VECTORIZE && songs.length > 0) {
      (async () => {
        try {
          const texts = songs.map(s =>
            `${s.title || ''} ${s.artist || ''} ${s.key || ''} ${s.tags || ''} ${s.notes || ''}`.trim()
          );
          const resp = await env.AI.run('@cf/baai/bge-small-en-v1.5', { text: texts });
          const embeddings = resp?.data || [];
          const vectors = songs
            .map((s, j) => embeddings[j]?.length ? ({
              id: `${orgId}:${s.id}`,
              values: embeddings[j],
              metadata: { orgId, songId: s.id, title: s.title || '', artist: s.artist || '', key: s.key || '' },
            }) : null)
            .filter(Boolean);
          if (vectors.length) await env.VECTORIZE.upsert(vectors);
        } catch { /* best-effort */ }
      })();
    }

    return json({
      ok: true,
      songs: Object.keys(songMap).length,
      people: mergedPeople.length,
      services: Object.values(servicesMap).length,
      plans: Object.keys(mergedPlans).length,
    });
  }

  // ── POST /sync/publish ───────────────────────────────────────────────────
  if (route === 'publish' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const { serviceId, plan, vocalAssignments } = body;
    if (!serviceId) return json({ error: 'serviceId required' }, 400);

    const [services, plans, people, pushDevices] = await Promise.all([
      kvGet(env, orgKey(orgId, 'services'), []),
      kvGet(env, orgKey(orgId, 'plans'), {}),
      kvGet(env, orgKey(orgId, 'people'), []),
      getPushDevices(env, orgId),
    ]);
    const svcIdx = services.findIndex(s => s.id === serviceId);
    const updated = svcIdx >= 0 ? { ...services[svcIdx] } : { id: serviceId };
    const existingServicePlan = updated.plan && typeof updated.plan === 'object'
      ? updated.plan
      : {};
    const previousTeam = plans[serviceId]?.team || existingServicePlan.team || [];
    const mergedPlan = {
      ...(plans[serviceId] || {}),
      ...(plan || {}),
      team: Array.isArray(plan?.team)
        ? mergePlanTeamEntries(
            plans[serviceId]?.team || existingServicePlan.team || [],
            plan.team || [],
          )
        : (plans[serviceId]?.team || existingServicePlan.team || []),
      serviceId,
    };
    const { byId: peopleById, byEmail: peopleByEmail } = buildPeopleIndexes(people);
    const newPendingAssignments = collectNewPendingAssignments(
      previousTeam,
      mergedPlan.team || [],
      peopleById,
      peopleByEmail,
    );
    const serviceDate = normalizeDateKey(updated.date || updated.serviceDate || '');
    if (serviceDate && Array.isArray(mergedPlan.team) && mergedPlan.team.length > 0) {
      const orgBlockouts = await kvGet(env, orgKey(orgId, 'blockouts'), []);
      const directBlockedNames = new Set(
        mergeBlockoutEntries(orgBlockouts)
          .filter((entry) => entry.date === serviceDate)
          .map((entry) => normalizeLower(entry.name || ''))
          .filter(Boolean),
      );
      const teamEmails = [...new Set(
        mergedPlan.team
          .map((member) => {
            const linkedPerson = getLinkedTeamMemberPerson(member, peopleById, peopleByEmail);
            return normalizeLower(member?.email || linkedPerson?.email || '');
          })
          .filter(Boolean),
      )];
      const globalBlockoutsByEmail = new Map(
        await Promise.all(teamEmails.map(async (email) => [
          email,
          mergeBlockoutEntries(await kvGet(env, globalMemberBlockoutsKey(email), []))
            .filter((entry) => entry.date === serviceDate),
        ])),
      );
      const blockedMembers = mergedPlan.team.flatMap((member) => {
        const linkedPerson = getLinkedTeamMemberPerson(member, peopleById, peopleByEmail);
        const memberEmail = normalizeLower(member?.email || linkedPerson?.email || '');
        const memberName = String(member?.name || linkedPerson?.name || '').trim();
        const memberBlockouts = memberEmail ? (globalBlockoutsByEmail.get(memberEmail) || []) : [];
        const isBlocked =
          memberBlockouts.length > 0
          || (memberName && directBlockedNames.has(normalizeLower(memberName)));
        if (!isBlocked) return [];
        return [{
          personId: String(member?.personId || linkedPerson?.id || '').trim(),
          name: memberName || memberEmail || 'Team member',
          email: memberEmail,
          role: String(member?.role || '').trim(),
          date: serviceDate,
        }];
      });
      if (blockedMembers.length > 0) {
        return json({
          error: 'Some assigned members are unavailable on this date. Remove them before publishing.',
          blockedMembers,
        }, 409);
      }
    }

    updated.plan = {
      ...existingServicePlan,
      ...mergedPlan,
    };
    updated.publishedAt = new Date().toISOString();
    const newServices = services.filter(s => s.id !== serviceId);
    newServices.push(updated);
    plans[serviceId] = mergedPlan;

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

    let pushCount = 0;
    let emailAttempted = 0;
    let emailSent = 0;
    let emailFailed = 0;

    if (newPendingAssignments.length > 0) {
      const targetEmails = [...new Set(newPendingAssignments.map((entry) => entry.email).filter(Boolean))];
      const targets = filterPushDevices(pushDevices, {
        emails: targetEmails,
        preferenceKey: 'assignments',
      });
      if (targets.length > 0) {
        const orgName = String(org?.name || '').trim() || 'Your organization';
        const serviceName = updated.name || updated.title || serviceId;
        const pushResult = await sendPushToDevices(targets, {
          title: `${orgName} assignment`,
          body: `${serviceName} is ready for your response in ${orgName}.`,
          data: {
            type: 'assignment',
            screen: 'AssignmentsTab',
            serviceId,
            serviceName,
            orgName,
          },
        }, 'assignments').catch((error) => {
          console.log('[sync/push] assignment notify failed', error?.message || String(error));
          return { ok: false, count: 0 };
        });
        pushCount = Number(pushResult?.count || 0);
      }

      const emailRecipients = Array.from(
        newPendingAssignments.reduce((map, entry) => {
          const email = normalizeLower(entry?.email || '');
          if (!email) return map;

          const current = map.get(email) || {
            to: email,
            recipientName: String(entry?.name || '').trim(),
            roles: [],
          };

          if (!current.recipientName && entry?.name) {
            current.recipientName = String(entry.name || '').trim();
          }
          if (entry?.role && !current.roles.includes(entry.role)) {
            current.roles.push(entry.role);
          }

          map.set(email, current);
          return map;
        }, new Map()).values(),
      );

      emailAttempted = emailRecipients.length;
      const emailResults = await Promise.allSettled(
        emailRecipients.map((recipient) =>
          sendAssignmentAlertEmail(env, {
            to: recipient.to,
            assignment: {
              orgName: org.name,
              branchCity: org.city || '',
              recipientName: recipient.recipientName,
              serviceId,
              serviceName: updated.name || updated.title || serviceId,
              serviceDate: updated.date || updated.serviceDate || '',
              serviceTime: updated.time || updated.startTime || '',
              roles: recipient.roles,
            },
          })
        )
      );
      for (const result of emailResults) {
        if (result.status === 'fulfilled') emailSent += 1;
        else {
          emailFailed += 1;
          console.log('[sync/publish] assignment email failed', result.reason?.message || String(result.reason));
        }
      }
    }

    // D1 write-through for published service + analytics
    d1UpsertService(env, orgId, { ...updated, publishedAt: new Date().toISOString() });
    trackEvent(env, orgId, 'publish', { serviceId, emailSent, pushSent: pushCount });

    return json({
      ok: true,
      serviceId,
      alerts: {
        pushSent: pushCount,
        emailAttempted,
        emailSent,
        emailFailed,
      },
    });
  }

  // ── POST /sync/service/delete ────────────────────────────────────────────
  if (route === 'service/delete' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const serviceId =
      String(
        body.serviceId
        || body.id
        || url.searchParams.get('serviceId')
        || url.searchParams.get('id')
        || '',
      ).trim();
    if (!serviceId) return json({ error: 'serviceId required' }, 400);

    const [services, plans, vocalAssignments, pendingServices] = await Promise.all([
      kvGet(env, orgKey(orgId, 'services'), []),
      kvGet(env, orgKey(orgId, 'plans'), {}),
      kvGet(env, orgKey(orgId, 'vocalAssignments'), {}),
      kvGet(env, orgKey(orgId, 'pending_services'), []),
    ]);

    const nextServices = (Array.isArray(services) ? services : []).filter((service) => service?.id !== serviceId);
    const nextPendingServices = (Array.isArray(pendingServices) ? pendingServices : []).filter((service) => service?.id !== serviceId);
    const nextPlans = { ...(plans || {}) };
    const nextVocals = { ...(vocalAssignments || {}) };
    delete nextPlans[serviceId];
    delete nextVocals[serviceId];

    await Promise.all([
      kvPut(env, orgKey(orgId, 'services'), nextServices),
      kvPut(env, orgKey(orgId, 'plans'), nextPlans),
      kvPut(env, orgKey(orgId, 'vocalAssignments'), nextVocals),
      kvPut(env, orgKey(orgId, 'pending_services'), nextPendingServices),
    ]);

    return json({ ok: true, serviceId, removed: nextServices.length !== services.length });
  }

  // ── POST /sync/push/register ─────────────────────────────────────────────
  if (route === 'push/register' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const token = String(body.token || '').trim();
    const email = normalizeLower(body.email || '');

    if (!token || !email) {
      return json({ error: 'token and email are required' }, 400);
    }

    const saved = await registerPushDevice(env, orgId, body);
    return json({ ok: true, token: saved?.token || token });
  }

  // ── POST /sync/push/unregister ───────────────────────────────────────────
  if (route === 'push/unregister' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const removed = await unregisterPushDevice(env, orgId, body || {});
    return json({ ok: true, removed });
  }

  // ── GET /sync/assignments ────────────────────────────────────────────────
  if (route === 'assignments' && method === 'GET') {
    const serviceIdParam = url.searchParams.get('serviceId');
    const emailParam     = (url.searchParams.get('email') || '').toLowerCase().trim();
    const nameParam      = (url.searchParams.get('name')  || '').toLowerCase().trim();

    const [services, plans, people, messages] = await Promise.all([
      kvGet(env, orgKey(orgId, 'services'), []),
      kvGet(env, orgKey(orgId, 'plans'), {}),
      kvGet(env, orgKey(orgId, 'people'), []),
      kvGet(env, orgKey(orgId, 'messages'), []),
    ]);
    const { byId: personById } = buildPeopleIndexes(people);
    const derivedResponsesByService = buildAssignmentResponsesFromMessages(messages);

    // Legacy: specific serviceId → return that service object (used by SetlistScreen)
    if (serviceIdParam) {
      return json(services.find(s => s.id === serviceIdParam) || {});
    }

    // No person filter → return raw services (admin/debug)
    if (!emailParam && !nameParam) {
      return json(services);
    }

    // Build a quick id→person map so we can look up emails by personId
    // Normalise a display name for fuzzy matching
    const norm = s => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const isServicePublished = (service = {}) =>
      Boolean(
        String(
          service?.publishedAt
          || service?.published_at
          || '',
        ).trim(),
      );

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
      if (!isServicePublished(svc)) continue;
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

        const assignmentResponse = getAssignmentResponseForMember(
          mergeAssignmentResponseMaps(
            svc.assignmentResponses || {},
            derivedResponsesByService[svc.id] || {},
          ),
          member,
          personById,
        );

        assignments.push({
          id:             member.id || `${svc.id}_${member.personId || norm(member.name).replace(/\s/g, '_')}_${member.role || 'role'}`,
          service_id:     svc.id,
          service_name:   svc.name || svc.title || 'Service',
          service_date:   svc.date || svc.serviceDate || '',
          service_end_at,
          role:           member.role || '',
          notes:          member.notes || plan.notes || '',
          status:         pickPreferredAssignmentStatus(member.status, assignmentResponse),
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
    // Accept both formats: {serviceId,personId,response,role} and {assignmentId,email,status}
    const serviceId   = body.serviceId || (body.assignmentId || '').split('_')[0] || '';
    const personId    = (body.personId || body.email || '').toLowerCase().trim();
    const status      = (body.response || body.status || 'pending').toLowerCase();
    const role        = body.role || '';
    const personName  = body.name || body.fromName || personId;
    const declineReason = body.declineReason || body.reason || '';
    if (!serviceId) return json({ error: 'serviceId required' }, 400);

    const people = await kvGet(env, orgKey(orgId, 'people'), []);
    const personByEmail = people.find(p => (p.email || '').toLowerCase() === personId);
    const personUUID = personByEmail?.id || null;
    const responseEmail = normalizeLower(
      personByEmail?.email || (personId.includes('@') ? personId : ''),
    );
    if (!responseEmail) return json({ error: 'email required' }, 400);
    const resolvedName = personByEmail?.name || personName;
    const respondedAt = new Date().toISOString();
    const { byId: peopleByIdForRespond } = buildPeopleIndexes(people);

    const applyResponseToTeam = (team = []) => {
      let didUpdate = false;
      const nextTeam = team.map((member) => {
        // Primary match: email, UUID, or linked UUID match
        let matched = teamMemberMatchesResponse(member, personId, personUUID, role);
        // Fallback: resolve member's personId via people KV to find their email
        if (!matched && member.personId) {
          const linkedPerson = peopleByIdForRespond[member.personId] || peopleByIdForRespond[normalizeLower(member.personId)] || null;
          const linkedEmail = normalizeLower(linkedPerson?.email || '');
          if (linkedEmail && linkedEmail === responseEmail) {
            const memberRole = normalizeLower(member?.role || '');
            const normalizedRole = normalizeLower(role || '');
            matched = !normalizedRole || !memberRole || memberRole === normalizedRole;
          }
        }
        if (!matched) return member;
        didUpdate = true;
        return {
          ...member,
          status,
          declineReason: status === 'declined' ? declineReason : '',
          responded_at: respondedAt,
          ...(!member.email && personId.includes('@') ? { email: personId } : {}),
        };
      });
      return { didUpdate, nextTeam };
    };

    // 1. Store in services[].assignmentResponses
    const services = await kvGet(env, orgKey(orgId, 'services'), []);
    const svcIdx = services.findIndex(s => s.id === serviceId);
    const serviceName = svcIdx >= 0 ? (services[svcIdx].name || services[svcIdx].title || serviceId) : serviceId;
    const serviceDate = svcIdx >= 0 ? (services[svcIdx].date || services[svcIdx].serviceDate || '') : '';
    const serviceTime = svcIdx >= 0 ? (services[svcIdx].time || services[svcIdx].startTime || '') : '';
    if (status === 'accepted') {
      const acceptedAssignments = await kvGet(env, acceptedAssignmentsIndexKey(responseEmail), []);
      const conflict = findAcceptedAssignmentConflict(acceptedAssignments, {
        email: responseEmail,
        orgId,
        orgName: org.name || '',
        serviceId,
        serviceName,
        serviceDate,
        serviceTime,
      });
      if (conflict) {
        return json({
          error:
            `You already accepted "${conflict.serviceName || 'another service'}" in `
            + `${conflict.orgName || 'another organization'} on `
            + `${conflict.serviceDate || 'that date'}`
            + `${conflict.serviceTime ? ` at ${conflict.serviceTime}` : ''}. `
            + 'Decline one assignment before accepting the other.',
          conflict,
        }, 409);
      }
    }
    if (svcIdx >= 0) {
      if (!services[svcIdx].assignmentResponses) services[svcIdx].assignmentResponses = {};
      const responseEntry = {
        response: status, status, role, declineReason, name: personName, ts: Date.now(), responded_at: respondedAt,
      };
      services[svcIdx].assignmentResponses[personId] = responseEntry;
      if (personUUID) services[svcIdx].assignmentResponses[normalizeLower(personUUID)] = responseEntry;
      // Also index by any team member UUID that resolves to this email (handles UUID mismatch across systems)
      const team = (services[svcIdx].plan?.team || services[svcIdx].team || []);
      for (const member of team) {
        if (!member.personId) continue;
        const linked = peopleByIdForRespond[member.personId] || peopleByIdForRespond[normalizeLower(member.personId)];
        if (linked && normalizeLower(linked.email) === responseEmail) {
          services[svcIdx].assignmentResponses[normalizeLower(member.personId)] = responseEntry;
        }
      }

      if (services[svcIdx].plan && Array.isArray(services[svcIdx].plan.team)) {
        const { didUpdate, nextTeam } = applyResponseToTeam(services[svcIdx].plan.team || []);
        if (didUpdate) {
          services[svcIdx].plan = {
            ...services[svcIdx].plan,
            team: nextTeam,
          };
        }
      } else if (Array.isArray(services[svcIdx].team)) {
        const { didUpdate, nextTeam } = applyResponseToTeam(services[svcIdx].team || []);
        if (didUpdate) {
          services[svcIdx].team = nextTeam;
        }
      }
      await kvPut(env, orgKey(orgId, 'services'), services);
    }

    // 2. Update plan.team[].status in plans KV
    const plans = await kvGet(env, orgKey(orgId, 'plans'), {});
    if (plans[serviceId]) {
      const { didUpdate, nextTeam } = applyResponseToTeam(plans[serviceId].team || []);
      if (didUpdate) {
        plans[serviceId] = {
          ...plans[serviceId],
          team: nextTeam,
        };
        await kvPut(env, orgKey(orgId, 'plans'), plans);
      }
    }

    // 3. Create admin notification message
    const emoji = status === 'accepted' ? '✅' : status === 'declined' ? '❌' : 'ℹ️';
    const displayName = resolvedName || personName;
    const msgBody = status === 'declined' && declineReason
      ? `${displayName} declined the assignment for "${serviceName}".\nReason: ${declineReason}`
      : `${displayName} ${status} the assignment for "${serviceName}".`;
    const msgs = await kvGet(env, orgKey(orgId, 'messages'), []);
    msgs.unshift({
      id: makeId(),
      fromEmail: personId,
      fromName: displayName,
      subject: `${emoji} Assignment ${status}: ${displayName}`,
      message: msgBody,
      to: 'admin',
      timestamp: new Date().toISOString(),
      read: false,
      replies: [],
      isSystemMsg: true,
      visibility: 'admin_only',
      messageType: 'assignment_response',
      metadata: {
        serviceId,
        serviceName,
        status,
        role,
        personEmail: responseEmail,
        declineReason,
        respondedAt,
      },
    });
    await kvPut(env, orgKey(orgId, 'messages'), msgs);

    const acceptedAssignments = (await kvGet(env, acceptedAssignmentsIndexKey(responseEmail), []))
      .map(normalizeAcceptedAssignmentEntry)
      .filter(Boolean)
      .filter((entry) => acceptedAssignmentIdentityKey(entry) !== `${orgId}:${serviceId}`);
    if (status === 'accepted') {
      const acceptedEntry = normalizeAcceptedAssignmentEntry({
        email: responseEmail,
        orgId,
        orgName: org.name || '',
        serviceId,
        serviceName,
        serviceDate,
        serviceTime,
        respondedAt,
      });
      if (acceptedEntry) acceptedAssignments.push(acceptedEntry);
    }
    await kvPut(env, acceptedAssignmentsIndexKey(responseEmail), acceptedAssignments);

    // D1 write-through + analytics
    d1UpsertAssignmentResponse(env, orgId, serviceId, {
      personEmail: responseEmail, personId, role, status,
      note: declineReason || '', respondedAt,
    });
    trackEvent(env, orgId, 'assignment_respond', { serviceId, status, role });

    // Push notification to admin(s) about the response
    const pushEmoji = status === 'accepted' ? '✅' : status === 'declined' ? '❌' : 'ℹ️';
    const pushDevicesForRespond = await getPushDevices(env, orgId).catch(() => []);
    const adminTargets = filterPushDevices(pushDevicesForRespond, { adminOnly: true, preferenceKey: 'assignments' });
    if (adminTargets.length > 0) {
      const displayName2 = resolvedName || personName;
      sendPushToDevices(adminTargets, {
        title: `${pushEmoji} ${displayName2} ${status} assignment`,
        body: `"${serviceName}"${serviceDate ? ' on ' + serviceDate : ''}`,
        data: { type: 'assignment_response', screen: 'ServicePlanTab', serviceId, status },
      }, 'assignments').catch(() => {});
    }

    return json({ ok: true });
  }

  // ── GET /sync/assignment/responses ─────────────────────────────────────
  if (route === 'assignment/responses' && method === 'GET') {
    const svcId = url.searchParams.get('serviceId') || '';
    if (!svcId) return json({ error: 'serviceId required' }, 400);
    const [services, plans, people, messages] = await Promise.all([
      kvGet(env, orgKey(orgId, 'services'), []),
      kvGet(env, orgKey(orgId, 'plans'), {}),
      kvGet(env, orgKey(orgId, 'people'), []),
      kvGet(env, orgKey(orgId, 'messages'), []),
    ]);
    const svc = services.find(s => s.id === svcId);
    const { byId: peopleById } = buildPeopleIndexes(people);
    const derivedResponsesByService = buildAssignmentResponsesFromMessages(messages);
    const responses = mergeAssignmentResponseMaps(
      svc?.assignmentResponses || {},
      derivedResponsesByService[svcId] || {},
    );
    // Also merge from plans.team[] for completeness
    const team = plans[svcId]?.team || [];
    const result = { ...responses };
    for (const m of team) {
      const statusEntry = normalizeAssignmentResponseEntry({
        response: m.status,
        status: m.status,
        declineReason: m.declineReason || '',
        responded_at: m.responded_at || m.respondedAt || null,
      });
      for (const key of getAssignmentResponseLookupKeys(m, peopleById)) {
        result[key] = result[key]
          ? mergeAssignmentResponseEntries(result[key], statusEntry)
          : statusEntry;
      }
    }
    return json(result);
  }

  // ── POST /sync/song/patch ────────────────────────────────────────────────
  if (route === 'song/patch' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const resolvedId = (body.id || body.songId || '').trim();
    if (!resolvedId) return json({ error: 'id required' }, 400);
    const songMap = await kvGet(env, orgKey(orgId, 'songLibrary'), {});
    const song = songMap[resolvedId] || { id: resolvedId, title: body.songTitle || '', artist: body.songArtist || '' };

    const isPrivileged = PRIVILEGED_ROLES.includes(body.senderRole);
    let detected = {};

    if (body.field && body.value !== undefined) {
      detected = applyChartToSong(song, {
        field:        body.field,
        value:        body.value,
        instrument:   body.instrument,
        keyboardRigs: body.keyboardRigs,
        isPrivileged,
      });
    } else {
      // Generic patch — spread all fields except id/songId
      const { id: _id, songId: _sid, ...patch } = body;
      Object.assign(song, patch);
    }

    song.updatedAt = new Date().toISOString();
    songMap[resolvedId] = song;
    await kvPut(env, orgKey(orgId, 'songLibrary'), songMap);
    return json({ ok: true, detected });
  }

  // ── POST /sync/blockout ──────────────────────────────────────────────────
  if (route === 'blockout' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const email = (body.email || '').trim().toLowerCase();
    if (!email) return json({ error: 'email required' }, 400);
    const entry = normalizeBlockoutEntry({
      ...body,
      email,
    });
    if (!entry) return json({ error: 'date required' }, 400);

    const [orgBlockouts, globalBlockouts, people] = await Promise.all([
      kvGet(env, orgKey(orgId, 'blockouts'), []),
      kvGet(env, globalMemberBlockoutsKey(email), []),
      kvGet(env, orgKey(orgId, 'people'), []),
    ]);

    const nextGlobalBlockouts = mergeBlockoutEntries(globalBlockouts, [entry]);
    const nextOrgBlockouts = mergeBlockoutEntries(orgBlockouts, [entry]);
    const { didUpdate, nextPeople } = syncPeopleBlockoutDates(
      people,
      email,
      nextGlobalBlockouts,
    );

    const writes = [
      kvPut(env, globalMemberBlockoutsKey(email), nextGlobalBlockouts),
      kvPut(env, orgKey(orgId, 'blockouts'), nextOrgBlockouts),
    ];
    if (didUpdate) writes.push(kvPut(env, orgKey(orgId, 'people'), nextPeople));
    await Promise.all(writes);

    return json({ ok: true, id: entry.id, blockout: entry });
  }

  // ── DELETE /sync/blockout ────────────────────────────────────────────────
  if (route === 'blockout' && method === 'DELETE') {
    const blkId = url.searchParams.get('id') || '';
    const email = (url.searchParams.get('email') || '').toLowerCase();
    const date = url.searchParams.get('date') || '';
    const orgBlockouts = await kvGet(env, orgKey(orgId, 'blockouts'), []);
    const matchedEntry = mergeBlockoutEntries(orgBlockouts).find((entry) => {
      if (blkId && entry.id === blkId) return true;
      if (email && date) {
        return entry.email === normalizeLower(email) && entry.date === normalizeDateKey(date);
      }
      return false;
    });
    const targetEmail = normalizeLower(email || matchedEntry?.email || '');
    const [globalBlockouts, people] = targetEmail
      ? await Promise.all([
          kvGet(env, globalMemberBlockoutsKey(targetEmail), []),
          kvGet(env, orgKey(orgId, 'people'), []),
        ])
      : [[], []];

    const nextOrgBlockouts = removeBlockoutEntries(orgBlockouts, {
      id: blkId,
      email: targetEmail,
      date,
    });
    const nextGlobalBlockouts = targetEmail
      ? removeBlockoutEntries(globalBlockouts, {
          id: blkId,
          email: targetEmail,
          date,
        })
      : [];

    const writes = [kvPut(env, orgKey(orgId, 'blockouts'), nextOrgBlockouts)];
    if (targetEmail) {
      writes.push(kvPut(env, globalMemberBlockoutsKey(targetEmail), nextGlobalBlockouts));
      const { didUpdate, nextPeople } = syncPeopleBlockoutDates(
        people,
        targetEmail,
        nextGlobalBlockouts,
      );
      if (didUpdate) writes.push(kvPut(env, orgKey(orgId, 'people'), nextPeople));
    }
    await Promise.all(writes);
    return json({ ok: true });
  }

  // ── GET /sync/blockouts ──────────────────────────────────────────────────
  if (route === 'blockouts' && method === 'GET') {
    const dateFilter = normalizeDateKey(url.searchParams.get('date') || '');
    const emailFilter = normalizeLower(url.searchParams.get('email') || '');

    let blockouts = [];
    if (emailFilter) {
      blockouts = mergeBlockoutEntries(
        await kvGet(env, globalMemberBlockoutsKey(emailFilter), []),
      );
    } else {
      const [orgBlockouts, people] = await Promise.all([
        kvGet(env, orgKey(orgId, 'blockouts'), []),
        kvGet(env, orgKey(orgId, 'people'), []),
      ]);
      const normalizedPeople = Array.isArray(people) ? people : [];
      const peopleByEmail = new Map(
        normalizedPeople
          .map((person) => [normalizeLower(person?.email || ''), person])
          .filter(([email]) => Boolean(email)),
      );
      const globalBlockoutLists = await Promise.all(
        Array.from(peopleByEmail.keys()).map(async (personEmail) => {
          const person = peopleByEmail.get(personEmail);
          const globalEntries = await kvGet(env, globalMemberBlockoutsKey(personEmail), []);
          return (Array.isArray(globalEntries) ? globalEntries : []).map((entry) => ({
            ...entry,
            email: personEmail,
            name: entry?.name || person?.name || '',
          }));
        }),
      );
      const peopleBlockouts = normalizedPeople.flatMap((person) => {
        const personEmail = normalizeLower(person?.email || '');
        return (Array.isArray(person?.blockout_dates) ? person.blockout_dates : []).map((entry) => ({
          ...entry,
          email: personEmail || normalizeLower(entry?.email || ''),
          name: entry?.name || person?.name || '',
        }));
      });
      blockouts = mergeBlockoutEntries(orgBlockouts, peopleBlockouts, ...globalBlockoutLists);
    }

    if (dateFilter) blockouts = blockouts.filter((entry) => entry.date === dateFilter);
    if (emailFilter) blockouts = blockouts.filter((entry) => entry.email === emailFilter);
    return json(blockouts);
  }

  // ── POST /sync/stems-store ───────────────────────────────────────────────
  // Called by CineStage server or desktop uploader after processing to store results in KV.
  // Body: { songId, title, stems, harmonies, key, bpm, jobId, ...metadata }
  if (route === 'stems-store' && method === 'POST') {
    const body = normalizeStemPayload(await request.json().catch(() => ({})));
    const { songId } = body;
    if (!songId) return json({ error: 'songId required' }, 400);
    const existing = await kvGet(env, orgKey(orgId, `stems:${songId}`), {});
    const entry = normalizeStemPayload({
      ...existing,
      ...body,
      updatedAt: new Date().toISOString(),
    });
    await kvPut(env, orgKey(orgId, `stems:${songId}`), entry);
    await syncSongLibraryStemSnapshot(env, orgId, songId, {
      ...entry,
      source: body.source || existing.source || 'desktop_upload',
    }, {
      title: body.title,
      artist: body.artist,
      youtubeLink: body.youtubeLink,
    });
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
    return json(normalizeStemPayload(result));
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

  // ── POST /sync/feedback — store manual reports and crash reports ─────────
  if (route === 'feedback' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const message = clipText(body.message, 16000);
    if (!message) return json({ error: 'message required' }, 400);

    const reporterInput = body.reporter && typeof body.reporter === 'object' ? body.reporter : {};
    const metadata = body.metadata && typeof body.metadata === 'object' ? body.metadata : {};
    const appInput = body.app && typeof body.app === 'object' ? body.app : {};
    const type = normalizeRoleKey(body.type) || 'manual';
    const severity = normalizeRoleKey(body.severity) || (type === 'crash' ? 'error' : 'info');

    const entry = {
      id: clipText(body.id || `fb_${Date.now()}_${makeId(6)}`, 80),
      type,
      severity,
      subject: clipText(
        body.subject || (type === 'crash' ? 'Playback crash report' : 'Playback feedback'),
        160,
      ),
      message,
      routeName: clipText(body.routeName, 120),
      createdAt: clipText(body.createdAt || new Date().toISOString(), 80),
      reporter: {
        name: clipText(reporterInput.name, 120),
        lastName: clipText(reporterInput.lastName, 120),
        email: clipText(reporterInput.email, 160).toLowerCase(),
        phone: clipText(reporterInput.phone, 40),
        roleAssignments: clipText(reporterInput.roleAssignments, 500),
      },
      app: {
        name: clipText(appInput.name || 'Ultimate Playback', 120),
        platform: clipText(appInput.platform, 80),
        platformVersion: clipText(appInput.platformVersion, 80),
        jsEngine: clipText(appInput.jsEngine, 80),
        releaseChannel: clipText(appInput.releaseChannel, 80),
      },
      metadata,
    };

    const reports = await kvGet(env, orgKey(orgId, 'feedback'), []);
    reports.unshift(entry);
    await kvPut(env, orgKey(orgId, 'feedback'), reports.slice(0, 200));

    const reporterName = [
      entry.reporter.name,
      entry.reporter.lastName,
    ].filter(Boolean).join(' ').trim()
      || entry.reporter.email
      || entry.reporter.phone
      || 'Unknown member';

    const messageLines = [
      `Reporter: ${reporterName}`,
      entry.reporter.email ? `Email: ${entry.reporter.email}` : '',
      entry.reporter.phone ? `Phone: ${entry.reporter.phone}` : '',
      entry.reporter.roleAssignments ? `Roles: ${entry.reporter.roleAssignments}` : '',
      entry.routeName ? `Screen: ${entry.routeName}` : '',
      entry.app.platform ? `Platform: ${entry.app.platform} ${entry.app.platformVersion || ''}`.trim() : '',
      entry.app.releaseChannel ? `Channel: ${entry.app.releaseChannel}` : '',
      entry.subject ? `Subject: ${entry.subject}` : '',
      '',
      entry.message,
      Object.keys(metadata).length
        ? `Metadata:\n${clipText(JSON.stringify(metadata, null, 2), 4000)}`
        : '',
    ].filter(Boolean);

    const adminMessages = await kvGet(env, orgKey(orgId, 'messages'), []);
    adminMessages.unshift({
      id: makeId(),
      fromEmail: entry.reporter.email || 'system@cinestage.local',
      fromName: reporterName,
      subject: `${type === 'crash' ? '💥 Crash report' : '📝 Feedback'}: ${entry.subject}`,
      message: clipText(messageLines.join('\n'), 9000),
      to: 'admin',
      timestamp: new Date().toISOString(),
      read: false,
      replies: [],
      isSystemMsg: true,
      visibility: 'admin_only',
      messageType: 'app_feedback',
      metadata: {
        type: 'app_feedback',
        feedbackId: entry.id,
        severity: entry.severity,
        reportType: entry.type,
        routeName: entry.routeName || '',
      },
    });
    await kvPut(env, orgKey(orgId, 'messages'), adminMessages);

    return json({ ok: true, id: entry.id });
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
    // Owner role is permanent — cannot be changed via API
    if (role === 'owner') return json({ error: 'Owner role is assigned at organization creation and cannot be changed' }, 403);
    // Branch credentials cannot assign or remove admin roles — only root org can
    const isBranch = !!org.parentOrgId;
    if (role === 'admin' && isBranch) return json({ error: 'Admin roles require org owner credentials' }, 403);
    const roles = await kvGet(env, orgKey(orgId, 'roles'), {});
    if (roles[email] === 'owner') return json({ error: 'Cannot modify the organization owner role' }, 403);
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

  // ── POST /sync/auth/register — create user account for an existing member ─
  // Accepts email or phone number as identifier.
  // Succeeds only when the person already exists in the org directory.
  if (route === 'auth/register' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const cfIp = request.headers.get('CF-Connecting-IP') || '';
    // Rate limit: 5 register attempts per IP per 10 minutes
    const rlReg = await checkRateLimit(env, cfIp, 'register', 5, 600);
    if (rlReg.limited) {
      return new Response(JSON.stringify({ error: 'Too many attempts. Please wait a few minutes before trying again.' }), {
        status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(rlReg.retryAfter), ...CORS_HEADERS },
      });
    }
    // Only enforce Turnstile for web portal requests (mobile app skips Turnstile)
    const isWebPortal = request.headers.get('x-requested-by') === 'web-portal';
    if (isWebPortal) {
      const tsResult = await verifyTurnstile(env, body.turnstileToken || '', cfIp);
      if (!tsResult.success) return json({ error: tsResult.error }, 403);
    }
    const raw = (body.identifier || body.email || '').trim();
    const { password = '', name = '' } = body;
    if (!raw || !password) return json({ error: 'identifier and password required' }, 400);
    if (!env.RESEND_API_KEY || !env.FROM_EMAIL) {
      return json({ error: 'Account verification email is not configured for this workspace.' }, 503);
    }
    const {
      canonicalEmail,
      personName,
      personPhone,
      personExists,
    } = await resolveIdentifier(env, orgId, raw);
    if (!canonicalEmail) return json({ error: 'Phone number not found in this organization. Try registering with your email instead.' }, 404);
    if (!personExists) {
      return json({ error: 'Your email is not on this team yet. Ask your admin or manager to create your profile first.' }, 403);
    }
    const users = await kvGet(env, orgKey(orgId, 'users'), {});
    const existingUser = users[canonicalEmail];
    if (existingUser && isUserVerified(existingUser)) {
      return json({ error: 'Account already exists. Please sign in.' }, 409);
    }
    const { role, grantedRole } = await loadAuthAccess(env, orgId, canonicalEmail, existingUser);
    const resolvedName = name || personName || canonicalEmail;
    const user = existingUser || {};
    user.name = resolvedName;
    user.passwordHash = await sha256(password);
    user.role = role;
    user.createdAt = user.createdAt || new Date().toISOString();
    if (!hasOwn(user, 'verifiedAt')) user.verifiedAt = null;
    const code = await setUserVerification(user, {
      purpose: 'signup',
      deviceId: body.deviceId || '',
    });
    users[canonicalEmail] = user;
    await kvPut(env, orgKey(orgId, 'users'), users);
    try {
      await sendSignupVerificationEmail(env, {
        to: canonicalEmail,
        name: resolvedName,
        code,
        orgName: org.name,
      });
    } catch (error) {
      return json({ error: error.message || 'Failed to send verification email' }, 502);
    }
    return json(buildAuthResponse({
      user,
      canonicalEmail,
      personName,
      personPhone,
      org,
      role,
      grantedRole,
      extra: {
        needsVerification: true,
        verificationPurpose: 'signup',
      },
    }));
  }

  // ── POST /sync/auth/login — verify credentials, return role ──────────────
  // Accepts email or phone number as identifier.
  if (route === 'auth/login' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const cfIp = request.headers.get('CF-Connecting-IP') || '';
    // Rate limit: 10 login attempts per IP per 5 minutes
    const rlLogin = await checkRateLimit(env, cfIp, 'login', 10, 300);
    if (rlLogin.limited) {
      return new Response(JSON.stringify({ error: 'Too many sign-in attempts. Please wait a few minutes.' }), {
        status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(rlLogin.retryAfter), ...CORS_HEADERS },
      });
    }
    // Only enforce Turnstile for web portal requests
    const isWebPortalLogin = request.headers.get('x-requested-by') === 'web-portal';
    if (isWebPortalLogin) {
      const tsResult = await verifyTurnstile(env, body.turnstileToken || '', cfIp);
      if (!tsResult.success) return json({ error: tsResult.error }, 403);
    }
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
    const { role, grantedRole } = await loadAuthAccess(env, orgId, canonicalEmail, user);
    user.role = role;
    const deviceId = sanitizeDeviceId(body.deviceId);

    if (!isUserVerified(user)) {
      const signupCode = await setUserVerification(user, {
        purpose: 'signup',
        deviceId,
      });
      users[canonicalEmail] = user;
      await kvPut(env, orgKey(orgId, 'users'), users);
      try {
        await sendSignupVerificationEmail(env, {
          to: canonicalEmail,
          name: user.name || personName || canonicalEmail,
          code: signupCode,
          orgName: org.name,
        });
      } catch (error) {
        return json({ error: error.message || 'Failed to send verification email' }, 502);
      }
      return json(buildAuthResponse({
        user,
        canonicalEmail,
        personName,
        personPhone,
        org,
        role,
        grantedRole,
        extra: {
          needsVerification: true,
          verificationPurpose: 'signup',
        },
      }));
    }

    const requiresStepUp = shouldAlwaysVerifyAuth(role, grantedRole)
      || !deviceId
      || !hasTrustedDevice(user, deviceId);

    if (requiresStepUp) {
      const loginCode = await setUserVerification(user, {
        purpose: 'login',
        deviceId,
      });
      users[canonicalEmail] = user;
      await kvPut(env, orgKey(orgId, 'users'), users);
      try {
        await sendLoginVerificationEmail(env, {
          to: canonicalEmail,
          name: user.name || personName || canonicalEmail,
          code: loginCode,
          orgName: org.name,
        });
      } catch (error) {
        return json({ error: error.message || 'Failed to send sign-in verification email' }, 502);
      }
      return json(buildAuthResponse({
        user,
        canonicalEmail,
        personName,
        personPhone,
        org,
        role,
        grantedRole,
        extra: {
          needsVerification: true,
          verificationPurpose: 'login',
        },
      }));
    }

    rememberTrustedDevice(user, deviceId);
    clearUserVerification(user);
    user.updatedAt = new Date().toISOString();
    users[canonicalEmail] = user;
    await kvPut(env, orgKey(orgId, 'users'), users);
    trackEvent(env, orgId, 'login', { role });
    return json(buildAuthResponse({
      user,
      canonicalEmail,
      personName,
      personPhone,
      org,
      role,
      grantedRole,
    }));
  }

  // ── POST /sync/auth/resend — resend signup/login verification email ─────
  if (route === 'auth/resend' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const raw = (body.identifier || body.email || body.phone || '').trim();
    if (!raw) return json({ error: 'identifier required' }, 400);
    if (!env.RESEND_API_KEY || !env.FROM_EMAIL) {
      return json({ error: 'Verification email is not configured for this workspace.' }, 503);
    }

    const { canonicalEmail, personName, personPhone } = await resolveIdentifier(env, orgId, raw);
    if (!canonicalEmail) return json({ ok: true });

    const users = await kvGet(env, orgKey(orgId, 'users'), {});
    const user = users[canonicalEmail];
    if (!user) return json({ ok: true });

    const { role, grantedRole } = await loadAuthAccess(env, orgId, canonicalEmail, user);
    const requestedPurpose = normalizeVerificationPurpose(body.purpose);
    const verificationPurpose = requestedPurpose
      || normalizeVerificationPurpose(user.verification?.purpose)
      || (isUserVerified(user) ? 'login' : 'signup');

    if (verificationPurpose === 'signup' && isUserVerified(user)) {
      return json(buildAuthResponse({
        user,
        canonicalEmail,
        personName,
        personPhone,
        org,
        role,
        grantedRole,
        extra: { alreadyVerified: true },
      }));
    }

    const code = await setUserVerification(user, {
      purpose: verificationPurpose,
      deviceId:
        verificationPurpose === 'login'
          ? (body.deviceId || user.verification?.deviceId || '')
          : (body.deviceId || ''),
    });
    users[canonicalEmail] = user;
    await kvPut(env, orgKey(orgId, 'users'), users);

    try {
      if (verificationPurpose === 'signup') {
        await sendSignupVerificationEmail(env, {
          to: canonicalEmail,
          name: user.name || personName || canonicalEmail,
          code,
          orgName: org.name,
        });
      } else {
        await sendLoginVerificationEmail(env, {
          to: canonicalEmail,
          name: user.name || personName || canonicalEmail,
          code,
          orgName: org.name,
        });
      }
    } catch (error) {
      return json({ error: error.message || 'Failed to resend verification email' }, 502);
    }

    return json(buildAuthResponse({
      user,
      canonicalEmail,
      personName,
      personPhone,
      org,
      role,
      grantedRole,
      extra: {
        needsVerification: true,
        verificationPurpose,
        resent: true,
      },
    }));
  }

  // ── POST /sync/auth/verify — verify signup/login code and complete auth ─
  if (route === 'auth/verify' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const raw = (body.identifier || body.email || body.phone || '').trim();
    const code = String(body.code || '').trim();
    const requestedPurpose = normalizeVerificationPurpose(body.purpose);
    if (!raw || !code) {
      return json({ error: 'identifier and code required' }, 400);
    }

    const { canonicalEmail, personName, personPhone } = await resolveIdentifier(env, orgId, raw);
    if (!canonicalEmail) {
      return json({ error: 'Invalid or expired verification code' }, 400);
    }

    const users = await kvGet(env, orgKey(orgId, 'users'), {});
    const user = users[canonicalEmail];
    if (!user?.verification?.codeHash) {
      return json({ error: 'Invalid or expired verification code' }, 400);
    }
    if (requestedPurpose && user.verification.purpose !== requestedPurpose) {
      return json({ error: 'That verification code is for a different step.' }, 400);
    }
    if (Date.now() > Number(user.verification.expiresAt || 0)) {
      clearUserVerification(user);
      users[canonicalEmail] = user;
      await kvPut(env, orgKey(orgId, 'users'), users);
      return json({ error: 'Invalid or expired verification code' }, 400);
    }

    const submittedCodeHash = await sha256(code);
    if (submittedCodeHash !== user.verification.codeHash) {
      return json({ error: 'Invalid or expired verification code' }, 400);
    }

    const { role, grantedRole } = await loadAuthAccess(env, orgId, canonicalEmail, user);
    user.role = role;
    const verificationPurpose = user.verification.purpose;
    const wasAlreadyVerified = isUserVerified(user);
    if (user.verification.purpose === 'signup') {
      user.verifiedAt = user.verifiedAt || new Date().toISOString();
    }
    rememberTrustedDevice(user, user.verification.deviceId || body.deviceId || '');
    clearUserVerification(user);
    user.updatedAt = new Date().toISOString();
    users[canonicalEmail] = user;
    await kvPut(env, orgKey(orgId, 'users'), users);

    if (verificationPurpose === 'signup' && !wasAlreadyVerified) {
      await Promise.allSettled([
        markInviteRegistered(env, orgId, {
          email: canonicalEmail,
          phone: personPhone || '',
          name: user.name || personName || canonicalEmail,
        }),
        markPersonAsPlaybackRegistered(env, orgId, {
          email: canonicalEmail,
          phone: personPhone || '',
        }),
      ]);

      const displayName = user.name || personName || canonicalEmail;
      const adminMessages = await kvGet(env, orgKey(orgId, 'messages'), []);
      adminMessages.push({
        id: makeId(),
        fromEmail: canonicalEmail,
        fromName: displayName,
        subject: `${displayName} completed registration`,
        message:
          `${displayName} has finished registering in Ultimate Playback and can now be assigned to any service.`,
        to: 'admin',
        timestamp: new Date().toISOString(),
        read: false,
        replies: [],
        hiddenFor: [],
        visibility: 'admin_only',
        messageType: 'member_registration',
      });
      await kvPut(env, orgKey(orgId, 'messages'), adminMessages);
    }

    return json(buildAuthResponse({
      user,
      canonicalEmail,
      personName,
      personPhone,
      org,
      role,
      grantedRole,
    }));
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

  // ── POST /sync/auth/change-password — update user's password ─────────────
  if (route === 'auth/change-password' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const raw = (body.identifier || body.email || '').trim();
    const { currentPassword = '', newPassword = '' } = body;
    if (!raw || !currentPassword || !newPassword) return json({ error: 'identifier, currentPassword, and newPassword required' }, 400);
    if (newPassword.length < 6) return json({ error: 'New password must be at least 6 characters' }, 400);
    const { canonicalEmail } = await resolveIdentifier(env, orgId, raw);
    if (!canonicalEmail) return json({ error: 'Account not found' }, 404);
    const users = await kvGet(env, orgKey(orgId, 'users'), {});
    const user = users[canonicalEmail];
    if (!user) return json({ error: 'No account found' }, 404);
    const currentHash = await sha256(currentPassword);
    if (currentHash !== user.passwordHash) return json({ error: 'Current password is incorrect' }, 401);
    user.passwordHash = await sha256(newPassword);
    user.updatedAt = new Date().toISOString();
    await kvPut(env, orgKey(orgId, 'users'), users);
    return json({ ok: true });
  }

  // ── GET /sync/people — return the org's people list ─────────────────────
  if (route === 'people' && method === 'GET') {
    const people = await kvGet(env, orgKey(orgId, 'people'), []);
    return json(mergeStoredPeople([], people));
  }

  // ── POST /sync/people — upsert one or more team members ─────────────────
  if (route === 'people' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const incomingPeople = Array.isArray(body?.people)
      ? body.people
      : body?.person
        ? [body.person]
        : [];

    if (incomingPeople.length === 0) {
      return json({ error: 'person or people required' }, 400);
    }

    const existingPeople = await kvGet(env, orgKey(orgId, 'people'), []);
    const mergedPeople = mergeStoredPeople(existingPeople, incomingPeople);
    await kvPut(env, orgKey(orgId, 'people'), mergedPeople);
    return json({ ok: true, people: mergedPeople });
  }

  // ── DELETE /sync/people — remove one member by id/email/phone ───────────
  if (route === 'people' && method === 'DELETE') {
    const body = await request.json().catch(() => ({}));
    const personId = String(body.personId || body.id || url.searchParams.get('personId') || '').trim();
    const email = normalizeLower(body.email || url.searchParams.get('email') || '');
    const phone = normalizePhone(body.phone || url.searchParams.get('phone') || '');
    if (!personId && !email && !phone) {
      return json({ error: 'personId, email, or phone required' }, 400);
    }

    const people = await kvGet(env, orgKey(orgId, 'people'), []);
    const nextPeople = people.filter((person) => {
      const personEmail = normalizeLower(person?.email || '');
      const personPhone = normalizePhone(person?.phone || '');
      return !(
        (personId && person?.id === personId)
        || (email && personEmail === email)
        || (phone && personPhone === phone)
      );
    });

    await kvPut(env, orgKey(orgId, 'people'), nextPeople);
    return json({ ok: true, people: nextPeople });
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
    const normalizedTo = normalizeLower(to || 'admin') || 'admin';
    const newMsg = {
      id: makeId(),
      fromEmail,
      fromName,
      subject,
      message: msgText,
      to,
      timestamp: new Date().toISOString(),
      read: false,
      replies: [],
      hiddenFor: [],
      visibility: to === 'all_team' ? 'broadcast' : 'conversation',
      messageType: 'conversation',
    };
    msgs.push(newMsg);
    await kvPut(env, orgKey(orgId, 'messages'), msgs);
    d1InsertMessage(env, orgId, newMsg);

    try {
      const pushDevices = await getPushDevices(env, orgId);
      let targets = [];
      if (normalizedTo === 'all_team') {
        targets = filterPushDevices(pushDevices, {
          preferenceKey: 'messages',
          excludeEmails: [fromEmail],
        });
      } else if (normalizedTo === 'admin') {
        targets = filterPushDevices(pushDevices, {
          adminOnly: true,
          preferenceKey: 'messages',
          excludeEmails: [fromEmail],
        });
      } else {
        targets = filterPushDevices(pushDevices, {
          emails: [normalizedTo],
          preferenceKey: 'messages',
          excludeEmails: [fromEmail],
        });
      }

      await sendPushToDevices(targets, {
        title: normalizedTo === 'all_team'
          ? `Team message from ${fromName || 'Team'}`
          : `New message from ${fromName || 'Team'}`,
        body: subject || msgText || 'Open Ultimate Playback to read your message.',
        data: {
          type: 'message',
          screen: 'MessagesTab',
          to: normalizedTo,
          subject: clipText(subject, 80),
        },
      }, 'messages');
    } catch (error) {
      console.log('[sync/push] message notify failed', error?.message || String(error));
    }

    return json({ ok: true });
  }

  // ── DELETE /sync/message — delete globally or hide for one viewer ───────
  if (route === 'message' && method === 'DELETE') {
    const messageId = url.searchParams.get('messageId') || '';
    const scope = (url.searchParams.get('scope') || 'global').toLowerCase();
    const viewerEmail = (url.searchParams.get('email') || '').toLowerCase().trim();
    if (!messageId) return json({ error: 'messageId required' }, 400);
    const msgs = await kvGet(env, orgKey(orgId, 'messages'), []);
    const idx = msgs.findIndex(m => m.id === messageId);
    if (idx === -1) return json({ error: 'Message not found' }, 404);

    if (scope === 'viewer') {
      if (!viewerEmail) return json({ error: 'email required' }, 400);
      const msg = msgs[idx];
      msg.hiddenFor = Array.isArray(msg.hiddenFor) ? msg.hiddenFor : [];
      if (!msg.hiddenFor.includes(viewerEmail)) msg.hiddenFor.push(viewerEmail);
      await kvPut(env, orgKey(orgId, 'messages'), msgs);
      return json({ ok: true, scope: 'viewer' });
    }

    msgs.splice(idx, 1);
    await kvPut(env, orgKey(orgId, 'messages'), msgs);
    return json({ ok: true, scope: 'global' });
  }

  // ── GET /sync/messages/admin — admin inbox ───────────────────────────────
  if (route === 'messages/admin' && method === 'GET') {
    const msgs = await kvGet(env, orgKey(orgId, 'messages'), []);
    return json(
      (Array.isArray(msgs) ? msgs : [])
        .filter((message) => !isMemberOnlySystemMessage(message))
        .sort((a, b) => (b.timestamp || b.createdAt || '').localeCompare(a.timestamp || a.createdAt || '')),
    );
  }

  // ── GET /sync/messages/replies — user's sent + received messages ──────────
  if (route === 'messages/replies' && method === 'GET') {
    const emailQ = (url.searchParams.get('email') || '').toLowerCase().trim();
    const msgs = await kvGet(env, orgKey(orgId, 'messages'), []);
    const mine = msgs.filter(m => {
      const hiddenFor = Array.isArray(m.hiddenFor)
        ? m.hiddenFor.map(v => (v || '').toLowerCase())
        : [];
      if (hiddenFor.includes(emailQ)) return false;
      if (m.visibility === 'admin_only' || m.isSystemMsg) return false;
      return (
        (m.fromEmail || '').toLowerCase() === emailQ || // sent by user
        m.to === 'all_team' ||                          // broadcast to all
        (m.to || '').toLowerCase() === emailQ           // sent directly to user
      );
    });
    return json(mine.sort((a, b) => (b.timestamp || b.createdAt || '').localeCompare(a.timestamp || a.createdAt || '')));
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

    try {
      const targetEmail = normalizeLower(msg.fromEmail || '');
      if (targetEmail) {
        const pushDevices = await getPushDevices(env, orgId);
        const targets = filterPushDevices(pushDevices, {
          emails: [targetEmail],
          preferenceKey: 'messages',
        });
        await sendPushToDevices(targets, {
          title: 'Reply from Admin',
          body: replyText || 'Open Ultimate Playback to read the reply.',
          data: {
            type: 'message',
            screen: 'MessagesTab',
            subject: clipText(msg.subject || '', 80),
          },
        }, 'messages');
      }
    } catch (error) {
      console.log('[sync/push] reply notify failed', error?.message || String(error));
    }

    return json({ ok: true });
  }

  // ── GET /sync/xdirectory — list admins/WLs across sibling branches ───────
  if (route === 'xdirectory' && method === 'GET') {
    const parentId = org.parentOrgId;
    if (!parentId) return json([]);  // single-org: return empty directory gracefully
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
    return json(mine.sort((a, b) => (b.timestamp || b.createdAt || '').localeCompare(a.timestamp || a.createdAt || '')));
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

  // ── POST /sync/stems/submit ──────────────────────────────────────────────
  // Queue a stem separation job. Publishes to CF Queue → triggers Container immediately.
  // Body: { fileUrl, title, songId, tier, separateHarmonies, voiceCount, enhanceInstrumentStems }
  // tier: 'free' (CPU, 3-5 min) | 'fast' (GPU, ~60s) — fast requires pro plan or credits
  if (route === 'stems/submit' && method === 'POST') {
    const {
      fileUrl,
      title = 'Untitled',
      songId,
      tier = 'free',
      separateHarmonies = true,
      voiceCount = 3,
      enhanceInstrumentStems = true,
    } =
      await request.json().catch(() => ({}));
    if (!fileUrl) return json({ error: 'fileUrl required' }, 400);

    const resolvedSongId = String(songId || '').trim();
    const requestedStemOptions = {
      separateHarmonies,
      enhanceInstrumentStems,
    };

    if (resolvedSongId) {
      const cachedCandidate = await findReusableStemCandidateForSong(
        env,
        orgId,
        resolvedSongId,
        requestedStemOptions,
      );

      if (cachedCandidate) {
        const nowIso = new Date().toISOString();
        const cachedJobId = `cached_${makeId(12)}`;
        const cachedResult = cachedCandidate.evaluation.normalized;
        const cachedJob = {
          id: cachedJobId,
          title,
          tier,
          status: 'COMPLETED',
          jobType: 'STEM_SEPARATION',
          orgId,
          songId: resolvedSongId,
          input: {
            fileUrl,
            sourceUrl: fileUrl,
            title,
            tier,
            separateHarmonies,
            voiceCount,
            enhanceInstrumentStems,
          },
          result: cachedResult,
          error: null,
          key: cachedResult.key ?? null,
          bpm: cachedResult.bpm ?? null,
          source: 'cached',
          cacheHit: {
            source: cachedCandidate.source,
            updatedAt: cachedCandidate.updatedAt || nowIso,
            availableStems: Array.from(cachedCandidate.evaluation.stemTypes).sort(),
            harmonyCount: cachedCandidate.evaluation.harmonyCount,
            requestedEnhanceInstrumentStems: enhanceInstrumentStems !== false,
            requestedSeparateHarmonies: separateHarmonies !== false,
          },
          createdAt: nowIso,
          updatedAt: nowIso,
          completedAt: nowIso,
        };
        await kvPut(env, orgKey(orgId, `stems:job:${cachedJobId}`), cachedJob);
        return json(cachedJob);
      }
    }

    // ── Tier gating ───────────────────────────────────────────────────────
    // Load org plan from D1 (falls back to 'free' if not found)
    let orgPlan = 'free';
    let stemCredits = 0;
    if (env.UM_DB) {
      try {
        const row = await env.UM_DB.prepare(
          'SELECT plan, stemCredits, stemJobsThisMonth, stemJobsResetAt FROM orgs WHERE orgId = ?'
        ).bind(orgId).first();
        if (row) {
          orgPlan = row.plan || 'free';
          stemCredits = row.stemCredits || 0;
          // Reset monthly counter if it's a new month
          const resetAt = new Date(row.stemJobsResetAt || 0);
          const now = new Date();
          if (now.getFullYear() !== resetAt.getFullYear() || now.getMonth() !== resetAt.getMonth()) {
            await env.UM_DB.prepare(
              'UPDATE orgs SET stemJobsThisMonth = 0, stemJobsResetAt = ? WHERE orgId = ?'
            ).bind(now.toISOString(), orgId).run();
            row.stemJobsThisMonth = 0;
          }
          // Free plan: max 5 CPU jobs per month
          if (orgPlan === 'free' && row.stemJobsThisMonth >= 5) {
            return json({ error: 'Free plan limit reached (5 songs/month). Upgrade to Pro for unlimited processing.', limitReached: true }, 402);
          }
          // Fast GPU tier requires pro plan or credits
          if (tier === 'fast' && orgPlan !== 'pro' && stemCredits <= 0) {
            return json({ error: 'GPU fast processing requires Pro plan or GPU credits.', upgradeRequired: true }, 402);
          }
          // Deduct GPU credit if using fast tier
          if (tier === 'fast' && orgPlan !== 'pro' && stemCredits > 0) {
            await env.UM_DB.prepare(
              'UPDATE orgs SET stemCredits = stemCredits - 1 WHERE orgId = ?'
            ).bind(orgId).run();
          }
          // Increment monthly counter
          await env.UM_DB.prepare(
            'UPDATE orgs SET stemJobsThisMonth = stemJobsThisMonth + 1 WHERE orgId = ?'
          ).bind(orgId).run();
        }
      } catch (_) { /* D1 not available — allow job (graceful degradation) */ }
    }

    const jobId = makeId();
    // For fast tier: pass the GPU worker URL; for free tier: leave blank (CPU fallback)
    const modalWorkerUrl = tier === 'fast' ? (env.MODAL_WORKER_URL || env.RUNPOD_WORKER_URL || '') : '';

    const job = {
      id: jobId,
      title,
      tier,
      status: 'PENDING',
      jobType: 'STEM_SEPARATION',
      orgId,
      songId: resolvedSongId || jobId,
      input: {
        fileUrl,
        sourceUrl: fileUrl,
        title,
        tier,
        separateHarmonies,
        voiceCount,
        enhanceInstrumentStems,
      },
      result: null,
      error: null,
      key: null,
      bpm: null,
      createdAt: new Date().toISOString(),
    };
    await kvPut(env, orgKey(orgId, `stems:job:${jobId}`), job);

    const CONTAINER_URL = 'https://cinestage.studio-cinestage.workers.dev';
    const dispatchPayload = JSON.stringify({
      jobId,
      orgId,
      job,
      _secrets: {
        modalWorkerUrl,
        anthropicApiKey: env.ANTHROPIC_API_KEY || '',
        syncOrgId: orgId,
        syncSecretKey: request.headers.get('x-secret-key') || '',
      },
    });

    let queued = false;
    let directDispatchError = '';

    if (env.STEM_QUEUE) {
      try {
        await env.STEM_QUEUE.send(JSON.parse(dispatchPayload));
        queued = true;
      } catch (queueError) {
        directDispatchError = `queue dispatch failed: ${String(queueError?.message || queueError)}`;
      }
    }

    if (!queued) {
      try {
        const dispatchResponse = await fetch(`${CONTAINER_URL}/jobs/process`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: dispatchPayload,
        });
        if (!dispatchResponse.ok) {
          directDispatchError = await dispatchResponse.text().catch(() => `HTTP ${dispatchResponse.status}`);
        } else {
          directDispatchError = '';
        }
      } catch (error) {
        directDispatchError = String(error?.message || error || 'dispatch failed');
      }
    }

    if (directDispatchError && !queued) {
      job.status = 'FAILED';
      job.error = `Dispatch failed: ${directDispatchError}`;
      job.updatedAt = new Date().toISOString();
      await kvPut(env, orgKey(orgId, `stems:job:${jobId}`), job);
      return json({ id: jobId, status: 'FAILED', jobType: 'STEM_SEPARATION', input: job.input, error: job.error }, 502);
    }

    return json({
      id: jobId,
      status: 'PENDING',
      jobType: 'STEM_SEPARATION',
      input: job.input,
      dispatch: {
        direct: !queued && !directDispatchError,
        queued,
      },
    });
  }

  // ── GET /sync/stems/job/:id ──────────────────────────────────────────────
  // Poll job status. Authenticated by org credentials.
  if (route.startsWith('stems/job/') && method === 'GET') {
    const jobId = route.slice('stems/job/'.length);
    let job = await kvGet(env, orgKey(orgId, `stems:job:${jobId}`), null);
    if (!job) return json({ error: 'Job not found' }, 404);

    const jobStatus = String(job.status || '').toUpperCase();
    if ((jobStatus === 'PENDING' || jobStatus === 'PROCESSING') && job.songId) {
      const cachedCandidate = await findReusableStemCandidateForSong(
        env,
        orgId,
        job.songId,
        {
          separateHarmonies: job.input?.separateHarmonies,
          enhanceInstrumentStems: job.input?.enhanceInstrumentStems,
        },
      );

      if (cachedCandidate) {
        const nowIso = new Date().toISOString();
        const cachedResult = cachedCandidate.evaluation.normalized;
        job = {
          ...job,
          status: 'COMPLETED',
          result: cachedResult,
          error: null,
          key: cachedResult.key ?? job.key ?? null,
          bpm: cachedResult.bpm ?? job.bpm ?? null,
          source: 'cached',
          cacheHit: {
            source: cachedCandidate.source,
            updatedAt: cachedCandidate.updatedAt || nowIso,
            availableStems: Array.from(cachedCandidate.evaluation.stemTypes).sort(),
            harmonyCount: cachedCandidate.evaluation.harmonyCount,
            requestedEnhanceInstrumentStems: job.input?.enhanceInstrumentStems !== false,
            requestedSeparateHarmonies: job.input?.separateHarmonies !== false,
          },
          updatedAt: nowIso,
          completedAt: nowIso,
        };
        await kvPut(env, orgKey(orgId, `stems:job:${jobId}`), job);
      }
    }

    return json(job);
  }

  // ── GET /sync/stems/jobs ─────────────────────────────────────────────────
  // List all stem jobs for this org (for the stems dashboard).
  if (route === 'stems/jobs' && method === 'GET') {
    // KV list: keys matching org:{orgId}:stems:job:*
    const prefix = orgKey(orgId, 'stems:job:');
    const listed = await env.STORE.list({ prefix });
    const keys   = (listed?.keys || []).map(k => k.name);
    const jobs   = await Promise.all(
      keys.map(key => env.STORE.get(key, 'json').catch(() => null))
    );
    const sorted = jobs
      .filter(Boolean)
      .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
      .slice(0, 100); // cap at 100 most recent
    return json({ jobs: sorted });
  }

  // ── POST /sync/stems/checkout — create Stripe Checkout session ───────────
  // Returns { url } — front-end redirects to Stripe-hosted checkout page.
  // On success, Stripe webhook fires → flips plan to 'pro' in D1.
  if (route === 'stems/checkout' && method === 'POST') {
    if (!env.STRIPE_SECRET_KEY) {
      return json({ error: 'Stripe not configured' }, 503);
    }
    const { plan = 'pro', successUrl, cancelUrl } = await request.json().catch(() => ({}));
    const origin = request.headers.get('origin') || 'https://ultimatelab.co';
    const success = successUrl || `${origin}/stems?upgraded=1`;
    const cancel  = cancelUrl  || `${origin}/stems/upgrade`;

    // Price IDs — set via wrangler secrets STRIPE_PRO_PRICE_ID
    const priceId = env.STRIPE_PRO_PRICE_ID;
    if (!priceId) return json({ error: 'STRIPE_PRO_PRICE_ID secret not set' }, 503);

    const params = new URLSearchParams({
      'mode': 'subscription',
      'payment_method_types[]': 'card',
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      'success_url': success,
      'cancel_url': cancel,
      'metadata[orgId]': orgId,
      'metadata[plan]': plan,
      'allow_promotion_codes': 'true',
    });
    // Pre-fill email if we have it
    if (org.adminEmail) params.set('customer_email', org.adminEmail);

    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const stripeData = await stripeRes.json();
    if (!stripeRes.ok) {
      console.error('[stems/checkout] Stripe error:', stripeData?.error?.message);
      return json({ error: stripeData?.error?.message || 'Stripe error' }, 500);
    }
    return json({ url: stripeData.url });
  }

  // ── GET /sync/stems/plan — return current plan info for this org ──────────
  if (route === 'stems/plan' && method === 'GET') {
    let planInfo = { plan: 'free', stemCredits: 0, stemJobsThisMonth: 0 };
    if (env.UM_DB) {
      try {
        const row = await env.UM_DB.prepare(
          'SELECT plan, stemCredits, stemJobsThisMonth, planExpiresAt FROM orgs WHERE orgId = ?'
        ).bind(orgId).first();
        if (row) planInfo = { plan: row.plan || 'free', stemCredits: row.stemCredits || 0, stemJobsThisMonth: row.stemJobsThisMonth || 0, planExpiresAt: row.planExpiresAt };
      } catch (_) {}
    }
    return json(planInfo);
  }

  // ── POST /sync/stems/worker-poll ─────────────────────────────────────────
  // Railway worker: get next pending job from the global queue.
  // Uses root org credentials. Returns { job } or { job: null } if empty.
  if (route === 'stems/worker-poll' && method === 'POST') {
    const queue = await kvGet(env, 'stems:queue', []);
    if (queue.length === 0) return json({ job: null });
    const { jobId, orgId: jobOrgId } = queue.shift();
    await kvPut(env, 'stems:queue', queue);
    const job = await kvGet(env, orgKey(jobOrgId, `stems:job:${jobId}`), null);
    if (!job) return json({ job: null });
    job.status = 'PROCESSING';
    job.startedAt = new Date().toISOString();
    await kvPut(env, orgKey(jobOrgId, `stems:job:${jobId}`), job);
    return json({ job });
  }

  // ── POST /sync/stems/worker-update ───────────────────────────────────────
  // Railway worker: post job completion or failure back to KV.
  // Body: { jobId, jobOrgId, status, result, error, key, bpm }
  if (route === 'stems/worker-update' && method === 'POST') {
    const { jobId, jobOrgId, status, result, error: jobError, key, bpm } =
      await request.json().catch(() => ({}));
    if (!jobId) return json({ error: 'jobId required' }, 400);
    const targetOrgId = jobOrgId || orgId;
    const job = await kvGet(env, orgKey(targetOrgId, `stems:job:${jobId}`), null);
    if (!job) return json({ error: 'Job not found' }, 404);
    // Never downgrade a completed job — double-dispatch race protection
    if (job.status === 'COMPLETED' && status === 'FAILED') {
      return json({ ok: true, skipped: 'already_completed' });
    }
    job.status = status;
    if (result != null) job.result = result;
    if (jobError != null) job.error = jobError;
    if (key != null) job.key = key;
    if (bpm != null) job.bpm = bpm;
    job.updatedAt = new Date().toISOString();
    await kvPut(env, orgKey(targetOrgId, `stems:job:${jobId}`), job);
    // Also update legacy stems:songId entry for backward compat
    if (status === 'COMPLETED' && result?.stems && job.songId) {
      const prev = await kvGet(env, orgKey(targetOrgId, `stems:${job.songId}`), {});
      const entry = normalizeStemPayload({
        ...prev,
        songId: job.songId,
        title: job.input?.title,
        stems: result.stems || {},
        harmonies: result.harmonies || {},
        click_track: result.click_track,
        voice_guide: result.voice_guide,
        pad_track: result.pad_track,
        fullMix: result.fullMix,
        full_mix: result.full_mix,
        lyrics: result.lyrics,
        chordChart: result.chordChart,
        sections: result.sections,
        waveformPeaks: result.waveformPeaks,
        waveform_peaks: result.waveform_peaks,
        durationSec: result.durationSec,
        duration_sec: result.duration_sec,
        timeSig: result.timeSig,
        time_signature: result.time_signature,
        key,
        bpm,
        jobId,
        updatedAt: job.updatedAt,
      });
      await kvPut(env, orgKey(targetOrgId, `stems:${job.songId}`), entry);
      await syncSongLibraryStemSnapshot(env, targetOrgId, job.songId, {
        ...entry,
        source: 'cinestage_worker',
      }, {
        title: job.input?.title,
        artist: job.input?.artist,
      });
    }
    return json({ ok: true });
  }

  // ── GET /sync/song-library?songId= — return a single song from the library ─
  if (route === 'song-library' && method === 'GET') {
    const songId = url.searchParams.get('songId') || '';
    const songMap = await kvGet(env, orgKey(orgId, 'songLibrary'), {});
    if (!songId) return json(Object.values(songMap));
    const song = songMap[songId] || null;
    if (!song) return json({ error: 'Song not found' }, 404);
    return json(song);
  }

  // ── POST /sync/proposal — team member submits a content proposal ──────────
  if (route === 'proposal' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const proposal = {
      id: `prop_${makeId(12)}`,
      songId: (body.songId || '').trim(),
      serviceId: (body.serviceId || '').trim(),
      type: body.type === 'chord_chart' ? 'chord_chart' : 'lyrics',
      instrument: (body.instrument || '').trim(),
      content: (body.content || '').trim(),
      keyboardRigs: Array.isArray(body.keyboardRigs) ? body.keyboardRigs : [],
      from_email: (body.from_email || '').trim(),
      from_name: (body.from_name || 'Team Member').trim(),
      songTitle: (body.songTitle || '').trim(),
      songArtist: (body.songArtist || '').trim(),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    const proposals = await kvGet(env, orgKey(orgId, 'proposals'), []);
    proposals.unshift(proposal);
    await kvPut(env, orgKey(orgId, 'proposals'), proposals);
    return json({ ok: true, id: proposal.id });
  }

  // ── GET /sync/proposals?status= — list proposals ─────────────────────────
  if (route === 'proposals' && method === 'GET') {
    const status = url.searchParams.get('status') || '';
    const proposals = await kvGet(env, orgKey(orgId, 'proposals'), []);
    return json(status ? proposals.filter(p => p.status === status) : proposals);
  }

  // ── POST /sync/proposal/approve?id= — approve and apply to song library ──
  if (route === 'proposal/approve' && method === 'POST') {
    const id = url.searchParams.get('id') || '';
    const proposals = await kvGet(env, orgKey(orgId, 'proposals'), []);
    const proposal = proposals.find(p => p.id === id);
    if (!proposal) return json({ error: 'Proposal not found' }, 404);
    proposal.status = 'approved';
    proposal.approvedAt = new Date().toISOString();

    // Apply content to song library using the shared seeding protocol.
    // Approval by admin/WL is treated as privileged (overrides master if needed).
    const songMap = await kvGet(env, orgKey(orgId, 'songLibrary'), {});
    if (!songMap[proposal.songId]) {
      songMap[proposal.songId] = {
        id: proposal.songId,
        title: proposal.songTitle || '',
        artist: proposal.songArtist || '',
        updatedAt: new Date().toISOString(),
      };
    }
    const libSong = songMap[proposal.songId];
    // Determine field type from proposal
    const field = proposal.instrument
      ? 'instrumentNotes'
      : (proposal.type === 'lyrics' ? 'lyrics' : 'chordChart');
    applyChartToSong(libSong, {
      field,
      value:        proposal.content,
      instrument:   proposal.instrument || '',
      keyboardRigs: proposal.keyboardRigs,
      isPrivileged: true, // admin approved → treat as privileged, seeds master + other slots
    });
    libSong.updatedAt = new Date().toISOString();

    await Promise.all([
      kvPut(env, orgKey(orgId, 'proposals'), proposals),
      kvPut(env, orgKey(orgId, 'songLibrary'), songMap),
    ]);
    return json({ ok: true });
  }

  // ── POST /sync/proposal/reject?id= — reject a proposal ───────────────────
  if (route === 'proposal/reject' && method === 'POST') {
    const id = url.searchParams.get('id') || '';
    const body = await request.json().catch(() => ({}));
    const proposals = await kvGet(env, orgKey(orgId, 'proposals'), []);
    const proposal = proposals.find(p => p.id === id);
    if (!proposal) return json({ error: 'Proposal not found' }, 404);
    proposal.status = 'rejected';
    proposal.rejectedAt = new Date().toISOString();
    proposal.rejectReason = (body.reason || '').trim();
    await kvPut(env, orgKey(orgId, 'proposals'), proposals);
    return json({ ok: true });
  }

  // ── POST /sync/invite/create — generate invite token for a new team member ──
  if (route === 'invite/create' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const name = String(body.name || '').trim();
    const email = normalizeLower(body.email || '');
    const phone = String(body.phone || '').trim();
    const sendEmail = body.sendEmail === true;
    const invitedByName = String(body.invitedByName || body.fromName || '').trim();

    if (!email) {
      return json({ error: 'email required — account verification is email-based.' }, 400);
    }

    const invite = await saveInviteRecord(env, {
      token: makeId(),
      orgId,
      orgName: org.name || 'Worship Team',
      name,
      email,
      phone,
      invitedByName,
      createdAt: new Date().toISOString(),
      status: 'pending',
    });

    await updatePersonInviteState(env, orgId, {
      email,
      phone,
      patch: {
        inviteStatus: 'pending',
        inviteToken: invite.token,
        inviteCreatedAt: invite.createdAt || new Date().toISOString(),
        inviteSentAt: new Date().toISOString(),
      },
    });

    if (sendEmail) {
      try {
        await sendTeamInviteEmail(env, { to: email, invite });
      } catch (error) {
        return json({ error: error.message || 'Failed to send invitation email' }, 502);
      }
    }

    return json({
      ok: true,
      ...publicInvitePayload(invite),
      shareText: buildInviteShareText(invite),
      emailSent: sendEmail,
    });
  }

  // ── Playback Trigger — UM signals "open this service in UP" ─────────────────
  if (route === 'playback-trigger' && method === 'POST') {
    const { serviceId } = await request.json().catch(() => ({}));
    if (!serviceId) return json({ error: 'serviceId required' }, 400);
    await kvPut(env, orgKey(orgId, 'playback_trigger'), { serviceId, timestamp: new Date().toISOString() });
    return json({ ok: true });
  }

  if (route === 'playback-trigger' && method === 'GET') {
    const trigger = await kvGet(env, orgKey(orgId, 'playback_trigger'), null);
    return json(trigger || {});
  }

  // ── POST /sync/services/propose — Leader submits a service for approval ────
  if (route === 'services/propose' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const svc = {
      id: `psvc_${makeId(12)}`,
      name: String(body.name || '').trim() || 'Untitled Service',
      date: String(body.date || '').trim(),
      time: String(body.time || '').trim(),
      type: String(body.type || 'standard').trim(),
      notes: String(body.notes || '').trim(),
      status: 'pending_approval',
      created_by_email: String(body.created_by_email || '').trim(),
      created_by_name: String(body.created_by_name || 'Leader').trim(),
      createdAt: new Date().toISOString(),
    };
    const pending = await kvGet(env, orgKey(orgId, 'pending_services'), []);
    pending.unshift(svc);
    await kvPut(env, orgKey(orgId, 'pending_services'), pending);
    return json({ ok: true, id: svc.id });
  }

  // ── GET /sync/services/pending — list pending services ────────────────────
  if (route === 'services/pending' && method === 'GET') {
    const pending = await kvGet(env, orgKey(orgId, 'pending_services'), []);
    return json(pending);
  }

  // ── POST /sync/services/approve?id= — approve a pending service ──────────
  if (route === 'services/approve' && method === 'POST') {
    const id = url.searchParams.get('id') || '';
    const pending = await kvGet(env, orgKey(orgId, 'pending_services'), []);
    const idx = pending.findIndex(s => s.id === id);
    if (idx === -1) return json({ error: 'Pending service not found' }, 404);
    const [svc] = pending.splice(idx, 1);
    // Promote to live services list
    const lib = await kvGet(env, orgKey(orgId, 'library'), { services: [], people: [], plans: {}, songs: [], blockouts: [] });
    if (!Array.isArray(lib.services)) lib.services = [];
    const liveId = svc.id.replace('psvc_', 'svc_');
    lib.services.push({
      id: liveId, name: svc.name, date: svc.date, time: svc.time,
      serviceType: svc.type, notes: svc.notes,
      created_by_email: svc.created_by_email, created_by_name: svc.created_by_name,
      approvedAt: new Date().toISOString(),
    });
    await Promise.all([
      kvPut(env, orgKey(orgId, 'pending_services'), pending),
      kvPut(env, orgKey(orgId, 'library'), lib),
    ]);
    return json({ ok: true, id: liveId });
  }

  // ── POST /sync/services/reject?id= — reject a pending service ────────────
  if (route === 'services/reject' && method === 'POST') {
    const id = url.searchParams.get('id') || '';
    const body = await request.json().catch(() => ({}));
    const pending = await kvGet(env, orgKey(orgId, 'pending_services'), []);
    const svc = pending.find(s => s.id === id);
    if (!svc) return json({ error: 'Pending service not found' }, 404);
    svc.status = 'rejected';
    svc.rejectedAt = new Date().toISOString();
    svc.rejectReason = String(body.reason || '').trim();
    await kvPut(env, orgKey(orgId, 'pending_services'), pending);
    return json({ ok: true });
  }

  // ── POST /sync/library/song-propose — Leader proposes a new song ──────────
  if (route === 'library/song-propose' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const song = {
      id: `psong_${makeId(12)}`,
      title: String(body.title || '').trim() || 'Untitled',
      artist: String(body.artist || '').trim(),
      key: String(body.key || '').trim(),
      bpm: parseInt(body.bpm, 10) || 0,
      notes: String(body.notes || '').trim(),
      from_email: String(body.from_email || '').trim(),
      from_name: String(body.from_name || 'Leader').trim(),
      status: 'pending_approval',
      createdAt: new Date().toISOString(),
    };
    const pending = await kvGet(env, orgKey(orgId, 'pending_songs'), []);
    pending.unshift(song);
    await kvPut(env, orgKey(orgId, 'pending_songs'), pending);
    return json({ ok: true, id: song.id });
  }

  // ── GET /sync/library/pending-songs — list pending songs ─────────────────
  if (route === 'library/pending-songs' && method === 'GET') {
    const pending = await kvGet(env, orgKey(orgId, 'pending_songs'), []);
    return json(pending);
  }

  // ── POST /sync/library/song-approve?id= — approve a pending song ─────────
  if (route === 'library/song-approve' && method === 'POST') {
    const id = url.searchParams.get('id') || '';
    const pending = await kvGet(env, orgKey(orgId, 'pending_songs'), []);
    const idx = pending.findIndex(s => s.id === id);
    if (idx === -1) return json({ error: 'Pending song not found' }, 404);
    const [song] = pending.splice(idx, 1);
    const songMap = await kvGet(env, orgKey(orgId, 'songLibrary'), {});
    const liveId = song.id.replace('psong_', '');
    songMap[liveId] = {
      id: liveId, title: song.title, artist: song.artist,
      key: song.key, bpm: song.bpm, notes: song.notes,
      updatedAt: new Date().toISOString(),
    };
    await Promise.all([
      kvPut(env, orgKey(orgId, 'pending_songs'), pending),
      kvPut(env, orgKey(orgId, 'songLibrary'), songMap),
    ]);
    return json({ ok: true, id: liveId });
  }

  // ── POST /sync/library/song-reject?id= — reject a pending song ───────────
  if (route === 'library/song-reject' && method === 'POST') {
    const id = url.searchParams.get('id') || '';
    const body = await request.json().catch(() => ({}));
    const pending = await kvGet(env, orgKey(orgId, 'pending_songs'), []);
    const song = pending.find(s => s.id === id);
    if (!song) return json({ error: 'Pending song not found' }, 404);
    song.status = 'rejected';
    song.rejectedAt = new Date().toISOString();
    song.rejectReason = String(body.reason || '').trim();
    await kvPut(env, orgKey(orgId, 'pending_songs'), pending);
    return json({ ok: true });
  }

  // ── POST /sync/members/add — Admin adds a member ─────────────────────────
  if (route === 'members/add' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const email = normalizeLower(body.email || '');
    const name  = String(body.name || '').trim();
    if (!email || !name) return json({ error: 'name and email required' }, 400);
    const lib = await kvGet(env, orgKey(orgId, 'library'), { services: [], people: [], plans: {}, songs: [], blockouts: [] });
    if (!Array.isArray(lib.people)) lib.people = [];
    const exists = lib.people.find(p => normalizeLower(p.email || '') === email);
    if (!exists) {
      lib.people.push({ id: makeId(12), name, email, role: String(body.role || '').trim(), createdAt: new Date().toISOString() });
      await kvPut(env, orgKey(orgId, 'library'), lib);
    }
    return json({ ok: true });
  }

  // ── DELETE /sync/members?email= — Admin removes a member ─────────────────
  if (route === 'members' && method === 'DELETE') {
    const email = normalizeLower(url.searchParams.get('email') || '');
    if (!email) return json({ error: 'email required' }, 400);
    const lib = await kvGet(env, orgKey(orgId, 'library'), { services: [], people: [], plans: {}, songs: [], blockouts: [] });
    if (Array.isArray(lib.people)) {
      lib.people = lib.people.filter(p => normalizeLower(p.email || '') !== email);
      await kvPut(env, orgKey(orgId, 'library'), lib);
    }
    return json({ ok: true });
  }

  // ── POST /sync/send-reminders — send service reminders for this org ────────
  // Called by admin (or by the cron helper below). Finds services in 1 or 3
  // days and sends email + in-app message + push to every assigned team member.
  // Deduplicates: each (serviceId, daysOut, memberEmail) triple is sent once.
  if (route === 'send-reminders' && (method === 'POST' || method === 'GET')) {
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const reminderBody = method === 'POST'
      ? await request.json().catch(() => ({}))
      : {};

    const [services, plans, people, pushDevices] = await Promise.all([
      kvGet(env, orgKey(orgId, 'services'), []),
      kvGet(env, orgKey(orgId, 'plans'), {}),
      kvGet(env, orgKey(orgId, 'people'), []),
      getPushDevices(env, orgId),
    ]);

    // Build email index: personId → email, name
    const emailById = {};
    for (const p of (Array.isArray(people) ? people : [])) {
      if (p.id) emailById[normalizeLower(p.id)] = { email: normalizeLower(p.email || ''), name: p.name || '' };
    }

    // Load sent-reminder log to avoid duplicates
    const sentKey = orgKey(orgId, 'remindersSent');
    const remindersSent = await kvGet(env, sentKey, {});

    const targetServiceId = String(
      url.searchParams.get('serviceId') ||
      reminderBody.serviceId ||
      '',
    ).trim();
    const daysOutParamOrg = url.searchParams.get('daysOut') || reminderBody.daysOut;
    const TARGET_DAYS = daysOutParamOrg
      ? [parseInt(daysOutParamOrg, 10)].filter(n => n > 0 && n < 30)
      : [3, 1];
    let emailSent = 0, emailFailed = 0, msgCreated = 0, pushSent = 0;

    const newlySent = {};

    for (const service of (Array.isArray(services) ? services : [])) {
      if (targetServiceId && String(service?.id || '').trim() !== targetServiceId) continue;
      if (!isServicePublished(service)) continue;
      const rawDate = service.date || service.serviceDate || '';
      if (!rawDate) continue;
      const serviceDate = rawDate.slice(0, 10); // YYYY-MM-DD

      // How many days away is this service?
      const diffMs = new Date(serviceDate + 'T00:00:00Z') - new Date(todayStr + 'T00:00:00Z');
      const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
      if (!TARGET_DAYS.includes(diffDays)) continue;

      const plan = plans[service.id] || {};
      const team = Array.isArray(plan.team) ? plan.team
        : Array.isArray(service.team) ? service.team : [];

      if (team.length === 0) continue;

      const serviceName = service.name || service.title || 'Service';
      const orgName = org.name || 'Your Church';
      const songs = Array.isArray(plan.songs)
        ? plan.songs.map(s => s.title || s.name || '').filter(Boolean)
        : [];

      const recipients = buildReminderRecipients(team, emailById);
      for (const recipient of recipients) {
        const memberEmail = recipient.email;
        const memberName = recipient.name;
        const dupKey = `${service.id}::${diffDays}d::${memberEmail}`;
        if (remindersSent[dupKey] || newlySent[dupKey]) continue;

        const reminderContent = buildServiceReminderContent({
          service,
          orgName,
          memberName,
          roles: recipient.roles,
          songs,
          diffDays,
        });

        // ── 1. Email ────────────────────────────────────────────────────────
        const resendApiKey = env.RESEND_API_KEY || '';
        if (resendApiKey) {
          try {
            const fromEmail = env.ASSIGNMENT_FROM_EMAIL || env.INVITE_FROM_EMAIL || 'ultimatemusician@ultimatelabs.co';
            const fromName = env.ASSIGNMENT_FROM_NAME || env.INVITE_FROM_NAME || 'Ultimate Musician';
            const emailRes = await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendApiKey}` },
              body: JSON.stringify({
                from: `${fromName} <${fromEmail}>`,
                to: [memberEmail],
                subject: reminderContent.emailSubject,
                html: reminderContent.htmlBody,
                text: reminderContent.textBody,
              }),
            });
            if (emailRes.ok) emailSent++;
            else { emailFailed++; console.log('[reminders] email failed', memberEmail, await emailRes.text()); }
          } catch (err) {
            emailFailed++;
            console.log('[reminders] email error', memberEmail, err?.message || String(err));
          }
        }

        // ── 2. In-app message (direct to member) ───────────────────────────
        try {
          const msgs = await kvGet(env, orgKey(orgId, 'messages'), []);
          msgs.unshift({
            id: makeId(),
            fromEmail: 'system@ultimatelabs.co',
            fromName: org.name || 'Ultimate Musician',
            subject: reminderContent.inAppSubject,
            message: reminderContent.inAppMessage,
            to: memberEmail,
            timestamp: new Date().toISOString(),
            read: false,
            replies: [],
            hiddenFor: [],
            visibility: 'conversation',
            messageType: 'reminder',
            audience: 'member',
            isSystemMsg: false,
            serviceId: service.id,
          });
          await kvPut(env, orgKey(orgId, 'messages'), msgs);
          msgCreated++;
        } catch (err) {
          console.log('[reminders] in-app message error', memberEmail, err?.message || String(err));
        }

        // ── 3. Push notification ────────────────────────────────────────────
        try {
          const targets = filterPushDevices(pushDevices, { emails: [memberEmail], preferenceKey: 'messages' });
          if (targets.length > 0) {
            await sendPushToDevices(targets, {
              title: reminderContent.pushTitle,
              body: reminderContent.pushBody,
              data: { type: 'reminder', screen: 'AssignmentsTab', serviceId: service.id },
            }, 'messages');
            pushSent += targets.length;
          }
        } catch (err) {
          console.log('[reminders] push error', memberEmail, err?.message || String(err));
        }

        newlySent[dupKey] = new Date().toISOString();
        d1InsertReminderSent(env, orgId, service.id, diffDays, memberEmail); // D1 dedup write
      }
    }

    // Persist dedup log
    const merged = { ...remindersSent, ...newlySent };
    // Prune entries older than 8 days to keep KV tidy
    const cutoff = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    for (const k of Object.keys(merged)) {
      if (merged[k] < cutoff) delete merged[k];
    }
    await kvPut(env, sentKey, merged);

    return json({ ok: true, emailSent, emailFailed, msgCreated, pushSent, newReminders: Object.keys(newlySent).length });
  }

  // ── POST /sync/ai/recommend — Workers AI song recommendations ────────────
  if (route === 'ai/recommend' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const { currentSong = {}, setlistContext = [], songPool = [] } = body;

    const currentTitle = clipText(String(currentSong.title || 'Unknown'), 80);
    const currentKey   = clipText(String(currentSong.key   || 'Unknown'), 12);
    const currentBpm   = Number.isFinite(Number(currentSong.bpm)) ? Number(currentSong.bpm) : null;
    const contextLines = Array.isArray(setlistContext)
      ? setlistContext.slice(0, 8).map((s, i) =>
          `${i + 1}. "${clipText(String(s?.title || ''), 60)}" (Key: ${clipText(String(s?.key || '?'), 12)}, BPM: ${s?.bpm || '?'})`)
      : [];
    const songMap = await kvGet(env, orgKey(orgId, 'songLibrary'), {});
    const candidatePool = collectRecommendationCandidates(
      songMap,
      songPool,
      { title: currentTitle, key: currentKey, bpm: currentBpm },
      setlistContext,
    );
    const candidateLines = candidatePool.slice(0, 12).map((song, index) =>
      `${index + 1}. "${clipText(song.title, 60)}" by ${clipText(song.artist || 'Unknown', 60)} (Key: ${clipText(song.key || '?', 12)}, BPM: ${song.bpm || '?'}, Fit: ${song.reasonSummary})`);

    const systemPrompt = 'You are a worship music director assistant. Recommend exactly 3 songs that flow well next. Use only songs from the provided candidate pool. Consider key compatibility, energy arc, and typical setlist flow. Respond with a JSON object exactly like: {"recommendations": [{"title": "...", "artist": "...", "reason": "...", "suggestedKey": "..."}]}. Use only valid JSON. No markdown. No extra text.';
    const userPrompt = [
      `Current song: "${currentTitle}" — Key: ${currentKey}${currentBpm ? `, BPM: ${currentBpm}` : ''}.`,
      contextLines.length > 0 ? `Setlist so far:\n${contextLines.join('\n')}` : 'This is the first song on the setlist.',
      candidateLines.length > 0 ? `Candidate songs:\n${candidateLines.join('\n')}` : 'Candidate songs: none supplied.',
      'What 3 songs would flow well next?',
    ].join('\n');

    let recommendations = [];
    if (env.AI && candidatePool.length > 0) {
      try {
        const aiResult = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 512,
          temperature: 0.7,
        });
        const rawResponse = aiResult?.response || aiResult?.result?.response || '';
        const jsonMatch = rawResponse.match(/\{[\s\S]*"recommendations"[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          recommendations = normalizeAiRecommendations(parsed.recommendations, candidatePool, currentKey);
        }
      } catch (err) {
        console.log('[ai/recommend] error:', err?.message || String(err));
      }
    }

    if (recommendations.length === 0) {
      recommendations = buildFallbackRecommendations(candidatePool, currentKey);
    }

    trackEvent(env, orgId, 'ai_call', { endpoint: 'recommend', currentSong: currentTitle, resultCount: recommendations.length });
    return json({
      ok: true,
      recommendations,
      currentSong: { title: currentTitle, key: currentKey, bpm: currentBpm },
      candidateCount: candidatePool.length,
    });
  }

  // ── GET /sync/ai/stats — D1 analytics summary for the org ─────────────
  if (route === 'ai/stats' && method === 'GET') {
    if (!env.UM_DB) return json({ error: 'Analytics database not configured.' }, 503);
    try {
      const [eventCounts, recentActivity] = await Promise.all([
        env.UM_DB.prepare(
          `SELECT event, COUNT(*) as count FROM analytics_events WHERE orgId = ? GROUP BY event ORDER BY count DESC LIMIT 20`
        ).bind(orgId).all(),
        env.UM_DB.prepare(
          `SELECT event, metadata, ts FROM analytics_events WHERE orgId = ? ORDER BY ts DESC LIMIT 50`
        ).bind(orgId).all(),
      ]);
      return json({ ok: true, eventCounts: eventCounts.results, recentActivity: recentActivity.results });
    } catch (err) {
      return json({ error: 'Stats query failed', detail: err?.message }, 500);
    }
  }

  // ── GET /sync/room/:serviceId/ws — WebSocket proxy to SyncRoom DO ────────
  if (route.startsWith('room/') && route.endsWith('/ws') && method === 'GET') {
    if (!env.SYNC_ROOM_WORKER) return json({ error: 'Real-time sync is not configured.' }, 503);
    const serviceId = route.split('/')[1];
    if (!serviceId) return json({ error: 'serviceId required' }, 400);
    const workerUrl = new URL(request.url);
    workerUrl.pathname = `/room/${encodeURIComponent(serviceId)}/ws`;
    // Pass verified orgId so clients can't spoof it
    workerUrl.searchParams.set('orgId', orgId);
    return env.SYNC_ROOM_WORKER.fetch(new Request(workerUrl.toString(), request));
  }

  // ── GET /sync/room/:serviceId/state — last known position (REST fallback) ─
  if (route.startsWith('room/') && route.endsWith('/state') && method === 'GET') {
    if (!env.SYNC_ROOM_WORKER) return json({ error: 'Real-time sync is not configured.' }, 503);
    const serviceId = route.split('/')[1];
    if (!serviceId) return json({ error: 'serviceId required' }, 400);
    return env.SYNC_ROOM_WORKER.fetch(
      new Request(`https://internal/room/${encodeURIComponent(serviceId)}/state`, { method: 'GET' })
    );
  }

  // ── POST /sync/room/:serviceId/broadcast — server-side broadcast to room ─
  if (route.startsWith('room/') && route.endsWith('/broadcast') && method === 'POST') {
    if (!env.SYNC_ROOM_WORKER) return json({ error: 'Real-time sync is not configured.' }, 503);
    const serviceId = route.split('/')[1];
    if (!serviceId) return json({ error: 'serviceId required' }, 400);
    const body = await request.json().catch(() => ({}));
    return env.SYNC_ROOM_WORKER.fetch(
      new Request(`https://internal/room/${encodeURIComponent(serviceId)}/broadcast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    );
  }

  return json({ error: 'Not found', route }, 404);
}
