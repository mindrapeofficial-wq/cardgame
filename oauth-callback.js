"use strict";
(()=>{
  const p=new URLSearchParams(location.search),code=p.get('code'),flow=p.get('flow'),status=document.getElementById('oauthStatus');
  history.replaceState(null,'',location.pathname);
  if(!code||code.length>512||!flow||!/^[A-Za-z0-9_-]{43}$/.test(flow)||p.has('error')){status.textContent='El acceso no se completó. Vuelve al juego para intentarlo de nuevo.';return}
  if(p.get('native')==='1'){
    const link=document.getElementById('oauthReturn');link.href='arcanumtcg://auth/callback?'+new URLSearchParams({code,flow});link.hidden=false;
    status.textContent='Toca Volver a la app ARCANUM para terminar el acceso.';
  }else location.replace('./?'+new URLSearchParams({oauth_code:code,oauth_flow:flow}));
})();
