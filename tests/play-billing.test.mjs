import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePlayPurchase,playAccountId,playBillingAction } from '../supabase/functions/rolplay-api/play-billing.ts';
const paid={purchaseStateContext:{purchaseState:'PURCHASED'},obfuscatedExternalAccountId:'hash',productLineItem:[{productId:'arcanum_apoyador',productOfferDetails:{quantity:1}}],purchaseCompletionTime:'2026-10-03T10:00:00Z'};
test('Grant only authoritative completed purchases for the right product and account',()=>{
  assert.equal(validatePlayPurchase(paid,'arcanum_apoyador','hash'),null);
  assert.equal(validatePlayPurchase({...paid,purchaseStateContext:{purchaseState:'PENDING'}},'arcanum_apoyador','hash'),'purchase_pending');
  assert.equal(validatePlayPurchase({...paid,purchaseStateContext:{purchaseState:'CANCELLED'}},'arcanum_apoyador','hash'),'purchase_not_purchased');
  assert.equal(validatePlayPurchase(paid,'arcanum_apoyador','other'),'purchase_account_mismatch');
  assert.equal(validatePlayPurchase(paid,'arcanum_mecenas','hash'),'purchase_product_mismatch');
  assert.equal(validatePlayPurchase({...paid,productLineItem:[{productId:'arcanum_apoyador',productOfferDetails:{quantity:2}}]},'arcanum_apoyador','hash'),'purchase_quantity_invalid');
  assert.equal(validatePlayPurchase({...paid,purchaseCompletionTime:''},'arcanum_apoyador','hash'),'purchase_date_invalid');
});
test('Google receives a deterministic pseudonymous account id, not the internal UUID',async()=>{
  const id='735db204-741a-4e53-bca9-74a711687b9a';
  const hash=await playAccountId(id);assert.match(hash,/^[a-f0-9]{64}$/);assert.notEqual(hash,id);assert.equal(hash,await playAccountId(id));assert.notEqual(hash,await playAccountId('other'));
});
test('Unconfigured billing fails closed without grants or external requests',async()=>{
  globalThis.Deno={env:{get:()=>undefined}};
  let granted=false;
  const ctx={auth:{account:{id:'owner',terms_version:'2026-10-03'}},db:{rpc:()=>{granted=true}},fail:(error,status=400)=>({error,status}),json:body=>body};
  assert.deepEqual(await playBillingAction('play_prepare_purchase',{productId:'arcanum_apoyador'},ctx),{error:'play_not_configured',status:503});
  assert.equal(granted,false);
});

