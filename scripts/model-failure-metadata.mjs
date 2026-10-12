// Read-side projection; never return arbitrary stored JSON to an operator.
export function modelFailureMetadata(value){
 const out={};if(!value||typeof value!=='object')return out;
 const enums={classification:['transport-error','response-too-large','invalid-json','authentication-denied','authorization-denied','rate-limited','provider-unavailable','http-error','model-validation','unclassified-error'],code:['budget-before','budget-after','embedded-provider-error','missing-choice','missing-content','empty-content','truncated','content-filter','non-json','malformed-contract','field-bounds','utf8-byte-bounds','invalid-text'],finishReason:['stop','length','content_filter','tool_calls','function_call','unknown']};
 for(const [k,allowed] of Object.entries(enums))if(allowed.includes(value[k]))out[k]=value[k];
 if(Number.isInteger(value.httpStatus)&&value.httpStatus>=100&&value.httpStatus<=599)out.httpStatus=value.httpStatus;
 for(const k of ['contentChars','contractBytes'])if(Number.isInteger(value[k])&&value[k]>=0&&value[k]<=1000000)out[k]=value[k];
 for(const k of ['choicePresent','contentPresent'])if(typeof value[k]==='boolean')out[k]=value[k];
 return out;
}
