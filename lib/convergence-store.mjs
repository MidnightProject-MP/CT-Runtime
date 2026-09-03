import { canonicalJson } from './config.mjs';
import { canonicalizeMergedCommit, normalizeCheckResult, normalizeConvergenceSubject, normalizeWorkUnit } from './convergence.mjs';

const row = (result) => result.rows[0];
const conflict = (message, category = 'conflict') => Object.assign(new Error(message), { category });
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const tx = async (pool, fn) => { const client = await pool.connect(); try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; } catch (error) { await client.query('ROLLBACK').catch(() => {}); if (error.code === '23505') error.category = 'conflict'; throw error; } finally { client.release(); } };

export class PostgresConvergenceAdapter {
  constructor({ pool } = {}) { if (!pool) throw new Error('Postgres pool is required'); this.pool = pool; this.available = true; }

  async createWorkUnit(input) {
    const value = normalizeWorkUnit(input);
    return tx(this.pool, async (client) => {
      const inserted = await client.query(`INSERT INTO federation_work_units(work_unit_id,work_order_id,project,intended_outcome,invariants,branch,base_commit,evidence_requirements,intent_digest) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8::jsonb,$9) ON CONFLICT (work_unit_id) DO NOTHING RETURNING *`, [value.workUnitId, value.workOrderId, value.project, JSON.stringify(value.intendedOutcome), JSON.stringify(value.invariants), value.branch, value.baseCommit, JSON.stringify(value.evidenceRequirements), value.intentDigest]);
      const current = row(inserted) || row(await client.query('SELECT * FROM federation_work_units WHERE work_unit_id=$1 FOR SHARE', [value.workUnitId]));
      if (!current) throw new Error('work unit was not created');
      const expected = { workOrderId: value.workOrderId, project: value.project, intendedOutcome: value.intendedOutcome, invariants: value.invariants, branch: value.branch, baseCommit: value.baseCommit, evidenceRequirements: value.evidenceRequirements, intentDigest: value.intentDigest };
      const actual = { workOrderId: current.work_order_id, project: current.project, intendedOutcome: current.intended_outcome, invariants: current.invariants, branch: current.branch, baseCommit: current.base_commit, evidenceRequirements: current.evidence_requirements, intentDigest: current.intent_digest };
      if (!same(actual, expected)) throw conflict('work unit identity conflict');
      return { created: Boolean(row(inserted)), workUnit: value };
    });
  }

  async bindSubject(input) {
    const value = normalizeConvergenceSubject(input);
    const subjectId = input.subjectId == null ? `${value.workUnitId}:${value.pullRequestId}:${value.headSha}` : input.subjectId;
    if (typeof subjectId !== 'string' || !subjectId.trim() || subjectId.length > 500 || /[\0\r\n]/.test(subjectId)) throw new Error('subjectId must be a bounded safe string');
    return tx(this.pool, async (client) => {
      const inserted = await client.query(`INSERT INTO federation_convergence_subjects(subject_id,work_unit_id,pull_request_id,head_sha,base_sha,branch) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING *`, [subjectId, value.workUnitId, value.pullRequestId, value.headSha, value.baseSha, value.branch]);
      const current = row(inserted) || row(await client.query('SELECT * FROM federation_convergence_subjects WHERE subject_id=$1 FOR SHARE', [subjectId]));
      const expected = { subjectId, workUnitId: value.workUnitId, pullRequestId: value.pullRequestId, headSha: value.headSha, baseSha: value.baseSha, branch: value.branch };
      const actual = current ? { subjectId: current.subject_id, workUnitId: current.work_unit_id, pullRequestId: current.pull_request_id, headSha: current.head_sha, baseSha: current.base_sha, branch: current.branch } : null;
      if (!current || !same(actual, expected)) throw conflict('convergence subject identity conflict');
      return { created: Boolean(row(inserted)), subject: { ...value, subjectId } };
    });
  }

  async recordCheck(input, workUnit, subject) {
    const value = normalizeCheckResult(input, workUnit, subject);
    return tx(this.pool, async (client) => {
      const inserted = await client.query(`INSERT INTO federation_convergence_checks(check_id,work_unit_id,pull_request_id,head_sha,check_name,implementation_version,intent_digest,result,evidence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT (work_unit_id,pull_request_id,head_sha,check_name,implementation_version) DO NOTHING RETURNING *`, [value.checkId, value.workUnitId, value.pullRequestId, value.headSha, value.checkName, value.implementationVersion, value.intentDigest, value.result, JSON.stringify(value.evidence)]);
      const current = row(inserted) || row(await client.query('SELECT * FROM federation_convergence_checks WHERE work_unit_id=$1 AND pull_request_id=$2 AND head_sha=$3 AND check_name=$4 AND implementation_version=$5 FOR SHARE', [value.workUnitId, value.pullRequestId, value.headSha, value.checkName, value.implementationVersion]));
      if (!current || current.check_id !== value.checkId || !same(current.evidence, value.evidence) || current.result !== value.result) throw conflict('convergence check identity conflict');
      return { created: Boolean(row(inserted)), check: value };
    });
  }

  async recordMerge(input, workUnit, subject) {
    const unit = normalizeWorkUnit(workUnit), pr = normalizeConvergenceSubject(subject);
    if (unit.workUnitId !== pr.workUnitId) throw conflict('merge work unit binding conflict');
    if (input.workUnitId !== undefined && input.workUnitId !== unit.workUnitId) throw conflict('merge work unit binding conflict');
    if (input.pullRequestId !== undefined && String(input.pullRequestId) !== pr.pullRequestId) throw conflict('merge pull request binding conflict');
    if (input.sourceHeadSha !== undefined && input.sourceHeadSha !== pr.headSha) throw conflict('merge source head binding conflict');
    const merged = canonicalizeMergedCommit(pr, input.mergedCommitSha);
    const value = { mergeId: input.mergeId, workUnitId: unit.workUnitId, pullRequestId: pr.pullRequestId, sourceHeadSha: merged.sourceHeadSha, mergedCommitSha: merged.mergedCommitSha, intentDigest: unit.intentDigest };
    if (typeof value.mergeId !== 'string' || !value.mergeId.trim() || value.mergeId.length > 500 || /[\0\r\n]/.test(value.mergeId)) throw new Error('mergeId must be a bounded safe string');
    return tx(this.pool, async (client) => {
      const inserted = await client.query(`INSERT INTO federation_convergence_merges(merge_id,work_unit_id,pull_request_id,source_head_sha,merged_commit_sha,intent_digest) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (work_unit_id,pull_request_id,source_head_sha) DO NOTHING RETURNING *`, [value.mergeId, value.workUnitId, value.pullRequestId, value.sourceHeadSha, value.mergedCommitSha, value.intentDigest]);
      const current = row(inserted) || row(await client.query('SELECT * FROM federation_convergence_merges WHERE work_unit_id=$1 AND pull_request_id=$2 AND source_head_sha=$3 FOR SHARE', [value.workUnitId, value.pullRequestId, value.sourceHeadSha]));
      if (!current || current.merge_id !== value.mergeId || current.merged_commit_sha !== value.mergedCommitSha || current.intent_digest !== value.intentDigest) throw conflict('merge recording conflict');
      return { created: Boolean(row(inserted)), merge: value };
    });
  }
}
