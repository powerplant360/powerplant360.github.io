const fs=require('fs'),vm=require('vm'),assert=require('assert'),{stripTypeScriptTypes}=require('module');
const elements={};const doc={getElementById:id=>elements[id]||(elements[id]={})};
let calls=0,resolvePending;
const cfg={supabaseUrl:'https://example.supabase.co',supabaseKey:'public'};
const window={pp360SearchUserId:'owner',PP360_CONFIG:cfg,pp360Supabase:{auth:{getSession:async()=>({data:{session:{access_token:'test'}}})}}};
const batch=(n)=>Array.from({length:3},(_,i)=>({question:`Question ${n}-${i}?`,answer:['Check <safe>','Assess','Act','Verify'],focus:'Focus'}));
const ctx={window,document:doc,AbortSignal,console,pp360CanUseMockInterview:()=>true,norm:s=>s.toLowerCase(),esc:s=>String(s).replace(/</g,'&lt;'),fetch:async(url,options)=>{calls++;const b=JSON.parse(options.body);return {ok:true,json:async()=>({questions:batch(calls),department:b.department,designation:b.designation})};}};
vm.createContext(ctx);const s=fs.readFileSync('app.js','utf8');vm.runInContext(s.slice(s.indexOf('// AI interview sessions'),s.indexOf('function equipmentPage(e)')),ctx);
(async()=>{
for(const role of ['Plant Head','Operations Manager','Shift Incharge','Engineer','Operator'])for(const department of ['Operation','Mechanical','Electrical','C&I']){
 vm.runInContext(`interviewState.role=${JSON.stringify(role)};interviewState.department=${JSON.stringify(department)};renderMockInterview()`,ctx);
 await vm.runInContext('generateInterviewQuestions()',ctx);
 assert(elements.view.innerHTML.includes('Question 1'));
 elements.interviewDraft.oninput({target:{value:'draft <safe>'}});
 elements.interviewNext.onclick();elements.interviewPrevious.onclick();assert(elements.view.innerHTML.includes('draft &lt;safe>'));
 elements.interviewNext.onclick();elements.interviewNext.onclick();await vm.runInContext('generateInterviewQuestions()',ctx);
 assert.equal(vm.runInContext('interviewSession().questions.length',ctx),6);assert.equal(vm.runInContext('interviewSession().index',ctx),3);
}
// Failure retains the old question and draft, and exposes retry.
ctx.fetch=async()=>({ok:false,json:async()=>({error:'API quota exhausted'})});
await vm.runInContext('generateInterviewQuestions()',ctx);assert(elements.view.innerHTML.includes('API quota exhausted'));assert.equal(vm.runInContext('interviewSession().questions.length',ctx),6);
// Account changes discard in-memory practice history.
window.pp360SearchUserId='different';vm.runInContext('renderMockInterview()',ctx);assert.equal(vm.runInContext('interviewSession().questions.length',ctx),0);
console.log('PASS: 20 combinations; continued batches, cached navigation, drafts, failures and account isolation.');
// Test the real edge handler with mocked Supabase/OpenAI dependencies.
let handler,aiCalls=0,verifiedEmail='raghuvarma06@gmail.com',role='admin',usageRows=[];
const edgeContext={Request,Response,AbortSignal,console,crypto:global.crypto,Deno:{env:{get:k=>({SUPABASE_URL:'https://example.test',SUPABASE_ANON_KEY:'anon',SUPABASE_SERVICE_ROLE_KEY:'server',OPENAI_API_KEY:'test-secret'}[k])},serve:fn=>handler=fn},createClient:()=>({auth:{getUser:async()=>({data:{user:{id:'owner',email:verifiedEmail,email_confirmed_at:'yes'}}})},from:table=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{role}})})}),insert:async row=>{usageRows.push(row);return {error:null};}})}),fetch:async(url,options)=>{aiCalls++;const body=JSON.parse(options.body);assert(body.store===false);assert(body.text.format.strict);return {ok:true,json:async()=>({status:'completed',output_text:JSON.stringify({questions:batch(aiCalls)}),usage:{input_tokens:100,output_tokens:100}})};}};
vm.createContext(edgeContext);const edge=fs.readFileSync('supabase/functions/mock-interview/index.ts','utf8').replace(/^import .*\n/,'');vm.runInContext(stripTypeScriptTypes(edge),edgeContext);
const req=(body,auth=true)=>new Request('https://example.test',{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer test'}:{})},body:JSON.stringify(body)});
assert.equal((await handler(req({},false))).status,401);verifiedEmail='other@example.test';assert.equal((await handler(req({}))).status,403);verifiedEmail='raghuvarma06@gmail.com';role='viewer';assert.equal((await handler(req({}))).status,403);role='admin';assert.equal(aiCalls,0);
assert.equal((await handler(req({department:'Boiler',designation:'Operator'}))).status,400);
for(const designation of ['Plant Head','Operations Manager','Shift Incharge','Engineer','Operator'])for(const department of ['Operation','Mechanical','Electrical','C&I']){const response=await handler(req({department,designation}));assert.equal(response.status,200);assert.equal((await response.json()).questions.length,3);}
assert.equal(usageRows.length,20);console.log('PASS: edge owner/Admin enforcement, invalid inputs, all 20 AI request schemas and usage tracking.');
})().catch(e=>{console.error(e);process.exitCode=1;});
