import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sql = await readFile(new URL('../migrations/017_work_unit_convergence_immutability.sql', import.meta.url), 'utf8');

test('convergence hardening migration protects identity and intent fields', () => {
  assert.match(sql, /work_unit_id IS DISTINCT FROM OLD\.work_unit_id/);
  assert.match(sql, /intended_outcome IS DISTINCT FROM OLD\.intended_outcome/);
  assert.match(sql, /intent_digest IS DISTINCT FROM OLD\.intent_digest/);
  assert.match(sql, /pull_request_id IS DISTINCT FROM OLD\.pull_request_id/);
  assert.match(sql, /head_sha IS DISTINCT FROM OLD\.head_sha/);
});

test('convergence hardening migration makes checks and merges append-only', () => {
  assert.match(sql, /federation_convergence_checks_append_only BEFORE UPDATE OR DELETE/);
  assert.match(sql, /federation_convergence_merges_append_only BEFORE UPDATE OR DELETE/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.federation_convergence_merges/);
  assert.match(sql, /federation_convergence_checks_intent_digest_fk/);
});

test('convergence hardening binds work-unit project to federation authority', () => {
  assert.match(sql, /federation_work_units_project_fk/);
  assert.match(sql, /REFERENCES public\.federation_work_orders\(work_order_id, project\)/);
});
