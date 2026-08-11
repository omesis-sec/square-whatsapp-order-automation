CREATE TABLE IF NOT EXISTS support_conversations (
  phone TEXT PRIMARY KEY,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'BOT',
  opened_at TEXT,
  updated_at TEXT NOT NULL,
  last_customer_at TEXT,
  last_message_preview TEXT,
  unread_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS support_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  direction TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'text',
  body TEXT NOT NULL,
  external_id TEXT UNIQUE,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_support_messages_phone_created
  ON support_messages (phone, created_at);

CREATE INDEX IF NOT EXISTS idx_support_conversations_status_updated
  ON support_conversations (status, updated_at);

CREATE TABLE IF NOT EXISTS whatsapp_order_update_consents (
  phone TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  evidence_message_id TEXT,
  consented_at TEXT,
  opted_out_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_notifications (
  order_id TEXT PRIMARY KEY,
  payment_id TEXT,
  phone TEXT NOT NULL,
  message_id TEXT UNIQUE,
  status TEXT NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_notifications_message_id
  ON order_notifications (message_id);

CREATE TABLE IF NOT EXISTS order_tracking_links (
  order_id TEXT PRIMARY KEY,
  payment_id TEXT,
  phone TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_tracking_links_phone_updated
  ON order_tracking_links (phone, updated_at DESC);

CREATE TABLE IF NOT EXISTS order_status_notifications (
  order_id TEXT NOT NULL,
  status_key TEXT NOT NULL,
  phone TEXT NOT NULL,
  message_id TEXT UNIQUE,
  status TEXT NOT NULL,
  error_code TEXT,
  event_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (order_id, status_key)
);

CREATE INDEX IF NOT EXISTS idx_order_status_notifications_message_id
  ON order_status_notifications (message_id);

