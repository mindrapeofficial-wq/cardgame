"use strict";
(()=>{
  const endpoint="https://mrmvmoyysxuopqexbxfk.supabase.co/functions/v1/rolplay-api";
  const root=document.getElementById("reportsRoot"),status=document.getElementById("moderationStatus");
  const esc=s=>String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));
  async function api(action,payload={}){
    const token=localStorage.getItem("rolplay.session.v1")||"";
    if(!token)return{ok:false,error:"unauthorized"};
    try{
      const response=await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json","x-rolplay-session":token},body:JSON.stringify({action,...payload})});
      return await response.json();
    }catch{return{ok:false,error:"network_error"}}
  }
  async function load(){
    status.textContent="Cargando denuncias…";
    const result=await api("moderation_list");
    if(!result.ok){root.innerHTML="";status.textContent=result.error==="unauthorized"?"Inicia sesión en el juego con la cuenta de moderación y vuelve a esta página.":result.error==="forbidden"?"Esta cuenta no tiene acceso a moderación.":"No se pudieron cargar las denuncias.";return}
    status.textContent=`${result.reports.length} denuncias recientes. Revisa las pendientes y los riesgos para menores con prioridad.`;
    root.innerHTML=result.reports.map(r=>`<section class="legal-card"><h2>${esc(r.reason)} · ${esc(r.status)}</h2><p><b>Denunciado:</b> ${esc(r.target?.username||"Cuenta eliminada")} ${r.target?.suspended_at?"(suspendido)":""}<br><b>Denunciante:</b> ${esc(r.reporter?.username||"Cuenta eliminada")}<br><b>Fecha:</b> ${esc(new Date(r.created_at).toLocaleString("es-ES"))}</p>${r.message_text?`<blockquote>${esc(r.message_text)}</blockquote>`:""}<p>${esc(r.details)}</p><form data-report-id="${esc(r.id)}"><label>Resultado<select name="status" required><option value="reviewed">Revisada</option><option value="dismissed">Desestimada</option><option value="action_taken">Medida aplicada</option></select></label><label>Nota de moderación<textarea name="note" maxlength="1000" rows="3">${esc(r.moderator_note||"")}</textarea></label><label><input name="suspend" type="checkbox" ${r.target?.username?"":"disabled"}>Suspender la cuenta denunciada y revocar sus sesiones</label><label>Para suspender, escribe exactamente el usuario denunciado<input name="confirmName" maxlength="20" autocomplete="off"></label><button type="submit">Guardar revisión</button><p class="review-status" role="status"></p></form></section>`).join("")||"<p>No hay denuncias recientes.</p>";
  }
  document.getElementById("refreshReports").addEventListener("click",load);
  root.addEventListener("submit",async e=>{
    const form=e.target.closest("form[data-report-id]");if(!form)return;
    e.preventDefault();const button=form.querySelector("button"),note=form.querySelector(".review-status");button.disabled=true;
    const fields=new FormData(form);
    const result=await api("moderation_review",{reportId:form.dataset.reportId,status:fields.get("status"),note:fields.get("note"),suspend:fields.get("suspend")==="on",confirmName:fields.get("confirmName")});
    note.textContent=result.ok?"Revisión guardada.":result.error==="suspension_confirmation_required"?"El nombre no coincide. No se ha suspendido la cuenta.":"No se pudo guardar la revisión.";
    button.disabled=false;
    if(result.ok)void load();
  });
  void load();
})();

