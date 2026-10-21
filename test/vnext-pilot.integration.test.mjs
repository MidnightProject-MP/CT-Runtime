import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { testPool } from './pilot-test-pool.mjs';
import { migrateVNext } from '../lib/vnext/migration.mjs';
import { createPilotStore } from '../lib/vnext/pilot-store.mjs';
import { runPilotOnce } from '../lib/vnext/pilot.mjs';
import { testAcceptanceAuthority } from './vnext-test-acceptance.mjs';
import { verifyTurnEvidenceIntegrity } from '../lib/objective-turn.mjs';
import { digest } from '../lib/vnext/operating-boundary.mjs';

const authority = {
  authorizeExecution: async ({execution}) => ({ref:`test:${execution.execution_id}`}),
  verifyExecution: async (d,{execution}) => d.ref === `test:${execution.execution_id}`,
  authorizeTerminal: async () => ({ ref: "acceptance:pilot-test-accepter" }),
};
const next = objective_id => ({objective_id,disposition:'continue',summary:'Verified one useful change.',learned:'Keep the useful observation.',continuation:{mode:'immediate',next_action:'Check next consequence.'}});

test('pilot durable input, fresh wakes, evidence, waits, rollback, and uncertainty', {timeout:60000}, async t => {
  const pool = await testPool();
  const dir = await mkdtemp(path.join(tmpdir(),'pilot-'));
  await writeFile(path.join(dir,'identity.md'),'Celestan: reconstruct, do, check, persist.');
  await pool.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anonymous') THEN CREATE ROLE anonymous; END IF; END $$");
  await migrateVNext({pool,directory:path.join(import.meta.dirname,'../vnext-migrations')});
   const acceptance = testAcceptanceAuthority(async c => { await verifyTurnEvidenceIntegrity(c.turn, { workspaceRoot: dir }); return c.turn.summary === 'Outcome checked.'; });
   const operatingAuthority = { ...authority, ...acceptance };
   const store = () => createPilotStore({pool,authorizationVerifier:authority.verifyExecution,acceptanceVerifier:acceptance.verifyAcceptance,intervalMs:1000});
  const projectId = `pilot-test-${randomUUID()}`;
  let n=0;
  const input = (s,thread,message='Improve one concrete thing.') => s.submit({projectId,threadId:thread,receiptId:`receipt-${++n}`,message});
   const run = (s,executor) => runPilotOnce({store:s,projectId,workspaceRoot:dir,identityFiles:[path.join(dir,'identity.md')],authority:operatingAuthority,executor});
  try {
    await t.test('idempotent receipt and conflicting content', async () => {
      const s=store();const args={projectId,threadId:'first',receiptId:'fixed-'+projectId,message:'Improve it.'};
      const a=await s.submit(args);assert.equal((await s.submit(args)).created,false);
      await assert.rejects(s.submit({...args,message:'Changed'}),/conflict/);
      assert.equal((await s.status(projectId)).length,1);
      const result=await run(s,async ({workUnit,identity})=>{assert.match(identity[0].text,/Celestan/);return next(workUnit.objective_ref);});
      assert.equal(result.disposition,'continue');
      const saved=await pool.query('SELECT * FROM vnext_pilot_results WHERE execution_id=$1',[result.execution_id]);
      assert.equal(saved.rows[0].turn.learned,'Keep the useful observation.');
      assert.equal(await store().nextEligible(projectId),null);
      await pool.query("UPDATE vnext_pilot_progress SET next_wake_at='2000-01-01T00:00:00Z' WHERE work_unit_id=$1",[a.work_unit_id]);
      await writeFile(path.join(dir,'proof.txt'),'verified result');
      const hash=createHash('sha256').update('verified result').digest('hex');
      const terminal=await run(store(),async ({workUnit})=>{assert.equal(workUnit.last_turn.learned,'Keep the useful observation.');return {objective_id:workUnit.objective_ref,disposition:'done',summary:'Outcome checked.',outcome_evidence:[{kind:'file',path:'proof.txt',sha256:hash}]};});
      assert.equal(terminal.disposition,'terminal');assert.notEqual(terminal.execution_id,result.execution_id);
      assert.equal(await store().nextEligible(projectId),null);
    });
    await t.test('waiting resumes on new human input without losing input arriving during execution', async()=>{
      const s=store();const a=await input(s,'waiting');
      await run(s,async ({workUnit})=>({objective_id:workUnit.objective_ref,disposition:'waiting',summary:'Need a choice.',question:'Which behavior?',continuation:{mode:'condition',condition:{kind:'human',condition:'Human replies.'}}}));
      assert.equal(await s.nextEligible(projectId),null);
      await input(s,'waiting','Use the existing behavior.');
      await run(store(),async ({workUnit})=>{await input(store(),'waiting','Also preserve accessibility.');return next(workUnit.objective_ref);});
      assert.equal(await store().nextEligible(projectId),a.work_unit_id);
      await run(store(),async ({workUnit})=>({objective_id:workUnit.objective_ref,disposition:'waiting',summary:'Waiting for test fixture.',continuation:{mode:'condition',condition:{kind:'external',condition:'Fixture arrives.'}}}));
    });
    await t.test('new input during completion remains eligible', async()=>{
      const s=store();const a=await input(s,'completion-reply');
      const hash=createHash('sha256').update('verified result').digest('hex');
      await run(s,async ({workUnit})=>{await input(s,'completion-reply','Check one more consequence.');return {objective_id:workUnit.objective_ref,disposition:'done',summary:'Original goal checked.',outcome_evidence:[{kind:'file',path:'proof.txt',sha256:hash}]};});
      assert.equal(await store().nextEligible(projectId),a.work_unit_id);
      await run(store(),async ({workUnit})=>({objective_id:workUnit.objective_ref,disposition:'waiting',summary:'Follow-up read; waiting for fixture.',continuation:{mode:'condition',condition:{kind:'external',condition:'Fixture arrives.'}}}));
    });
    await t.test('failed result settlement rolls back result and eligibility together, no retry of uncertain effects',async()=>{
      const s=store();const a=await input(s,'rollback');
      const broken={...s,persistTurn:async result=>{result.handoff.runtime.input_seq=-1;return s.persistTurn(result);}};
      await assert.rejects(run(broken,async ({workUnit})=>next(workUnit.objective_ref)));
      const row=await s.reconstruct({work_unit_id:a.work_unit_id});assert.ok(row.claim);
      assert.equal((await pool.query('SELECT * FROM vnext_pilot_results WHERE work_unit_id=$1',[a.work_unit_id])).rowCount,0);
      assert.equal(await store().nextEligible(projectId),null);
      // Preserve this uncertain claim; it also blocks other objectives in the project.
      await input(s,'other');assert.equal(await s.nextEligible(projectId),null);
    });
  } finally { await pool.end();await rm(dir,{recursive:true,force:true}); }
});

