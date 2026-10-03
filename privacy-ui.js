"use strict";
window.ARCANUM_PRIVACY=(()=>{
  const version="2026-10-03";
  let ctx=null,busy=false,required=false,reportContext=null;
  const root=()=>document.getElementById("privacyRoot");
  const validLegal=p=>p.acceptTerms===true&&p.termsVersion===version&&["16-17","18+"].includes(p.ageGroup);
  function shell(title,body,lock=false){
    required=lock;
    root().innerHTML=`<div class="privacy-backdrop"><section class="privacy-dialog" role="dialog" aria-modal="true" aria-labelledby="privacyTitle"><div class="privacy-heading"><h2 id="privacyTitle">${title}</h2>${lock?"":'<button type="button" class="btn" data-privacy-action="close" aria-label="Cerrar">×</button>'}</div>${body}<p id="privacyStatus" class="privacy-status" role="status" aria-live="polite"></p></section></div>`;
    root().querySelector("select,input,button")?.focus();
  }
  function status(text){document.getElementById("privacyStatus").textContent=text}
  function close(){if(!busy&&!required)root().innerHTML=""}
  function ensureAccess(){
    if(ctx.state.profile?.suspended){
      shell("Cuenta suspendida",'<p>La cuenta está suspendida. Puedes solicitar una revisión a <a href="mailto:mindrapeofficial@gmail.com">mindrapeofficial@gmail.com</a> o eliminar tu cuenta y sus datos.</p><div class="actions"><button class="btn danger" data-privacy-action="delete">Eliminar cuenta</button><button class="btn" data-privacy-action="logout">Cerrar sesión</button></div>',true);return false;
    }
    if(ctx.state.profile?.termsVersion===version){root().innerHTML="";required=false;return true}
    shell("Antes de entrar al salón",`<p>ARCANUM TCG está dirigido a personas de 16 años en adelante. Para utilizar el chat debes aceptar las normas: respeto, sin acoso, odio, contenido sexual ni riesgos para menores.</p><form id="legalAcceptForm"><label for="legalAge">Tu grupo de edad</label><select class="input" id="legalAge" required><option value="">Selecciona tu grupo</option><option value="under16">Menos de 16 años</option><option value="16-17">16–17 años</option><option value="18+">18 años o más</option></select><label class="legal-check"><input type="checkbox" id="legalTerms" required><span>Acepto los <a href="terminos.html" target="_blank" rel="noopener">términos y normas</a> y he leído la <a href="privacidad.html" target="_blank" rel="noopener">política de privacidad</a>.</span></label><div class="actions"><button class="btn primary" type="submit">Aceptar y continuar</button><button class="btn" type="button" data-privacy-action="logout">Cerrar sesión</button><button class="btn danger" type="button" data-privacy-action="delete">Eliminar cuenta</button></div></form>`,true);
    return false;
  }
  function isBlocked(name){return(ctx?.state.profile?.blocks||[]).some(b=>String(b.name).toLowerCase()===String(name).toLowerCase())}
  function playerTools(name){
    if(!ctx||name===ctx.state.profile?.name)return"";
    return `<div class="privacy-player-tools"><button class="btn small" data-privacy-action="report" data-name="${ctx.esc(name)}">Denunciar jugador</button><button class="btn small" data-privacy-action="${isBlocked(name)?"unblock":"block"}" data-name="${ctx.esc(name)}">${isBlocked(name)?"Desbloquear":"Bloquear"}</button></div>`;
  }
  function chatTools(m){
    if(!m.from||m.from===ctx.state.profile?.name)return"";
    return `<span class="privacy-chat-tools"><button type="button" data-privacy-action="report" data-name="${ctx.esc(m.from)}" data-message-id="${ctx.esc(m.id||"")}" aria-label="Denunciar mensaje de ${ctx.esc(m.from)}">Denunciar</button><button type="button" data-privacy-action="block" data-name="${ctx.esc(m.from)}" aria-label="Bloquear a ${ctx.esc(m.from)}">Bloquear</button></span>`;
  }
  function accountPanel(){
    const blocks=ctx.state.profile?.blocks||[];
    return `<section class="panel privacy-account-panel"><div class="panel-head"><h2>Privacidad y seguridad</h2></div><div class="panel-body"><nav class="legal-links" aria-label="Información legal"><a href="privacidad.html">Privacidad</a><a href="terminos.html">Términos y normas</a><a href="aviso-legal.html">Aviso legal</a><a href="mailto:mindrapeofficial@gmail.com">Asistencia</a>${ctx.state.profile?.moderator?'<a href="moderacion.html">Revisar denuncias</a>':""}</nav><h3>Jugadores bloqueados</h3>${blocks.length?blocks.map(b=>`<div class="privacy-block-row"><span>${ctx.esc(b.name)}</span><button class="btn small" data-privacy-action="unblock" data-name="${ctx.esc(b.name)}">Desbloquear</button></div>`).join(""):'<p class="muted">No has bloqueado a ningún jugador.</p>'}<p class="muted">El bloqueo oculta sus mensajes e impide solicitudes de amistad, retos privados y señales de voz entre ambas cuentas.</p><button class="btn danger" data-privacy-action="delete">Eliminar mi cuenta y datos</button></div></section>`;
  }
  function deleteDialog(){
    ctx.closeModal();
    shell("Eliminar cuenta y datos",`<p>Se eliminarán permanentemente <b>${ctx.esc(ctx.state.profile.name)}</b>, su progreso, cartas, mazos, amistades, sesiones y vínculo con Discord. No podrás recuperar la cuenta. Los registros mínimos de pagos se conservarán por obligaciones legales, separados del perfil.</p><form id="privacyDeleteForm"><label for="deletePassword">Confirma tu contraseña</label><input id="deletePassword" class="input" type="password" autocomplete="current-password" minlength="8" maxlength="128" required><label for="deleteConfirm">Escribe ELIMINAR</label><input id="deleteConfirm" class="input" autocomplete="off" pattern="ELIMINAR" required><div class="actions"><button class="btn danger" type="submit">Eliminar definitivamente</button><button class="btn" type="button" data-privacy-action="cancelDelete">Cancelar</button></div></form>`);
  }
  function reportDialog(el){
    const name=el.dataset.name,message=ctx.state.chat.find(m=>m.id&&m.id===el.dataset.messageId);
    reportContext={name,messageId:message?.id||"",messageText:message?.text||""};
    ctx.closeModal();
    shell("Denunciar a "+ctx.esc(name),`<p>La denuncia será revisada por moderación. Tu identidad no se mostrará al jugador denunciado.</p>${message?`<blockquote>${ctx.esc(message.text)}</blockquote>`:""}<form id="privacyReportForm"><label for="reportReason">Motivo</label><select class="input" id="reportReason" required><option value="">Selecciona un motivo</option><option value="acoso">Acoso o amenazas</option><option value="odio">Odio o discriminación</option><option value="contenido_sexual">Contenido sexual</option><option value="riesgo_menores">Riesgo o explotación de menores</option><option value="spam">Spam o estafas</option><option value="trampas">Trampas</option><option value="otro">Otro</option></select><label for="reportDetails">Detalles (opcional)</label><textarea id="reportDetails" class="input" maxlength="1000" rows="4" placeholder="Explica lo ocurrido sin incluir datos privados innecesarios."></textarea><label class="legal-check"><input type="checkbox" id="reportBlock">Bloquear también a este jugador</label><button class="btn primary" type="submit">Enviar denuncia</button></form>`);
  }
  async function refresh(){const r=await ctx.api("me");if(r.ok){ctx.applyProfile(r.profile);ctx.renderView()}}
  async function block(name,remove=false){
    const r=await ctx.api(remove?"unblock_player":"block_player",{name});
    if(!r.ok){ctx.toast("No se pudo actualizar el bloqueo. Inténtalo de nuevo.","bad");return false}
    if(!remove)ctx.state.chat=ctx.state.chat.filter(m=>String(m.from).toLowerCase()!==String(name).toLowerCase());
    await refresh();ctx.toast(remove?"Jugador desbloqueado.":"Jugador bloqueado.","good");return true;
  }
  document.addEventListener("click",e=>{
    const el=e.target.closest("[data-privacy-action]");if(!el||!ctx||busy)return;
    e.preventDefault();const action=el.dataset.privacyAction;
    if(action==="close")close();
    else if(action==="cancelDelete"){close();ensureAccess()}
    else if(action==="logout"){required=false;close();ctx.logout()}
    else if(action==="delete")deleteDialog();
    else if(action==="report")reportDialog(el);
    else if(action==="block"||action==="unblock")void block(el.dataset.name,action==="unblock");
  });
  document.addEventListener("submit",async e=>{
    const id=e.target.id;
    if(!["legalAcceptForm","privacyDeleteForm","privacyReportForm"].includes(id)||!ctx)return;
    e.preventDefault();if(busy)return;busy=true;
    const buttons=[...e.target.querySelectorAll("button")];buttons.forEach(b=>b.disabled=true);
    try{
      if(id==="legalAcceptForm"){
        const payload={termsVersion:version,acceptTerms:document.getElementById("legalTerms").checked,ageGroup:document.getElementById("legalAge").value};
        if(!validLegal(payload)){status("Debes tener al menos 16 años y aceptar los términos.");return}
        const r=await ctx.api("legal_accept",payload);
        if(!r.ok){status("No se pudo guardar la aceptación. Comprueba tu conexión e inténtalo de nuevo.");return}
        await refresh();required=false;root().innerHTML="";ctx.enterGame();
      } else if(id==="privacyDeleteForm"){
        const r=await ctx.api("delete_account",{password:document.getElementById("deletePassword").value,confirm:document.getElementById("deleteConfirm").value});
        if(!r.ok){status(r.error==="invalid_credentials"?"La contraseña es incorrecta.":r.error==="too_many_attempts"?"Demasiados intentos. Espera 15 minutos.":"No se pudo eliminar la cuenta. Inténtalo de nuevo o contacta con asistencia.");return}
        for(const key of ctx.keys)localStorage.removeItem(key);
        for(const id of["loginName","loginPassword","loginConfirm"]){const input=document.getElementById(id);if(input)input.value=""}
        ctx.state.chat=[];ctx.state.savedDecks=[];ctx.state.friends=null;
        required=false;root().innerHTML="";await ctx.logout();ctx.toast("Cuenta y datos eliminados.","good");
      } else {
        const alsoBlock=document.getElementById("reportBlock").checked;
        const r=await ctx.api("report_player",{...reportContext,reason:document.getElementById("reportReason").value,details:document.getElementById("reportDetails").value});
        if(!r.ok){status(r.error==="report_limit"?"Has alcanzado el límite de denuncias de esta hora.":"No se pudo enviar la denuncia. Inténtalo de nuevo.");return}
        const name=reportContext.name;required=false;root().innerHTML="";ctx.toast("Denuncia enviada a moderación.","good");
        if(alsoBlock)await block(name);
      }
    } finally{busy=false;buttons.forEach(b=>b.disabled=false)}
  });
  document.addEventListener("keydown",e=>{if(e.key==="Escape"&&!required&&!busy)close()});
  return{version,bind:c=>ctx=c,validLegal,ensureAccess,isBlocked,playerTools,chatTools,accountPanel};
})();
