-- S04 schema version 1: durable commands, runs, events, approvals and sync.
-- 正文边界：本文件不包含 originalInput/content/resultPromise 或任何明文 token 列。

CREATE TABLE schema_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schemaVersion INTEGER NOT NULL,
  desktopId TEXT,
  migrationState TEXT NOT NULL CHECK (migrationState IN ('absent', 'database_committed', 'completed')),
  updatedAt INTEGER NOT NULL
) STRICT;

CREATE TABLE migration_sources (
  sourceType TEXT PRIMARY KEY,
  sourceHash TEXT NOT NULL,
  migratedAt INTEGER NOT NULL
) STRICT;

CREATE TABLE devices (
  deviceId TEXT PRIMARY KEY,
  deviceName TEXT NOT NULL,
  tokenHash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  createdAt INTEGER NOT NULL,
  revokedAt INTEGER
) STRICT;

CREATE TABLE workspaces (
  workspaceId TEXT PRIMARY KEY,
  displayName TEXT NOT NULL,
  rootPath TEXT NOT NULL,
  perSessionQueueLimit INTEGER NOT NULL DEFAULT 20,
  mobileApprovalMode TEXT NOT NULL DEFAULT 'deny' CHECK (mobileApprovalMode IN ('deny', 'allow_once')),
  createdAt INTEGER NOT NULL,
  removedAt INTEGER
) STRICT;

CREATE UNIQUE INDEX idx_workspaces_root_active
  ON workspaces (rootPath) WHERE removedAt IS NULL;

CREATE TABLE sessions (
  sessionId TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL REFERENCES workspaces (workspaceId),
  claudeSessionId TEXT,
  title TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'archived')),
  status TEXT NOT NULL,
  lastSeq INTEGER NOT NULL DEFAULT 0 CHECK (lastSeq >= 0),
  retentionFloor INTEGER NOT NULL DEFAULT 0 CHECK (retentionFloor >= 0),
  createdAt INTEGER NOT NULL,
  lastActivityAt INTEGER NOT NULL,
  archivedAt INTEGER
) STRICT;

CREATE UNIQUE INDEX idx_sessions_claude_id
  ON sessions (claudeSessionId) WHERE claudeSessionId IS NOT NULL;

CREATE INDEX idx_sessions_workspace ON sessions (workspaceId);

CREATE TABLE runs (
  runId TEXT PRIMARY KEY,
  sessionId TEXT NOT NULL REFERENCES sessions (sessionId),
  workspaceId TEXT NOT NULL,
  deviceId TEXT NOT NULL,
  commandId TEXT NOT NULL,
  traceId TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'queued', 'starting', 'running', 'waiting_approval', 'cancelling',
    'succeeded', 'failed', 'cancelled', 'interrupted', 'recovery_required'
  )),
  promptText TEXT,
  promptExpiresAt INTEGER,
  enqueueOrder INTEGER NOT NULL,
  recoveryGeneration INTEGER NOT NULL DEFAULT 0 CHECK (recoveryGeneration >= 0),
  pendingApprovalCount INTEGER NOT NULL DEFAULT 0 CHECK (pendingApprovalCount >= 0),
  outcomeUnknown INTEGER NOT NULL DEFAULT 0 CHECK (outcomeUnknown IN (0, 1)),
  eventTailMayBeIncomplete INTEGER NOT NULL DEFAULT 0 CHECK (eventTailMayBeIncomplete IN (0, 1)),
  recoveryReason TEXT,
  enqueuedAt INTEGER NOT NULL,
  startedAt INTEGER,
  endedAt INTEGER,
  errorSummary TEXT
) STRICT;

CREATE UNIQUE INDEX idx_runs_command ON runs (commandId);
CREATE INDEX idx_runs_session_status ON runs (sessionId, status);
CREATE INDEX idx_runs_enqueue_order ON runs (status, enqueueOrder);
CREATE INDEX idx_runs_workspace ON runs (workspaceId);

CREATE TABLE events (
  eventId TEXT PRIMARY KEY,
  sessionId TEXT NOT NULL REFERENCES sessions (sessionId),
  seq INTEGER NOT NULL CHECK (seq > 0),
  runId TEXT,
  approvalId TEXT,
  type TEXT NOT NULL,
  payloadJson TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  UNIQUE (sessionId, seq)
) STRICT;

