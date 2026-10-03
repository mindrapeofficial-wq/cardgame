"use strict";
window.ARCANUM_AUDIO=(()=>{
  const key="arcanum.audio.v1";
  const files={click:"sonidos/click.WAV",turn:"sonidos/turn.wav",draw:"sonidos/n_cartas.wav",summon:"sonidos/invocar.WAV",power:"sonidos/poder.WAV",hit:"sonidos/lucha1.WAV",win:"sonidos/n_lvl.WAV"};
  const clamp=(value,fallback)=>typeof value==="number"&&Number.isFinite(value)?Math.max(0,Math.min(1,value)):fallback;
  let saved=null,legacyOff=false;
  try{saved=JSON.parse(localStorage.getItem(key));legacyOff=localStorage.getItem("rolplay.sound")==="off"}catch{}
  const prefs={music:clamp(saved?.music,.25),effects:clamp(saved?.effects,.28),muted:typeof saved?.muted==="boolean"?saved.muted:legacyOff};
  let active=false,starting=false,blocked=false,failed=false;
  const effects=new Set(),music=document.getElementById("gameBackgroundMusic");
  function persist(){try{localStorage.setItem(key,JSON.stringify(prefs))}catch{}}
  const shouldPlay=()=>active&&!document.hidden&&!prefs.muted&&prefs.music>0;
  function status(){return failed?"No se pudo cargar la música. Puedes volver a intentarlo desde este panel.":blocked?"Toca Activar música para empezar a escucharla.":prefs.muted?"Música y efectos silenciados.":"Dungeon Lobby · música de fondo en bucle"}
  function updateControls(){
    document.querySelectorAll("[data-audio-volume]").forEach(el=>el.value=Math.round(prefs[el.dataset.audioVolume]*100));
    document.querySelectorAll("[data-audio-output]").forEach(el=>el.textContent=Math.round(prefs[el.dataset.audioOutput]*100)+" %");
    document.querySelectorAll("[data-audio-mute]").forEach(el=>el.checked=prefs.muted);
    document.querySelectorAll("[data-audio-status]").forEach(el=>el.textContent=status());
    document.querySelectorAll("[data-audio-retry]").forEach(el=>el.hidden=!blocked&&!failed);
    document.querySelectorAll("[data-audio-open]").forEach(el=>{el.title=prefs.muted?"Ajustes de audio · silenciado":"Ajustes de audio";el.classList.toggle("audio-is-muted",prefs.muted)});
  }
  function syncMusic(){
    if(!music)return;
    music.volume=prefs.music;music.muted=prefs.muted;
    if(!shouldPlay()){music.pause();return}
    if(!music.getAttribute("src"))music.src="assets/audio/dungeon-lobby.mp3";
    if(!music.paused||starting)return;
    starting=true;
    music.play().then(()=>{blocked=false;failed=false;if(!shouldPlay())music.pause();updateControls()}).catch(error=>{blocked=error?.name==="NotAllowedError";failed=!blocked&&error?.name!=="AbortError";updateControls()}).finally(()=>{starting=false});
  }
  function sync(){
    for(const effect of effects){effect.volume=prefs.effects;effect.muted=prefs.muted}
    syncMusic();updateControls();
  }
  function stopEffects(){for(const effect of effects)effect.pause();effects.clear()}
  function setActive(value){active=!!value;if(!active)stopEffects();sync()}
  function playEffect(name){
    if(!active||document.hidden||prefs.muted||prefs.effects<=0||!files[name])return;
    const effect=new Audio(files[name]);effect.volume=prefs.effects;
    if(effects.size>=12){const oldest=effects.values().next().value;oldest.pause();effects.delete(oldest)}
    effects.add(effect);const remove=()=>effects.delete(effect);
    effect.addEventListener("ended",remove,{once:true});effect.addEventListener("error",remove,{once:true});
    effect.play().catch(remove);
  }
  function controls(scope){return `<div class="audio-controls"><label for="${scope}-music"><span>Música</span><output data-audio-output="music">${Math.round(prefs.music*100)} %</output></label><input id="${scope}-music" type="range" min="0" max="100" step="1" value="${Math.round(prefs.music*100)}" data-audio-volume="music" aria-label="Volumen de la música"><label for="${scope}-effects"><span>Efectos</span><output data-audio-output="effects">${Math.round(prefs.effects*100)} %</output></label><input id="${scope}-effects" type="range" min="0" max="100" step="1" value="${Math.round(prefs.effects*100)}" data-audio-volume="effects" aria-label="Volumen de los efectos"><label class="audio-mute"><input type="checkbox" data-audio-mute ${prefs.muted?"checked":""}><span>Silenciar música y efectos</span></label><p class="audio-status" data-audio-status role="status">${status()}</p><button type="button" class="btn small" data-audio-retry ${blocked||failed?"":"hidden"}>Activar música</button><small class="muted">Los ajustes se guardan en este dispositivo.</small></div>`}
  function panel(){return `<section class="panel audio-settings-panel"><div class="panel-head"><h2>Audio del juego</h2></div><div class="panel-body">${controls("profile-audio")}</div></section>`}
  function open(){
    const dialog=document.getElementById("audioDialog");if(!dialog)return;
    dialog.innerHTML=`<div class="audio-dialog-heading"><h2 id="audioTitle">Audio del juego</h2><button class="btn icon ghost" type="button" data-audio-close aria-label="Cerrar ajustes de audio">×</button></div>${controls("dialog-audio")}`;
    if(!dialog.open)dialog.showModal();updateControls();
  }
  document.addEventListener("click",e=>{
    if(e.target.closest("[data-audio-open]"))open();
    if(e.target.closest("[data-audio-close]"))document.getElementById("audioDialog")?.close();
    if(e.target.closest("[data-audio-retry]")){if(failed)music?.load();failed=false;blocked=false;if(prefs.muted)prefs.muted=false;if(!prefs.music)prefs.music=.25;persist();sync()}
    if(e.isTrusted)syncMusic();
  });
  document.addEventListener("input",e=>{
    if(!e.target.matches("[data-audio-volume]"))return;
    const channel=e.target.dataset.audioVolume;if(!["music","effects"].includes(channel))return;
    prefs[channel]=clamp(Number(e.target.value)/100,prefs[channel]);persist();sync();
  });
  document.addEventListener("change",e=>{if(e.target.matches("[data-audio-mute]")){prefs.muted=e.target.checked;persist();sync()}});
  document.addEventListener("keydown",e=>{if(e.isTrusted&&!e.ctrlKey&&!e.metaKey&&!e.altKey)syncMusic()});
  document.addEventListener("visibilitychange",()=>{if(document.hidden)stopEffects();sync()});
  window.addEventListener("pagehide",()=>{music?.pause();stopEffects()});
  window.addEventListener("pageshow",sync);
  updateControls();return{setActive,playEffect,panel,open};
})();
