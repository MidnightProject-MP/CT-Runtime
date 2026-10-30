import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// No network or credentials. Approval is an environment-scoped, per-release tuple.
const RELEASE_PREFIXES = ['refs/tags/gas-release/', 'refs/tags/gas-sandbox-release/'];
export function authorizeRelease(env, resolveRef) {
  const { RELEASE_COMMIT: commit, RELEASE_REF: ref, DESIRED_BUNDLE_HASH: desired,
    EXPECTED_LIVE_BUNDLE_HASH: predecessor } = env;
  const prefix = env.RELEASE_REF_PREFIX || RELEASE_PREFIXES[0];
  if (!RELEASE_PREFIXES.includes(prefix)) throw new Error('Release ref prefix not allowed');
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch') throw new Error('Manual release required');
  if (!/^[0-9a-f]{40}$/.test(commit || '') || commit !== env.GITHUB_SHA) throw new Error('Release commit mismatch');
  if (typeof ref !== 'string' || !ref.startsWith(prefix) || !/^[A-Za-z0-9._-]+$/.test(ref.slice(prefix.length)) || env.GITHUB_REF !== ref || resolveRef(ref) !== commit) throw new Error('Release ref mismatch');
  if (![desired, predecessor].every(value => /^[0-9a-f]{64}$/.test(value || ''))) throw new Error('Both reviewed hashes required');
  if (desired !== env.GAS_BUNDLE_HASH) throw new Error('Desired bundle mismatch');
  if (env.APPROVED_RELEASE !== `${ref}:${commit}:${desired}:${predecessor}`) throw new Error('Per-release environment approval mismatch');
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  authorizeRelease(process.env, ref => execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { encoding: 'utf8' }).trim());
}
