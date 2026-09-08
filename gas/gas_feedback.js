/* Human feedback-sheet adapter. The sheet is an interface; runtime state remains authoritative. */
var CT_GAS_FEEDBACK = (function () {
  /* Canonical human-facing contract: 8 columns, header row 4, human intake begins at row 5.
     Rows 1-4 are bootstrap/header content and are never messages. The 8-column sheet is a
     different interface contract from the 13-field durable work-order payload, never a reduced
     positional view of it: human project/message/reply/revision plus deterministic thread and
     message derivation map semantically to durable goal and linkage, while lifecycle, response,
     activity, and assigned thread project back to system-written columns. Runtime-generated
     identifiers, fingerprint, model binding, and launch/resume context have no human cell.
     A previous revision read the human sheet positionally as the durable layout,
     which admitted the header row as a message; the mapping below is the fix. */
  var SHEET_HEADERS = ['Project (optional)','Message / objective','Status','Celestan update / question','Your reply','Last activity','Thread ID','Reply revision'];
  var HEADER_ROW = 4, DATA_FIRST_ROW = 5, HEADER_SCAN_ROWS = 10;
  /* 1-based column positions within the human contract. Columns C, D, F, G are system-written;
     columns A, B, E, H are human input. There are no message_id / work_order_id / ack columns:
     message identity is derived deterministically and work linkage resolves via thread+revision. */
  var COL = { project:1, message:2, status:3, response:4, reply:5, activity:6, thread:7, revision:8 };

  function props() { return PropertiesService.getScriptProperties(); }
  function spreadsheetId() { return props().getProperty('CT_GAS_FEEDBACK_SPREADSHEET_ID') || props().getProperty('CT_GAS_SPREADSHEET_ID'); }
  function sheetName() { return props().getProperty('CT_GAS_FEEDBACK_SHEET_NAME') || 'Feedback'; }
  function book() { var id=spreadsheetId(); if (!id) throw new Error('CT_GAS_FEEDBACK_SPREADSHEET_ID or CT_GAS_SPREADSHEET_ID is required'); return SpreadsheetApp.openById(id); }
  function sheet() { var s=book().getSheetByName(sheetName()); if (!s) throw new Error('Configured feedback sheet not found: '+sheetName()); if (s.getLastRow()===0) throw new Error('Feedback sheet is not initialized: canonical header row '+HEADER_ROW+' is required'); return s; }
  function text(v,n) { return String(v==null?'':v).trim().slice(0,n||4000); }
  function norm(v) { return text(v).toLowerCase().replace(/\s+/g,' '); }
  function isHeaderCells(cells) { if(!cells||cells.length<SHEET_HEADERS.length) return false; for(var i=0;i<SHEET_HEADERS.length;i++) if(norm(cells[i])!==norm(SHEET_HEADERS[i])) return false; return true; }
  function headerRowNumber(s) { var n=Math.min(s.getLastRow(),HEADER_SCAN_ROWS); for(var r=1;r<=n;r++) if(isHeaderCells(s.getRange(r,1,1,SHEET_HEADERS.length).getValues()[0])) return r; return 0; }
  function revNum(v) { var n=Number(text(v)); return (isFinite(n)&&n>=1)?Math.floor(n):1; }
  function nowISO() { return new Date().toISOString(); }
  function values() {
    var s=sheet(), n=s.getLastRow(), header=headerRowNumber(s);
    if(header!==HEADER_ROW||n<DATA_FIRST_ROW) return {header:header,rows:[]};
    var found=s.getRange(DATA_FIRST_ROW,1,n-DATA_FIRST_ROW+1,SHEET_HEADERS.length).getValues(), rows=[];
    for(var i=0;i<found.length;i++) {
      if(isHeaderCells(found[i])) continue;
      var r=found[i];
      rows.push({row:DATA_FIRST_ROW+i,project:text(r[COL.project-1],100),message:text(r[COL.message-1],CT_GAS.MAX_MESSAGE),status:text(r[COL.status-1],80),response:text(r[COL.response-1],4000),reply:text(r[COL.reply-1],CT_GAS.MAX_MESSAGE),activity:text(r[COL.activity-1],80),thread:text(r[COL.thread-1],160),revision:text(r[COL.revision-1],80)});
    }
    return {header:header,rows:rows};
  }
  function effectiveMessage(x) { return text(x.message,CT_GAS.MAX_MESSAGE)||text(x.reply,CT_GAS.MAX_MESSAGE); }
  function write(rowNum,patch) {
    var s=sheet(), map={status:COL.status,response:COL.response,activity:COL.activity,thread:COL.thread};
    Object.keys(patch).forEach(function(k){ if(map[k]>0) s.getRange(rowNum,map[k]).setValue(patch[k]); });
  }
  function hash(row) { return CT_GAS.sha256(JSON.stringify({thread_id:text(row.thread_id,160),project:text(row.project,100),message:text(row.message,CT_GAS.MAX_MESSAGE),reply_to:text(row.reply_to,160),revision:Number(row.revision||1)})); }
  function referencedThread(row,all) {
    var ref=text(row.reply_to,80); if(!/^\d+$/.test(ref)) return '';
    var target=all.filter(function(x){return x.row===Number(ref);})[0]; return target ? text(target.thread_id,160) : '';
  }
  function ensureThread(x) {
    var thread=text(x.thread,160);
    if(thread) return thread;
    thread='thread_'+CT_GAS.sha256(String(x.row)+'|'+effectiveMessage(x)).slice(0,32);
    write(x.row,{thread:thread});
    x.thread=thread;
    return thread;
  }
  function messageIdFor(x,thread) { return 'message_'+CT_GAS.sha256(String(x.row)+'|'+thread+'|'+effectiveMessage(x)).slice(0,32); }
  function findOrder(messageId,revision) { return CT_GAS_STATE.list('work_orders').filter(function(o){ return o.payload&&o.payload.feedback_message_id===messageId&&Number(o.payload.feedback_revision||0)===revision; }); }
  function threadContext(x,all,thread,message) {
    var messages=all.filter(function(a){return text(a.thread,160)===thread&&Number(a.row)<=Number(x.row)&&effectiveMessage(a);}).slice(-8).map(function(a){return effectiveMessage(a);});
    return messages.length>1 ? 'Feedback thread:\n'+messages.join('\n---\n') : message;
  }
  function responseFor(order,continuation) {
    var p=(order&&order.payload)||{}, c=continuation||{};
    if (typeof p.response==='string' && p.response) return p.response;
    if (typeof p.output==='string' && p.output) return p.output;
    if (typeof c.output==='string' && c.output) return c.output;
    if (Array.isArray(c.completed) && c.completed.length) return c.completed.join('\n');
    if (Array.isArray(c.evidence) && c.evidence.length) return 'Verified evidence: '+c.evidence.join(', ');
    if (c.reason) return 'Waiting: '+c.reason;
    return '';
  }
  function statusFor(order) {
    if(!order) return 'Unknown';
    switch(String(order.lifecycle||'')) {
      case 'requested': case 'pending': return 'Accepted';
      case 'claimed': case 'running': return 'Working';
      case 'checkpointed': case 'deferred': case 'waiting': return 'Waiting';
      case 'completed': return 'Verified';
      case 'invalid': return 'Failed';
      default: return String(order.lifecycle||'Unknown');
    }
  }
  function admission(x,all) {
    var thread=ensureThread(x), message=effectiveMessage(x);
    if(!message) return null;
    var messageId=messageIdFor(x,thread), revision=revNum(x.revision);
    var again=findOrder(messageId,revision);
    if(again.length) return again[again.length-1];
    var model=props().getProperty('CT_GAS_PROOF_MODEL'); if(!model) throw new Error('CT_GAS_PROOF_MODEL is required');
    CT_GAS.freeModel(model);
    var fingerprint=hash({thread_id:thread,project:text(x.project,100),message:message,reply_to:'',revision:revision});
    var workOrderId=CT_GAS.id('feedback-work-order',{message_id:messageId,revision:revision,fingerprint:fingerprint});
    var executionId=CT_GAS.id('feedback-execution',{work_order_id:workOrderId});
    var continuationId=CT_GAS.id('feedback-continuation',{work_order_id:workOrderId,execution_id:executionId});
    var goal=threadContext(x,all,thread,message);
    var payload={work_order_id:workOrderId,goal:goal,step:'feedback',model:model,physical_execution_count:1,feedback_thread_id:thread,feedback_message_id:messageId,feedback_revision:revision,feedback_fingerprint:fingerprint,project:text(x.project,100),reply_to:'',launch_context:{model:model,source:'feedback-sheet'},resume_context:{source:'feedback-sheet',thread_id:thread,message_id:messageId}};
    var order=CT_GAS_STATE.create('work_orders',{id:workOrderId,lifecycle:'requested',payload:payload});
    requestNextWake({time:new Date().toISOString(),reason:'human',project:text(x.project,100)||'feedback',work_order_id:workOrderId,execution_id:executionId,continuation_id:continuationId,launch:{model:model,source:'feedback-sheet',goal:goal},resume:{source:'feedback-sheet',thread_id:thread,message_id:messageId}});
    return order;
  }
  function poll(clock,bundle) {
    var all=(bundle&&bundle.rows)||[], rows=all.filter(function(r){
      if(!effectiveMessage(r)) return false;
      var revision=revNum(r.revision), known=findOrder(messageIdFor(r,text(r.thread,160)),revision);
      return !known.length;
    }).slice(0,12), out=[];
    for(var i=0;i<rows.length;i++) {
      if(clock&&!clock.canStart(CT_GAS.OPERATION_BUDGETS.stateWrite)) break;
      var row=rows[i];
      try {
        var order=admission(row,all);
        if(!order) continue;
        write(row.row,{status:'Accepted',response:'',activity:nowISO(),thread:text(order.payload.feedback_thread_id,160)});
        out.push({row:row.row,status:'accepted',work_order_id:order.id});
      } catch(e) {
        write(row.row,{status:'Failed',activity:nowISO(),response:CT_GAS.bound(e.message||e,400)});
        out.push({row:row.row,status:'failed',error:String(e.message||e)});
      }
    }
    return out;
  }
  function resolveOrder(x) {
    var thread=text(x.thread,160); if(!thread) return null;
    var revision=revNum(x.revision);
    var match=CT_GAS_STATE.list('work_orders').filter(function(o){ return o.payload&&text(o.payload.feedback_thread_id,160)===thread&&Number(o.payload.feedback_revision||0)===revision; });
    return match.length?match[match.length-1]:null;
  }
  function sync(clock,bundle) {
    var all=(bundle&&bundle.rows)||[], out=[];
    for(var i=0;i<all.length;i++) {
      if(clock&&!clock.canStart(CT_GAS.OPERATION_BUDGETS.stateRead)) break;
      var row=all[i], order=resolveOrder(row); if(!order) continue;
      var cp=CT_GAS_STATE.latestContinuation(order.id), status=statusFor(order), response=responseFor(order,cp), patch={status:status,activity:nowISO()};
       if(response && (status==='Verified'||status==='Waiting')) patch.response=CT_GAS.bound(response,4000);
      if(status==='Failed') patch.response=CT_GAS.bound((order.payload&&order.payload.reason)||'runtime failure',400);
      write(row.row,patch); out.push({row:row.row,status:status,work_order_id:order.id});
    }
    return out;
  }
  function reconcile(clock) {
    var c=clock||CT_GAS.clock(Date.now(),CT_GAS.BUDGET_MS), initialized=ensureSheet();
    if(!initialized.header_ok) return {sheet:initialized,admitted:[],synced:[]};
    var bundle=values();
    if(bundle.header!==HEADER_ROW) return {sheet:initialized,admitted:[],synced:[]};
    return {sheet:initialized,admitted:poll(c,bundle),synced:sync(c,values())};
  }
  function ensureSheet() {
    var s=sheet(), header=headerRowNumber(s);
    return {spreadsheet_id:spreadsheetId(),sheet_name:sheetName(),headers:SHEET_HEADERS,header_row:HEADER_ROW,header_ok:header===HEADER_ROW,row_count:Math.max(0,s.getLastRow()-DATA_FIRST_ROW+1)};
  }
  function configure(spreadsheetIdValue,sheetNameValue) {
    var id=text(spreadsheetIdValue,200), name=text(sheetNameValue,200)||'Feedback';
    if(!id) throw new Error('Feedback spreadsheet ID is required');
    var book=SpreadsheetApp.openById(id), target=book.getSheetByName(name);
    if(!target) throw new Error('Feedback sheet not found: '+name);
    props().setProperty('CT_GAS_FEEDBACK_SPREADSHEET_ID',id);
    props().setProperty('CT_GAS_FEEDBACK_SHEET_NAME',name);
    var header=headerRowNumber(target);
    return {spreadsheet_id:id,sheet_name:name,headers:SHEET_HEADERS,header_row:HEADER_ROW,header_ok:header===HEADER_ROW,row_count:Math.max(0,target.getLastRow()-DATA_FIRST_ROW+1)};
  }
  function setup() { var result=ensureSheet(); props().setProperty('CT_GAS_FEEDBACK_READY','true'); return result; }
  /* One-shot fenced repair for the row-4 header misadmission of 2026-09-08. All expected
     values are hardcoded: the function refuses unless the malformed work order, wake, and
     polluted header state match exactly. It creates no general destructive admin surface. */
  var MALFORMED_ROW4_ADMISSION = {
    row:4,
    workOrderId:'feedback-work-order_fa0cdf76b1a3dce3e4a0dca04a626ee0',
    wakeId:'wake_b5fb51881cb9ffdd6ef00eadd940266e',
    goal:'Last activity', project:'Your reply',
    threadLabel:'Message / objective', messageLabel:'Status',
    reason:'feedback-header-row-misadmission'
  };
  /* Observed malformed status words for row 4. The pre-fix synchronizer stamped the order's
     lifecycle word into H4 as it moved (Accepted while requested, Working while running,
     Waiting once checkpointed); 'Waiting' was observed live on 2026-09-08. No other word is
     accepted: the I4 work-order pin plus intact label cells stay the exact-match fence. */
  var MALFORMED_ROW4_STATUSES = ['Accepted','Working','Waiting'];
  function pollutedRow4(s,workOrderId) {
    var cells=s.getRange(MALFORMED_ROW4_ADMISSION.row,1,1,9).getValues()[0];
    if(text(cells[8],200)!==workOrderId) return false;
    if(isHeaderCells(cells.slice(0,8))) return false;
    var intact=[0,1,2,4,5,6];
    for(var k=0;k<intact.length;k++) if(norm(cells[intact[k]])!==norm(SHEET_HEADERS[intact[k]])) return false;
    return MALFORMED_ROW4_STATUSES.indexOf(text(cells[7],80))>=0;
  }
  function repairRow4Admission() {
    var m=MALFORMED_ROW4_ADMISSION;
    var order=CT_GAS_STATE.get('work_orders',m.workOrderId);
    if(!order) throw new Error('repair refused: malformed work order not found: '+m.workOrderId);
    if(order.lifecycle==='completed') throw new Error('repair refused: malformed work order is completed; manual review required');
    if(order.lifecycle!=='requested') throw new Error('repair refused: malformed work order lifecycle is '+order.lifecycle+'; manual review required');
    var p=order.payload||{};
    if(text(p.goal,1200)!==m.goal||text(p.project,100)!==m.project||text(p.feedback_thread_id,160)!==m.threadLabel||text(p.feedback_message_id,160)!==m.messageLabel) throw new Error('repair refused: work order payload does not match the malformed header admission');
    var wake=CT_GAS_STATE.get('wakes',m.wakeId);
    if(!wake) throw new Error('repair refused: malformed wake not found: '+m.wakeId);
    if(!wake.payload||wake.payload.work_order_id!==m.workOrderId) throw new Error('repair refused: wake identity does not match the malformed work order');
    var wakeAction='already-invalid';
    if(wake.lifecycle==='pending') wakeAction='retire';
    else if(wake.lifecycle==='invalid') wakeAction='already-invalid';
    else if(wake.lifecycle==='claimed'&&new Date(wake.lease_until||0).getTime()<=Date.now()) wakeAction='retire';
    else throw new Error('repair refused: malformed wake lifecycle is '+wake.lifecycle+'; manual review required');
    var s=sheet();
    if(!pollutedRow4(s,m.workOrderId)) throw new Error('repair refused: sheet row 4 does not carry the expected malformed admission markers');
    for(var i=0;i<SHEET_HEADERS.length;i++) s.getRange(m.row,i+1).setValue(SHEET_HEADERS[i]);
    for(var c=9;c<=13;c++) s.getRange(m.row,c).setValue('');
    CT_GAS_STATE.update('work_orders',m.workOrderId,{lifecycle:'invalid',payload:{retire_reason:m.reason,retired_at:nowISO(),retired_row:m.row}});
    if(wakeAction==='retire') CT_GAS_TRIGGER.retire(wake,m.reason,[]);
    CT_GAS_STATE.event('feedback_admission_repaired',{operation:'feedback-repair',work_order_id:m.workOrderId,wake_id:m.wakeId,row:m.row,reason:m.reason,wake:wakeAction,general_compute_requested:false});
    return {status:'repaired',work_order_id:m.workOrderId,wake_id:m.wakeId,wake:wakeAction,header:'restored'};
  }
  /* One-shot fenced repair for the checkpointed malformed chain of 2026-09-08. The original
     wake executed before the first repair ran, so the work order is checkpointed with a live
     continuation and descendant wakes (one already resurrected). This fences the entire chain:
     the order goes to the existing invalid terminal; every wake carrying it is retired (or
     noted when already terminal); every continuation is audit-fenced. Continuations are
     append-only facts: they become inert once the order is terminal and no dispatchable wake
     references them, and history is preserved. All expected IDs are hardcoded; any mismatch
     aborts before the first mutation. */
  var MALFORMED_ROW4_CHAIN = {
    row:4,
    workOrderId:'feedback-work-order_fa0cdf76b1a3dce3e4a0dca04a626ee0',
    wakeIds:['wake_b5fb51881cb9ffdd6ef00eadd940266e','wake_18b1d9bc40a3e9beda145a43ea0f9c63'],
    goal:'Last activity', project:'Your reply',
    threadLabel:'Message / objective', messageLabel:'Status',
    reason:'feedback-header-row-misadmission'
  };
  function latestPerId(rows) { var byId={}; rows.forEach(function(r){ var cur=byId[r.id]; if(!cur||Number(r.revision||0)>=Number(cur.revision||0)) byId[r.id]=r; }); return Object.keys(byId).map(function(k){ return byId[k]; }); }
  function chainWakes(workOrderId) { return latestPerId(CT_GAS_STATE.list('wakes')).filter(function(w){ return w.payload&&w.payload.work_order_id===workOrderId; }); }
  function chainContinuations(workOrderId) { return CT_GAS_STATE.list('continuations').filter(function(c){ return c.payload&&c.payload.work_order_id===workOrderId; }); }
  function observedExecutions(wakes,continuations) {
    var ids={};
    wakes.forEach(function(w){ if(w.payload&&w.payload.execution_id) ids[w.payload.execution_id]=1; });
    continuations.forEach(function(c){ if(c.payload){ if(c.payload.execution_id) ids[c.payload.execution_id]=1; if(c.payload.resumed_from) ids[c.payload.resumed_from]=1; } });
    return Object.keys(ids);
  }
  function repairChain() {
    var m=MALFORMED_ROW4_CHAIN;
    var order=CT_GAS_STATE.get('work_orders',m.workOrderId);
    if(!order) throw new Error('chain repair refused: malformed work order not found: '+m.workOrderId);
    if(order.lifecycle==='completed') throw new Error('chain repair refused: malformed work order is completed; manual review required');
    if(order.lifecycle!=='checkpointed') throw new Error('chain repair refused: malformed work order lifecycle is '+order.lifecycle+'; manual review required');
    var p=order.payload||{};
    if(text(p.goal,1200)!==m.goal||text(p.project,100)!==m.project||text(p.feedback_thread_id,160)!==m.threadLabel||text(p.feedback_message_id,160)!==m.messageLabel) throw new Error('chain repair refused: work order payload does not match the malformed header admission');
    var wakes=chainWakes(m.workOrderId);
    if(!wakes.length) throw new Error('chain repair refused: no wakes carry the malformed work order');
    m.wakeIds.forEach(function(id){ if(!wakes.some(function(w){ return w.id===id; })) throw new Error('chain repair refused: expected wake not found among order wakes: '+id); });
    var continuations=chainContinuations(m.workOrderId);
    if(!continuations.length) throw new Error('chain repair refused: no continuations carry the malformed work order');
    var plan=wakes.map(function(w){
      if(w.lifecycle==='pending') return {wake:w,action:'retire'};
      if(w.lifecycle==='invalid') return {wake:w,action:'already-invalid'};
      if(w.lifecycle==='completed') return {wake:w,action:'already-completed'};
      if(w.lifecycle==='claimed'&&new Date(w.lease_until||0).getTime()<=Date.now()) return {wake:w,action:'retire'};
      throw new Error('chain repair refused: wake '+w.id+' lifecycle is '+w.lifecycle+'; manual review required');
    });
    var s=sheet();
    if(!pollutedRow4(s,m.workOrderId)) throw new Error('chain repair refused: sheet row 4 does not carry the expected malformed admission markers');
    var continuationIds=continuations.map(function(c){ return c.id; });
    var executionIds=observedExecutions(wakes,continuations);
    for(var i=0;i<SHEET_HEADERS.length;i++) s.getRange(m.row,i+1).setValue(SHEET_HEADERS[i]);
    for(var c=9;c<=13;c++) s.getRange(m.row,c).setValue('');
    CT_GAS_STATE.update('work_orders',m.workOrderId,{lifecycle:'invalid',payload:{retire_reason:m.reason,retired_at:nowISO(),retired_row:m.row,fenced_wake_ids:plan.map(function(a){ return a.wake.id; }),fenced_continuation_ids:continuationIds}});
    var retired=[], noted={already_invalid:[],already_completed:[]};
    plan.forEach(function(a){ if(a.action==='retire'){ CT_GAS_TRIGGER.retire(a.wake,m.reason,[]); retired.push(a.wake.id); } else if(a.action==='already-invalid'){ noted.already_invalid.push(a.wake.id); } else { noted.already_completed.push(a.wake.id); } });
    CT_GAS_STATE.event('feedback_chain_repaired',{operation:'feedback-repair',work_order_id:m.workOrderId,wake_ids_retired:retired,wake_ids_noted:noted,continuation_ids:continuationIds,physical_execution_ids:executionIds,row:m.row,reason:m.reason,general_compute_requested:false});
    return {status:'chain-repaired',work_order_id:m.workOrderId,wakes_retired:retired,wakes_noted:noted,continuations_fenced:continuationIds,header:'restored'};
  }
  return {setup:setup,reconcile:reconcile,ensureSheet:ensureSheet,configure:configure,repairRow4Admission:repairRow4Admission,repairChain:repairChain};
}());
function setupFeedbackSheet() { return CT_GAS_FEEDBACK.setup(); }
function configureFeedbackInbox(spreadsheetId,sheetName) { return CT_GAS_FEEDBACK.configure(spreadsheetId,sheetName); }
function reconcileFeedbackSheet(clock) { return CT_GAS_FEEDBACK.reconcile(clock); }
function repairFeedbackHeaderRowAdmission() { return CT_GAS_FEEDBACK.repairRow4Admission(); }
function repairFeedbackHeaderChain() { return CT_GAS_FEEDBACK.repairChain(); }
