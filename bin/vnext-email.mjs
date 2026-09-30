#!/usr/bin/env node
import { Pool } from 'pg';
import { createEmailPilot } from '../lib/vnext/email-pilot.mjs';
import { createGmailTransport } from '../lib/vnext/gmail-transport.mjs';
let pool;
try {
  if (process.argv[2] !== 'poll') throw new Error('usage: vnext-email poll');
  if (process.env.CT_EMAIL_PILOT_ENABLED !== 'true') throw new Error('email pilot disabled');
  if (!process.env.CT_PILOT_DATABASE_URL) throw new Error('database required');
  pool=new Pool({connectionString:process.env.CT_PILOT_DATABASE_URL,max:3,connectionTimeoutMillis:10000,statement_timeout:15000});
  const email=createEmailPilot({pool,mailboxId:process.env.CT_EMAIL_MAILBOX_ID,projectId:process.env.CT_EMAIL_PROJECT_ID,
    allowedSender:process.env.CT_EMAIL_ALLOWED_SENDER,mailboxAddress:process.env.CT_EMAIL_MAILBOX_ADDRESS,labelName:process.env.CT_EMAIL_LABEL});
  const transport=createGmailTransport({url:process.env.CT_GAS_ADMIN_WEB_APP_URL,secret:process.env.CT_GAS_FEDERATION_HMAC_SECRET});
  console.log(JSON.stringify(await email.poll(transport)));
} catch { console.error('Email pilot stopped; check configuration and durable outbox. No automatic resend of uncertain effects.'); process.exitCode=1; }
finally { await pool?.end(); }
