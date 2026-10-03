"use strict";
window.ARCANUM_MESSAGES=(()=>{
  let ctx,contacts=[],peer=null,messages=[],more=false,timer=null,active=false,busy=false,polling=false,generation=0,initialized=false;
  const drafts=new Map(),pendingSends=new Map(),root=()=>document.getElementById('messagesDialog');
  const error=code=>({friends_required:'Solo puedes enviar mensajes privados a tus amigos.',player_blocked:'No puedes contactar con este jugador.',message_limit:'Has enviado demasiados mensajes. Espera antes de continuar.',message_invalid:'Escribe un mensaje de 1 a 500 caracteres.',message_unavailable:'Esta conversación no está disponible.'}[code]||'No se pudo completar la operación. Comprueba tu conexión.');
  const total=()=>contacts.reduce((n,c)=>n+c.unread,0);
  function badges(){document.querySelectorAll('[data-message-count]').forEach(e=>{e.textContent=total()?String(Math.min(total(),99)):' ';e.hidden=!total()});
    document.querySelectorAll('[data-messages-open]').forEach(e=>e.setAttribute('aria-label',`Mensajes privados${total()?' · '+total()+' sin leer':''}`))}
  function panel(){return `<section class="panel message-settings-panel"><div class="panel-head"><h2>Mensajes privados</h2></div><div class="panel-body"><p>Habla con tus amigos. Puedes bloquear a un jugador o denunciar un mensaje desde la conversación.</p><button class="btn" type="button" data-messages-open>Ver mensajes <span data-message-count ${total()?'':'hidden'}>${total()||''}</span></button><p class="muted">Los mensajes se conservan hasta 90 días. No incluyas contraseñas ni información privada innecesaria.</p></div></section>`}
  async function refresh(){
    if(!active||polling||document.hidden)return;polling=true;const stamp=generation;
    try{
      const result=await ctx.api('messages_contacts');if(stamp!==generation||!active)return;
      if(!result.ok)return;
      const before=total();contacts=result.contacts||[];badges();
      if(initialized&&total()>before&&!root()?.open)ctx.toast('Tienes nuevos mensajes privados.');initialized=true;
      if(root()?.open&&peer){
        const updated=contacts.find(c=>c.id===peer.id);
        if(!updated){peer=null;messages=[];paint();return}
        const r=await ctx.api('messages_thread',{recipientId:peer.id});if(stamp!==generation||!active||!r.ok)return;
        if(r.messages.length&&r.messages.at(-1).id!==messages.at(-1)?.id){
          merge(r.messages);paint(true);void markRead(r.messages);
        }
      }else if(root()?.open)paint();
    }finally{polling=false}
  }
  async function markRead(items){
    if(document.hidden||!root()?.open||!peer)return;
    const ids=items.filter(m=>m.senderId!==ctx.state.profile.id&&!m.readAt).map(m=>m.id).slice(0,50);
    if(!ids.length)return;
    const result=await ctx.api('messages_read',{recipientId:peer.id,ids});
    if(result.ok){const c=contacts.find(c=>c.id===peer?.id);if(c)c.unread=Math.max(0,c.unread-ids.length);badges()}
  }
  function merge(items){const map=new Map(messages.map(m=>[m.id,m]));for(const m of items)map.set(m.id,m);
    messages=[...map.values()].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));}
  function remember(){if(peer){const input=document.getElementById('directMessageInput');if(input&&input.dataset.peer===peer.id)drafts.set(peer.id,input.value)}}
  function paint(keep=false){
    remember();const old=document.getElementById('messageHistory');const atBottom=!old||old.scrollHeight-old.scrollTop-old.clientHeight<80;
    const position=old?.scrollTop||0,e=ctx.esc;
    root().innerHTML=`<div class="message-dialog-heading"><h2 id="messagesTitle">${peer?'Conversación con '+e(peer.name):'Mensajes privados'}</h2><button type="button" class="btn" data-messages-close aria-label="Cerrar mensajes privados">×</button></div>${peer?`<button class="btn small" type="button" data-messages-back>← Amigos</button><div class="message-history" id="messageHistory" role="log" aria-live="polite" aria-label="Mensajes con ${e(peer.name)}">${more?'<button class="btn small" type="button" data-messages-older>Ver mensajes anteriores</button>':''}${messages.length?messages.map(m=>`<article class="direct-message ${m.senderId===ctx.state.profile.id?'own':''}"><p>${e(m.text)}</p><small>${e(new Date(m.createdAt).toLocaleString('es-ES',{dateStyle:'short',timeStyle:'short'}))}</small>${m.senderId!==ctx.state.profile.id?`<button class="message-report" type="button" data-privacy-action="report" data-name="${e(peer.name)}" data-direct-message-id="${e(m.id)}" data-message-text="${e(m.text)}">Denunciar</button>`:''}</article>`).join(''):'<p class="muted">Aún no hay mensajes.</p>'}</div><form id="directMessageForm"><label for="directMessageInput">Mensaje para ${e(peer.name)}</label><textarea class="input" id="directMessageInput" data-peer="${e(peer.id)}" maxlength="500" rows="2" required placeholder="Escribe un mensaje…">${e(drafts.get(peer.id)||'')}</textarea><button type="submit" class="btn primary" ${busy?'disabled':''}>Enviar</button></form><div class="message-thread-tools"><button type="button" class="btn small danger" data-privacy-action="block" data-name="${e(peer.name)}">Bloquear a ${e(peer.name)}</button></div>`:`<p>Mensajes disponibles entre amigos. Añade jugadores a tu lista para iniciar una conversación.</p><div class="message-contacts">${contacts.length?contacts.map(c=>`<button type="button" class="btn message-contact" data-message-peer="${e(c.id)}"><span>${e(c.name)}</span>${c.unread?`<span class="pill">${c.unread} sin leer</span>`:''}</button>`).join(''):'<p class="muted">Todavía no tienes amigos disponibles.</p>'}</div>`}<p data-message-status role="status"></p>`;
    const history=document.getElementById('messageHistory');if(history)history.scrollTop=!keep||atBottom?history.scrollHeight:position;
  }
  async function open(){
    if(!active)return;ctx.closeModal();peer=null;messages=[];more=false;
    const stamp=generation,result=await ctx.api('messages_contacts');if(stamp!==generation||!active)return;
    if(!result.ok){ctx.toast(error(result.error),'bad');return}contacts=result.contacts||[];badges();paint();if(!root().open)root().showModal();
  }
  async function select(id){
    const target=contacts.find(c=>c.id===id);if(!target)return;remember();peer=target;messages=[];more=false;paint();
    const stamp=generation,r=await ctx.api('messages_thread',{recipientId:id});if(stamp!==generation||peer?.id!==id||!active)return;
    if(!r.ok){root().querySelector('[data-message-status]').textContent=error(r.error);return}
    messages=r.messages;more=r.more;paint();void markRead(messages);
  }
  function start(){if(active)return;active=true;initialized=false;generation++;void refresh();timer=setInterval(()=>void refresh(),15000)}
  function stop(){active=false;generation++;clearInterval(timer);timer=null;contacts=[];peer=null;messages=[];drafts.clear();pendingSends.clear();initialized=false;root()?.close();badges()}
  document.addEventListener('click',async e=>{
    if(e.target.closest('[data-messages-open]'))void open();
    if(e.target.closest('[data-messages-close]')){remember();root()?.close()}
    const target=e.target.closest('[data-message-peer]');if(target)void select(target.dataset.messagePeer);
    if(e.target.closest('[data-messages-back]')){remember();peer=null;messages=[];paint()}
    if(e.target.closest('[data-messages-older]')&&peer&&messages.length){
      const target=peer.id,stamp=generation,first=messages[0];
      const result=await ctx.api('messages_thread',{recipientId:target,before:{id:first.id,at:first.createdAt}});
      if(stamp!==generation||peer?.id!==target||!active)return;
      if(result.ok){merge(result.messages);more=result.more;paint(true)}else ctx.toast(error(result.error),'bad');
    }
    if(e.target.closest('[data-privacy-action]')&&root()?.open){remember();root().close()}
  });
  document.addEventListener('submit',async e=>{
    if(e.target.id!=='directMessageForm')return;e.preventDefault();if(busy||!peer)return;
    const input=document.getElementById('directMessageInput'),text=input.value.trim();if(!text)return;
    const target=peer.id,stamp=generation;busy=true;input.disabled=true;e.target.querySelector('button').disabled=true;
    try{
      // Keep this id with the draft on a network failure, so retrying cannot duplicate a sent message.
      const previous=pendingSends.get(target),savedId=previous?.text===text?previous.id:crypto.randomUUID();
      pendingSends.set(target,{text,id:savedId});
      const result=await ctx.api('messages_send',{recipientId:target,text,clientId:savedId});
      if(stamp!==generation||peer?.id!==target||!active)return;
      if(!result.ok){root().querySelector('[data-message-status]').textContent=error(result.error);return}
      input.value='';drafts.delete(target);pendingSends.delete(target);merge([result.message]);busy=false;paint();
    }finally{busy=false;const button=document.querySelector('#directMessageForm button');if(button)button.disabled=false;const current=document.getElementById('directMessageInput');if(current)current.disabled=false}
  });
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refresh()});
  return{bind:c=>ctx=c,start,stop,panel,open};
})();
