import { writeFile } from 'node:fs/promises';

process.stdout.write(`${process.env.CT_SECRET || ''}${'x'.repeat(Number(process.env.OUTPUT_SIZE || 0))}`);
process.stderr.write(process.env.CT_SECRET || '');
if (process.env.TIMEOUT === '1') await new Promise(() => {});
if (process.env.RESULT_MODE !== 'missing') {
  const result = process.env.RESULT_MODE === 'invalid'
    ? { status: 'complete', summary: 'bad', requested_next_wake: null, arbitrary: true }
    : { status: process.env.HANDOFF_STATUS || 'complete', summary: 'fixture complete', requested_next_wake: process.env.NEXT_WAKE ? JSON.parse(process.env.NEXT_WAKE) : null };
  if (process.env.RESULT_SIZE === 'large') result.summary = 'x'.repeat(70000);
  await writeFile(process.env.CT_RUNTIME_RESULT_FILE, JSON.stringify(result));
}
