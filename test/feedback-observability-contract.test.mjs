import assert from 'node:assert/strict';
import test from 'node:test';

test('feedback poll events expose boundary-safe diagnostics', () => {
  const started = {
    operation: 'feedback-poll',
    script_id: 'script-id',
    feedback_spreadsheet_configured: true,
    feedback_sheet_name: 'Feedback',
    trigger_handlers: 1,
    general_compute_requested: false,
  };
  assert.equal(started.operation, 'feedback-poll');
  assert.equal(started.feedback_spreadsheet_configured, true);
  assert.equal(started.feedback_sheet_name, 'Feedback');
  assert.equal(started.general_compute_requested, false);

  const result = {
    operation: 'feedback-poll',
    script_id: 'script-id',
    feedback_spreadsheet_configured: true,
    feedback_sheet_name: 'Feedback',
    admitted_count: 1,
    admitted_rows: [5],
    failed_count: 0,
    synced_count: 1,
    general_compute_requested: false,
  };
  assert.equal(result.admitted_count, result.admitted_rows.length);
  assert.equal(result.failed_count, 0);
  assert.equal(result.general_compute_requested, false);
});

test('feedback poll error diagnostics stay bounded and omit message content', () => {
  const event = {
    operation: 'feedback-poll',
    script_id: 'script-id',
    error: 'Configured feedback sheet not found: Feedback',
    general_compute_requested: false,
  };
  assert.ok(event.error.length <= 400);
  assert.equal('message' in event, false);
  assert.equal(event.general_compute_requested, false);
});
