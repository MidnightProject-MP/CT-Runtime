// Read-only operational diagnostic. Credentials and raw API records stay in memory.
import { pathToFileURL } from 'node:url';

export const PROJECT = '788761466843';
export const SCRIPT = '1Uzv-r4UW-y9XLuO-f3QEvrwzInGu1JarmqecVtwarJor6Z5qpmUD2dri';
const statuses = ['disabled','busy','uncertain','blocked','budget','idle','model-failed','checkpointed','sent','superseded','intake-unavailable','delivery-first'];
const stages = ['persisted-config','script-lock','gmail-profile','neon-health','intake','delivery','claim','model','checkpoint'];
const classes = ['transport-error','response-too-large','invalid-json','authentication-denied','authorization-denied','rate-limited','provider-unavailable','http-error','readiness-rejected','unclassified-error'];
const reasons = ['serviceDisabled','accessNotConfigured','insufficientPermissions','invalidCredentials','rateLimitExceeded','userRateLimitExceeded','SERVICE_DISABLED','ACCESS_TOKEN_SCOPE_INSUFFICIENT','CREDENTIALS_MISSING','ACCESS_TOKEN_EXPIRED','SERVICE_USAGE_DENIED','PERMISSION_DENIED','UNAUTHENTICATED','INVALID_ARGUMENT','invalid_grant','invalid_client'];
const sqlStates = ['42501','28000','28P01','22023','22P02','23505','40001','40P01','57014','53300','53400'];
const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const validTime = value => typeof value === 'string' && utc.test(value) && Number.isFinite(Date.parse(value));

export function query(from, to) {
  if (!validTime(from) || !validTime(to) || Date.parse(to) <= Date.parse(from) || Date.parse(to)-Date.parse(from) > 3600000) throw new Error('invalid-window');
  // resourceNames accepts the project number; resource.labels.project_id may be
  // its textual ID, so do not incorrectly compare that label to the number.
  return { resourceNames: [`projects/${PROJECT}`], filter: `resource.type="app_script_function" AND resource.labels.function_name="vnextEmailTick" AND timestamp>="${from}" AND timestamp<"${to}"`, orderBy: 'timestamp asc', pageSize: 50 };
}

export function metadata(entry) {
  const key=entry?.labels?.['script.googleapis.com/project_key'];
  const fn=entry?.resource?.labels?.function_name;
  return {functionNamePresent:fn!==undefined,functionName:fn==='vnextEmailTick'?'vnextEmailTick':'other',scriptKeyPresent:key!==undefined,scriptKeyMatch:key===SCRIPT,payloadShape:typeof entry?.jsonPayload?.message==='string'?'jsonmessage':typeof entry?.textPayload==='string'?'text':entry?.jsonPayload&&typeof entry.jsonPayload==='object'?'jsonobject':'other'};
}

export function sanitize(entry, from, to, reject=()=>{}) {
  const omit=reason=>{reject(reason);return null;};
  const key=entry?.labels?.['script.googleapis.com/project_key'];
  if (entry?.resource?.type !== 'app_script_function' || entry.resource.labels?.function_name !== 'vnextEmailTick') return omit('resource-mismatch');
  if (key!==undefined && key!==SCRIPT) return omit('script-mismatch');
  if (!validTime(entry.timestamp) || Date.parse(entry.timestamp)<Date.parse(from) || Date.parse(entry.timestamp)>=Date.parse(to)) return omit('timestamp-mismatch');
  const raw = entry.jsonPayload?.message ?? entry.textPayload;
  if (typeof raw !== 'string' || raw.length>16384) return omit('payload-shape');
  let record; try { record=JSON.parse(raw); } catch { return omit('invalid-json'); }
  if (!statuses.includes(record?.status) || !stages.includes(record?.stage)) return omit('unknown-tick');
  const out = { timestamp: entry.timestamp, status: record.status, stage: record.stage, identityLevel:key===SCRIPT?'script-verified':'project-function' };
  const f=record.failure;
  if (f && typeof f === 'object') {
    if (classes.includes(f.classification)) out.classification=f.classification;
    if (Number.isInteger(f.httpStatus) && f.httpStatus>=100 && f.httpStatus<=599) out.httpStatus=f.httpStatus;
    if (reasons.includes(f.providerReason)) out.providerReason=f.providerReason;
    if (sqlStates.includes(f.sqlState)) out.sqlState=f.sqlState;
  }
  return out;
}

