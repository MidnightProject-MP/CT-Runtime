var CT_GAS_ACTIONS = (function () {
  function allowlist() { var raw=PropertiesService.getScriptProperties().getProperty('GITHUB_ACTION_WORKFLOW_ALLOWLIST'); if (!raw) throw new Error('GITHUB_ACTION_WORKFLOW_ALLOWLIST is required'); return raw.split(',').map(function (x) { return x.trim(); }).filter(Boolean); }
  function ref(value) { value=String(value || 'main'); if (!/^[A-Za-z0-9._/-]{1,120}$/.test(value) || value.indexOf('..') >= 0 || value[0] === '/') throw new Error('invalid GitHub ref'); return value; }
  function dispatch(workflow, branch, clock) { if (allowlist().indexOf(workflow) < 0) throw new Error('workflow is not allowlisted'); return CT_GAS_GITHUB.dispatchWorkflow(workflow,ref(branch),clock); }
  function inspectRuns(clock) { return CT_GAS_GITHUB.workflowRuns(clock); }
  return {dispatch:dispatch,inspectRuns:inspectRuns};
}());
function testExecutor() { return CT_GAS_ACTIONS; }
