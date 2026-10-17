import { readFile } from 'node:fs/promises';

// One attempt's OS-level run identity. It is recorded durably at spawn so a
// restarted coordinator can distinguish not-launched / running / completed /
// unknown from durable records instead of timing assumptions. The probe is a
// Linux /proc contract; other platforms report 'unavailable' and recovery
// stays conservative.

export async function readBootId() {
  try { return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() || null; }
  catch { return null; }
}

export function parseProcStat(text) {
  // The comm field may contain spaces and parentheses; fields follow the last ')'.
  const close = text.lastIndexOf(')');
  if (close < 0) throw new Error('invalid /proc stat content');
  const fields = text.slice(close + 2).trim().split(/\s+/);
  return { state: fields[0], pgid: Number(fields[2]), start_ticks: fields[19] };
}

// Start ticks survive pid reuse: a recycled pid cannot share the recorded
// process start time.
export async function readRunIdentity(pid, { bootId } = {}) {
  if (!Number.isInteger(pid) || pid <= 1) throw new Error('run identity requires a positive pid');
  try {
    const stat = parseProcStat(await readFile(`/proc/${pid}/stat`, 'utf8'));
    return { pid, pgid: stat.pgid, start_ticks: stat.start_ticks, boot_id: bootId ?? await readBootId(), started_at: new Date().toISOString() };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
    throw error;
  }
}

export async function probeRunIdentity(identity) {
  if (process.platform !== 'linux') return 'unavailable';
  if (!identity || !Number.isInteger(identity.pid) || identity.pid <= 1) return 'unavailable';
  if (!identity.boot_id || !identity.start_ticks) return 'unavailable';
  const boot = await readBootId();
  if (!boot) return 'unavailable';
  if (boot !== identity.boot_id) return 'gone';
  let stat;
  try { stat = parseProcStat(await readFile(`/proc/${identity.pid}/stat`, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return 'gone'; return 'unavailable'; }
  if (String(stat.start_ticks) !== String(identity.start_ticks)) return 'gone';
  if (stat.state === 'Z' || stat.state === 'X') return 'gone';
  return 'live';
}

export function killProcessGroup(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 1) throw new Error('refusing to kill an unspecified process group');
  try { process.kill(-pgid, 'SIGKILL'); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
