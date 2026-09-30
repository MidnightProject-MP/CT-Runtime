-- Durable Gmail ingress/egress fences for the vNext pilot.
CREATE TABLE vnext_email_mailboxes (
  mailbox_id text PRIMARY KEY,
  label_name text NOT NULL,
  allowed_sender text,
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE vnext_email_receipts (
  receipt_id text PRIMARY KEY,
  mailbox_id text NOT NULL REFERENCES vnext_email_mailboxes(mailbox_id),
  provider_message_id text NOT NULL,
  provider_thread_id text NOT NULL,
  from_address text NOT NULL,
  to_address text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  work_unit_id text NOT NULL,
  input_seq bigint,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (mailbox_id, provider_message_id)
);
CREATE TABLE vnext_email_outbox (
  outbox_id text PRIMARY KEY,
  mailbox_id text NOT NULL REFERENCES vnext_email_mailboxes(mailbox_id),
  provider_thread_id text,
  to_address text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sent','uncertain','failed')),
  attempt integer NOT NULL DEFAULT 0,
  provider_message_id text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sent_at timestamptz
);
CREATE INDEX vnext_email_receipts_work_idx ON vnext_email_receipts(work_unit_id, received_at);
CREATE INDEX vnext_email_outbox_pending_idx ON vnext_email_outbox(state, created_at);
