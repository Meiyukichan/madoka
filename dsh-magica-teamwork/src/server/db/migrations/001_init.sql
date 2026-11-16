-- dsh-teamwork · 001_init.sql
-- 由 docs/design/db-design.zh.md §4 直接生成，勿手改（改文档后重新抽取）
-- 迁移器会在事务内执行本文件，成功后把 PRAGMA user_version 置为 1
-- 目标：SQLite >= 3.35（依赖 RETURNING 与部分唯一索引）
-- 约定：所有时间列为 TEXT，UTC ISO-8601 毫秒；所有索引显式命名
-- 执行：BEGIN IMMEDIATE; <本文件>; PRAGMA user_version = 1; COMMIT;

CREATE TABLE dsh_teamwork_account (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    TEXT NOT NULL,
  display_name  TEXT,
  account_token  TEXT NOT NULL,
  global_role    TEXT NOT NULL DEFAULT 'user',
  status        TEXT NOT NULL DEFAULT 'active',
  last_login_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT ck_tw_account_id_len  CHECK (length(account_id) BETWEEN 3 AND 64),
  CONSTRAINT ck_tw_account_status  CHECK (status IN ('active','disabled')),
  CONSTRAINT ck_tw_account_role    CHECK (global_role IN ('administrator','leader','user')),
  CONSTRAINT ck_tw_account_token    CHECK (length(account_token) = 64
                                     AND account_token NOT GLOB '*[^0-9a-f]*')
);
CREATE UNIQUE INDEX uk_tw_account ON dsh_teamwork_account(account_id);



CREATE TABLE dsh_teamwork_project (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  visibility  TEXT NOT NULL DEFAULT 'public',
  description TEXT,
  created_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT ck_tw_project_name_len CHECK (length(trim(name)) BETWEEN 1 AND 100),
  CONSTRAINT ck_tw_project_visibility CHECK (visibility IN ('public','private'))
);
CREATE UNIQUE INDEX uk_tw_project_name    ON dsh_teamwork_project(name);
CREATE INDEX        idx_tw_project_updated ON dsh_teamwork_project(updated_at DESC);

CREATE TABLE dsh_teamwork_project_member (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER NOT NULL,
  account_id   TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'member',
  joined_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT fk_tw_member_project FOREIGN KEY (project_id)
    REFERENCES dsh_teamwork_project(id) ON DELETE CASCADE,
  CONSTRAINT ck_tw_member_role CHECK (role IN ('owner','manager','member'))
);
CREATE UNIQUE INDEX uk_tw_member       ON dsh_teamwork_project_member(project_id, account_id);
-- 每个项目【恰好一个】owner（部分唯一索引，DB 强制）
CREATE UNIQUE INDEX uk_tw_member_owner ON dsh_teamwork_project_member(project_id) WHERE role = 'owner';
CREATE INDEX        idx_tw_member_acct ON dsh_teamwork_project_member(account_id);
CREATE INDEX        idx_tw_member_pid  ON dsh_teamwork_project_member(project_id);

CREATE TABLE dsh_teamwork_device (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id          TEXT NOT NULL,
  host                TEXT NOT NULL,
  port                INTEGER NOT NULL DEFAULT 0,
  os                  TEXT,
  status              TEXT NOT NULL DEFAULT 'active',
  last_active_at      TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT ck_tw_device_port   CHECK (port BETWEEN 0 AND 65535),
  CONSTRAINT ck_tw_device_status CHECK (status IN ('active','inactive'))
);
CREATE UNIQUE INDEX uk_tw_device         ON dsh_teamwork_device(account_id, host, port);
CREATE INDEX        idx_tw_device_acct    ON dsh_teamwork_device(account_id);
CREATE INDEX        idx_tw_device_host    ON dsh_teamwork_device(host);
CREATE INDEX        idx_tw_device_acct_st ON dsh_teamwork_device(account_id, status);

CREATE TABLE dsh_teamwork_device_workspace (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   TEXT NOT NULL,
  instance     TEXT NOT NULL,
  workspace_id TEXT,
  cwd          TEXT,
  type         TEXT NOT NULL,
  detail       TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT ck_tw_ws_type CHECK (type IN ('index','portal')),
  CONSTRAINT ck_tw_ws_shape CHECK (
       (type = 'index'  AND workspace_id IS NULL     AND cwd IS NULL)
    OR (type = 'portal' AND workspace_id IS NOT NULL AND cwd IS NOT NULL)
  )
);
CREATE UNIQUE INDEX uk_tw_ws_portal   ON dsh_teamwork_device_workspace(account_id, instance, workspace_id)
  WHERE workspace_id IS NOT NULL;
