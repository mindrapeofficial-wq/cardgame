"use strict";
window.ARCANUM_NOTIFICATIONS=(()=>{
  const labels={challenges:'Retos a combate',friends:'Solicitudes de amistad',packs:'Sobre gratuito disponible',messages:'Mensajes privados'};
  let ctx,prefs={challenges:false,friends:false,packs:false,messages:false},info=null,native=null,token='',account='',generation=0,pending=null,route=null;
  const bridge=()=>window.ArcanumAndroid;
  function panel(){
    const available=info?.configured&&typeof bridge()?.enableNotifications==='function'&&native?.available;
    const status=!info?'Cargando ajustes…':!info.configured?'Los avisos del móvil todavía no están activados.':
      typeof bridge()?.enableNotifications!=='function'?'Abre la versión actualizada de Android para activar los avisos del móvil.':
      !native?.available?'Falta completar la configuración de avisos de esta versión.':
      native.permission&&native.enabled?'Los avisos están activados en este dispositivo.':'Los avisos están desactivados en este dispositivo.';
    return `<section class="panel notification-settings"><div class="panel-head"><h2>Notificaciones</h2></div><div class="panel-body"><p>Elige qué avisos quieres recibir. Los mensajes privados no muestran su contenido en la pantalla bloqueada.</p><div class="notification-options">${Object.entries(labels).map(([id,label])=>`<label><input type="checkbox" data-notification-category="${id}" ${prefs[id]?'checked':''}><span>${label}</span></label>`).join('')}</div><div class="actions"><button type="button" class="btn" data-notification-save>Guardar preferencias</button><button type="button" class="btn primary" data-notification-enable ${available?'':'disabled'}>Activar avisos en este móvil</button>${native?.enabled?'<button type="button" class="btn" data-notification-disable>Desactivar en este móvil</button>':''}</div><p class="muted" data-notification-status role="status">${status}</p></div></section>`;
  }
  function paint(){if(ctx.state.view==='profile')ctx.renderView()}
  async function start(){
    if(account===ctx.state.profile?.id&&info)return;
    account=ctx.state.profile?.id||'';const stamp=++generation;token='';native=null;info=null;
    const result=await ctx.api('notifications_info');if(stamp!==generation||!account)return;
    if(result.ok){info=result;prefs=result.hasPreferences?result.preferences:{challenges:true,friends:true,packs:true,messages:true}}
    if(typeof bridge()?.bindPushAccount==='function'){
      bridge().bindPushAccount(account);request(false);
    }else paint();
    followRoute();
  }
  function request(enable){
    const requestId=crypto.randomUUID();pending={requestId,account,generation};
    if(enable)bridge().enableNotifications(requestId);else bridge().getPushState(requestId);
  }
  async function save(){
    const selected={};document.querySelectorAll('[data-notification-category]').forEach(e=>selected[e.dataset.notificationCategory]=e.checked);
    if(Object.keys(selected).length===4)prefs=selected;
    const result=await ctx.api('notifications_preferences',{preferences:prefs});
    if(!result.ok){ctx.toast('No se pudieron guardar las preferencias.','bad');return false}
    info=result;ctx.toast('Preferencias de notificaciones guardadas.','good');return true;
  }
  async function disable(){
    // Stop local display immediately, even if the device has just lost its connection.
    bridge()?.disableNotifications?.();native={...native,enabled:false};const old=token;token='';pending=null;
    if(old)await ctx.api('notifications_unregister',{token:old});paint();
  }
  async function stop(){
    const old=token;generation++;pending=null;token='';account='';info=null;native=null;route=null;
    bridge()?.disableNotifications?.();
    if(old)await ctx.api('notifications_unregister',{token:old});
  }
  function followRoute(){
    if(!route||!ctx.state.profile)return;
    const value=route;route=null;if(value.accountId!==ctx.state.profile.id)return;
    if(value.route==='messages'){ctx.go('profile');void ARCANUM_MESSAGES.open()}
    else if(value.route==='friends')ctx.go('profile');else if(value.route==='shop')ctx.go('shop');else ctx.go('home');
  }
  window.addEventListener('arcanum:push',async e=>{
    const value=e.detail,request=pending;
    if(!request||value?.requestId!==request.requestId||request.generation!==generation||request.account!==ctx.state.profile?.id)return;
    pending=null;native={available:!!value.available,permission:!!value.permission,enabled:!!value.enabled};
    if(value.token&&native.permission&&native.enabled){
      const result=await ctx.api('notifications_register',{token:value.token});
      if(request.generation!==generation)return;
      if(result.ok)token=value.token;else ctx.toast('No se pudo registrar este móvil para los avisos. Vuelve a intentarlo.','bad');
    }
    if(value.error)ctx.toast('No se pudo conectar con las notificaciones. Vuelve a intentarlo.','bad');
    paint();
  });
  window.addEventListener('arcanum:notification-open',e=>{route=e.detail;followRoute()});
  document.addEventListener('click',async e=>{
    if(e.target.closest('[data-notification-save]'))void save();
    if(e.target.closest('[data-notification-enable]')&&info?.configured&&typeof bridge()?.enableNotifications==='function'){
      if(await save())request(true);
    }
    if(e.target.closest('[data-notification-disable]'))void disable();
  });
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&account&&typeof bridge()?.getPushState==='function')request(false)});
  return{bind:c=>ctx=c,start,stop,panel};
})();
