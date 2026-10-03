"use strict";
(()=>{
  const endpoint="https://mrmvmoyysxuopqexbxfk.supabase.co/functions/v1/rolplay-api";
  const form=document.getElementById("webDeleteForm"),button=document.getElementById("webDeleteButton"),status=document.getElementById("webDeleteStatus");
  let busy=false;
  async function request(action,payload,token=""){
    const headers={"content-type":"application/json"};if(token)headers["x-rolplay-session"]=token;
    const response=await fetch(endpoint,{method:"POST",headers,body:JSON.stringify({action,...payload})});
    const data=await response.json();return{...data,status:response.status};
  }
  form.addEventListener("submit",async e=>{
    e.preventDefault();if(busy)return;
    if(document.getElementById("webDeleteConfirm").value!=="ELIMINAR"){status.textContent="Escribe ELIMINAR para confirmar.";return}
    busy=true;button.disabled=true;status.textContent="Verificando la titularidad y eliminando la cuenta…";
    let token="",deleted=false;
    try{
      const username=document.getElementById("deleteUser").value.trim(),password=document.getElementById("webDeletePassword").value;
      const login=await request("login",{username,password});
      if(!login.ok){status.textContent=login.error==="too_many_attempts"?"Demasiados intentos. Espera 15 minutos.":"No se pudo verificar la cuenta. Comprueba tu usuario y contraseña.";return}
      token=login.token;
      const result=await request("delete_account",{password,confirm:"ELIMINAR"},token);
      if(!result.ok){status.textContent=result.error==="too_many_attempts"?"Demasiados intentos. Espera 15 minutos.":"No se pudo eliminar la cuenta. Inténtalo de nuevo o contacta con asistencia.";return}
      deleted=true;
      // Do not wipe another account's session if this browser was signed in as someone else.
      let cache=null;try{cache=JSON.parse(localStorage.getItem("rolplay.profile.cache.v2")||"null")}catch{}
      if(cache?.id===login.profile?.id){for(const k of["rolplay.session.v1","rolplay.profile.cache.v2","rolplay.last.username","rolplay.pending.rewards.v1"])localStorage.removeItem(k)}
      form.reset();status.textContent="Cuenta y datos eliminados. Tus sesiones han sido revocadas.";
      [...form.querySelectorAll("input")].forEach(input=>input.disabled=true);button.hidden=true;
    }catch{status.textContent="No se pudo contactar con el servidor. Comprueba tu conexión o escribe a mindrapeofficial@gmail.com."}
    finally{if(token&&!deleted)void request("logout",{},token).catch(()=>{});busy=false;button.disabled=false}
  });
})();

