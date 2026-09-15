import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

function load({ executions = [], triggerHandlers = ['gasSafetyWake'] } = {}) {
  return readFile(new URL('../gas/gas_cutover.js', import.meta.url), 'utf8').then(source => {
    const properties = new Map([['CT_AUTONOMY_MODE', 'vnext']]);
    const triggers = triggerHandlers.map((handler, index) => ({
      handler,
      id: `trigger-${index}`,
      getHandlerFunction() { return this.handler; },
      getUniqueId() { return this.id; },
    }));
    const byId = new Map(executions.map(row => [row.id, row]));
    const deleted = [];
    const context = {
      Date,
      PropertiesService: { getScriptProperties: () => ({
        getProperty: key => properties.get(key) || null,
        setProperty: (key, value) => properties.set(key, String(value)),
      }) },
      LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
      ScriptApp: {
        getProjectTriggers: () => triggers.filter(trigger => !deleted.includes(trigger)),
        deleteTrigger: trigger => deleted.push(trigger),
      },
      CT_GAS_STATE: {
        list: kind => kind === 'executions' ? executions : [],
        get: (kind, id) => kind === 'executions' ? byId.get(id) || null : null,
      },
    };
    vm.createContext(context);
    vm.runInContext(source, context);
    return { context, properties, triggers, deleted };
  });
}

test('cutover retires the known automatic legacy trigger and records quiescence when no writer is live', async () => {
  const { context, properties, triggers, deleted } = await load();
  assert.deepEqual(JSON.parse(JSON.stringify(context.quiesceLegacyAutonomy())), {
    status: 'LEGACY_QUIESCED',
    autonomy_mode: 'vnext',
    retired_trigger_count: 1,
  });
  assert.equal(deleted.length, 1);
  assert.equal(properties.has('CT_VNEXT_LEGACY_QUIESCED'), true);
  assert.deepEqual(JSON.parse(JSON.stringify(context.assertLegacyQuiesced())), {
    status: 'LEGACY_QUIESCED',
    autonomy_mode: 'vnext',
    retired_trigger_count: 1,
  });
  assert.equal(triggers.length, 1);
});

test('cutover refuses to declare quiescence while a legacy execution is still running', async () => {
  const { context, properties, deleted } = await load({
    executions: [{ id: 'execution-live', lifecycle: 'running' }],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(context.quiesceLegacyAutonomy())), {
    status: 'LEGACY_NOT_QUIESCED',
    autonomy_mode: 'vnext',
    retired_trigger_count: 1,
    live_execution_ids: ['execution-live'],
  });
  assert.equal(deleted.length, 1);
  assert.equal(properties.has('CT_VNEXT_LEGACY_QUIESCED'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(context.assertLegacyQuiesced())), {
    status: 'LEGACY_NOT_QUIESCED',
    autonomy_mode: 'vnext',
  });
});

test('cutover requires vnext mode and does not mutate triggers otherwise', async () => {
  const { context, properties, deleted } = await load();
  properties.set('CT_AUTONOMY_MODE', 'legacy');
  assert.deepEqual(JSON.parse(JSON.stringify(context.quiesceLegacyAutonomy())), {
    status: 'REQUIRES_VNEXT',
    autonomy_mode: 'legacy',
  });
  assert.equal(deleted.length, 0);
});
