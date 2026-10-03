export const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function messageBody(value:unknown){
  if(typeof value!=='string')return null;
  const text=value.trim();return text.length>0&&[...text].length<=500&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)?text:null;
}
export async function messagesAction(action:string,body:any,ctx:any){
  if(!['messages_contacts','messages_thread','messages_send','messages_read'].includes(action))return null;
  const {db,auth,json,fail}=ctx,me=auth.account.id;
  if(action==='messages_contacts'){
    const {data:friends,error}=await db.from('rolplay_friends').select('friend_id').eq('account_id',me).eq('status','accepted');
    if(error)throw error;
    const ids=(friends||[]).map((f:any)=>f.friend_id);
    if(!ids.length)return json({ok:true,contacts:[]});
    const {data:people,error:pe}=await db.from('rolplay_accounts').select('id,username').in('id',ids).eq('is_bot',false).is('suspended_at',null);
    if(pe)throw pe;
    const {data:blocks,error:be}=await db.from('rolplay_blocks').select('account_id,blocked_id').or(`account_id.eq.${me},blocked_id.eq.${me}`);
    if(be)throw be;
    const blocked=new Set((blocks||[]).map((b:any)=>b.account_id===me?b.blocked_id:b.account_id));
    const {data:unread,error:ue}=await db.from('rolplay_direct_messages').select('sender_id').eq('recipient_id',me).is('read_at',null).limit(5000);
    if(ue)throw ue;
    const counts=new Map<string,number>();for(const m of unread||[])counts.set(m.sender_id,(counts.get(m.sender_id)||0)+1);
    return json({ok:true,contacts:(people||[]).filter((p:any)=>!blocked.has(p.id)).map((p:any)=>({id:p.id,name:p.username,unread:counts.get(p.id)||0}))});
  }
  const id=String(body.recipientId||'');if(!UUID.test(id)||id===me)return fail('message_unavailable');
  const {data:friend,error}=await db.from('rolplay_friends').select('status').eq('account_id',me).eq('friend_id',id).eq('status','accepted').maybeSingle();
  if(error)throw error;
  if(!friend)return fail('friends_required',403);
  const {data:blocks,error:be}=await db.from('rolplay_blocks').select('account_id')
    .or(`and(account_id.eq.${me},blocked_id.eq.${id}),and(account_id.eq.${id},blocked_id.eq.${me})`).limit(1);
  if(be)throw be;if(blocks?.length)return fail('player_blocked',403);
  if(action==='messages_send'){
    const text=messageBody(body.text),clientId=String(body.clientId||'');
    if(!text||!UUID.test(clientId))return fail('message_invalid');
    const {data,error}=await db.rpc('rolplay_send_direct_message',{p_sender:me,p_recipient:id,p_body:text,p_client:clientId});
    if(error){for(const code of ['friends_required','player_blocked','message_limit','message_unavailable','message_id_conflict']){
      if(String(error.message).includes(code))return fail(code,code==='message_limit'?429:403)}throw error}
    return json({ok:true,message:{id:data.id,senderId:data.sender_id,text:data.body,createdAt:data.created_at,readAt:data.read_at}});
  }
  if(action==='messages_read'){
    const ids=Array.isArray(body.ids)?body.ids.filter((v:any)=>typeof v==='string'&&UUID.test(v)).slice(0,50):[];
    if(!ids.length)return json({ok:true});
    const {error}=await db.from('rolplay_direct_messages').update({read_at:new Date().toISOString()})
      .eq('recipient_id',me).eq('sender_id',id).in('id',ids).is('read_at',null);
    if(error)throw error;return json({ok:true});
  }
  let query=db.from('rolplay_direct_messages').select('id,sender_id,body,created_at,read_at')
    .or(`and(sender_id.eq.${me},recipient_id.eq.${id}),and(sender_id.eq.${id},recipient_id.eq.${me})`)
    .order('created_at',{ascending:false}).order('id',{ascending:false}).limit(50);
  if(body.before){
    if(!UUID.test(String(body.before.id||''))||!Number.isFinite(Date.parse(body.before.at)))return fail('cursor_invalid');
    const at=new Date(body.before.at).toISOString();
    query=query.or(`created_at.lt.${at},and(created_at.eq.${at},id.lt.${body.before.id})`);
  }
  const {data,error:qe}=await query;if(qe)throw qe;
  const messages=(data||[]).map((m:any)=>({id:m.id,senderId:m.sender_id,text:m.body,createdAt:m.created_at,readAt:m.read_at}));
  return json({ok:true,messages:messages.reverse(),more:messages.length===50});
}
