import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

function loadTransport({ status = 'inserted', code = 200 } = {}) {
  const calls = [];
  const context = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: (key) => key === 'CT_GAS_FEDERATION_DATA_API_URL' ? 'https://data.example' : null }) },
    ScriptApp: { getIdentityToken: () => 'google-token' },
    UrlFetchApp: {
      fetch: (url, options) => {
        calls.push({ url, options });
        return { getResponseCode: () => code, getContentText: () => JSON.stringify(status) };
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(new URL('../gas/gas_vnext_events.js', import.meta.url), 'utf8'), context);
  return { transport: context.CT_GAS_VNEXT_EVENTS, calls };
}

test('GAS transport sends only event_id, event_type, and immutable payload', () => {
  const { transport, calls } = loadTransport();
  const result = transport.append({
    event_id: 'human-feedback:F1:1',
    type: 'external_input.received',
    feedback_id: 'F1',
    source_revision: 1,
    message: 'hello',
  });

  assert.equal(result, 'inserted');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://data.example/rpc/vnext_append_immutable_event');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer google-token');
  assert.deepEqual(JSON.parse(calls[0].options.payload), {
    event_id: 'human-feedback:F1:1',
    event_type: 'external_input.received',
    payload: { feedback_id: 'F1', source_revision: 1, message: 'hello' },
  });
});

test('GAS transport preserves duplicate and integrity-conflict statuses', () => {
  assert.equal(loadTransport({ status: 'duplicate' }).transport.append({ event_id: 'x', type: 'external_input.received', value: 1 }), 'duplicate');
  assert.equal(loadTransport({ status: 'integrity_conflict' }).transport.append({ event_id: 'x', type: 'external_input.received', value: 1 }), 'integrity_conflict');
});

test('GAS transport fails closed on unauthorized RPC', () => {
  assert.throws(() => loadTransport({ code: 401, status: { error: 'unauthorized' } }).transport.append({ event_id: 'x', type: 'external_input.received', value: 1 }), /unauthorized/);
});
