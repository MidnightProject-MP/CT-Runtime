import { randomUUID } from 'node:crypto';
export function testAcceptanceAuthority(check) {
  const issued = new Map();
  let revoked = false;
  return {
    revoke() { revoked = true; },
    async authorizeTerminal(context) {
      if (revoked || !context.snapshotDigest || !await check(context)) return false;
      const decision = { ref: `test-acceptance:${randomUUID()}`, snapshotDigest: context.snapshotDigest };
      issued.set(decision.ref, decision.snapshotDigest);
      return decision;
    },
    async verifyAcceptance(decision, context) {
      return !revoked && issued.has(decision.ref) && issued.get(decision.ref) === context.snapshotDigest
        && decision.snapshotDigest === context.snapshotDigest && await check(context) === true;
    },
  };
}
