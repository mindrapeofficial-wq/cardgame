import test from 'node:test';
import assert from 'node:assert/strict';
import {validateSocialUser,verifiedSocialUser} from '../supabase/functions/rolplay-api/social-auth.ts';
import {messageBody,messagesAction} from '../supabase/functions/rolplay-api/messages.ts';
import {notificationPreferences,notificationsAction} from '../supabase/functions/rolplay-api/notifications.ts';
import {privacyAction} from '../supabase/functions/rolplay-api/privacy.ts';

const now=Date.now(),url='https://project.supabase.co';
const user={id:'person',last_sign_in_at:new Date(now).toISOString(),identities:[{provider:'google'}]};
const claims={sub:'person',iss:url+'/auth/v1',aud:'authenticated',exp:Math.floor(now/1000)+3600,
  iat:Math.floor(now/1000),amr:[{method:'oauth',timestamp:Math.floor(now/1000)}]};
const token=c=>'h.'+Buffer.from(JSON.stringify(c)).toString('base64url')+'.s';
test('Social access requires a fresh provider sign-in and the right verified JWT subject, issuer and audience',()=>{
  assert.equal(validateSocialUser(user,token(claims),url,now),true);
  for(const altered of [{...claims,sub:'other'},{...claims,iss:'https://elsewhere/auth/v1'},
    {...claims,aud:'anon'},{...claims,exp:0},{...claims,amr:[{method:'oauth',timestamp:Math.floor(now/1000)-600}]},
    {...claims,amr:[{method:'password',timestamp:Math.floor(now/1000)}]}])assert.equal(validateSocialUser(user,token(altered),url,now),false);
  assert.equal(validateSocialUser({...user,last_sign_in_at:new Date(now-600000).toISOString()},token(claims),url,now),false);
  assert.equal(validateSocialUser({...user,identities:[],user_metadata:{provider:'google'}},token(claims),url,now),false);
});
test('A forged OAuth-looking token never bypasses verification with Supabase Auth',async()=>{
  assert.equal(await verifiedSocialUser({auth:{getUser:async()=>({data:{user},error:{status:401}})}},token(claims),url),null);
});
test('Messages have bounded length and exclude invisible control characters',()=>{
  assert.equal(messageBody(' Hola '),'Hola');
});
test('Invalid message bodies are rejected before storage',()=>{
  for(const input of ['',null,'x'.repeat(501),'hi\u0000there'])assert.equal(messageBody(input),null);
  assert.equal(messageBody('😀'.repeat(500)),'😀'.repeat(500));
});
test('Direct message APIs cannot read or send to someone outside your accepted friends',async()=>{
  let rpc=false;const query={select(){return this},eq(){return this},maybeSingle:async()=>({data:null,error:null})};
  const ctx={db:{from:()=>query,rpc:async()=>{rpc=true}},auth:{account:{id:'11111111-1111-4111-8111-111111111111'}},
    fail:(error,status=400)=>new Response(JSON.stringify({error}),{status}),json:body=>new Response(JSON.stringify(body))};
  for(const action of ['messages_send','messages_thread','messages_read']){
    assert.equal((await messagesAction(action,{recipientId:'22222222-2222-4222-8222-222222222222',text:'hi'},ctx)).status,403);
  }
  assert.equal(rpc,false);
});
test('Notification preferences require explicit booleans for every supported category',()=>{
  assert.equal(notificationPreferences({messages:'true'}),null);
  const p={challenges:true,friends:false,packs:true,messages:false};assert.deepEqual(notificationPreferences(p),p);
});
test('Unregistering a push device always filters by the authenticated owner',async()=>{
  const filters=[],query={delete(){return this},eq(name,value){filters.push([name,value]);return this},then(resolve){return Promise.resolve({error:null}).then(resolve)}};
  await notificationsAction('notifications_unregister',{token:'device',accountId:'victim'},
    {db:{from:()=>query},auth:{account:{id:'owner'}},json:body=>body});
  assert.deepEqual(filters,[['account_id','owner'],['token','device']]);
});
test('OAuth-only account deletion rejects a fresh identity that belongs to another game account',async()=>{
  let deleted=false;const query={select(){return this},eq(){return this},maybeSingle:async()=>({data:null,error:null})};
  const ctx={db:{from:()=>query,rpc:async()=>{deleted=true;return{error:null}}},auth:{account:{id:'owner',password_enabled:false}},
    verifySocial:async()=>({id:'other-provider-user'}),recentAttempts:async()=>0,recordAttempts:async()=>{},
    fail:(error,status=400)=>new Response(JSON.stringify({error}),{status}),json:body=>new Response(JSON.stringify(body))};
  assert.equal((await privacyAction('delete_account',{confirm:'ELIMINAR',accessToken:'valid-other-user'},ctx)).status,401);
  assert.equal(deleted,false);
});
