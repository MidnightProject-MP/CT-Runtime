export function createSqlWorkerClient(worker,{signal,bytes,timeout=30000,startSequence=0}={}){
  const state=new Int32Array(signal),buffer=new Uint8Array(bytes);
  let sequence=startSequence;
  function request(message){
    const expected=++sequence;
    worker.postMessage({...message,sequence:expected});
    let observed=Atomics.load(state,0);
    while(observed<expected){
      if(Atomics.wait(state,0,observed,timeout)==='timed-out')throw new Error('email SQL worker response timeout');
      observed=Atomics.load(state,0);
    }
    const answer=JSON.parse(new TextDecoder().decode(buffer.subarray(0,Atomics.load(state,1))));
    if(answer.sequence!==expected)throw new Error(`email SQL worker response sequence ${answer.sequence} != ${expected}`);
    if(answer.error)throw new Error(answer.error);
    return answer.result;
  }
  return {
    request,
    sql:(sql,args)=>request({type:'sql',sql,args}),
    rawRpc:(operation,input,extra={})=>request({type:'rpc',operation,input,...extra})
  };
}
