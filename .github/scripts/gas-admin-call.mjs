import { createHmac, randomUUID } from 'node:crypto';

const url = process.env.CT_GAS_ADMIN_WEB_APP_URL;
const secret = process.env.CT_GAS_ADMIN_SECRET;
const operation = process.env.CT_GAS_ADMIN_OPERATION;
if (!url || !secret || !operation) throw new Error('GAS admin URL, secret, and operation are required');
const params = process.env.CT_GAS_ADMIN_PARAMS ? JSON.parse(process.env.CT_GAS_ADMIN_PARAMS) : {};
const timestamp = String(Math.floor(Date.now() / 1000));
const nonce = randomUUID().replaceAll('-', '');
const unsigned = JSON.stringify({ timestamp, nonce, operation, params });
const signature = createHmac('sha256', secret).update(unsigned).digest('hex');
const response = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ timestamp, nonce, operation, params, signature }),
});
const body = await response.text();
let parsed;
try { parsed = JSON.parse(body); } catch { throw new Error(`GAS admin returned non-JSON HTTP ${response.status}`); }
if (!response.ok || parsed.status === 'rejected') throw new Error(`GAS admin ${operation} rejected: ${parsed.reason || response.status}`);
if (process.env.CT_GAS_ADMIN_REQUIRE && !JSON.stringify(parsed).includes(process.env.CT_GAS_ADMIN_REQUIRE)) throw new Error(`GAS admin ${operation} omitted required result`);
process.stdout.write(JSON.stringify(parsed));