test('purpose-bound stewardship, independent review, requested changes, and authorized acceptance', { timeout: 60000 }, async () => {
  const pool = await testPool();
  const dir = await mkdtemp(path.join(tmpdir(), 'pilot-assignments-'));
  const projectId = `pilot-assignments-${randomUUID()}`;
  const profiles = {
    execution: { model: 'exec-model', agent: 'builder', access_class: 'bounded-mutation', permissions: ['project:write'] },
    review: { model: 'review-model', agent: 'independent-reviewer', access_class: 'read-only', permissions: ['project:read'] },
    diagnosis: { model: 'diagnosis-model', agent: 'diagnostician', access_class: 'read-only', permissions: ['project:read'] },
    stewardship: { model: 'stewardship-model', agent: 'steward', access_class: 'read-only', permissions: ['project:read'] },
  };
  const proof = 'purpose-bound completion evidence';
  const proofHash = createHash('sha256').update(proof).digest('hex');
  await writeFile(path.join(dir, 'identity.md'), 'Celestan owns objective judgment; Runtime enforces assignment and evidence boundaries.');
  await writeFile(path.join(dir, 'proof.txt'), proof);
  await pool.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anonymous') THEN CREATE ROLE anonymous; END IF; END $$");
  await migrateVNext({ pool, directory: path.join(import.meta.dirname, '../vnext-migrations') });
  const acceptance = testAcceptanceAuthority(async context => {
    await verifyTurnEvidenceIntegrity(context.turn, { workspaceRoot: dir });
    return context.turn.summary === 'Outcome checked.';
  });
  const decisionCalls = new Map();
  const testAuthority = {
    ...authority,
    ...acceptance,
    async authorizeAssignmentDecision({ assignment, report }) {
      const count = (decisionCalls.get(assignment.purpose) ?? 0) + 1;
      decisionCalls.set(assignment.purpose, count);
      const outcome = assignment.purpose === 'stewardship' ? 'propose'
        : count === 1 ? 'request_changes' : 'recommend_accept';
      return { ref: `celestan:${assignment.assignment_id}:${count}`, outcome,
        assignment_id: assignment.assignment_id, assignment_digest: assignment.assignment_digest,
        report_digest: digest(report), subject_digest: assignment.subject_digest };
    },
  };
  const store = createPilotStore({ pool, authorizationVerifier: authority.verifyExecution,
    acceptanceVerifier: acceptance.verifyAcceptance, assignmentDecisionVerifier: async () => true, intervalMs: 1000 });
  const run = executor => runPilotOnce({ store, projectId, workspaceRoot: dir, identityFiles: [path.join(dir, 'identity.md')],
    authority: testAuthority, assignmentProfiles: profiles, executor });
  try {
    const submitted = await store.submit({ projectId, threadId: 'workflow', receiptId: `input-${randomUUID()}`, message: 'Improve and verify the objective.' });
    const stewardship = await run(async ({ assignment }) => {
      assert.equal(assignment.purpose, 'stewardship');
      assert.equal(assignment.access_class, 'read-only');
      return { proposal: 'Complete the objective and verify the resulting artifact.' };
    });
    assert.equal(stewardship.disposition, 'assignment-reported');
    assert.equal((await run(async () => { throw new Error('decision-only pass must not dispatch'); })).disposition, 'assignment-decided');
    assert.equal((await run(async ({ assignment }) => {
      assert.equal(assignment.purpose, 'execution');
      return { objective_id: submitted.work_unit_id, disposition: 'done', summary: 'Outcome checked.',
        outcome_evidence: [{ kind: 'file', path: 'proof.txt', sha256: proofHash }] };
    })).disposition, 'needs-review', 'execution completion must not accept before independent review');
    const prematureContext = await store.getAcceptanceContext(submitted.work_unit_id);
    await assert.rejects(store.acceptWork(submitted.work_unit_id, { ref: 'premature-acceptance', snapshotDigest: prematureContext.snapshotDigest }), /independent review recommendation/);

    const firstReview = await run(async ({ assignment }) => {
      assert.equal(assignment.purpose, 'review');
      assert.equal(assignment.agent, 'independent-reviewer');
      return { outcome: 'request_changes', summary: 'The evidence is valid, but a further consequence needs checking.',
        requested_changes: 'Check the follow-up consequence and retain the evidence.' };
    });
    assert.equal(firstReview.disposition, 'assignment-reported');
    const afterReview = await store.reconstruct({ work_unit_id: submitted.work_unit_id });
    const firstDecision = await store.pendingAssignment(projectId, firstReview.assignment_id);
    const requested = await testAuthority.authorizeAssignmentDecision({ ...firstDecision, assignment: firstDecision.assignment, report: firstDecision.report });
    assert.equal(requested.outcome, 'request_changes');
    await store.recordAssignmentDecision({ ...firstDecision, decision: requested });
    assert.equal((await store.reconstruct({ work_unit_id: submitted.work_unit_id })).work_revision, afterReview.work_revision,
      'routine reviewer feedback is handled without a new objective revision');

    const stewardshipFollowup = await run(async ({ assignment }) => {
      assert.equal(assignment.purpose, 'stewardship');
      return { proposal: 'Check the requested follow-up consequence before final completion.' };
    });
    assert.equal(stewardshipFollowup.disposition, 'assignment-reported');
    assert.equal((await run(async () => { throw new Error('decision-only pass must not dispatch'); })).disposition, 'assignment-decided');
    const secondExecution = await run(async ({ assignment }) => {
      assert.equal(assignment.purpose, 'execution');
      return { objective_id: submitted.work_unit_id, disposition: 'done', summary: 'Outcome checked.',
        outcome_evidence: [{ kind: 'file', path: 'proof.txt', sha256: proofHash }] };
    });
    assert.equal(secondExecution.disposition, 'needs-review');
    const secondReview = await run(async ({ assignment }) => {
      assert.equal(assignment.purpose, 'review');
      return { outcome: 'recommend_accept', summary: 'The revised result meets the bound objective and evidence requirement.' };
    });
    assert.equal(secondReview.disposition, 'assignment-reported');
    assert.equal((await run(async () => { throw new Error('decision-only pass must not dispatch'); })).disposition, 'assignment-decided');
    assert.equal((await run(async () => { throw new Error('accepted work must not dispatch'); })).disposition, 'terminal');
    const ledger = await store.coordinatorLedger(projectId);
    assert.equal(ledger.works.find(work => work.work_unit_id === submitted.work_unit_id).state, 'terminal');
    assert.equal(ledger.assignments.filter(row => row.work_unit_id === submitted.work_unit_id && row.purpose === 'review').length, 2);
    assert.equal(await store.nextEligible(projectId), null);

    const late = await store.submit({ projectId, threadId: 'late-review-input', receiptId: `input-${randomUUID()}`, message: 'A new instruction arrived.' });
    const lateReport = await run(async ({ assignment }) => {
      assert.equal(assignment.purpose, 'stewardship');
      return { proposal: 'Inspect the newly arrived instruction.' };
    });
    const lateAssignment = await store.pendingAssignment(projectId, lateReport.assignment_id);
    assert.ok(lateAssignment);
    await store.submit({ projectId, threadId: 'late-review-input', receiptId: `input-${randomUUID()}`, message: 'Replace the earlier instruction with this one.' });
    const staleRow = await pool.query('SELECT status FROM vnext_assignments WHERE assignment_id=$1', [lateReport.assignment_id]);
    assert.equal(staleRow.rows[0].status, 'superseded', 'new input invalidates an outstanding assignment report');
    assert.equal(await store.pendingAssignment(projectId, lateReport.assignment_id), null);
    const refreshed = await store.planNext(projectId, profiles);
    assert.equal(refreshed.assignment.purpose, 'stewardship');
    assert.equal(refreshed.assignment.input_seq, late.input_seq + 1);
    await assert.rejects(pool.query('UPDATE vnext_assignments SET agent=\'forged\' WHERE assignment_id=$1', [refreshed.assignment.assignment_id]), /identity is immutable/);
  } finally {
    await pool.end();
    await rm(dir, { recursive: true, force: true });
  }
});

