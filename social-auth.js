"use strict";
window.ARCANUM_SOCIAL=(()=>{
  const url='https://mrmvmoyysxuopqexbxfk.supabase.co',key='sb_publishable_tZEPJi2v7Tp-xDuVa0qWRw_geizIGoD';
  const flowKey='arcanum.oauth.flow.v1';
  let ctx,providers=[],started=false,pending=null,busy=false,claim='',claimExpires=0;
  const random=()=>{const b=crypto.getRandomValues(new Uint8Array(32));return btoa(String.fromCharCode(...b)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'')};
  const dialog=()=>document.getElementById('socialDialog');
  function buttons(purpose){return providers.map(p=>`<button type="button" class="btn social-provider" data-social-provider="${p}" data-social-purpose="${purpose}">${purpose==='link'?'Vincular':'Continuar con'} ${p==='google'?'Google':'Apple'}</button>`).join('')}
  function refreshButtons(){const box=document.getElementById('socialLogin');if(box){box.innerHTML=buttons('login');box.hidden=!providers.length}}
  async function init(){
    started=true;
    try{const r=await fetch(url+'/auth/v1/settings',{headers:{apikey:key},signal:AbortSignal.timeout(8000),cache:'no-store'});const data=await r.json();
      if(r.ok)providers=['google','apple'].filter(p=>data.external?.[p]===true)}catch{}
    refreshButtons();
    const params=new URLSearchParams(location.search),code=params.get('oauth_code'),flow=params.get('oauth_flow');
    if(code){params.delete('oauth_code');params.delete('oauth_flow');history.replaceState(null,'',location.pathname+(params.size?'?'+params:'')+location.hash);pending={code,flow}}
    if(pending){const value=pending;pending=null;await finish(value)}
  }
  function panel(){return `<section class="panel social-settings-panel"><div class="panel-head"><h2>Acceso a tu cuenta</h2></div><div class="panel-body"><p>Conserva tus cartas y progreso al vincular el acceso con un proveedor desde esta cuenta.</p>${providers.length?`<div class="actions">${buttons('link')}</div>`:'<p class="muted">El acceso con Google y Apple todavía no está activado.</p>'}</div></section>`}
  async function start(provider,purpose){
    if(busy||!providers.includes(provider)||!['login','link','delete'].includes(purpose))return;
    if(purpose!=='login'&&!ctx.state.profile)return;
    busy=true;
    try{
      const verifier=random(),flow=random(),digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier));
      const challenge=btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'');
      const native=typeof window.ArcanumAndroid?.openSocialLogin==='function';
      localStorage.setItem(flowKey,JSON.stringify({verifier,flow,provider,purpose,accountId:ctx.state.profile?.id||null,at:Date.now()}));
      const redirect=new URL('oauth-callback.html',location.href);redirect.searchParams.set('flow',flow);if(native)redirect.searchParams.set('native','1');
      const target=new URL(url+'/auth/v1/authorize');
      for(const [k,v]of Object.entries({provider,redirect_to:redirect.href,code_challenge:challenge,code_challenge_method:'s256'}))target.searchParams.set(k,v);
      target.searchParams.set('prompt',provider==='google'?'select_account':'login');
      if(native)window.ArcanumAndroid.openSocialLogin(target.href);else location.assign(target.href);
    }catch{ctx.toast('No se pudo iniciar el acceso. Comprueba tu conexión.','bad')}
    finally{busy=false}
  }
  async function finish(value){
    if(busy)return;
    let flow=null;try{flow=JSON.parse(localStorage.getItem(flowKey)||'null')}catch{}
    if(!flow||flow.flow!==value.flow||Date.now()-flow.at>10*60*1000||typeof value.code!=='string'||value.code.length>512){ctx.toast('El acceso ha caducado. Vuelve a iniciarlo.','bad');return}
    if(flow.purpose!=='login'&&flow.accountId!==ctx.state.profile?.id){localStorage.removeItem(flowKey);ctx.toast('Entra primero en la cuenta que deseas vincular.','bad');return}
    busy=true;localStorage.removeItem(flowKey);
    try{
      const response=await fetch(url+'/auth/v1/token?grant_type=pkce',{method:'POST',signal:AbortSignal.timeout(15000),headers:{apikey:key,'content-type':'application/json'},
        body:JSON.stringify({auth_code:value.code,code_verifier:flow.verifier})});
      const data=await response.json();if(!response.ok||!data.access_token)throw Error('oauth');
      claim=data.access_token;claimExpires=Date.now()+4*60*1000;
      // Provider access/refresh tokens are deliberately discarded. Only the game session persists.
      if(flow.purpose==='delete'){ctx.openDelete();return}
      const result=await ctx.api(flow.purpose==='link'?'social_link':'social_login',{accessToken:claim},flow.purpose==='link');
      if(!result.ok){ctx.toast(result.error==='identity_already_linked'?'Ese acceso ya pertenece a otra cuenta de ARCANUM.':ctx.authError(result.error),'bad');return}
      if(result.registrationRequired){registration();return}
      if(flow.purpose==='link'){clearClaim();ctx.toast('Acceso vinculado. Tus cartas y progreso se conservan.','good');return}
      clearClaim();ctx.acceptSession(result);
    }catch{clearClaim();ctx.toast('No se pudo completar el acceso. Vuelve a intentarlo.','bad')}
    finally{busy=false}
  }
  function registration(){
    const root=dialog();root.innerHTML=`<div class="social-dialog-head"><h2 id="socialTitle">Elige tu nombre de jugador</h2><button type="button" class="btn" data-social-close aria-label="Cerrar">×</button></div><p>Tu correo y nombre del proveedor no se muestran a otros jugadores.</p><p>Si ya tienes una cuenta de ARCANUM, entra con tu usuario y vincúlala desde Perfil para conservar tu progreso.</p><form id="socialRegisterForm"><label for="socialName">Nombre de jugador</label><input class="input" id="socialName" pattern="[A-Za-z0-9_-]{3,20}" minlength="3" maxlength="20" autocomplete="nickname" required><label for="socialAge">Tu grupo de edad</label><select class="input" id="socialAge" required><option value="">Selecciona tu grupo</option><option value="under16">Menos de 16 años</option><option value="16-17">16–17 años</option><option value="18+">18 años o más</option></select><label class="legal-check"><input type="checkbox" id="socialTerms" required><span>Acepto los <a href="terminos.html" target="_blank" rel="noopener">términos y normas</a> y he leído la <a href="privacidad.html" target="_blank" rel="noopener">política de privacidad</a>.</span></label><button class="btn primary" type="submit">Crear mi cuenta</button><p data-social-status role="status"></p></form>`;
    if(!root.open)root.showModal();
  }
  function reauthenticate(){
    const root=dialog();root.innerHTML=`<div class="social-dialog-head"><h2 id="socialTitle">Verifica tu identidad</h2><button type="button" class="btn" data-social-close aria-label="Cerrar">×</button></div><p>Vuelve a acceder con el proveedor de esta cuenta para confirmar la eliminación.</p><div class="actions">${buttons('delete')}</div>`;
    if(!root.open)root.showModal();
  }
  const clearClaim=()=>{claim='';claimExpires=0};
  document.addEventListener('click',e=>{
    const provider=e.target.closest('[data-social-provider]');if(provider){dialog()?.close();void start(provider.dataset.socialProvider,provider.dataset.socialPurpose)}
    if(e.target.closest('[data-social-close]')){dialog()?.close();clearClaim()}
  });
  document.addEventListener('submit',async e=>{
    if(e.target.id!=='socialRegisterForm')return;e.preventDefault();if(busy)return;
    const payload={accessToken:claim,username:document.getElementById('socialName').value.trim(),ageGroup:document.getElementById('socialAge').value,
      acceptTerms:document.getElementById('socialTerms').checked,termsVersion:ctx.legalVersion};
    const status=e.target.querySelector('[data-social-status]');if(!ctx.validLegal(payload)){status.textContent='Debes tener al menos 16 años y aceptar los términos.';return}
    if(!claim||Date.now()>claimExpires){status.textContent='El acceso ha caducado. Cierra este panel y vuelve a entrar con el proveedor.';return}
    busy=true;const button=e.target.querySelector('button[type=submit]');button.disabled=true;
    try{const result=await ctx.api('social_login',payload,false);if(!result.ok){status.textContent=ctx.authError(result.error);return}
      clearClaim();dialog().close();ctx.acceptSession(result)}finally{busy=false;button.disabled=false}
  });
  window.addEventListener('arcanum:auth',e=>{if(!started)pending=e.detail;else void finish(e.detail)});
  return{bind:c=>ctx=c,init,panel,reauthenticate,reauthToken:()=>Date.now()<claimExpires?claim:'',clear:()=>{clearClaim();localStorage.removeItem(flowKey);dialog()?.close()}};
})();
