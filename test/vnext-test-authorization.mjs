export function testAuthorizationDecision({ execution }) {
  return { ref: `test-auth:${execution.execution_id}` };
}

export async function testAuthorizationVerifier(decision, { execution }) {
  return decision?.ref === execution.authorization_decision_ref;
}