CREATE INDEX idx_events_session_seq ON events (sessionId, seq);

CREATE TABLE approvals (
  approvalId TEXT PRIMARY KEY,
  requestKey TEXT NOT NULL UNIQUE,
  requestFingerprint TEXT NOT NULL,
  workspaceId TEXT NOT NULL,
  sessionId TEXT NOT NULL,
  runId TEXT NOT NULL,
  deviceId TEXT NOT NULL,
  toolUseID TEXT NOT NULL,
  toolName TEXT NOT NULL,
  agentID TEXT,
  defaultToNo INTEGER NOT NULL DEFAULT 0 CHECK (defaultToNo IN (0, 1)),
  hasDecisionReason INTEGER NOT NULL DEFAULT 0 CHECK (hasDecisionReason IN (0, 1)),
  hasBlockedPath INTEGER NOT NULL DEFAULT 0 CHECK (hasBlockedPath IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'approved_once', 'denied', 'expired', 'invalidated'
  )),
  createdAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL,
  resolvedAt INTEGER,
  resolutionReason TEXT,
  responseCommandId TEXT,
  contentSha256 TEXT,
  contentByteLength INTEGER
) STRICT;

CREATE INDEX idx_approvals_run_status ON approvals (runId, status);
CREATE INDEX idx_approvals_status ON approvals (status);

CREATE TABLE commands (
  commandId TEXT PRIMARY KEY,
  actorDeviceId TEXT,
  localActor TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('mutating', 'read_only')),
  fingerprint TEXT NOT NULL,
  resultJson TEXT,
  resultExpired INTEGER NOT NULL DEFAULT 0 CHECK (resultExpired IN (0, 1)),
  createdAt INTEGER NOT NULL,
  completedAt INTEGER,
  CHECK (
    (actorDeviceId IS NOT NULL AND localActor IS NULL)
    OR (actorDeviceId IS NULL AND localActor IS NOT NULL)
  )
) STRICT;

CREATE INDEX idx_commands_created ON commands (createdAt);

CREATE TABLE snapshots (
  snapshotId TEXT PRIMARY KEY,
  sessionId TEXT NOT NULL REFERENCES sessions (sessionId),
  lastSeq INTEGER NOT NULL,
  pageCount INTEGER NOT NULL CHECK (pageCount BETWEEN 1 AND 8),
  byteLength INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('sync', 'retention')),
  createdAt INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_snapshots_session_created ON snapshots (sessionId, createdAt);

CREATE TABLE snapshot_pages (
  snapshotId TEXT NOT NULL REFERENCES snapshots (snapshotId) ON DELETE CASCADE,
  pageIndex INTEGER NOT NULL CHECK (pageIndex >= 0),
  payloadJson TEXT NOT NULL,
  PRIMARY KEY (snapshotId, pageIndex)
) STRICT;

CREATE TABLE audit_logs (
  auditId TEXT PRIMARY KEY,
  actorDeviceId TEXT,
  localActor TEXT,
  sessionId TEXT,
  runId TEXT,
  approvalId TEXT,
  action TEXT NOT NULL,
  result TEXT NOT NULL,
  traceId TEXT,
  createdAt INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_audit_created ON audit_logs (createdAt);

CREATE TABLE scheduler_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

-- lastSeq 只能随同事务中的事件前进；单独 UPDATE 或超前 INSERT 必须失败。
CREATE TRIGGER sessions_last_seq_insert_guard
BEFORE INSERT ON sessions
WHEN NEW.lastSeq > 0
BEGIN
  SELECT RAISE(ABORT, 'lastSeq ahead of events');
END;

CREATE TRIGGER sessions_last_seq_update_guard
BEFORE UPDATE OF lastSeq ON sessions
WHEN NEW.lastSeq > COALESCE(
  (SELECT MAX(seq) FROM events WHERE events.sessionId = NEW.sessionId),
  0
)
BEGIN
  SELECT RAISE(ABORT, 'lastSeq ahead of events');
END;