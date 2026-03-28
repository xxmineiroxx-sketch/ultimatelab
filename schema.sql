-- ──────────────────────────────────────────────────────────────────────────
-- Ultimate Musician D1 Schema
-- Apply once: wrangler d1 execute UM_DB --file=schema.sql --remote
-- ──────────────────────────────────────────────────────────────────────────

-- Organizations
CREATE TABLE IF NOT EXISTS orgs (
  orgId        TEXT PRIMARY KEY,
  name         TEXT NOT NULL DEFAULT '',
  city         TEXT NOT NULL DEFAULT '',
  secretKeyHash TEXT NOT NULL DEFAULT '',
  createdAt    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  parentOrgId  TEXT
);
CREATE INDEX IF NOT EXISTS idx_orgs_parentOrgId ON orgs(parentOrgId);

-- Services
CREATE TABLE IF NOT EXISTS services (
  id          TEXT PRIMARY KEY,
  orgId       TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  date        TEXT NOT NULL DEFAULT '',
  time        TEXT NOT NULL DEFAULT '',
  type        TEXT NOT NULL DEFAULT 'standard',
  locked      INTEGER NOT NULL DEFAULT 0,
  publishedAt TEXT,
  createdAt   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_services_orgId ON services(orgId);
CREATE INDEX IF NOT EXISTS idx_services_date  ON services(orgId, date);

-- People
CREATE TABLE IF NOT EXISTS people (
  id        TEXT PRIMARY KEY,
  orgId     TEXT NOT NULL,
  email     TEXT NOT NULL DEFAULT '',
  name      TEXT NOT NULL DEFAULT '',
  phone     TEXT NOT NULL DEFAULT '',
  role      TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_people_orgId  ON people(orgId);
CREATE INDEX IF NOT EXISTS idx_people_email  ON people(orgId, email);

-- Songs
CREATE TABLE IF NOT EXISTS songs (
  id        TEXT PRIMARY KEY,
  orgId     TEXT NOT NULL,
  title     TEXT NOT NULL DEFAULT '',
  artist    TEXT NOT NULL DEFAULT '',
  key       TEXT NOT NULL DEFAULT '',
  bpm       INTEGER,
  tags      TEXT NOT NULL DEFAULT '',
  notes     TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_songs_orgId  ON songs(orgId);
CREATE INDEX IF NOT EXISTS idx_songs_title  ON songs(orgId, title);

-- Assignment Responses
CREATE TABLE IF NOT EXISTS assignment_responses (
  id          TEXT PRIMARY KEY,
  orgId       TEXT NOT NULL,
  serviceId   TEXT NOT NULL,
  personEmail TEXT NOT NULL DEFAULT '',
  personId    TEXT NOT NULL DEFAULT '',
  role        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'pending',
  note        TEXT NOT NULL DEFAULT '',
  respondedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_ar_orgId     ON assignment_responses(orgId);
CREATE INDEX IF NOT EXISTS idx_ar_serviceId ON assignment_responses(orgId, serviceId);
CREATE INDEX IF NOT EXISTS idx_ar_email     ON assignment_responses(orgId, personEmail);

-- Messages
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  orgId       TEXT NOT NULL,
  fromEmail   TEXT NOT NULL DEFAULT '',
  toEmail     TEXT NOT NULL DEFAULT '',
  subject     TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  read        INTEGER NOT NULL DEFAULT 0,
  messageType TEXT NOT NULL DEFAULT 'general',
  serviceId   TEXT,
  createdAt   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_orgId   ON messages(orgId);
CREATE INDEX IF NOT EXISTS idx_messages_toEmail ON messages(orgId, toEmail);

-- Reminder Sent Dedup Log
CREATE TABLE IF NOT EXISTS reminder_sent (
  orgId       TEXT NOT NULL,
  serviceId   TEXT NOT NULL,
  daysOut     INTEGER NOT NULL,
  memberEmail TEXT NOT NULL,
  sentAt      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (orgId, serviceId, daysOut, memberEmail)
);

-- Analytics Events
CREATE TABLE IF NOT EXISTS analytics_events (
  id       TEXT PRIMARY KEY,
  orgId    TEXT NOT NULL DEFAULT '',
  event    TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  ts       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_ae_orgId ON analytics_events(orgId);
CREATE INDEX IF NOT EXISTS idx_ae_event ON analytics_events(event);
CREATE INDEX IF NOT EXISTS idx_ae_ts    ON analytics_events(ts);
