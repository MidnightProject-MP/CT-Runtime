import test from 'node:test';
import assert from 'node:assert/strict';
import { stateUncertainAfterMutation, DeploymentStateUncertainError } from '../lib/gas-deploy-client.mjs';

test('self-deploy response failure is represented as state uncertain and requires readback', () => {
  const original = new Error('HTTP 404: Requested entity was not found');
  const uncertain = stateUncertainAfterMutation(original);

  assert.ok(uncertain instanceof DeploymentStateUncertainError);
  assert.equal(uncertain.state, 'uncertain');
  assert.equal(uncertain.readbackRequired, true);
  assert.equal(uncertain.message, 'deployment state is uncertain after the self-deploy mutation request; authoritative readback required');
  assert.equal(uncertain.cause, original);
});