test('pilot due-time discovery keeps database time unless a coordinator clock is supplied', async () => {
  const pool = await testPool();
  const project = `pilot-clock-${randomUUID()}`;
  try {
    await pool.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anonymous') THEN CREATE ROLE anonymous; END IF; END $$");
    await migrateVNext({ pool, directory: path.join(import.meta.dirname, '../vnext-migrations') });
    const store = (options = {}) => createPilotStore({ pool, intervalMs: 1000, ...options });
    const { work_unit_id: id } = await store().submit({ projectId: project, threadId: 'clock', receiptId: `receipt-${randomUUID()}`, message: 'Clock semantics.' });
    assert.equal(await store().nextEligible(project), id, 'a fresh submit is due on the database clock');
    await pool.query("UPDATE vnext_pilot_progress SET consumed_input_seq=(SELECT COALESCE(max(input_seq),0) FROM vnext_pilot_inputs WHERE work_unit_id=$1) WHERE work_unit_id=$1", [id]);
    await pool.query("UPDATE vnext_pilot_progress SET next_wake_at=clock_timestamp()+interval '10 minutes' WHERE work_unit_id=$1", [id]);
    assert.equal(await store().nextEligible(project), null, 'default discovery uses the database clock');
    assert.equal(await store({ now: () => Date.now() + 20 * 60 * 1000 }).nextEligible(project), id, 'an explicit clock can observe a database-future due time');
    await pool.query("UPDATE vnext_pilot_progress SET next_wake_at=clock_timestamp()-interval '10 minutes' WHERE work_unit_id=$1", [id]);
    assert.equal(await store().nextEligible(project), id, 'default discovery sees a database-past due time');
    assert.equal(await store({ now: () => Date.now() - 20 * 60 * 1000 }).nextEligible(project), null, 'an explicit clock can hold a database-past due time');
  } finally { await pool.end(); }
});
