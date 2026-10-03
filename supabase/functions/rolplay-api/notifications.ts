export const CATEGORIES=['challenges','friends','packs','messages'];
export function notificationPreferences(body:any){
  const prefs:any={};for(const key of CATEGORIES){if(typeof body?.[key]!=='boolean')return null;prefs[key]=body[key]}return prefs;
}
export function notificationConfigured(){return !!Deno.env.get('FIREBASE_MESSAGING_SERVICE_ACCOUNT_JSON')}
let accessToken='',expires=0;
const b64url=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'');
async function firebaseAccessToken(service:any){
  if(accessToken&&Date.now()<expires)return accessToken;
  const now=Math.floor(Date.now()/1000),encoder=new TextEncoder();
  const header=b64url(encoder.encode(JSON.stringify({alg:'RS256',typ:'JWT'})));
  const claims=b64url(encoder.encode(JSON.stringify({iss:service.client_email,
    scope:'https://www.googleapis.com/auth/firebase.messaging',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600})));
  const raw=Uint8Array.from(atob(service.private_key.replace(/-----[^-]+-----/g,'').replace(/\s/g,'')),(c:string)=>c.charCodeAt(0));
  const key=await crypto.subtle.importKey('pkcs8',raw,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
  const signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,encoder.encode(header+'.'+claims));
  const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',signal:AbortSignal.timeout(8000),
    headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({
      grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:header+'.'+claims+'.'+b64url(new Uint8Array(signature))})});
  const data=await response.json();if(!response.ok||!data.access_token)throw new Error('push_auth_unavailable');
  accessToken=data.access_token;expires=Date.now()+(Math.min(Number(data.expires_in)||3600,3600)-60)*1000;return accessToken;
}
export async function notificationsAction(action:string,body:any,ctx:any){
  if(!['notifications_info','notifications_preferences','notifications_register','notifications_unregister'].includes(action))return null;
  const {db,auth,json,fail}=ctx,me=auth.account.id;
  if(action==='notifications_preferences'){
    const prefs=notificationPreferences(body.preferences);if(!prefs)return fail('notification_preferences_invalid');
    const {error}=await db.from('rolplay_notification_preferences').upsert({account_id:me,...prefs});if(error)throw error;
  }
  if(action==='notifications_register'){
    if(!notificationConfigured())return fail('notifications_not_configured',503);
    if(typeof body.token!=='string'||body.token.length<20||body.token.length>4096||!/^[A-Za-z0-9_:.-]+$/.test(body.token))return fail('push_token_invalid');
    const {data:owned,error:oe}=await db.from('rolplay_push_devices').select('token').eq('account_id',me).order('updated_at',{ascending:false});
    if(oe)throw oe;
    // Keep a bounded number of devices; changing accounts first unregisters the previous one.
    if((owned||[]).length>=5&&!owned.some((d:any)=>d.token===body.token)){
      const {error}=await db.from('rolplay_push_devices').delete().eq('token',owned[owned.length-1].token).eq('account_id',me);if(error)throw error;
    }
    const {error}=await db.from('rolplay_push_devices').upsert({account_id:me,token:body.token,updated_at:new Date().toISOString()});if(error)throw error;
  }
  if(action==='notifications_unregister'){
    if(typeof body.token==='string'){
      const {error}=await db.from('rolplay_push_devices').delete().eq('account_id',me).eq('token',body.token);if(error)throw error;
    }
    return json({ok:true});
  }
  const {data,error}=await db.from('rolplay_notification_preferences').select('challenges,friends,packs,messages').eq('account_id',me).maybeSingle();
  if(error)throw error;
  return json({ok:true,configured:notificationConfigured(),hasPreferences:!!data,preferences:data||{challenges:false,friends:false,packs:false,messages:false}});
}
export async function processNotifications(db:any){
  if(!notificationConfigured())return{skipped:true,sent:0};
  const service=JSON.parse(Deno.env.get('FIREBASE_MESSAGING_SERVICE_ACCOUNT_JSON')||'{}');
  if(!/^[a-z0-9-]+$/.test(service.project_id||''))throw new Error('push_configuration_invalid');
  const bearer=await firebaseAccessToken(service);
  const {error:reminderError}=await db.rpc('rolplay_queue_pack_reminders');if(reminderError)throw reminderError;
  const {data:jobs,error}=await db.rpc('rolplay_claim_push_jobs');if(error)throw error;
  let sent=0;
  await Promise.all((jobs||[]).map(async(job:any)=>{
    try{
      const {data:account,error:ae}=await db.from('rolplay_accounts').select('id,is_bot,suspended_at,terms_version,last_daily_pack').eq('id',job.account_id).maybeSingle();
      const {data:prefs,error:pe}=await db.from('rolplay_notification_preferences').select('*').eq('account_id',job.account_id).maybeSingle();
      if(ae||pe)throw ae||pe;
      let allowed=account&&!account.is_bot&&!account.suspended_at&&account.terms_version==='2026-10-03'&&prefs?.[job.category];
      if(job.source_id){
        const {data:blocked,error:be}=await db.from('rolplay_blocks').select('account_id')
          .or(`and(account_id.eq.${job.account_id},blocked_id.eq.${job.source_id}),and(account_id.eq.${job.source_id},blocked_id.eq.${job.account_id})`).limit(1);
        if(be)throw be;allowed=allowed&&!blocked?.length;
      }
      const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
      if(job.category==='packs'&&account?.last_daily_pack===today)allowed=false;
      if(job.category==='messages'){
        const messageId=job.event_key.slice(3);
        const {data:m,error:me}=await db.from('rolplay_direct_messages').select('id').eq('id',messageId).eq('recipient_id',job.account_id).is('read_at',null).maybeSingle();
        if(me)throw me;allowed=allowed&&!!m;
      }
      const {data:devices,error:de}=await db.from('rolplay_push_devices').select('token').eq('account_id',job.account_id)
        .gt('updated_at',new Date(Date.now()-45*24*60*60*1000).toISOString()).limit(5);
      if(de)throw de;
      if(!allowed||!devices?.length){await db.from('rolplay_notification_outbox').update({status:'skipped'}).eq('id',job.id);return}
      let retry=false;
      await Promise.all(devices.map(async(device:any)=>{
        // Data-only messages let Android check the current account and opt-in before showing anything.
        const ttl=Math.max(1,Math.min(86400,Math.floor((Date.parse(job.expires_at)-Date.now())/1000)));
        const response=await fetch(`https://fcm.googleapis.com/v1/projects/${service.project_id}/messages:send`,{
          method:'POST',signal:AbortSignal.timeout(8000),headers:{authorization:'Bearer '+bearer,'content-type':'application/json'},
          body:JSON.stringify({message:{token:device.token,data:{accountId:job.account_id,eventId:job.id,
            category:job.category,route:job.route,expiresAt:String(Date.parse(job.expires_at))},
            android:{priority:job.category==='packs'?'NORMAL':'HIGH',ttl:ttl+'s',collapse_key:job.category}}})});
        const data=await response.json().catch(()=>({}));
        if(response.ok){sent++;return}
        const code=(data.error?.details||[]).find((d:any)=>d['@type']==='type.googleapis.com/google.firebase.fcm.v1.FcmError')?.errorCode;
        if(code==='UNREGISTERED')await db.from('rolplay_push_devices').delete().eq('token',device.token).eq('account_id',job.account_id);
        else retry=true;
      }));
      await db.from('rolplay_notification_outbox').update({status:retry?'pending':'sent',next_attempt_at:new Date(Date.now()+5*60*1000).toISOString()}).eq('id',job.id);
    }catch{
      await db.from('rolplay_notification_outbox').update({status:'pending',next_attempt_at:new Date(Date.now()+5*60*1000).toISOString()}).eq('id',job.id);
    }
  }));
  return{sent,attempted:jobs?.length||0};
}
