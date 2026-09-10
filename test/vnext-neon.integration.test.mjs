import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { migrate } from '../lib/migration.mjs';
import { createWorkUnit } from '../lib/vnext/kernel.mjs';
import { createNeonStore } from '../lib/vnext/neon-store.mjs';
import { runOuterLoop } from '../lib/vnext/outer-loop.mjs';

const connectionString = process.env.TEST_DATABASE_URL;

test('vNext survives disposable executions through durable Neon state', { skip: !connectionString, timeout: 60000 }, async () => {
  const pool = new Pool({ connectionString, max: 5 });
  const store = createNeonStore({ pool });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const workUnitId = `wu-neon-${suffix}`;
  const objectiveRef = `objective-neon-${suffix}`;

  try {
    await migrate({ pool, directory: path.join(import.meta.dirname, '..', 'migrations') });
    await store.saveWorkUnit(createWorkUnit({ workUnitId, objectiveRef }));

    const executions = [];
    const first = await runOuterLoop({
      wake: { type: 'feedback.received', event_id: `feedback-${suffix}`, work_unit_id: workUnitId },
      store,
      executor: async ({ execution }) => {
        executions.push(execution.execution_id);
        return {
          objective_id: objectiveRef,
          disposition: 'waiting',
          summary: 'Durable state now waits for an external change.',
          continuation: { mode: 'condition', condition: { kind: 'external', condition: 'A new result is available.' } },
        };
      },
    });
    assert.equal(first.disposition, 'waiting');

    const persisted = await store.reconstruct({ work_unit_id: workUnitId });
    assert.equal(persisted.state, 'waiting');
    assert.equal(persisted.claim, null);
    assert.equal(persisted.fence, 1);

    const second = await runOuterLoop({
      wake: { type: 'external.changed', event_id: `external-${suffix}`, work_unit_id: workUnitId },
      store,
      isJustified: async ({ workUnit }) => workUnit.state === 'waiting',
      executor: async ({ execution }) => {
        executions.push(execution.execution_id);
        return {
          objective_id: objectiveRef,
          disposition: 'done',
          summary: 'The persisted objective has reached its terminal outcome.',
          outcome_evidence: [{ kind: 'manifest', execution_id: executions[0] }],
        };
      },
      authorizeTerminal: () => true,
    });

    assert.equal(second.disposition, 'terminal');
    assert.equal(executions.length, 2);
    assert.notEqual(executions[0], executions[1]);

    const finalWork = await store.reconstruct({ work_unit_id: workUnitId });
    assert.equal(finalWork.state, 'terminal');
    assert.equal(finalWork.claim, null);
    assert.equal(finalWork.fence, 2);
    assert.equal(finalWork.last_execution_id, executions[1]);

    const rows = await pool.query('SELECT execution_id,state,fence FROM vnext_executions WHERE work_unit_id=$1 ORDER BY fence', [workUnitId]);
    assert.deepEqual(rows.rows, [
      { execution_id: executions[0], state: 'succeeded', fence: '1' },
      { execution_id: executions[1], state: 'succeeded', fence: '2' },
    ]);
  } finally {
    await pool.query('DELETE FROM vnext_evidence_refs WHERE work_unit_id=$1', [workUnitId]).catch(() => {});
    await pool.query('DELETE FROM vnext_continuations WHERE work_unit_id=$1', [workUnitId]).catch(() => {});
    await pool.query('DELETE FROM vnext_executions WHERE work_unit_id=$1', [workUnitId]).catch(() => {});
    await pool.query('DELETE FROM vnext_work_units WHERE work_unit_id=$1', [workUnitId]).catch(() => {});
    await pool.end();
  }
});
