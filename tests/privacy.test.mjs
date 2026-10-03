import test from 'node:test';
import assert from 'node:assert/strict';
import { legalAccepted, isPlayClient, privacyAction } from '../supabase/functions/rolplay-api/privacy.ts';
import safety from '../server/community-safety.js';

const response=(body,status=200)=>new Response(JSON.stringify(body),{status});
function context(overrides={}){
  const calls=[];
  const db={rpc:async(name,args)=>{calls.push({name,args});return{error:null}},from:()=>{throw Error('Unexpected database write')}};
  return{db,calls,auth:{account:{id:'owner',terms_version:'2026-10-03',password_salt:'salt',password_hash:'correct-password'}},req:new Request('https://example.invalid'),json:response,fail:(error,status=400)=>response({ok:false,error},status),derivePassword:async p=>p,unb64:x=>x,safeEqual:(a,b)=>a===b,recentAttempts:async()=>0,recordAttempts:async rows=>calls.push({attempts:rows}),...overrides};
}
test('Registration consent requires current terms, explicit acceptance and eligible age',()=>{
  assert.equal(legalAccepted({acceptTerms:true,termsVersion:'2026-10-03',ageGroup:'16-17'}),true);
  assert.equal(legalAccepted({acceptTerms:true,termsVersion:'2026-10-03',ageGroup:'18+'}),true);
  for(const p of [{},{acceptTerms:false,termsVersion:'2026-10-03',ageGroup:'18+'},{acceptTerms:true,termsVersion:'old',ageGroup:'18+'},{acceptTerms:true,termsVersion:'2026-10-03',ageGroup:'under16'}])assert.equal(legalAccepted(p),false);
});
test('Play edition is recognized by native user agent and explicit client header',()=>{
  assert.equal(isPlayClient(new Request('https://example.invalid',{headers:{'user-agent':'ArcanumTCGAndroid/1.2.7 GooglePlay'}})),true);
  assert.equal(isPlayClient(new Request('https://example.invalid',{headers:{'x-arcanum-client':'google-play'}})),true);
  assert.equal(isPlayClient(new Request('https://example.invalid')),false);
});
test('Deletion needs explicit confirmation and password; never trusts a supplied account id',async()=>{
  const c=context();
  assert.equal((await privacyAction('delete_account',{confirm:'no',password:'correct-password'},c)).status,400);
  assert.equal(c.calls.length,0);
  assert.equal((await privacyAction('delete_account',{confirm:'ELIMINAR',password:'wrong-password'},c)).status,401);
  assert.equal(c.calls.some(x=>x.name==='rolplay_delete_account'),false);
  const r=await privacyAction('delete_account',{confirm:'ELIMINAR',password:'correct-password',accountId:'victim'},c);
  assert.equal(r.status,200);
  assert.deepEqual(c.calls.find(x=>x.name==='rolplay_delete_account').args,{p_account_id:'owner'});
});
test('Password verification is throttled before expensive crypto',async()=>{
  let derived=false;const c=context({recentAttempts:async()=>5,derivePassword:async()=>{derived=true}});
  assert.equal((await privacyAction('delete_account',{confirm:'ELIMINAR',password:'correct-password'},c)).status,429);
  assert.equal(derived,false);assert.equal(c.calls.length,0);
});
test('Blocked players cannot bypass accepted terms or suspension',async()=>{
  for(const account of [{id:'owner',terms_version:null},{id:'owner',terms_version:'2026-10-03',suspended_at:'now'}]){
    const c=context({auth:{account}});
    assert.equal((await privacyAction('block_player',{name:'other'},c)).status,403);
    assert.equal(c.calls.length,0);
  }
});
test('Community requires current terms; bot exemption never bypasses suspension',()=>{
  assert.equal(safety.canUseCommunity({termsVersion:'2026-10-03'}),true);
  assert.equal(safety.canUseCommunity({termsVersion:'old'}),false);
  assert.equal(safety.canUseCommunity({isBot:true}),true);
  assert.equal(safety.canUseCommunity({isBot:true,suspended:true}),false);
});
test('Blocking protects both directions, by account id even if the player changes name',()=>{
  const a={accountId:'a',name:'Alice',blocks:[{id:'b',name:'Bob'}]},b={accountId:'b',name:'Changed',blocks:[]};
  assert.equal(safety.mutuallyBlocked(a,b),true);assert.equal(safety.mutuallyBlocked(b,a),true);
  assert.equal(safety.mutuallyBlocked(a,{accountId:'c',name:'Charlie'}),false);
});