CREATE UNIQUE INDEX uk_tw_ws_index    ON dsh_teamwork_device_workspace(account_id, instance)
  WHERE workspace_id IS NULL;
CREATE INDEX        idx_tw_ws_acct_instance ON dsh_teamwork_device_workspace(account_id, instance);
CREATE INDEX        idx_tw_ws_cwd           ON dsh_teamwork_device_workspace(cwd);

CREATE TABLE dsh_teamwork_issue (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id          TEXT NOT NULL,
  project_id        INTEGER,
  title             TEXT NOT NULL,
  detail            TEXT,
  assigner          TEXT NOT NULL,
  assigner_task     TEXT,
  assigner_meta     TEXT,
  cwd               TEXT,
  urgency           TEXT NOT NULL DEFAULT 'normal',
  permission        TEXT,
  assignee          TEXT NOT NULL,
  assignee_task     TEXT,
  assignee_instance TEXT,
  assignee_meta     TEXT,
  status            TEXT NOT NULL DEFAULT 'pending',
  source            TEXT NOT NULL DEFAULT 'self',
  source_instance   TEXT,
  depends_on        TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  assigned_at       TEXT,
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT ck_tw_issue_id_len  CHECK (length(issue_id) BETWEEN 1 AND 100),
  CONSTRAINT ck_tw_issue_cwd_len CHECK (cwd IS NULL OR length(cwd) <= 500),
  CONSTRAINT ck_tw_issue_title_len  CHECK (length(trim(title)) BETWEEN 1 AND 200),
  CONSTRAINT ck_tw_issue_urgency   CHECK (urgency IN ('runtime','direct','urgent','normal','relaxed')),
  CONSTRAINT ck_tw_issue_permission CHECK (permission IS NULL OR permission IN ('read-only','workspace-write','danger-full-access'))
);
CREATE UNIQUE INDEX uk_tw_issue_id           ON dsh_teamwork_issue(issue_id);
CREATE INDEX        idx_tw_issue_assignee          ON dsh_teamwork_issue(assignee);
CREATE INDEX        idx_tw_issue_assignee_instance ON dsh_teamwork_issue(assignee_instance);
CREATE INDEX        idx_tw_issue_assigner          ON dsh_teamwork_issue(assigner);
CREATE INDEX        idx_tw_issue_assigner_task     ON dsh_teamwork_issue(assigner_task);
CREATE INDEX        idx_tw_issue_assignee_task     ON dsh_teamwork_issue(assignee_task);
CREATE INDEX        idx_tw_issue_status            ON dsh_teamwork_issue(status);
CREATE INDEX        idx_tw_issue_source            ON dsh_teamwork_issue(source);
CREATE INDEX        idx_tw_issue_project          ON dsh_teamwork_issue(project_id, created_at DESC);

CREATE TABLE dsh_teamwork_issue_attachment (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id    TEXT NOT NULL,
  file_id     TEXT NOT NULL,
  file_name   TEXT,
  type        TEXT NOT NULL,
  description TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT ck_tw_attachment_type CHECK (type IN ('assigner','assignee'))
);
CREATE UNIQUE INDEX uk_tw_attachment             ON dsh_teamwork_issue_attachment(issue_id, file_id);
CREATE INDEX        idx_tw_attachment_issue      ON dsh_teamwork_issue_attachment(issue_id);
CREATE INDEX        idx_tw_attachment_issue_type ON dsh_teamwork_issue_attachment(issue_id, type);

CREATE TABLE dsh_teamwork_issue_comment (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id          TEXT NOT NULL,
  issue_id            TEXT NOT NULL,
  author              TEXT,
  content             TEXT NOT NULL,
  comment_role        TEXT,
  comment_author_type TEXT,
  comment_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT ck_tw_comment_content CHECK (length(content) >= 1)
);
CREATE UNIQUE INDEX uk_tw_comment_id  ON dsh_teamwork_issue_comment(comment_id);
CREATE INDEX        idx_tw_comment_issue ON dsh_teamwork_issue_comment(issue_id);

CREATE TABLE dsh_teamwork_issue_source (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL,
  description TEXT,
  plugin_name TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT ck_tw_source_code CHECK (
       length(code) BETWEEN 1 AND 64
   AND code NOT GLOB '*[^a-z-]*'
   AND code NOT GLOB '-*'
   AND code NOT GLOB '*-'
   AND code NOT GLOB '*--*'
  )
);
CREATE UNIQUE INDEX uk_tw_source_code ON dsh_teamwork_issue_source(code);

INSERT INTO dsh_teamwork_issue_source (code, description) VALUES
  ('self',   '本地 DSH 创建'),
  ('dsh',    '项目组发起'),
  ('im-group', '即时通讯群发起')
ON CONFLICT (code) DO NOTHING;

PRAGMA user_version = 1;
