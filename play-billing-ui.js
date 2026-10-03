"use strict";
window.ARCANUM_PLAY=(()=>{
  let ctx=null,verification=Promise.resolve();
  const bridge=()=>window.ArcanumAndroid;
  const available=()=>!!(bridge()&&typeof bridge().loadPlayProducts==="function"&&typeof bridge().purchasePlayProduct==="function");
  async function load(){
    if(!ctx||!available())return{configured:false,needsUpdate:true};
    const result=await ctx.api("play_billing_info");
    if(!result.ok)return{configured:false};
    if(result.configured)bridge().loadPlayProducts();
    return result;
  }
  function restore(){if(ctx?.state.profile&&!ctx.state.profile.suspended&&available())bridge().restorePlayPurchases()}
  async function purchase(tier){
    if(!available()){ctx.toast("Actualiza la app para utilizar las compras de Google Play.","bad");return}
    const productId="arcanum_"+tier;
    const prepared=await ctx.api("play_prepare_purchase",{productId});
    if(!prepared.ok){ctx.toast(prepared.error==="tier_closed"?"Esta opción ya no está disponible.":"Las compras de Google Play aún no están disponibles.","bad");return}
    bridge().purchasePlayProduct(productId,prepared.accountHash);
  }
  window.addEventListener("arcanum:billing",event=>{
    if(!ctx)return;const data=event.detail||{};
    if(data.type==="products"){
      ctx.state.playProducts=Object.fromEntries((data.products||[]).map(p=>[p.productId,p]));
      if(ctx.state.view==="support")ctx.renderView();
    }else if(data.type==="purchase"){
      verification=verification.then(async()=>{
        if(!ctx.state.profile)return;
        const currentId=ctx.state.profile.id;
        const result=await ctx.api("play_verify_purchase",{productId:data.productId,purchaseToken:data.purchaseToken});
        if(ctx.state.profile?.id!==currentId)return;
        if(!result.ok){ctx.toast(result.error==="purchase_pending"?"El pago está pendiente. La recompensa llegará cuando se confirme.":"No se pudo verificar la compra. Puedes volver a comprobarla desde Apoya el proyecto.","bad");return}
        const previous=ctx.state.profile.supporterTier;
        ctx.applyProfile(result.profile);ctx.renderView();
        if(previous!==result.profile.supporterTier)ctx.toast("Compra verificada y recompensa activada.","good");
      }).catch(()=>ctx.toast("No se pudo comprobar la compra. Inténtalo de nuevo.","bad"));
    }else if(data.type==="error"){
      const messages={cancelled:"Compra cancelada.",purchase_pending:"Pago pendiente de confirmación.",products_unavailable:"No hay productos de Google Play disponibles para esta cuenta.",billing_unavailable:"No se pudo conectar con Google Play. Inténtalo de nuevo."};
      ctx.toast(messages[data.error]||"No se pudo completar la compra.",data.error==="cancelled"?"":"bad");
    }
  });
  document.addEventListener("click",e=>{if(e.target.closest("[data-play-restore]")){e.preventDefault();restore()}});
  document.addEventListener("visibilitychange",()=>{if(!document.hidden)restore()});
  return{bind:c=>ctx=c,load,purchase,restore,available};
})();

