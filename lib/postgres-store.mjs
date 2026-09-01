import crypto from 'node:crypto';
import { Pool } from 'pg';
import { canonicalJson, runtimeMetadata, sha256, validateModelPolicy } from './config.mjs';
import { validateNextWake, validateTopology } from './runtime.mjs';

const CLAIM_TTL_MS = 300000;
const row = (result) => result.rows[0];
const timestamp = (value) => value?.toISOString?.() || value;
const fenceError = () => Object.assign(new Error('lost fencing ownership'), { category: 'ownership-lost' });
const conflictError = (kind) => Object.assign(new Error(`${kind} immutable identity conflict`), { category: 'conflict' });
const equal = (left, right) => canonicalJson(left) === canonicalJson(right);

export class PostgresStore {
  constructor({ connectionString, config, pool, evidenceStore } = {}) {
    if (!connectionString && !pool) throw new Error('Postgres connection string is required');
    this.pool = pool || new Pool({ connectionString, max: 10, application_name: 'ct-runtime-v2' });
    this.config = config || {};
    this.evidenceStore = evidenceStore;
  }

  async init() { await this.pool.query('SELECT 1'); }
  async close() { await this.pool.end(); }

  async transaction(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async manifest(executionId) {
    const value = row(await this.pool.query('SELECT * FROM runtime_executions WHERE execution_id=$1', [executionId]));
    if (!value) throw new Error('execution not found');
    return fromExecution(value);
  }

  async manifestsAll() {
    const result = await this.pool.query('SELECT * FROM runtime_executions ORDER BY execution_id');
    return result.rows.map(fromExecution);
  }

  async createManifest(input) {
    validateModelPolicy(input.model, this.config);
    const executionId = input.executionId || `run-${crypto.randomUUID()}`;
    const suppliedTopology = input.topology || { rootId: executionId, childIds: [] };
    const topology = validateTopology(suppliedTopology, executionId);
    return this.transaction(async (client) => {
      if (topology.rootId !== executionId) {
        const root = row(await client.query('SELECT execution_id,parent_execution_id FROM runtime_executions WHERE execution_id=$1 FOR SHARE', [topology.rootId]));
        if (!root || root.parent_execution_id) throw new Error('topology root does not exist or is not a root');
      }
      if (topology.parentId) {
        const parent = row(await client.query('SELECT root_execution_id,parent_execution_id FROM runtime_executions WHERE execution_id=$1 FOR SHARE', [topology.parentId]));
        if (!parent) throw new Error('topology parent does not exist');
        if (parent.root_execution_id !== topology.rootId) throw new Error('topology root mismatch');
        let cursor = topology.parentId;
        const seen = new Set([executionId]);
        while (cursor) {
          if (seen.has(cursor)) throw new Error('topology cycle detected');
          seen.add(cursor);
          cursor = row(await client.query('SELECT parent_execution_id FROM runtime_executions WHERE execution_id=$1', [cursor]))?.parent_execution_id;
        }
      }

      if (input.workOrder) {
        if (input.launch !== undefined) await ensureWorkOrder(client, input.workOrder, input.project, input.launch, input.deploymentId || null);
        else {
          const workOrder = row(await client.query('SELECT * FROM runtime_work_orders WHERE work_order=$1 FOR SHARE', [input.workOrder]));
          if (!workOrder) await ensureWorkOrder(client, input.workOrder, input.project, {}, input.deploymentId || null);
          else if (workOrder.project !== input.project || workOrder.deployment_id !== (input.deploymentId || null)) throw conflictError('work order');
        }
      }
      const metadata = definedObject(runtimeMetadata(this.config));
      const inserted = await client.query(`
        INSERT INTO runtime_executions
          (execution_id,project,work_order,task,model,agent,cwd,wake_reason,root_execution_id,parent_execution_id,status,created_at,topology,runtime_metadata,requested_next_wake)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'manifested',clock_timestamp(),$11,$12,$13)
        ON CONFLICT (execution_id) DO NOTHING RETURNING *`,
      [executionId, input.project, input.workOrder || null, input.task, input.model, input.agent, input.cwd || null, input.wake_reason || 'user', topology.rootId, topology.parentId, topology, metadata, validateNextWake(input.requested_next_wake)]);
      const current = row(inserted) || row(await client.query('SELECT * FROM runtime_executions WHERE execution_id=$1 FOR SHARE', [executionId]));
      const identity = {
        project: current.project, workOrder: current.work_order, task: current.task, model: current.model, agent: current.agent,
        cwd: current.cwd, wakeReason: current.wake_reason, rootId: current.root_execution_id, parentId: current.parent_execution_id,
        runtimeMetadata: current.runtime_metadata
      };
      const expected = {
        project: input.project, workOrder: input.workOrder || null, task: input.task, model: input.model, agent: input.agent,
        cwd: input.cwd || null, wakeReason: input.wake_reason || 'user', rootId: topology.rootId, parentId: topology.parentId,
        runtimeMetadata: metadata
      };
      if (!equal(identity, expected)) throw conflictError('execution');
      return { manifest: fromExecution(current), created: Boolean(row(inserted)) };
    });
  }

  async updateManifest(executionId, patch, lease) {
    return this.transaction(async (client) => {
      if (lease) await lockLease(client, executionId, lease);
      const current = row(await client.query('SELECT * FROM runtime_executions WHERE execution_id=$1 FOR UPDATE', [executionId]));
      if (!current) throw new Error('execution not found');
      const execution = patch.execution || {};
      const updated = row(await client.query(`
        UPDATE runtime_executions SET
          status=$1,started_at=$2,finished_at=$3,last_heartbeat_at=$4,failure=$5,result=$6,output=$7,
          model_runtime_telemetry=$8,requested_next_wake=$9,attempts=$10,recovery_attempts=$11,recovery=$12,version=version+1
        WHERE execution_id=$13 RETURNING *`, [
        execution.status ?? current.status, execution.startedAt ?? current.started_at, execution.finishedAt ?? current.finished_at,
        execution.lastHeartbeatAt ?? current.last_heartbeat_at, patch.failure ?? current.failure, patch.result ?? current.result,
        patch.output ?? current.output, patch.modelRuntimeTelemetry ?? current.model_runtime_telemetry,
        patch.requested_next_wake === undefined ? current.requested_next_wake : validateNextWake(patch.requested_next_wake),
        patch.attempts ?? current.attempts, patch.recoveryAttempts ?? current.recovery_attempts, patch.recovery ?? current.recovery, executionId
      ]));
      return fromExecution(updated);
    });
  }

  async event(type, fields = {}) {
    await this.pool.query('INSERT INTO runtime_events(event_id,execution_id,event_type,occurred_at,payload) VALUES ($1,$2,$3,clock_timestamp(),$4)',
      [`evt-${crypto.randomUUID()}`, fields.executionId || null, type, fields]);
  }

  async telemetry(fields = {}) {
    await this.pool.query('INSERT INTO runtime_model_telemetry(telemetry_id,execution_id,attempt,occurred_at,payload) VALUES ($1,$2,$3,clock_timestamp(),$4)',
      [`tel-${crypto.randomUUID()}`, fields.executionId, fields.attempt || null, fields]);
  }

  async hostTelemetry(fields = {}, context = {}) {
    const payload = { ...fields };
    delete payload.executionId; delete payload.deploymentId; delete payload.workOrder;
    await this.pool.query(`
      INSERT INTO runtime_host_telemetry(telemetry_id,execution_id,host_instance_id,deployment_id,work_order,occurred_at,availability,payload)
      VALUES ($1,$2,$3,$4,$5,clock_timestamp(),$6,$7)`, [
      `host-${crypto.randomUUID()}`, context.executionId || fields.executionId || null, fields.host?.instanceId || 'unavailable',
      context.deploymentId || fields.deploymentId || null, context.workOrder || fields.workOrder || null, fields.availability || 'unavailable', payload
    ]);
  }

  async modelTelemetryFor(executionId) {
    const result = await this.pool.query('SELECT payload FROM runtime_model_telemetry WHERE execution_id=$1 ORDER BY occurred_at,telemetry_id', [executionId]);
    return result.rows.map((item) => item.payload);
  }

  async hostTelemetryFor(executionId) {
    const result = await this.pool.query('SELECT payload FROM runtime_host_telemetry WHERE execution_id=$1 ORDER BY occurred_at,telemetry_id', [executionId]);
    return result.rows.map((item) => item.payload);
  }

  async evidenceFor(executionId) {
    const result = await this.pool.query('SELECT object_uri AS uri,sha256,label,byte_count AS bytes,truncated FROM runtime_evidence WHERE execution_id=$1 ORDER BY created_at,evidence_id', [executionId]);
    return result.rows.map((item) => ({ ...item, bytes: String(item.bytes) }));
  }

  async evidence(executionId, label, content, lease, attempt = 1) {
    if (!this.evidenceStore) throw new Error('S3 evidence store is not configured');
    const manifest = await this.manifest(executionId);
    const item = await this.evidenceStore.put({ project: manifest.execution.project, executionId, attempt, label, content });
    const reference = { uri: item.objectUri, sha256: item.sha256, label, bytes: String(item.bytes), truncated: item.truncated, orphan: false };
    try {
      await this.transaction(async (client) => {
        if (lease) await lockLease(client, executionId, lease);
        const existing = row(await client.query('SELECT * FROM runtime_evidence WHERE execution_id=$1 AND evidence_id=$2 FOR UPDATE', [executionId, item.evidenceId]));
        if (existing) {
          if (existing.sha256 !== item.sha256 || !bigintEqual(existing.byte_count, item.bytes) || existing.object_key !== item.objectKey || existing.label !== label) throw conflictError('evidence');
          return;
        }
        await client.query(`
          INSERT INTO runtime_evidence
            (execution_id,evidence_id,label,object_key,object_uri,sha256,byte_count,truncated,content_type,retention_class,created_at,metadata)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp(),$11)`,
        [executionId, item.evidenceId, label, item.objectKey, item.objectUri, item.sha256, String(item.bytes), item.truncated, item.contentType, item.retentionClass, item.metadata]);
      });
      return reference;
    } catch (error) {
      if (error.category !== 'ownership-lost') throw error;
      return { ...reference, orphan: true, objectKey: item.objectKey, evidenceId: item.evidenceId };
    }
  }

  async listEvidenceObjects(options = {}) {
    if (typeof this.evidenceStore?.list !== 'function') throw new Error('evidence store does not support object listing');
    return this.evidenceStore.list(options);
  }

  async reconcileEvidenceObjects(options = {}) {
    if (typeof this.evidenceStore?.reconcileOrphans !== 'function') throw new Error('evidence store does not support orphan reconciliation');
    const objects = await this.listEvidenceObjects(options);
    const references = (await this.pool.query('SELECT object_key,sha256,byte_count FROM runtime_evidence ORDER BY object_key')).rows
      .map((item) => ({ objectKey: item.object_key, sha256: item.sha256, bytes: String(item.byte_count) }));
    return this.evidenceStore.reconcileOrphans(references, { ...options, objects });
  }

  async registerDeployment(value) {
    await this.transaction(async (client) => {
      const inserted = row(await client.query(`
        INSERT INTO runtime_deployments(deployment_id,provider,runtime_class,region,architecture,image_digest,config_digest,git_repository,git_commit,metadata)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (deployment_id) DO NOTHING RETURNING *`,
      [value.deploymentId, value.provider, value.runtimeClass, value.region || null, value.architecture, value.imageDigest, value.configDigest, value.gitRepository || null, value.gitCommit || null, value.metadata || {}]));
      const current = inserted || row(await client.query('SELECT * FROM runtime_deployments WHERE deployment_id=$1 FOR SHARE', [value.deploymentId]));
      const actual = [current.provider, current.runtime_class, current.region, current.architecture, current.image_digest, current.config_digest, current.git_repository, current.git_commit, current.metadata];
      const expected = [value.provider, value.runtimeClass, value.region || null, value.architecture, value.imageDigest, value.configDigest, value.gitRepository || null, value.gitCommit || null, value.metadata || {}];
      if (!equal(actual, expected)) throw conflictError('deployment');
    });
  }

  async lease(executionId, owner = crypto.randomUUID(), ttlMs = 300000) {
    return this.transaction(async (client) => {
      const current = row(await client.query('SELECT * FROM runtime_leases WHERE execution_id=$1 FOR UPDATE', [executionId]));
      if (current && !current.released_at && new Date(current.expires_at).getTime() > Date.now()) {
        return { acquired: false, owner: current.owner, fence: String(current.fence), revision: String(current.revision), ttlMs };
      }
      const value = current
        ? row(await client.query(`UPDATE runtime_leases SET owner=$2,fence=fence+1,revision=revision+1,acquired_at=clock_timestamp(),heartbeat_at=clock_timestamp(),expires_at=clock_timestamp()+($3::bigint * interval '1 millisecond'),released_at=NULL WHERE execution_id=$1 RETURNING *`, [executionId, owner, ttlMs]))
        : row(await client.query(`INSERT INTO runtime_leases(execution_id,owner,fence,revision,acquired_at,heartbeat_at,expires_at) VALUES ($1,$2,1,1,clock_timestamp(),clock_timestamp(),clock_timestamp()+($3::bigint * interval '1 millisecond')) RETURNING *`, [executionId, owner, ttlMs]));
      return { acquired: true, owner: value.owner, fence: String(value.fence), revision: String(value.revision), ttlMs };
    });
  }

  async heartbeat(executionId, lease) {
    await this.transaction(async (client) => {
      await lockLease(client, executionId, lease);
      await client.query(`UPDATE runtime_leases SET heartbeat_at=clock_timestamp(),expires_at=clock_timestamp()+($1::bigint * interval '1 millisecond') WHERE execution_id=$2`, [lease.ttlMs, executionId]);
      await client.query('UPDATE runtime_executions SET last_heartbeat_at=clock_timestamp(),version=version+1 WHERE execution_id=$1', [executionId]);
    });
  }

  async release(executionId, lease) {
    await this.transaction(async (client) => {
      await lockLease(client, executionId, lease);
      await client.query('UPDATE runtime_leases SET released_at=clock_timestamp() WHERE execution_id=$1', [executionId]);
    });
  }

  async schedule(nextWake, launch = {}) {
    const wake = validateNextWake(nextWake);
    launch = definedObject(launch);
    validateModelPolicy(launch.model, this.config);
    const key = scheduleKey(wake, launch);
    const executionId = `run-${key.slice(0, 32)}`;
    const workOrder = `work-${key}`;
    return this.transaction(async (client) => {
      await ensureWorkOrder(client, workOrder, wake.project, launch, null);
      const inserted = row(await client.query(`
        INSERT INTO runtime_schedules(schedule_key,schedule_id,execution_id,work_order,project,wake_time,wake_reason,priority,launch,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()) ON CONFLICT (schedule_key) DO NOTHING RETURNING *`,
      [key, `wake-${crypto.randomUUID()}`, executionId, workOrder, wake.project, wake.time, wake.reason, wake.priority, launch]));
      const current = inserted || row(await client.query('SELECT * FROM runtime_schedules WHERE schedule_key=$1 FOR SHARE', [key]));
      assertSchedule(current, { key, executionId, workOrder, wake, launch });
      return { status: inserted ? 'scheduled' : 'duplicate', schedule: fromSchedule(current) };
    });
  }

  async claimSchedules(limit = 100, owner = crypto.randomUUID()) {
    const result = await this.pool.query(`
      WITH due AS (
        SELECT s.schedule_key
        FROM runtime_schedules s
        WHERE s.wake_time<=clock_timestamp()
          AND (s.state='pending' OR (s.state='claimed' AND s.claimed_at < clock_timestamp()-($3::bigint * interval '1 millisecond')))
          AND NOT EXISTS (
            SELECT 1 FROM runtime_leases l
            WHERE l.execution_id=s.execution_id AND l.released_at IS NULL AND l.expires_at>clock_timestamp()
          )
        ORDER BY s.wake_time,s.priority,s.schedule_key
        FOR UPDATE OF s SKIP LOCKED LIMIT $1
      )
      UPDATE runtime_schedules s SET
        state='claimed',claim_owner=$2,claim_fence=COALESCE(s.claim_fence,0)+1,claimed_at=clock_timestamp(),
        recovery_attempts=CASE WHEN s.state='claimed' THEN s.recovery_attempts+1 ELSE s.recovery_attempts END
      FROM due WHERE s.schedule_key=due.schedule_key RETURNING s.*`, [limit, owner, CLAIM_TTL_MS]);
    return result.rows.map(fromSchedule);
  }

  async touchSchedule(schedule) {
    const value = row(await this.pool.query(`
      UPDATE runtime_schedules SET claimed_at=clock_timestamp()
      WHERE schedule_key=$1 AND state='claimed' AND claim_owner=$2 AND claim_fence=$3 RETURNING *`,
    [schedule.scheduleKey || schedule.key, schedule.claimOwner, String(schedule.claimFence)]));
    if (!value) throw fenceError();
    return fromSchedule(value);
  }

  async completeSchedule(schedule, state = 'completed', claimOwner = schedule.claimOwner, claimFence = schedule.claimFence) {
    const value = row(await this.pool.query(`
      UPDATE runtime_schedules SET state=$1,finished_at=clock_timestamp()
      WHERE schedule_key=$2 AND state='claimed' AND claim_owner=$3 AND claim_fence=$4 RETURNING *`,
    [state, schedule.scheduleKey || schedule.key, claimOwner, String(claimFence)]));
    if (!value) throw fenceError();
    return fromSchedule(value);
  }

  async finalizeExecution(executionId, value, lease) {
    const wake = validateNextWake(value.requested_next_wake);
    const finishedAt = value.finishedAt || new Date().toISOString();
    const attempt = value.attempt;
    if (!Number.isInteger(attempt) || attempt < 1) throw new Error('final execution attempt must be a positive integer');
    return this.transaction(async (client) => {
      await lockLease(client, executionId, lease);
      const execution = row(await client.query('SELECT * FROM runtime_executions WHERE execution_id=$1 FOR UPDATE', [executionId]));
      if (!execution) throw new Error('execution not found');
      if (wake) await assertMonotonicWake(client, execution, wake);

      const attemptValue = {
        status: value.status, startedAt: value.startedAt || execution.started_at || finishedAt, finishedAt,
        failure: value.failure || null, processResult: value.processResult || null, output: value.output || null, result: value.result || null
      };
      const insertedAttempt = row(await client.query(`
        INSERT INTO runtime_attempts(execution_id,attempt,status,started_at,finished_at,failure,process_result,output,result)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (execution_id,attempt) DO NOTHING RETURNING *`,
      [executionId, attempt, attemptValue.status, attemptValue.startedAt, attemptValue.finishedAt, attemptValue.failure, attemptValue.processResult, attemptValue.output, attemptValue.result]));
      if (!insertedAttempt) {
        const currentAttempt = row(await client.query('SELECT * FROM runtime_attempts WHERE execution_id=$1 AND attempt=$2 FOR SHARE', [executionId, attempt]));
        const actual = { status: currentAttempt.status, startedAt: timestamp(currentAttempt.started_at), finishedAt: timestamp(currentAttempt.finished_at), failure: currentAttempt.failure, processResult: currentAttempt.process_result, output: currentAttempt.output, result: currentAttempt.result };
        const expected = { ...attemptValue, startedAt: timestamp(new Date(attemptValue.startedAt)), finishedAt: timestamp(new Date(attemptValue.finishedAt)) };
        if (!equal(actual, expected)) throw conflictError('attempt');
      }

      const updated = row(await client.query(`
        UPDATE runtime_executions SET
          status=$1,attempts=$2,started_at=COALESCE(started_at,$3),finished_at=$4,failure=$5,output=$6,result=$7,
          model_runtime_telemetry=$8,requested_next_wake=$9,version=version+1
        WHERE execution_id=$10 RETURNING *`, [
        value.status, attempt, value.startedAt || execution.started_at || finishedAt, finishedAt, value.failure || null,
        value.output || null, value.result || null, value.modelRuntimeTelemetry || null, wake, executionId
      ]));
      if (!updated) throw fenceError();
      await client.query('INSERT INTO runtime_events(event_id,execution_id,event_type,occurred_at,payload) VALUES ($1,$2,$3,clock_timestamp(),$4)',
        [`evt-${crypto.randomUUID()}`, executionId, value.event?.type || 'process_finished', value.event || { executionId, status: value.status, attempt }]);
      if (wake) await scheduleInTransaction(client, wake, value.launch || {});
      return fromExecution(updated);
    });
  }

  async recoverExecution(executionId, { staleMs = 300000, maxRecovery = 3 } = {}) {
    return this.transaction(async (client) => {
      const execution = row(await client.query('SELECT * FROM runtime_executions WHERE execution_id=$1 FOR UPDATE', [executionId]));
      if (!execution || !['manifested', 'requeued', 'retrying', 'running'].includes(execution.status)) return null;
      const last = new Date(execution.last_heartbeat_at || execution.started_at || execution.created_at).getTime();
      if (Number.isFinite(last) && Date.now() - last < staleMs) return null;
      const lease = row(await client.query('SELECT * FROM runtime_leases WHERE execution_id=$1 FOR UPDATE', [executionId]));
      if (lease && !lease.released_at && new Date(lease.expires_at).getTime() > Date.now()) return null;

      const recoveryAttempts = execution.recovery_attempts + 1;
      const requeued = recoveryAttempts <= maxRecovery;
      const attempt = execution.attempts + 1;
      const at = new Date().toISOString();
      const failure = { category: 'crash', retryable: requeued };
      const recovery = { status: requeued ? 'requeued' : 'bounded-abandonment', at, interruptedAttempt: attempt };
      const inserted = await client.query(`
        INSERT INTO runtime_attempts(execution_id,attempt,status,started_at,finished_at,failure,process_result,output,result)
        VALUES ($1,$2,'crashed',$3,$3,$4,NULL,NULL,NULL) ON CONFLICT (execution_id,attempt) DO NOTHING`,
      [executionId, attempt, execution.started_at || at, failure]);
      if (!inserted.rowCount) throw conflictError('recovery attempt');
      await client.query(`
        UPDATE runtime_executions SET status=$1,attempts=$2,recovery_attempts=$3,finished_at=$4,failure=$5,recovery=$6,version=version+1
        WHERE execution_id=$7`, [requeued ? 'requeued' : 'crashed', attempt, recoveryAttempts, at, failure, recovery, executionId]);
      await client.query('INSERT INTO runtime_events(event_id,execution_id,event_type,occurred_at,payload) VALUES ($1,$2,$3,clock_timestamp(),$4)',
        [`evt-${crypto.randomUUID()}`, executionId, 'recovered', { executionId, from: execution.status, requeued, attempt, recoveryAttempts }]);
      return { executionId, requeued, attempt, recoveryAttempts };
    });
  }

  async rebuildTopology() {
    await this.transaction(async (client) => {
      const rows = (await client.query('SELECT execution_id,root_execution_id,parent_execution_id FROM runtime_executions ORDER BY execution_id FOR UPDATE')).rows;
      const byId = new Map(rows.map((item) => [item.execution_id, item]));
      for (const item of rows) {
        if (!byId.has(item.root_execution_id)) throw new Error(`topology root does not exist: ${item.execution_id}`);
        const root = byId.get(item.root_execution_id);
        if (root.parent_execution_id || root.root_execution_id !== root.execution_id) throw new Error(`topology root is invalid: ${item.execution_id}`);
        if (item.parent_execution_id && !byId.has(item.parent_execution_id)) throw new Error(`topology parent does not exist: ${item.execution_id}`);
        if (item.parent_execution_id && byId.get(item.parent_execution_id).root_execution_id !== item.root_execution_id) throw new Error(`topology crosses roots: ${item.execution_id}`);
        let cursor = item.parent_execution_id;
        const seen = new Set([item.execution_id]);
        while (cursor) {
          if (seen.has(cursor)) throw new Error(`topology cycle detected: ${item.execution_id}`);
          seen.add(cursor);
          cursor = byId.get(cursor)?.parent_execution_id;
        }
      }
      for (const item of rows) {
        const children = rows.filter((child) => child.parent_execution_id === item.execution_id).map((child) => child.execution_id).sort();
        await client.query('UPDATE runtime_executions SET topology=$1 WHERE execution_id=$2',
          [{ rootId: item.root_execution_id, parentId: item.parent_execution_id, childIds: children }, item.execution_id]);
      }
    });
  }
}

async function lockLease(client, executionId, lease) {
  if (!lease) throw fenceError();
  const current = row(await client.query('SELECT * FROM runtime_leases WHERE execution_id=$1 FOR UPDATE', [executionId]));
  if (!current || current.owner !== lease.owner || String(current.fence) !== String(lease.fence) || current.released_at || new Date(current.expires_at).getTime() <= Date.now()) throw fenceError();
  return current;
}

async function ensureWorkOrder(client, workOrder, project, launch, deploymentId) {
  const inserted = row(await client.query(`
    INSERT INTO runtime_work_orders(work_order,deployment_id,project,launch) VALUES ($1,$2,$3,$4)
    ON CONFLICT (work_order) DO NOTHING RETURNING *`, [workOrder, deploymentId, project, launch]));
  const current = inserted || row(await client.query('SELECT * FROM runtime_work_orders WHERE work_order=$1 FOR SHARE', [workOrder]));
  if (!equal([current.deployment_id, current.project, current.launch], [deploymentId, project, launch])) throw conflictError('work order');
  return current;
}

function scheduleKey(wake, launch) { return sha256({ wake, launch }); }

function assertSchedule(current, expected) {
  const actual = {
    key: current.schedule_key, executionId: current.execution_id, workOrder: current.work_order,
    wake: { time: timestamp(current.wake_time), reason: current.wake_reason, priority: current.priority, project: current.project }, launch: current.launch
  };
  const wanted = { ...expected, wake: { ...expected.wake, time: timestamp(new Date(expected.wake.time)) } };
  if (!equal(actual, wanted)) throw conflictError('schedule');
}

async function scheduleInTransaction(client, wake, launch) {
  launch = definedObject(launch);
  const key = scheduleKey(wake, launch);
  const expected = { key, executionId: `run-${key.slice(0, 32)}`, workOrder: `work-${key}`, wake, launch };
  await ensureWorkOrder(client, expected.workOrder, wake.project, launch, null);
  const inserted = row(await client.query(`
    INSERT INTO runtime_schedules(schedule_key,schedule_id,execution_id,work_order,project,wake_time,wake_reason,priority,launch,created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()) ON CONFLICT (schedule_key) DO NOTHING RETURNING *`,
  [key, `wake-${crypto.randomUUID()}`, expected.executionId, expected.workOrder, wake.project, wake.time, wake.reason, wake.priority, launch]));
  const current = inserted || row(await client.query('SELECT * FROM runtime_schedules WHERE schedule_key=$1 FOR SHARE', [key]));
  assertSchedule(current, expected);
  return current;
}

async function assertMonotonicWake(client, execution, wake) {
  const prior = row(await client.query(`
    SELECT max((requested_next_wake->>'time')::timestamptz) AS wake_time
    FROM runtime_executions
    WHERE requested_next_wake IS NOT NULL AND (execution_id=$1 OR ($2::text IS NOT NULL AND work_order=$2))`,
  [execution.execution_id, execution.work_order]));
  if (prior?.wake_time && new Date(wake.time).getTime() < new Date(prior.wake_time).getTime()) throw new Error('requested_next_wake cannot regress');
}

function fromExecution(value) {
  return {
    schema: 'celestan-runtime-manifest-v2',
    execution: {
      id: value.execution_id, project: value.project, task: value.task, model: value.model, agent: value.agent,
      cwd: value.cwd, wake_reason: value.wake_reason, status: value.status, createdAt: timestamp(value.created_at),
      startedAt: timestamp(value.started_at), finishedAt: timestamp(value.finished_at), lastHeartbeatAt: timestamp(value.last_heartbeat_at)
    },
    workOrder: value.work_order, attempts: value.attempts, recoveryAttempts: value.recovery_attempts, recovery: value.recovery,
    topology: value.topology, failure: value.failure, result: value.result, output: value.output,
    modelRuntimeTelemetry: value.model_runtime_telemetry, requested_next_wake: value.requested_next_wake,
    observer: { state: value.observer_state, pendingAt: timestamp(value.observer_pending_at), observedAt: timestamp(value.observer_observed_at) },
    runtimeMetadata: value.runtime_metadata
  };
}

function fromSchedule(value) {
  return {
    key: value.schedule_key, scheduleKey: value.schedule_key, id: value.schedule_id, executionId: value.execution_id,
    workOrder: value.work_order, claimOwner: value.claim_owner, claimFence: value.claim_fence == null ? null : String(value.claim_fence),
    wake: { time: timestamp(value.wake_time), reason: value.wake_reason, priority: value.priority, project: value.project },
    launch: value.launch, state: value.state, recoveryAttempts: value.recovery_attempts,
    claimedAt: timestamp(value.claimed_at), finishedAt: timestamp(value.finished_at), createdAt: timestamp(value.created_at)
  };
}

function definedObject(value) { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)); }
function bigintEqual(left, right) { try { return BigInt(left) === BigInt(right); } catch { return false; } }