export async function run(env, fetcher=fetch, emit=value=>console.log(JSON.stringify(value))) {
  let phase='configuration';
  try {
    const body=query(env.FROM_UTC,env.TO_UTC);
    const config=JSON.parse(env.CLASPRC_JSON);
    const credential=config.tokens?.default ?? (config.token && { ...config.token, client_id:config.oauth2ClientSettings?.clientId, client_secret:config.oauth2ClientSettings?.clientSecret });
    if (!credential || ['client_id','client_secret','refresh_token'].some(k=>typeof credential[k]!=='string'||!credential[k])) throw new Error('invalid-credentials');
    const request=async (url, options) => {
      const response=await fetcher(url,{...options,redirect:'error',signal:AbortSignal.timeout(20000)});
      let data; try { data=await response.json(); } catch { data={}; }
      if (!response.ok) {
        const candidates=[...(Array.isArray(data?.error?.details)?data.error.details.map(x=>x?.reason):[]),...(Array.isArray(data?.error?.errors)?data.error.errors.map(x=>x?.reason):[]),data?.error?.status,data?.error];
        emit({status:'access-unavailable',stage:phase,httpStatus:response.status,providerReason:candidates.find(x=>reasons.includes(x))??null});
        return null;
      }
      return data;
    };
    phase='oauth';
    const token=await request('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({grant_type:'refresh_token',client_id:credential.client_id,client_secret:credential.client_secret,refresh_token:credential.refresh_token})});
    if (!token) return false;
    if (typeof token.access_token!=='string'||!token.access_token) throw new Error('missing-token');
    phase='logging';
    let matched=0,rawEntriesReturned=0,truncated=false;
    const rejected={},groups=new Map();
    const aggregate=entry=>{const safe=metadata(entry),key=JSON.stringify(safe);groups.set(key,{...safe,count:(groups.get(key)?.count??0)+1});};
    const list=body=>request('https://logging.googleapis.com/v2/entries:list',{method:'POST',headers:{Authorization:`Bearer ${token.access_token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
    for (let page=0;page<2;page++) {
      const result=await list(body);
      if (!result) return false;
      if (result.entries!==undefined && !Array.isArray(result.entries)) throw new Error('invalid-entries');
      rawEntriesReturned+=(result.entries??[]).length;
      for (const entry of (result.entries??[]).slice(0,50)) { aggregate(entry);const safe=sanitize(entry,env.FROM_UTC,env.TO_UTC,reason=>{rejected[reason]=(rejected[reason]??0)+1;});if(safe){emit(safe);matched++;} }
      truncated=!!result.nextPageToken;
      if (!result.nextPageToken || page===1) break;
      if (typeof result.nextPageToken!=='string'||result.nextPageToken.length>8192) throw new Error('invalid-pagination');
      body.pageToken=result.nextPageToken;
    }
    emit({status:'read-complete',rawEntriesReturned,recognized:matched,truncated,sanitizerReasons:rejected,metadata:[...groups.values()]});
    if (rawEntriesReturned===0) {
      // One metadata-only fallback. Never parse or emit these payloads.
      phase='logging-metadata';
      const fallback=query(env.FROM_UTC,env.TO_UTC);
      fallback.filter=fallback.filter.replace(' AND resource.labels.function_name="vnextEmailTick"','');
      const result=await list(fallback);if(!result)return false;
      if (result.entries!==undefined && !Array.isArray(result.entries)) throw new Error('invalid-entries');
      groups.clear();for(const entry of (result.entries??[]).slice(0,50))aggregate(entry);
      emit({status:'metadata-complete',rawEntriesReturned:(result.entries??[]).length,truncated:!!result.nextPageToken,metadata:[...groups.values()]});
    }
    return true;
  } catch { emit({status:'access-unavailable',stage:phase});return false; }
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  if (!await run(process.env)) process.exitCode=1;
}
