import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler as actionHandler } from '../candidate/edge/microsoft-action/handler.ts';
import { createHandler as runnerHandler } from '../candidate/edge/workflow-runner/handler.ts';
import { createHandler as resumeHandler } from '../candidate/edge/workflow-resume/handler.ts';
import { executeTrustedWorkflow } from '../candidate/edge/_shared/approved-workflow.ts';
import { connectionBinding } from '../candidate/edge/_shared/microsoft-connection.ts';

// In-memory adapter. It validates route behavior, not PostgreSQL locking/RLS semantics.
// Network is forbidden. Every actual production handler request is intercepted here.
globalThis.fetch = async () => { throw new Error('Real network forbidden in offline tests'); };
const clone = value => structuredClone(value);
const now = () => Date.parse('2026-10-08T12:00:00Z');
const mail = { to: 'person@example.test', subject: 'Reviewed subject', message: 'Reviewed body' };
function fixture() {
  const connection = { id: 'connection', organization_id: 'org', integration_id: 'integration', provider: 'microsoft', status: 'Connected', tenant_id: 'tenant', client_id: 'client', external_account_id: 'account', scopes: ['User.Read', 'Mail.Send'], access_secret_id: 'access', refresh_secret_id: 'refresh', client_secret_id: 'secret', oauth_verified_version: 1, oauth_revision: 'revision' };
  const integration = { id: 'integration', organization_id: 'org', provider: 'Microsoft', integration_type: 'OAuth', status: 'Connected', oauth_revision: 'integration-revision', scopes: 'User.Read Mail.Send' };
  return {
    userId: 'approver', events: [], fail: {}, overrides: {}, graph: [], tokenCalls: 0,
    tables: {
      action_requests: [{ id: 'request', organization_id: 'org', integration_id: 'integration', connection_id: 'connection', provider: 'microsoft', action_type: 'send_email', status: 'Approved', requested_by: 'requestor', approved_by: 'approver', approved_at: new Date(now()).toISOString(), approval_guard_version: 1, approved_connection_binding: connectionBinding(connection, integration), payload: clone(mail), workflow_run_id: null }],
      organization_members: [{ organization_id: 'org', user_id: 'approver', role: 'admin' }, { organization_id: 'org', user_id: 'requestor', role: 'member' }], staff_accounts: [], oauth_connections: [connection], integrations: [integration], workflow_runs: [],
      workflow_definitions: [{ id: 'workflow', organization_id: 'org', status: 'Active', updated_at: 'frozen-revision', steps: [{ type: 'note', text: 'Prepared' }] }], audit_events: [], integration_runs: [],
    },
  };
}
function mock(state) {
  const supabase = {
    auth: { getUser: async jwt => { state.events.push(['auth', jwt]); return state.authError ? { error: {} } : { data: { user: { id: state.userId, is_anonymous: state.anonymous === true } }, error: null }; } },
    from(table) {
      let op = 'select', value, filters = [];
      const query = {
        select() { return query; }, eq(key, val) { filters.push([key,val]); return query; },
        insert(val) { op = 'insert'; value = val; return query; }, update(val) { op = 'update'; value = val; return query; },
        async run(single, maybe = false) {
          state.events.push([table, op, clone(value), clone(filters)]);
          if (state.fail[`${table}:${op}`]) return { data: null, error: { message: 'injected storage error' } };
          const rows = state.tables[table] || (state.tables[table] = []);
          let matches = rows.filter(row => filters.every(([key,val]) => row[key] === val));
          if (op === 'insert') { const row = { id: `${table}-${rows.length}`, ...clone(value) }; rows.push(row); matches = [row]; }
          if (op === 'update') for (const row of matches) Object.assign(row, clone(value));
          if (single && matches.length !== 1) return maybe && matches.length === 0 ? { data: null, error: null } : { data: null, error: { message: 'cardinality' } };
          return { data: clone(single ? matches[0] : matches), error: null };
        },
        single() { return query.run(true); }, maybeSingle() { return query.run(true,true); }, then(resolve,reject) { return query.run(false).then(resolve,reject); },
      };
      return query;
    },
    async rpc(name,args) {
      state.events.push(['rpc', name, clone(args)]);
      if (Object.hasOwn(state.overrides,name)) { const override = state.overrides[name]; return typeof override === 'function' ? override(args) : clone(override); }
      if (name === 'assert_agent_workflow_lineage') { const run=state.tables.workflow_runs.find(r=>r.id===args.p_run_id); return {data:run?.agent_run_request_id?{agent_request_id:run.agent_run_request_id}:null,error:null}; }
      if (name === 'finish_agent_workflow') return {data:true,error:null};
      if (name === 'claim_microsoft_action') {
        const row = state.tables.action_requests.find(row => row.id === args.request_id);
        if (!row || row.status !== 'Approved') return { error: {}, data: null };
        row.status = 'Executing'; return { error: null, data: clone(row) };
      }
      if (name === 'record_microsoft_attempt') { state.receipts ||= []; state.receipts.push(clone(args)); return { data: true, error: null }; }
      if (name === 'create_trusted_workflow_run') {
        const workflow = state.tables.workflow_definitions.find(w => w.id === args.p_workflow_id);
        if (!workflow) return { error: {}, data: null };
        const run = { id: 'run', organization_id: workflow.organization_id, workflow_id: workflow.id, status: 'Running', current_step: 0, initiated_by: args.p_actor_id, workflow_revision: workflow.updated_at, workflow_steps: clone(workflow.steps), workflow_context: clone(args.p_context), context: clone(args.p_context) };
        state.tables.workflow_runs.push(run); return { data: clone(run), error: null };
      }
      if (name === 'claim_workflow_continuation') {
        const run = state.tables.workflow_runs.find(run => run.id === args.p_run_id);
        if (!run || run.status !== 'Waiting Approval') return { data: null, error: {} };
        run.status = 'Running'; return { data: clone(run), error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    },
  };
  const fetchImpl = async (url, options) => {
    state.events.push(['fetch', url]); state.graph.push({ url, options });
    if (state.fetchImpl) return state.fetchImpl(url, options);
    return url.endsWith('/sendMail') ? new Response(null, { status: 202, headers: { 'request-id': 'provider-receipt' } }) : new Response(JSON.stringify({ ok: true, status: 'Success', result: {}, summary: 'Read complete' }), { status: 200 });
  };
  return { supabase, supabaseUrl: 'https://local.test', fetchImpl, now, getToken: async () => { state.tokenCalls++; if (state.tokenError) throw new Error('private credentials error'); return 'fake-token'; } };
}
const request = body => new Request('https://local.test/handler', { method: 'POST', headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function invoke(factory, state, body) { const response = await factory(mock(state))(request(body)); return { response, body: await response.json() }; }
const execute = state => invoke(actionHandler, state, { op: 'execute', request_id: 'request' });
const queryEvents = (s,table,op) => s.events.filter(e => e[0] === table && e[1] === op);

test('manual queue preserves real pending proposal and never dispatches', async () => {
 const s=fixture(); const out=await invoke(actionHandler,s,{op:'queue-email',organization_id:'org',...mail});
 assert.equal(out.response.status,200); assert.equal(out.body.request.status,'Pending'); assert.equal(out.body.request.requested_by,'approver'); assert.equal(out.body.request.workflow_run_id,null); assert.deepEqual(out.body.request.payload,mail); assert.equal(s.graph.length,0);
});
for (const field of ['workflow_run_id','approved_by','status','agent_run_request_id','connection_id']) test(`manual queue rejects client-forged ${field}`,async()=>{
 const s=fixture(); const out=await invoke(actionHandler,s,{op:'queue-email',organization_id:'org',...mail,[field]:'forged'}); assert.equal(out.response.status,400); assert.equal(queryEvents(s,'action_requests','insert').length,0);
});
test('self approval is denied with no mutation',async()=>{
 const s=fixture(); s.tables.action_requests[0].status='Pending'; s.tables.action_requests[0].requested_by=s.userId;
 const out=await invoke(actionHandler,s,{op:'approve',request_id:'request'}); assert.equal(out.response.status,403); assert.equal(queryEvents(s,'action_requests','update').length,0);
});
test('distinct authorized approver approves pending using conditional write',async()=>{
 const s=fixture(); s.tables.action_requests[0].status='Pending'; const out=await invoke(actionHandler,s,{op:'approve',request_id:'request'}); assert.equal(out.response.status,200); assert.equal(out.body.request.approved_by,'approver'); assert(queryEvents(s,'action_requests','update')[0][3].some(([k,v])=>k==='status'&&v==='Pending')); assert.equal(s.graph.length,0);
});
test('review fails closed when conditional write cannot be confirmed',async()=>{
 const s=fixture(); s.tables.action_requests[0].status='Pending'; s.fail['action_requests:update']=true; const out=await invoke(actionHandler,s,{op:'reject',request_id:'request'}); assert.equal(out.response.status,409);
});
test('authorization storage failure does not become implied permission',async()=>{
 const s=fixture();s.fail['organization_members:select']=true; const out=await execute(s);assert.equal(out.response.status,503);assert.equal(s.graph.length,0);
});
test('claim failure never obtains token or dispatches',async()=>{
 const s=fixture();s.overrides.claim_microsoft_action={data:null,error:{}};const out=await execute(s); assert.equal(out.response.status,409);assert.equal(s.tokenCalls,0);assert.equal(s.graph.length,0);
});
for (const data of [null,false,{},1,'true']) test(`Dispatching requires literal true, got ${JSON.stringify(data)}`,async()=>{
 const s=fixture();s.overrides.record_microsoft_attempt={data,error:null};const out=await execute(s);assert.equal(out.response.status,202);assert.equal(out.body.ok,false);assert.equal(out.body.retryable,false);assert.equal(s.graph.length,0);assert.equal(s.tables.action_requests[0].status,'Executing');
});
test('dispatch order is claim then token then acknowledged durable Dispatching then Graph',async()=>{
 const s=fixture();const out=await execute(s);assert.equal(out.response.status,200);assert.equal(out.body.outcome,'provider_accepted');assert.equal(out.body.delivered,false);assert.equal(s.graph.length,1); const claim=s.events.findIndex(e=>e[0]==='rpc'&&e[1]==='claim_microsoft_action');const dispatch=s.events.findIndex(e=>e[0]==='rpc'&&e[1]==='record_microsoft_attempt'&&e[2].p_phase==='Dispatching');const graph=s.events.findIndex(e=>e[0]==='fetch');assert(claim<dispatch&&dispatch<graph);assert.equal(s.receipts[1].p_phase,'ProviderAccepted');assert.equal(s.receipts[1].p_provider_reference,'provider-receipt'); assert.equal(s.graph[0].options.redirect,'error'); assert.deepEqual(JSON.parse(s.graph[0].options.body).message,{subject:mail.subject,body:{contentType:'Text',content:mail.message},toRecipients:[{emailAddress:{address:mail.to}}]});
});
for(const change of ['scope','account','integration','tenant','revision'])test(`changed ${change} invalidates frozen approved identity`,async()=>{
 const s=fixture();const c=s.tables.oauth_connections[0];if(change==='scope')c.scopes.push('Mail.Read');if(change==='account')c.external_account_id='different';if(change==='integration')s.tables.integrations[0].oauth_revision='different';if(change==='tenant')c.tenant_id='different';if(change==='revision')c.oauth_revision='different';const out=await execute(s);assert.equal(out.response.status,202);assert.equal(s.tokenCalls,0);assert.equal(s.graph.length,0);
});
test('token failure leaves nonretryable claimed predispatch state',async()=>{
 const s=fixture();s.tokenError=true;const out=await execute(s);assert.equal(out.response.status,202);assert.equal(out.body.outcome,'not_dispatched_needs_reconciliation');assert.equal(s.graph.length,0);assert(!JSON.stringify(out.body).includes('private credentials'));
});
for (const status of [200,201,400,401,429,500]) test(`unexpected Graph ${status} remains unresolved and never resets`,async()=>{
 const s=fixture();s.fetchImpl=async()=>new Response(null,{status});const out=await execute(s);assert.equal(out.response.status,202);assert.equal(out.body.ok,false);assert.equal(out.body.outcome,'unknown');assert.equal(s.tables.action_requests[0].status,'Executing');assert.equal(s.receipts.length,1);
});
test('network uncertainty never sends twice on repeated execution',async()=>{
 const s=fixture();s.fetchImpl=async()=>{throw new Error('timeout')};const first=await execute(s);const second=await execute(s);assert.equal(first.response.status,202);assert.equal(second.response.status,409);assert.equal(s.graph.length,1);assert.equal(s.tables.action_requests[0].status,'Executing');
});
test('provider accepted receipt failure returns accepted pending without retry',async()=>{
 const s=fixture();s.overrides.record_microsoft_attempt=args=>({data:args.p_phase==='Dispatching'?true:null,error:args.p_phase==='ProviderAccepted'?{}:null});const out=await execute(s);assert.equal(out.response.status,202);assert.equal(out.body.provider_accepted,true);assert.equal(s.tables.action_requests[0].status,'Executing');assert.equal(s.graph.length,1);
});
test('completion failure preserves ProviderAccepted receipt',async()=>{
 const s=fixture();s.fail['action_requests:update']=true;const out=await execute(s);assert.equal(out.response.status,202);assert.equal(s.receipts.at(-1).p_phase,'ProviderAccepted');assert.equal(s.tables.action_requests[0].status,'Executing');
});
test('audit failure does not erase provider acceptance or reclassify send',async()=>{
 const s=fixture();s.fail['audit_events:insert']=true;s.fail['integration_runs:insert']=true;const out=await execute(s);assert.equal(out.response.status,200);assert.equal(out.body.audit_pending,true);assert.equal(s.tables.action_requests[0].status,'Executed');assert.equal(s.receipts.at(-1).p_phase,'ProviderAccepted');
});
for(const result of ['throw',202,500])test(`workflow resume ${result} leaves accepted email Executed`,async()=>{
 const s=fixture();s.tables.action_requests[0].workflow_run_id='run';waitingRun(s);s.fetchImpl=async url=>{if(url.endsWith('/sendMail'))return new Response(null,{status:202});if(result==='throw')throw new Error('resume unavailable');return new Response(JSON.stringify({ok:true,status:'Success'}),{status:result})};const out=await execute(s);assert.equal(out.response.status,200);assert.equal(out.body.workflow_status,'Needs review');assert.equal(s.tables.action_requests[0].status,'Executed');assert.equal(s.receipts.at(-1).p_phase,'ProviderAccepted');assert.equal(s.graph.filter(x=>x.url.endsWith('/sendMail')).length,1);
});

test('manual note workflow uses trusted creation snapshot and completes',async()=>{
 const s=fixture();const out=await invoke(runnerHandler,s,{workflow_id:'workflow',context:{customer:'Known'}});assert.equal(out.response.status,200);assert.equal(out.body.status,'Success');assert.equal(s.tables.workflow_runs[0].workflow_context.customer,'Known');assert.equal(s.graph.length,0);assert(s.events.some(e=>e[0]==='rpc'&&e[1]==='create_trusted_workflow_run'));
});
for(const context of [{agent_run_request_id:'fake'},{outputs:[]},{action_request_id:'fake'},{nested:[[{agent_id:'fake'}]]},{nested:{approved_by:'fake'}}])test(`manual workflow rejects forged lineage ${JSON.stringify(context)}`,async()=>{
 const s=fixture();const out=await invoke(runnerHandler,s,{workflow_id:'workflow',context});assert.equal(out.response.status,400);assert.equal(s.tables.workflow_runs.length,0);assert.equal(s.graph.length,0);
});
test('unsupported later operation fails closed before any earlier read',async()=>{
 const s=fixture();s.tables.workflow_definitions[0].steps=[{type:'microsoft.health'},{type:'microsoft.send-email'}];const out=await invoke(runnerHandler,s,{workflow_id:'workflow'});assert.equal(out.response.status,409);assert.equal(s.graph.length,0);assert.equal(s.tables.workflow_runs[0].status,'Error');
});
test('trusted workflow queues linked pending proposal without public queue endpoint',async()=>{
 const s=fixture();s.tables.workflow_definitions[0].steps=[{type:'approval.email',to:'{{contact.email}}',subject:mail.subject,message:mail.message},{type:'note',text:'Later'}];const out=await invoke(runnerHandler,s,{workflow_id:'workflow',context:{contact:{email:mail.to}}});assert.equal(out.response.status,200);assert.equal(out.body.status,'Waiting Approval');const action=s.tables.action_requests.at(-1);assert.equal(action.status,'Pending');assert.equal(action.workflow_run_id,'run');assert.equal(action.requested_by,'approver');assert.deepEqual(action.payload,mail);assert.equal(s.graph.length,0);assert.equal(s.tables.workflow_runs[0].context.action_request_id,action.id);
});
test('Microsoft read 202 does not count as workflow completion',async()=>{
 const s=fixture();s.tables.workflow_definitions[0].steps=[{type:'microsoft.profile'}];s.fetchImpl=async()=>new Response(JSON.stringify({ok:true}),{status:202});const out=await invoke(runnerHandler,s,{workflow_id:'workflow'});assert.equal(out.response.status,502);assert.equal(s.tables.workflow_runs[0].status,'Error');
});
test('resume rejects client context and forged continuation fields',async()=>{
 const s=fixture();const out=await invoke(resumeHandler,s,{run_id:'run',context:{action_request_id:'forged'}});assert.equal(out.response.status,400);assert.equal(s.events.filter(e=>e[0]==='rpc').length,0);
});
test('continuation claim rejection has no side effects',async()=>{
 const s=fixture();s.overrides.claim_workflow_continuation={data:null,error:{}};const out=await invoke(resumeHandler,s,{run_id:'run'});assert.equal(out.response.status,409);assert.equal(s.graph.length,0);assert.equal(queryEvents(s,'workflow_runs','update').length,0);
});
function waitingRun(s) {const run={id:'run',organization_id:'org',workflow_id:'workflow',status:'Waiting Approval',current_step:0,initiated_by:'requestor',workflow_revision:'frozen-revision',workflow_steps:[{type:'approval.email',...mail},{type:'note',text:'Frozen next step'}],workflow_context:{customer:'Frozen'},context:{customer:'changed',action_request_id:'request',outputs:[]}};s.tables.workflow_runs.push(run);return run;}
test('continuation executes frozen steps and context, never live edits',async()=>{
 const s=fixture();const run=waitingRun(s);s.tables.workflow_definitions[0].steps=[{type:'unknown'}];const out=await invoke(resumeHandler,s,{run_id:'run'});assert.equal(out.response.status,200);assert.equal(out.body.outputs[0].summary,'Frozen next step');assert.equal(run.context.customer,'Frozen');assert.equal(run.status,'Success');
});
test('continuation queues next approval with original initiator as requester',async()=>{
 const s=fixture();const run=waitingRun(s);run.workflow_steps.push({type:'approval.email',...mail});const out=await invoke(resumeHandler,s,{run_id:'run'});assert.equal(out.response.status,200);assert.equal(out.body.status,'Waiting Approval');assert.equal(s.tables.action_requests.at(-1).requested_by,'requestor');
});
test('workflow persistence failure cannot be reported successful',async()=>{
 const s=fixture();s.fail['workflow_runs:update']=true;const out=await invoke(runnerHandler,s,{workflow_id:'workflow'});assert.equal(out.response.status,503);assert.equal(out.body.ok,false);
});
test('all entrypoints refuse malformed authentication without data access',async()=>{
 for(const factory of [actionHandler,runnerHandler,resumeHandler]){const s=fixture();const out=await factory(mock(s))(new Request('https://local.test',{method:'POST',body:'{}'}));assert.equal(out.status,401);assert.equal(s.events.length,0);}
});

test('anonymous authenticated sessions cannot queue, approve, execute or run workflows',async()=>{
 for(const [factory,body] of [[actionHandler,{op:'queue-email',organization_id:'org',...mail}],[actionHandler,{op:'approve',request_id:'request'}],[actionHandler,{op:'execute',request_id:'request'}],[runnerHandler,{workflow_id:'workflow'}],[resumeHandler,{run_id:'run'}]]){const s=fixture();s.anonymous=true;const out=await invoke(factory,s,body);assert.equal(out.response.status,401);assert.equal(s.events.length,1);}
});

test('linked action cannot fall back to manual lineage before credentials',async()=>{
 const s=fixture();s.tables.action_requests[0].workflow_run_id='run';const run=waitingRun(s);run.agent_run_request_id='agent-request';s.overrides.assert_agent_workflow_lineage={data:null,error:null};const out=await execute(s);assert.equal(out.response.status,202);assert.equal(s.tokenCalls,0);assert.equal(s.graph.length,0);
});
test('linked workflow assertion error stops before credentials or Graph',async()=>{
 const s=fixture();s.tables.action_requests[0].workflow_run_id='run';waitingRun(s);s.overrides.assert_agent_workflow_lineage={data:null,error:{}};const out=await execute(s);assert.equal(out.response.status,202);assert.equal(s.tokenCalls,0);assert.equal(s.graph.length,0);
});
test('lineage revoked after token acquisition blocks Dispatching and Graph',async()=>{
 const s=fixture();s.tables.action_requests[0].workflow_run_id='run';waitingRun(s);let checks=0;s.overrides.assert_agent_workflow_lineage=()=>({data:null,error:++checks===2?{}:null});const out=await execute(s);assert.equal(out.response.status,202);assert.equal(s.tokenCalls,1);assert.equal(s.graph.length,0);assert.equal(s.events.filter(e=>e[0]==='rpc'&&e[1]==='record_microsoft_attempt').length,0);
});
test('manual workflow cannot accept an unexpected linked lineage assertion',async()=>{
 const s=fixture();s.overrides.assert_agent_workflow_lineage={data:{agent_request_id:'forged'},error:null};const out=await invoke(runnerHandler,s,{workflow_id:'workflow'});assert.equal(out.response.status,409);assert.equal(s.graph.length,0);assert.equal(s.tables.workflow_runs[0].status,'Error');
});
test('trusted linked engine fails closed without exact matching agent request',async()=>{
 const s=fixture();const run=waitingRun(s);run.status='Running';run.agent_run_request_id='expected';s.overrides.assert_agent_workflow_lineage={data:{agent_request_id:'wrong'},error:null};await assert.rejects(()=>executeTrustedWorkflow({...mock(s),run,userId:'approver',jwt:'jwt'},1),/lineage/);assert.equal(s.graph.length,0);
});
test('linked continuation never downgrades missing lineage to manual',async()=>{
 const s=fixture();const run=waitingRun(s);run.agent_run_request_id='agent-request';s.overrides.assert_agent_workflow_lineage={data:null,error:null};const out=await invoke(resumeHandler,s,{run_id:'run'});assert.equal(out.response.status,409);assert.equal(s.tables.workflow_runs[0].status,'Error');
});

test('trusted linked workflow finalizes only after persisted terminal Success',async()=>{
 const s=fixture();const run=waitingRun(s);run.status='Running';run.agent_run_request_id='agent-request';const response=await executeTrustedWorkflow({...mock(s),run,userId:'approver',jwt:'jwt'},1);const body=await response.json();assert.equal(response.status,200);assert.equal(body.status,'Success');assert.equal(run.status,'Success');const update=s.events.findIndex(e=>e[0]==='workflow_runs'&&e[1]==='update'&&e[2]?.status==='Success');const finish=s.events.findIndex(e=>e[0]==='rpc'&&e[1]==='finish_agent_workflow');assert(update>=0&&finish>update);
});
for(const data of [null,false,'true'])test(`agent completion needs confirmed true, got ${JSON.stringify(data)}`,async()=>{
 const s=fixture();const run=waitingRun(s);run.agent_run_request_id='agent-request';s.overrides.finish_agent_workflow={data,error:null};const out=await invoke(resumeHandler,s,{run_id:'run'});assert.equal(out.response.status,202);assert.equal(out.body.ok,false);assert.equal(out.body.retryable,false);assert.equal(run.status,'Success');assert.equal(queryEvents(s,'workflow_runs','update').filter(e=>e[2].status==='Error').length,0);
});
test('linked waiting approval is never finalized as an executed agent request',async()=>{
 const s=fixture();const run=waitingRun(s);run.status='Running';run.agent_run_request_id='agent-request';run.workflow_steps.push({type:'approval.email',...mail});const response=await executeTrustedWorkflow({...mock(s),run,userId:'approver',jwt:'jwt'},1);const body=await response.json();assert.equal(response.status,200);assert.equal(body.status,'Waiting Approval');assert.equal(s.events.filter(e=>e[0]==='rpc'&&e[1]==='finish_agent_workflow').length,0);
});

test('workflow Microsoft read forwards only trusted server run linkage',async()=>{
 const s=fixture();s.tables.workflow_definitions[0].steps=[{type:'microsoft.profile'}];const out=await invoke(runnerHandler,s,{workflow_id:'workflow'});assert.equal(out.response.status,200);assert.deepEqual(JSON.parse(s.graph[0].options.body),{organization_id:'org',action:'profile',workflow_run_id:'run'});assert.equal(s.graph[0].options.redirect,'error');
});

test('linked customer replies require company reviewer membership before claim even for platform staff',async()=>{
 const s=fixture();s.tables.action_requests[0].customer_workflow_id='customer-workflow';s.tables.organization_members=[];s.tables.staff_accounts=[{user_id:s.userId,role:'platform_admin',active:true}];
 const out=await execute(s);assert.equal(out.response.status,403);assert.equal(s.tables.action_requests[0].status,'Approved');assert.equal(s.tokenCalls,0);assert.equal(s.graph.length,0);assert(!s.events.some(e=>e[0]==='rpc'&&e[1]==='claim_microsoft_action'));
});
test('linked customer replies retain allowed current company reviewer path',async()=>{
 const s=fixture();s.tables.action_requests[0].customer_workflow_id='customer-workflow';
 const out=await execute(s);assert.equal(out.response.status,200);assert.equal(out.body.outcome,'provider_accepted');assert.equal(s.graph.length,1);
});
