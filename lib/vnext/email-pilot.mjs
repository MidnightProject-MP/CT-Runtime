import { createHash } from 'node:crypto';
import { createPilotStore } from './pilot-store.mjs';
import { normalizeEmailAddress, parseInboundMessage } from './email-message.mjs';

export function createEmailPilot({ pool, mailboxId, projectId, allowedSender, mailboxAddress, labelName } = {}) {
  if (!pool || !/^[A-Za-z0-9._:-]{1,100}$/.test(mailboxId || '') || !projectId || !labelName) throw new Error('email configuration required');
  allowedSender = normalizeEmailAddress(allowedSender);
  mailboxAddress = normalizeEmailAddress(mailboxAddress);
  if (allowedSender === mailboxAddress) throw new Error('sender must differ from mailbox');
  const pilot = createPilotStore({ pool });
  const hash = value => createHash('sha256').update(value).digest('hex');
  async function configure() {
    await pool.query(`INSERT INTO vnext_email_mailboxes(mailbox_id,label_name,allowed_sender,enabled,project_id,mailbox_address)
      VALUES ($1,$2,$3,true,$4,$5) ON CONFLICT DO NOTHING`, [mailboxId,labelName,allowedSender,projectId,mailboxAddress]);
    const row = (await pool.query('SELECT * FROM vnext_email_mailboxes WHERE mailbox_id=$1',[mailboxId])).rows[0];
    if (!row?.enabled || row.label_name !== labelName || row.allowed_sender !== allowedSender || row.project_id !== projectId || row.mailbox_address !== mailboxAddress) throw new Error('mailbox configuration conflict');
  }
  async function ingest(message) {
    const v = parseInboundMessage(message,{mailboxId,allowedSender});
    if (v.to !== mailboxAddress) throw new Error('wrong destination mailbox');
    // Submit is independently idempotent. A crash before receipt recording retries
    // the same immutable receipt, never a second logical input.
    const submitted = await pilot.submit({projectId,threadId:`email-${hash(mailboxId+'\n'+v.providerThreadId)}`,receiptId:v.receiptId,message:v.body});
    await pool.query(`INSERT INTO vnext_email_receipts(receipt_id,mailbox_id,provider_message_id,provider_thread_id,from_address,to_address,subject,body,work_unit_id,input_seq)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,[v.receiptId,mailboxId,v.providerMessageId,v.providerThreadId,v.from,v.to,v.subject,v.body,submitted.work_unit_id,submitted.input_seq]);
    const old=(await pool.query('SELECT * FROM vnext_email_receipts WHERE receipt_id=$1',[v.receiptId])).rows[0];
    if (!old || old.body!==v.body || old.provider_thread_id!==v.providerThreadId || old.from_address!==v.from || old.to_address!==v.to || old.subject!==v.subject || old.work_unit_id!==submitted.work_unit_id) throw new Error('email receipt conflict');
    return submitted;
  }
  async function queueResults() {
    // Bind a reply to an input actually seen by this execution, never to a newer
    // email arriving during execution. Re-running this query closes crash windows.
    const rows=await pool.query(`SELECT r.execution_id,r.turn,e.* FROM vnext_pilot_results r
      JOIN LATERAL (SELECT * FROM vnext_email_receipts e WHERE e.work_unit_id=r.work_unit_id
        AND e.mailbox_id=$1 AND e.input_seq<=r.input_seq ORDER BY e.input_seq DESC LIMIT 1) e ON true
      WHERE NOT EXISTS (SELECT 1 FROM vnext_email_outbox o WHERE o.outbox_id='reply-'||r.execution_id)
      ORDER BY r.recorded_at LIMIT 10`,[mailboxId]);
    for (const r of rows.rows) {
      const body=Array.from(String(r.turn.summary)+(r.turn.question ? '\n\n'+r.turn.question : '')).slice(0,4000).join('');
      await pool.query(`INSERT INTO vnext_email_outbox(outbox_id,mailbox_id,provider_thread_id,to_address,subject,body,in_reply_to)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,['reply-'+r.execution_id,mailboxId,r.provider_thread_id,allowedSender,r.subject,body,r.provider_message_id]);
    }
    return rows.rowCount;
  }
  async function deliver(transport) {
    const rows=await pool.query(`SELECT * FROM vnext_email_outbox WHERE mailbox_id=$1 AND state IN ('pending','uncertain') ORDER BY created_at LIMIT 10`,[mailboxId]);
    let sent=0, uncertain=0, blocked=0;
    for (const row of rows.rows) {
      if(row.to_address!==allowedSender) throw new Error('outbox recipient conflict');
      // Admission is the consequential boundary. The durable store serializes
      // it with project reconciliation under the same project fence used by
      // execution acquisition and reconciliation. A null result means the
      // project is blocked; no provider call or outbox mutation occurs.
      const admitted=await pilot.admitEmailDelivery({projectId,outboxId:row.outbox_id,recipient:allowedSender});
      if (!admitted) { blocked++; continue; }
      try {
        const result=await transport('email-send',{mailboxId,key:admitted.outbox_id,threadId:admitted.provider_thread_id,inReplyTo:admitted.in_reply_to,to:allowedSender,subject:admitted.subject,body:admitted.body});
        if (result.status!=='sent' || !result.messageId) { uncertain++; continue; }
        await pool.query(`UPDATE vnext_email_outbox SET state='sent',provider_message_id=$2,sent_at=clock_timestamp(),last_error=NULL WHERE outbox_id=$1`,[admitted.outbox_id,result.messageId]); sent++;
      } catch { uncertain++; } // Never persist provider errors or email text in logs.
    }
    return {sent,uncertain,blocked};
  }
  async function poll(transport) {
    await configure();
    const response=await transport('email-poll',{mailboxId});
    if(response.status!=='ok' || !Array.isArray(response.messages)) throw new Error('mailbox unavailable');
    let received=0;
    for(const message of response.messages) {
      await ingest(message);
      const ack=await transport('email-ack',{mailboxId,messageId:message.id});
      if(ack.status!=='acknowledged') throw new Error('email acknowledgement failed');
      received++;
    }
    await queueResults();
    return {status:'ok',received,...await deliver(transport)};
  }
  return {configure,ingest,queueResults,deliver,poll};
}
