import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const request=JSON.parse(await readFile(process.env.CT_VNEXT_REQUEST_FILE,'utf8'));
const value=request.workUnit.last_turn ? '2' : '1';
await writeFile('outcome.txt',value);
if(await readFile('outcome.txt','utf8')!==value) throw new Error('verification failed');
const evidence=[{kind:'file',path:'outcome.txt',sha256:createHash('sha256').update(value).digest('hex')}];
const result={objective_id:request.workUnit.objective_ref,summary:value==='1'?'First increment checked.':'Two checked increments complete.',learned:'The previous turn was reconstructed from durable storage.',outcome_evidence:evidence,
 ...(value==='1'?{disposition:'continue',continuation:{mode:'immediate',next_action:'Make and check the second increment.'}}:{disposition:'done'})};
await writeFile(process.env.CT_VNEXT_RESULT_FILE,JSON.stringify(result));
