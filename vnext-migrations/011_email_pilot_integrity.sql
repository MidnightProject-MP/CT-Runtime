-- Complete the email pilot schema introduced by 010_email_pilot.sql.
ALTER TABLE vnext_email_mailboxes ADD COLUMN project_id text;
ALTER TABLE vnext_email_mailboxes ADD COLUMN mailbox_address text;
ALTER TABLE vnext_pilot_results ADD COLUMN input_seq bigint CHECK (input_seq >= 0);
ALTER TABLE vnext_email_outbox ADD COLUMN in_reply_to text;
-- Old rows cannot be safely inferred and require operator reconciliation.
UPDATE vnext_email_mailboxes SET enabled=false;
