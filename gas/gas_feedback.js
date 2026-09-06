/* Human feedback-sheet adapter. The sheet is an interface; runtime state remains authoritative. */
var CT_GAS_FEEDBACK = (function () {
  var headers = ['created_at','thread_id','message_id','revision','project','message','reply_to','status','work_order_id','ack_at','updated_at','response','error'];
  var inputColumns = {project:5,message:6,reply_to:7};

  function props() { return PropertiesService.getScriptProperties(); }
  function spreadsheetId() { return props().getProperty('CT_GAS_FEEDBACK_SPREADSHEET_ID') || props().getProperty('CT_GAS_SPREADSHEET_ID'); }
  function sheetName() { return props().getProperty('CT_GAS_FEEDBACK_SHEET_NAME') || 'feedback'; }
  function book() { var id=spreadsheetId(); if (!id) throw new Error('CT_GAS_SPREADSHEET_ID is required'); return SpreadsheetApp.openById(id); }
  function sheet() { var s=book().getSheetByName(sheetName()) || book().insertSheet(sheetName()); if (s.getLastRow()===0) { s.appendRow(headers); s.setFrozenRows(1); } return s; }
  function values() { var s=sheet(), n=s.getLastRow(); if (n<2) return []; return s.getRange(2,1,n-1,headers.length).getValues().map(function(r,i){ var x={row:i+2}; headers.forEach(function(h,j){x[h]=r[j];}); return x; }); }
  function text(v,n) { return String(v==null?'':v).trim().slice(0,n||4000); }
  function iso(v) { return v ? new Date(v).toISOString() : ''; }
  function write(row,patch) { var s=sheet(); Object.keys(patch).forEach(function(k){ var col=headers.indexOf(k)+1; if(col>0) s.getRange(row,col).setValue(patch[k]); }); }
  function hash(row) { return CT_GAS.sha256(JSON.stringify({thread_id:text(row.thread_id,160),project:text(row.project,100),message:text(row.message,CT_GAS.MAX_MESSAGE),reply_to:text(row.reply_to,160),revision:Number(row.revision||1)})); }
  function ensureIdentity(row) {
    var thread=text(row.thread_id,160), messageId=text(row.message_id,160), revision=Math.max(1,Number(row.revision||1));
    if(!thread) thread='thread_'+CT_GAS.sha256(String(row.row)+'|'+text(row.created_at,80)+'|'+text(row.message,CT_GAS.MAX_MESSAGE)).slice(0,32);
    if(!messageId) messageId='message_'+CT_GAS.sha256(String(row.row)+'|'+thread+'|'+text(row.message,CT_GAS.MAX_MESSAGE)).slice(0,32);
    if(!row.created_at) write(row.row,{created_at:new Date().toISOString()});
    if(row.thread_id!==thread||row.message_id!==messageId||Number(row.revision||0)!==revision) write(row.row,{thread_id:thread,message_id:messageId,revision:revision});
    return Object.assign({},row,{thread_id:thread,message_id:messageId,revision:revision});
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
      case 'requested': return 'Accepted';
      case 'pending': return 'Accepted';
      case 'claimed': return 'Working';
      case 'running': return 'Working';
      case 'checkpointed': return 'Waiting';
      case 'deferred': return 'Waiting';
      case 'waiting': return 'Waiting';
      case 'completed': return 'Verified';
      case 'invalid': return 'Failed';
      default: return String(order.lifecycle||'Unknown');
    }
  }
  function admission(row) {
    row=ensureIdentity(row);
    var message=text(row.message,CT_GAS.MAX_MESSAGE); if(!message) return null;
    var fingerprint=hash(row), existing=CT_GAS_STATE.list('work_orders').filter(function(x){return x.payload&&x.payload.feedback_message_id===row.message_id&&Number(x.payload.feedback_revision||0)===row.revision;});
    if(existing.length) return existing[existing.length-1];
    var model=props().getProperty('CT_GAS_PROOF_MODEL'); if(!model) throw new Error('CT_GAS_PROOF_MODEL is required');
    CT_GAS.freeModel(model);
    var workOrderId=CT_GAS.id('feedback-work-order',{message_id:row.message_id,revision:row.revision,fingerprint:fingerprint});
    var executionId=CT_GAS.id('feedback-execution',{work_order_id:workOrderId});
    var continuationId=CT_GAS.id('feedback-continuation',{work_order_id:workOrderId,execution_id:executionId});
    var payload={work_order_id:workOrderId,goal:message,step:'feedback',model:model,physical_execution_count:1,feedback_thread_id:row.thread_id,feedback_message_id:row.message_id,feedback_revision:row.revision,feedback_fingerprint:fingerprint,project:text(row.project,100),reply_to:text(row.reply_to,160),launch_context:{model:model,source:'feedback-sheet'},resume_context:{source:'feedback-sheet',thread_id:row.thread_id,message_id:row.message_id}};
    var order=CT_GAS_STATE.create('work_orders',{id:workOrderId,lifecycle:'requested',payload:payload});
    requestNextWake({time:new Date().toISOString(),reason:'human',project:text(row.project,100)||'feedback',work_order_id:workOrderId,execution_id:executionId,continuation_id:continuationId,launch:{model:model,source:'feedback-sheet',goal:message},resume:{source:'feedback-sheet',thread_id:row.thread_id,message_id:row.message_id}});
    return order;
  }
  function poll(clock) {
    var rows=values().filter(function(r){return text(r.message,CT_GAS.MAX_MESSAGE)&&(!r.work_order_id||!r.status);}).slice(0,12), out=[];
    for(var i=0;i<rows.length;i++) {
      if(clock&&!clock.canStart(CT_GAS.OPERATION_BUDGETS.stateWrite)) break;
      var row=rows[i];
      try {
        var order=admission(row);
        if(!order) continue;
        write(row.row,{status:'Accepted',work_order_id:order.id,ack_at:row.ack_at||new Date().toISOString(),updated_at:new Date().toISOString(),error:''});
        out.push({row:row.row,status:'accepted',work_order_id:order.id});
      } catch(e) {
        write(row.row,{status:'Failed',updated_at:new Date().toISOString(),error:CT_GAS.bound(e.message||e,400)});
        out.push({row:row.row,status:'failed',error:String(e.message||e)});
      }
    }
    return out;
  }
  function sync(clock) {
    var rows=values().filter(function(r){return r.work_order_id;}), out=[];
    for(var i=0;i<rows.length;i++) {
      if(clock&&!clock.canStart(CT_GAS.OPERATION_BUDGETS.stateRead)) break;
      var row=rows[i], order=CT_GAS_STATE.get('work_orders',String(row.work_order_id)); if(!order) continue;
      var cp=CT_GAS_STATE.latestContinuation(order.id), status=statusFor(order), response=responseFor(order,cp), patch={status:status,updated_at:new Date().toISOString()};
      if(response && status==='Verified') patch.response=CT_GAS.bound(response,4000);
      if(status==='Failed') patch.error=CT_GAS.bound((order.payload&&order.payload.reason)||'runtime failure',400);
      write(row.row,patch); out.push({row:row.row,status:status,work_order_id:order.id});
    }
    return out;
  }
  function reconcile(clock) { var c=clock||CT_GAS.clock(Date.now(),CT_GAS.BUDGET_MS); var initialized=ensureSheet(); var admitted=poll(c), synced=sync(c); return {sheet:initialized,admitted:admitted,synced:synced}; }
  function ensureSheet() { var s=sheet(); return {spreadsheet_id:spreadsheetId(),sheet_name:sheetName(),headers:headers,row_count:Math.max(0,s.getLastRow()-1)}; }
  function setup() { var result=ensureSheet(); props().setProperty('CT_GAS_FEEDBACK_READY','true'); return result; }
  return {setup:setup,reconcile:reconcile,ensureSheet:ensureSheet};
}());
function setupFeedbackSheet() { return CT_GAS_FEEDBACK.setup(); }
function reconcileFeedbackSheet(clock) { return CT_GAS_FEEDBACK.reconcile(clock); }
