var CT_GAS_TRIGGER = (function () {
  var safety = 'gasSafetyWake', marker = 'CT_GAS_SAFETY_TRIGGER';
  function registry() { return ScriptApp.getProjectTriggers().map(function (t) { return { handler:t.getHandlerFunction(), source:String(t.getTriggerSource()), id:t.getUniqueId ? t.getUniqueId() : null }; }); }
  function ensure() { var l=LockService.getScriptLock(); l.waitLock(20000); try { var props=PropertiesService.getScriptProperties(), found=registry().filter(function (x) { return x.handler === safety; }); if (found.length) { props.setProperty(marker,'present'); return found; } ScriptApp.newTrigger(safety).timeBased().everyMinutes(15).create(); props.setProperty(marker,'present'); return registry().filter(function (x) { return x.handler === safety; }); } finally { l.releaseLock(); } }
  function schedule(wake,clock) { var normalized=CT_GAS.wake(wake), own=clock||CT_GAS.clock(Date.now(),PropertiesService.getScriptProperties().getProperty('CT_GAS_BUDGET_MS')), result=CT_GAS.runGuard(own,'trigger-schedule',CT_GAS.OPERATION_BUDGETS.trigger,function () { var row=CT_GAS_STATE.schedule(normalized); if (!own.canStart(CT_GAS.OPERATION_BUDGETS.trigger)) return {status:'preempted',reason:'post-schedule-checkpoint'}; var ensured=CT_GAS.runGuard(own,'trigger-ensure',CT_GAS.OPERATION_BUDGETS.trigger,ensure); if (ensured.status==='preempted') return ensured; PropertiesService.getScriptProperties().setProperty('CT_GAS_WAKE_' + row.idempotency_key,'recorded'); return row; }); if (result.status==='preempted') throw new Error('insufficient budget for trigger scheduling'); return result; }
  function due(now,clock) { return CT_GAS.runGuard(clock||CT_GAS.clock(Date.now(),CT_GAS.BUDGET_MS),'state-read-wakes',CT_GAS.OPERATION_BUDGETS.stateRead,function () { var rows=CT_GAS_STATE.list('wakes'); return rows.filter(function (x,i,a) { return !a.some(function (y) { return y.id===x.id && Number(y.revision||0)>Number(x.revision||0); }); }).filter(function (x) { return (x.lifecycle === 'pending' || (x.lifecycle === 'claimed' && new Date(x.lease_until || 0).getTime() <= now)) && x.payload && new Date(x.payload.time).getTime() <= now; }); }); }
  function retire(row,reason,out) { try { CT_GAS_STATE.invalid(row.id,reason); CT_GAS_STATE.event('wake_retired',{wake_id:row.id,work_order_id:row.payload&&row.payload.work_order_id,continuation_id:row.payload&&row.payload.continuation_id,operation:'wake-recovery',reason:reason,general_compute_requested:false}); } catch (_) {} out.push({status:'retired',wake_id:row.id,work_order_id:row.payload&&row.payload.work_order_id,reason:reason}); }
  return { registry:registry, ensure:ensure, schedule:schedule, due:due, retire:retire };
}());
function diagnoseFeedbackInbox() {
  var props=PropertiesService.getScriptProperties();
  return {
    script_id:ScriptApp.getScriptId(),
    feedback_spreadsheet_id:props.getProperty('CT_GAS_FEEDBACK_SPREADSHEET_ID'),
    feedback_sheet_name:props.getProperty('CT_GAS_FEEDBACK_SHEET_NAME'),
    feedback_ready:props.getProperty('CT_GAS_FEEDBACK_READY')
  };
}
function gasSafetyWake() { var now=Date.now(), budget=CT_GAS.budgetMs(PropertiesService.getScriptProperties().getProperty('CT_GAS_BUDGET_MS')), clock=CT_GAS.clock(now,budget), out=[]; var ensured=CT_GAS.runGuard(clock,'trigger-ensure',CT_GAS.OPERATION_BUDGETS.trigger,CT_GAS_TRIGGER.ensure); if (ensured.status==='preempted') return [{status:'interrupted',reason:'insufficient-budget-for-trigger'}];
   /* The human feedback sheet is polled before runtime wakes so accepted messages become durable work. */
     try {
       if (typeof reconcileFeedbackSheet === 'function' && clock.canStart(CT_GAS.OPERATION_BUDGETS.stateRead)) {
         var feedbackProps=PropertiesService.getScriptProperties(), feedbackSpreadsheetId=feedbackProps.getProperty('CT_GAS_FEEDBACK_SPREADSHEET_ID'), feedbackSheetName=feedbackProps.getProperty('CT_GAS_FEEDBACK_SHEET_NAME')||'Feedback';
         try { CT_GAS_STATE.event('feedback_poll_started',{operation:'feedback-poll',source:'feedback-sheet',trigger:'gasSafetyWake',script_id:ScriptApp.getScriptId(),feedback_spreadsheet_configured:Boolean(feedbackSpreadsheetId),feedback_sheet_name:feedbackSheetName,trigger_handlers:CT_GAS_TRIGGER.registry().filter(function(x){return x.handler==='gasSafetyWake';}).length,general_compute_requested:false}); } catch (_) {}
          var feedbackResult=reconcileFeedbackSheet(clock);
          out.push({feedback:feedbackResult});
          try { CT_GAS_STATE.event('feedback_poll_result',{operation:'feedback-poll',source:'feedback-sheet',trigger:'gasSafetyWake',script_id:ScriptApp.getScriptId(),feedback_spreadsheet_configured:Boolean(feedbackSpreadsheetId),feedback_sheet_name:feedbackSheetName,header_ok:!!(feedbackResult&&feedbackResult.sheet&&feedbackResult.sheet.header_ok),header_row:feedbackResult&&feedbackResult.sheet?feedbackResult.sheet.header_row:0,admitted_count:feedbackResult&&feedbackResult.admitted?feedbackResult.admitted.length:0,admitted_rows:feedbackResult&&feedbackResult.admitted?feedbackResult.admitted.map(function(x){return x.row;}):[],admitted_work_order_ids:feedbackResult&&feedbackResult.admitted?feedbackResult.admitted.map(function(x){return x.work_order_id;}):[],failed_count:feedbackResult&&feedbackResult.admitted?feedbackResult.admitted.filter(function(x){return x.status==='failed';}).length:0,synced_count:feedbackResult&&feedbackResult.synced?feedbackResult.synced.length:0,general_compute_requested:false}); } catch (_) {}
       }
     } catch (e) {
        try { CT_GAS_STATE.event('feedback_poll_error',{operation:'feedback-poll',source:'feedback-sheet',trigger:'gasSafetyWake',script_id:ScriptApp.getScriptId(),error:CT_GAS.bound(e.message||e,400),general_compute_requested:false}); } catch (_) {}
        out.push({feedback:{status:'deferred',error:String(e.message||e)}});
      }
     try { if (clock.canStart(CT_GAS.OPERATION_BUDGETS.observer)) observePendingEvidence(clock); } catch (_) {}
     try { if (PropertiesService.getScriptProperties().getProperty('CT_GAS_FEDERATION_DATA_API_URL') && clock.canStart(CT_GAS.OPERATION_BUDGETS.trigger)) dispatchPendingFederationAdvisories(clock); } catch (_) {}
     try {
       var seen={}, orders=CT_GAS_STATE.list('work_orders');
       for (var oi=0;oi<orders.length;oi++) {
         if (!clock.canStart(CT_GAS.OPERATION_BUDGETS.trigger)) break;
         if (seen[orders[oi].id]) continue; seen[orders[oi].id]=true;
         var order=CT_GAS_STATE.get('work_orders',orders[oi].id);
         if (!order||order.lifecycle==='completed'||order.lifecycle==='invalid') continue;
         // GitHub proof entry points own their separate dispatch/inspection wait.
         if (order.payload&&order.payload.step==='github') continue;
         // Cutover fence: objectives owned by the new path are never advanced here.
         if (typeof CT_GAS_MIGRATION!=='undefined'&&!CT_GAS_MIGRATION.legacyAdvanceAllowed(order.id)) continue;
         if (!isGasDiagnosticOrder(order)) { waitForGasObjectiveCapacity(order.id); continue; }
         if (order.lifecycle!=='checkpointed'&&order.lifecycle!=='deferred') continue;
         var cp=CT_GAS_STATE.latestContinuation(order.id);
         if (!cp) continue;
         // Any existing wake for this cursor, including a retired one, is a durable
         // scheduling decision. Do not resurrect historical revisions or terminals.
         var wakes=CT_GAS_STATE.list('wakes').filter(function (w) { return w.payload&&w.payload.work_order_id===order.id&&w.payload.continuation_id===cp.continuation_id; });
         if (!wakes.length) CT_GAS_TRIGGER.schedule({time:new Date(now+1000).toISOString(),reason:order.lifecycle==='deferred'?'model-deferred':'recovery',work_order_id:order.id,execution_id:cp.execution_id,continuation_id:cp.continuation_id,launch:cp.launch_context,resume:cp.resume_context},clock);
       }
     } catch (_) {}
     var rows=CT_GAS_TRIGGER.due(now,clock); if (rows.status==='preempted') return [{status:'interrupted',reason:'insufficient-budget-for-wake-read'}]; rows=rows.slice(0,3); for (var i=0;i<rows.length;i++) { var row=rows[i], p=row.payload||{}, identity=p.work_order_id&&p.execution_id&&p.continuation_id, fence=CT_GAS.id('fence',{id:row.id,sequence:i,at:now}); try { if (!identity) { var invalid=CT_GAS_STATE.invalid(row.id,'missing-wake-identity'); var event=CT_GAS_STATE.event('invalid_wake',{wake_id:row.id,operation:'wake-dispatch',reason:'missing-wake-identity',general_compute_requested:false}); out.push({status:'invalid',wake_id:row.id,reason:'invalid-wake-identity',event_id:event.id}); continue; }
        var order=CT_GAS_STATE.get('work_orders',p.work_order_id), latest=order&&CT_GAS_STATE.latestContinuation(p.work_order_id), launch=CT_GAS.context(p.launch), selected=launch.model||(latest&&latest.launch_context&&latest.launch_context.model)||(order&&order.payload&&(order.payload.model||(order.payload.launch_context&&order.payload.launch_context.model)));
       if (typeof CT_GAS_MIGRATION!=='undefined'&&order&&!CT_GAS_MIGRATION.legacyAdvanceAllowed(order.id)) continue;
       if (order&&(order.lifecycle==='completed'||order.lifecycle==='invalid')) { CT_GAS_TRIGGER.retire(row,'work-order-'+order.lifecycle,out); continue; }
       if (order&&!isGasDiagnosticOrder(order,{launch:p.launch,resume:p.resume})) { var capacity=waitForGasObjectiveCapacity(order.id); if (capacity.status==='waiting') CT_GAS_TRIGGER.retire(row,'execution_capacity',out); else out.push(capacity); continue; }
       if (order&&order.lifecycle==='waiting') { CT_GAS_TRIGGER.retire(row,'work-order-waiting',out); continue; }
       if (latest&&(latest.execution_id!==p.execution_id||latest.continuation_id!==p.continuation_id)) { CT_GAS_TRIGGER.retire(row,'stale-continuation',out); continue; }
       if (!selected) { if (order&&(order.lifecycle==='checkpointed'||order.lifecycle==='deferred')) { try { CT_GAS_STATE.update('work_orders',order.id,{lifecycle:'waiting',payload:{wait_condition:'human',recovery_blocked_reason:'selected-model-missing'}}); } catch (_) {} } CT_GAS_TRIGGER.retire(row,'selected-model-missing',out); continue; }
        var claimed=CT_GAS.runGuard(clock,'wake-claim',CT_GAS.OPERATION_BUDGETS.stateWrite,function () { return CT_GAS_STATE.claim(row.id,'gas-safety',fence,new Date(now+budget).toISOString()); }); if (claimed.status==='preempted') break; var result=runWake({work_order_id:p.work_order_id,execution_id:p.execution_id,continuation_id:p.continuation_id,launch:p.launch,resume:p.resume,wake_id:row.id}); if (result.status==='blocked'&&result.reason==='evidence-root-configuration') { try { CT_GAS_STATE.update('work_orders',p.work_order_id,{lifecycle:'waiting',payload:{wait_condition:'configuration',recovery_blocked_reason:'evidence-root-configuration',response:'Evidence is outside the configured Drive root. Please repair CT_GAS_DRIVE_ROOT_ID or move the evidence file, then retry this work.'}}); CT_GAS_STATE.invalid(row.id,'evidence-root-configuration'); CT_GAS_STATE.event('wake_blocked',{execution_id:p.execution_id,work_order_id:p.work_order_id,wake_id:row.id,continuation_id:p.continuation_id,operation:'drive-verify',reason:'evidence-root-configuration',wait_condition:'configuration',general_compute_requested:false}); } catch (e) { result={status:'interrupted',reason:'configuration-block-uncommitted',work_order_id:p.work_order_id,error:String(e.message||e)}; } } else if (result.status==='checkpointed'||result.status==='complete') { try { var complete=CT_GAS.runGuard(clock,'wake-complete',CT_GAS.OPERATION_BUDGETS.stateWrite,function () { return CT_GAS_STATE.complete(row.id,{status:'dispatched'},'gas-safety',fence); }); if (complete.status==='preempted') result={status:'interrupted',reason:'wake-completion-uncommitted',work_order_id:p.work_order_id}; } catch (_) { result={status:'interrupted',reason:'wake-completion-failed',work_order_id:p.work_order_id}; } } out.push(result); } catch (e) { out.push({status:'deferred',wake_id:row.id,work_order_id:p.work_order_id,execution_id:p.execution_id,continuation_id:p.continuation_id,error:String(e.message||e)}); } } if (typeof reconcileFeedbackSheet === 'function') { try { if (clock.canStart(CT_GAS.OPERATION_BUDGETS.stateRead)) out.push({feedback_sync:reconcileFeedbackSheet(clock)}); } catch (_) {} } return out; }
function requestNextWake(wake) { return CT_GAS_TRIGGER.schedule(wake); }
function triggerRegistry() { return CT_GAS_TRIGGER.registry(); }
