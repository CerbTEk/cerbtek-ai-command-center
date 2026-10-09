import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const fixed = await fs.readFile(new URL('../candidate/sql/ai-draft-contract.sql', import.meta.url), 'utf8');
const before = await fs.readFile(new URL('./fixtures/ai-draft-before-utc-fix.sql', import.meta.url), 'utf8');
const org = '00000000-0000-4000-8000-000000000001';
const actor = '10000000-0000-4000-8000-000000000001';
const key = n => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const config = {schema_version:1,provider:'openai',model:'fixture-model',task:'customer_reply',instructions:'Use only supplied business facts.',source:'manual_context',max_input_bytes:6000,max_output_tokens:1000,max_daily_runs:2,daily_budget_microusd:50000,human_review:true};
const rpc = async (db, name, args) => (await db.query(`select public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) result`, args)).rows[0].result;

// Deterministic local-only time adapter. No business statements, locks, grants,
// quota checks, or inserts are changed. This models a transaction begun before
// UTC midnight and admission after it; it is not simultaneous-session evidence.
async function setup(source) {
  const db = new PGlite();
  await db.exec(`
    create schema auth; create role anon; create role authenticated; create role service_role bypassrls;
    create table auth.users(id uuid primary key); create table public.organizations(id uuid primary key);
    create table public.organization_members(organization_id uuid,user_id uuid,role text);
    insert into auth.users values('${actor}'); insert into organizations values('${org}');
    insert into organization_members values('${org}','${actor}','owner');
    grant usage on schema public,auth to service_role;
    grant select,update on organizations to service_role; grant select on organization_members to service_role;
    create schema test_clock;
    create table test_clock.state(calls integer not null, wall timestamptz not null, next_wall timestamptz not null);
    insert into test_clock.state values(0,'2040-01-02 00:00:01+00','2040-01-03 00:00:01+00');
    create function test_clock.transaction_time() returns timestamptz language sql stable as $$select '2040-01-01 23:59:59+00'::timestamptz$$;
    create function test_clock.wall_time() returns timestamptz language plpgsql volatile as $$declare n integer; stamp timestamptz; begin update test_clock.state set calls=calls+1 returning calls,case when calls=1 then wall else next_wall end into n,stamp; return stamp;end$$;
    grant usage on schema test_clock to service_role; grant select,update on test_clock.state to service_role;
    set timezone='America/Los_Angeles';
  `);
  const adapted = source.replaceAll('clock_timestamp()', 'test_clock.wall_time()').replaceAll('now()', 'test_clock.transaction_time()');
  await db.exec(adapted);
  await db.exec('set role service_role');
  const saved = await rpc(db, 'ai_draft_save', [org, actor, 0, config]);
  const seed = async (day, cost, n=90) => db.query(`insert into ai_draft_runs(organization_id,configuration_id,request_key,request_hash,requested_by,reserved_microusd,reservation_day,status) values($1,$2,$3,$4,$5,$6,$7,'failed')`, [org,saved.id,key(n),'a'.repeat(64),actor,cost,day]);
  const reserve = (cost=10000,n=1) => rpc(db,'ai_draft_reserve',[org,actor,saved.id,key(n),'a'.repeat(64),cost]);
  return {db, saved, seed, reserve};
}

test('UTC date is captured once after the organization lock and explicitly reused for persistence', () => {
  const reserve = fixed.slice(fixed.indexOf('create function public.ai_draft_reserve'), fixed.indexOf('create function public.ai_draft_finish'));
  const lock = reserve.indexOf('perform 1 from public.organizations where id=p_org for update;');
  const capture = reserve.indexOf("reservation_date:=(clock_timestamp() at time zone 'UTC')::date;");
  assert(lock >= 0 && capture > lock);
  assert.equal((reserve.match(/clock_timestamp\(\)/g) || []).length, 1);
  assert(!reserve.includes('now()'));
  assert.match(reserve, /reservation_day=reservation_date/);
  assert.match(reserve, /reserved_microusd,reservation_day\) values\(p_org,p_config,p_request_key,p_request_hash,p_actor,p_reserve,reservation_date\)/);
  assert.match(fixed, /reservation_day date not null,/);
});

test('after midnight admission uses the new UTC day despite an exhausted previous day; old code reproduces denial', async () => {
  for (const [source, expectNewDay] of [[fixed,true],[before,false]]) {
    const x = await setup(source);
    try {
      await x.seed('2040-01-01',50000);
      if (expectNewDay) {
        const result = await x.reserve();
        assert.equal(result.created,true);
        assert.equal(result.run.reservation_day,'2040-01-02');
      } else await assert.rejects(() => x.reserve(), /Daily allowance exhausted/);
    } finally { await x.db.close(); }
  }
});

test('new-day spending is enforced even if transaction began yesterday; old code reproduces bypass', async () => {
  for (const [source, shouldBlock] of [[fixed,true],[before,false]]) {
    const x = await setup(source);
    try {
      await x.seed('2040-01-02',40000);
      if (shouldBlock) await assert.rejects(() => x.reserve(20000), /Daily allowance exhausted/);
      else {
        const result = await x.reserve(20000);
        assert.equal(result.created,true);
        assert.equal(result.run.reservation_day,'2040-01-01');
      }
    } finally { await x.db.close(); }
  }
});

test('a single captured UTC day survives clock advance between quota accounting and insertion', async () => {
  const x = await setup(fixed);
  try {
    const result = await x.reserve();
    assert.equal(result.run.reservation_day,'2040-01-02');
    assert.equal((await x.db.query('select calls from test_clock.state')).rows[0].calls,1);
  } finally { await x.db.close(); }
});

test('replaying a prior-day request returns its original reservation without reading a new day', async () => {
  const x = await setup(fixed);
  try {
    await x.seed('2040-01-01',10000,1);
    const result = await x.reserve();
    assert.equal(result.created,false);
    assert.equal(result.run.reservation_day,'2040-01-01');
    assert.equal((await x.db.query('select calls from test_clock.state')).rows[0].calls,0);
  } finally { await x.db.close(); }
});
