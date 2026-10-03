import { LEGAL_VERSION, legalAccepted } from './privacy.ts';

// getUser(accessToken) must verify the JWT with this project's Auth service first.
// No display name, email, or editable user_metadata grants access to a game account.
export function validateSocialUser(user:any, verifiedToken:string, projectUrl:string, now=Date.now()) {
  if (!user?.id || !Array.isArray(user.identities) ||
      !user.identities.some((i:any)=>['google','apple'].includes(i.provider))) return false;
  try {
    const segment=verifiedToken.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');
    const claims=JSON.parse(atob(segment));
    const signedIn=Date.parse(user.last_sign_in_at || '');
    return claims.sub===user.id && claims.iss===projectUrl+'/auth/v1' &&
      (claims.aud==='authenticated'||Array.isArray(claims.aud)&&claims.aud.includes('authenticated')) &&
      Number(claims.exp)*1000>now && Number(claims.iat)*1000<=now+60000 &&
      Number.isFinite(signedIn) && signedIn<=now+60000 && now-signedIn<5*60*1000 &&
      Array.isArray(claims.amr) && claims.amr.some((a:any)=>a.method==='oauth'&&
        Number(a.timestamp)*1000<=now+60000 && now-Number(a.timestamp)*1000<5*60*1000);
  } catch {return false}
}
export async function verifiedSocialUser(db:any,token:unknown,projectUrl:string) {
  if(typeof token!=='string'||token.length>12000)return null;
  const {data,error}=await db.auth.getUser(token);
  return !error&&validateSocialUser(data.user,token,projectUrl)?data.user:null;
}
export async function eraseSocialUsers(db:any) {
  const {data,error}=await db.from('rolplay_auth_erasure_queue').select('auth_user_id').order('created_at').limit(10);
  if(error)throw error;
  for(const row of data||[]){
    const result=await db.auth.admin.deleteUser(row.auth_user_id);
    if(!result.error||result.error.status===404)await db.from('rolplay_auth_erasure_queue').delete().eq('auth_user_id',row.auth_user_id);
  }
}
export async function socialAuthAction(action:string,body:any,ctx:any) {
  if(!['social_login','social_link','social_status'].includes(action))return null;
  const {db,req,fail,json,authenticate,createSession,loadAccount,publicProfile,supabaseUrl,
    recentAttempts,recordAttempts,sha256Text,clientIp}=ctx;
  if(action==='social_status'){
    const auth=await authenticate(req);if(!auth)return fail('unauthorized',401);
    const {data,error}=await db.from('rolplay_social_identities').select('auth_user_id').eq('account_id',auth.account.id);
    if(error)throw error;
    return json({ok:true,linked:!!data?.length,passwordEnabled:auth.account.password_enabled!==false});
  }
  const ip=await sha256Text('social:'+clientIp(req));
  if(await recentAttempts('social_attempt',ip,15*60*1000)>=30)return fail('too_many_attempts',429);
  await recordAttempts([{kind:'social_attempt',subject:ip}]);
  const user=await verifiedSocialUser(db,body.accessToken,supabaseUrl);
  if(!user)return fail('social_auth_invalid',401);
  let existing:any=null;
  if(action==='social_link'){
    existing=await authenticate(req);if(!existing)return fail('unauthorized',401);
    if(existing.account.suspended_at)return fail('account_suspended',403);
  }
  const {data:mapping,error:me}=await db.from('rolplay_social_identities').select('account_id').eq('auth_user_id',user.id).maybeSingle();
  if(me)throw me;
  if(!mapping&&!existing&&!body.username)return json({ok:true,registrationRequired:true});
  if(!mapping&&!existing){
    if(!legalAccepted(body))return fail('legal_acceptance_required');
    if(!/^[A-Za-z0-9_-]{3,20}$/.test(String(body.username||'')))return fail('username_invalid');
    if(await recentAttempts('register_ip',await sha256Text('ip:'+clientIp(req)),24*60*60*1000)>=5)return fail('too_many_registrations',429);
  }
  const {data:id,error}=await db.rpc('rolplay_social_account',{
    p_auth_user:user.id,p_existing:existing?.account.id||null,
    p_username:String(body.username||'').trim(),p_age:body.ageGroup||null,p_terms:LEGAL_VERSION,
  });
  if(error){
    if(error.code==='23505')return fail('username_taken',409);
    if(String(error.message).includes('identity_already_linked'))return fail('identity_already_linked',409);
    if(String(error.message).includes('social_auth_invalid'))return fail('social_auth_invalid',401);
    throw error;
  }
  const account=await loadAccount(id);
  if(account.suspended_at)return fail('account_suspended',403);
  if(action==='social_link')return json({ok:true,linked:true});
  if(!mapping)await recordAttempts([{kind:'register_ip',subject:await sha256Text('ip:'+clientIp(req))}]);
  return json({ok:true,token:await createSession(id),profile:publicProfile(account)});
}
