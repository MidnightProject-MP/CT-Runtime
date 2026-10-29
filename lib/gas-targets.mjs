export const PRODUCTION_SCRIPT_ID = '1Uzv-r4UW-y9XLuO-f3QEvrwzInGu1JarmqecVtwarJor6Z5qpmUD2dri';
export const PRODUCTION_DEPLOYMENT_ID = 'AKfycbwyFPC55MvhCfPUmBlfm7eRp-uHr5tpZ2H9suobETGXod_hLLVDQtC9DelC7ee_WSNawg';

export function isProductionTarget(scriptId, deploymentId) {
  return scriptId === PRODUCTION_SCRIPT_ID || deploymentId === PRODUCTION_DEPLOYMENT_ID;
}
