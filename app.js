"use strict";

(function(){
const SERVER_URL="https://cardgame-server-erng.onrender.com";
const AUTH_API="https://mrmvmoyysxuopqexbxfk.supabase.co/functions/v1/rolplay-api";
const PHASES=["Enderezar","Robar","Poder","Invocar","Habilidades","Ataque"];
const SESSION_KEY="rolplay.session.v1";
const PROFILE_CACHE_KEY="rolplay.profile.cache.v2";
const LAST_USER_KEY="rolplay.last.username";
const PENDING_REWARDS_KEY="rolplay.pending.rewards.v1";
const CARD_BACK_IMAGE="assets/arcanum-card-back.webp";
const DECK_MIN=20;
const DECK_MAX=50;
const DECK_SIZE=DECK_MIN;
const MIN_POWER_CARDS=7;
const MAX_POWER_CARDS=40;
const MAX_POWER_POINTS=200;
const MATCH_LIMIT_MS=40*60*1000;
const COMBAT_LEAVE_GRACE_MS=2*60*1000;
const COMBAT_IDLE_BASE_MS=3*60*1000;
const COMBAT_IDLE_MAX_MS=5*60*1000;
const COMBAT_IDLE_ACTION_BONUS_MS=10*1000;
const CARD_DEATH_ANIMATION_MS=900;
const DUEL_GAME_ACTIONS=new Set(["duelCard","nextPhase","passDefense","concede","drawButton","offerDraw","acceptDraw","rejectDraw"]);
let sessionToken=localStorage.getItem(SESSION_KEY)||"";
let deckWriteQueue=Promise.resolve();
let deckWriteVersion=0;
let duelOrientationLockActive=false;
let duelFullscreenEnteredOnce=false;
let duelFullscreenDeadlineAt=0;
let duelFullscreenForfeitHandled=false;
let duelFullscreenMatchKey="";
let duelFullscreenAutoRequested=false;
let duelAwayReason="";
let duelLobbyAway=false;
let duelLastActivityAt=Date.now();
let duelIdleAllowanceMs=COMBAT_IDLE_BASE_MS;
let duelIdleWarn90Shown=false;
let duelIdleFinalCountdownVisible=false;
let duelActivityEmitAt=0;
const RARITIES=[
  {name:"Común",key:"common",min:0},
  {name:"Poco común",key:"uncommon",min:10},
  {name:"Rara",key:"rare",min:35},
  {name:"Épica",key:"epic",min:70},
  {name:"Legendaria",key:"legendary",min:Infinity}
];
const LEGENDARY_IDS=new Set([76,115,142,157,158,160,161,176,183,190,191,192,193,194,203,210,213,215,216,229,230,236,237,238,242,248,253,265,269,272,273,279,283,284,285]);
const LEVEL1_COMBAT_STATS=Object.freeze({
  "Duende":{atk:1,def:1},
  "Elfo Bardo":{atk:0,def:2},
  "Guerrero Menor":{atk:1,def:1},
  "Dophan":{atk:2,def:1},
  "Gorad Menor":{atk:1,def:2},
  "Mimit":{atk:0,def:3},
  "Mel":{atk:1,def:1}
});
const LEVEL1_POWER_COSTS=Object.freeze({
  "Duende":1,
  "Elfo Bardo":2,
  "Guerrero Menor":2,
  "Mel":2,
  "Dophan":3,
  "Gorad Menor":3,
  "Mimit":3
});
const $=id=>document.getElementById(id);
const state={
  catalog:[],byId:new Map(),imageMap:{},profile:null,view:"home",
  socket:null,connected:false,connecting:false,users:[],matches:[],chat:[],
  collectionQuery:"",collectionMode:"owned",collectionType:"all",deckTarget:DECK_SIZE,
  savedDecks:[],activeDeckId:null,deckName:"",decksLoading:false,
  duel:null,trade:freshTrade(),lastPack:[],packLevel:null,packOdds:[],packOddsLoading:false,sound:localStorage.getItem("rolplay.sound")!=="off",
  authMode:"login",authBusy:false,offlineSession:false,
  ranking:[],rankingLoading:false,myRank:null,
  marketListings:[],marketLoading:false,marketKind:"gold"
};

function freshTrade(){return{mine:[],theirs:[],theirGold:0,ownGold:0,onlineId:null,partnerId:"",partnerName:"",ready:false,accepted:false,revision:null}}
function esc(s){return String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]))}
function norm(s){return String(s??"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase()}
function summonCost(name,level,powerCard){
  if(powerCard)return 0;
  const fixed=Number(level)===1?LEVEL1_POWER_COSTS[name]:undefined;
  return Number.isFinite(fixed)?fixed:Math.max(1,Math.min(10,Math.ceil((Number(level)||1)/5)));
}
function uid(){return crypto.randomUUID?crypto.randomUUID():Math.random().toString(36).slice(2)+Date.now().toString(36)}
function shuffle(a){a=a.slice();for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a}
function clamp(n,a,b){return Math.min(b,Math.max(a,n))}
function initial(s){return (String(s||"?").trim()[0]||"?").toUpperCase()}
function rarity(c){
  if(LEGENDARY_IDS.has(Number(c.id)))return RARITIES[4];
  if(c.rarity>=70)return RARITIES[3];
  if(c.rarity>=35)return RARITIES[2];
  if(c.rarity>=10)return RARITIES[1];
  return RARITIES[0];
}
function cardType(c){return c.powerCard?"Poder":c.abilityCard?"Habilidad":"Criatura"}
function cardValue(c){return Math.max(1,Math.round(c.level/2)+Math.round(c.rarity/20))}
function powerValue(c){const m=c&&c.name.match(/^Poder\s+x\s+(\d+)/i);return m?Math.max(1,Number(m[1])||1):1}
function powerTotal(list){return Math.min(MAX_POWER_POINTS,(list||[]).reduce((n,c)=>n+powerValue(c),0))}
function owned(id){return Number(state.profile?.collection?.[id]||0)}
function deckCount(id){return state.profile?.deck?.filter(x=>Number(x)===Number(id)).length||0}
function isBasicPower(c){return !!(c&&c.powerCard&&c.level===1)}
function freeCopies(id){const c=card(id);return isBasicPower(c)?Infinity:Math.max(0,owned(id)-deckCount(id))}
function card(id){return state.byId.get(Number(id))}
function isPowerName(n){return /^Poder(?:\s+x\s+\d+|\s*$)/i.test(n)}
function isAbilityName(n){return /^(Veneno|Fuente de vida|Drenador|Escudal|Barrera Mistica|Poder Mental|Poderador|Rueda)/i.test(n)}

function imageKey(s){
  return norm(s).replace(/\bx\s+(\d+)/g,"$1").replace(/\b(del|de|la|el)\b/g," ").replace(/[^a-z0-9]+/g,"");
}
function cardImage(c){
  if(!c)return CARD_BACK_IMAGE;
  if(isBasicPower(c))return"assets/arcanum-power-lvl1.png";
  const k=imageKey(c.name);
  if(k==="arpada")return"legacy-assets/imagenes/crt_arpia_g.jpg";
  if(k==="dragonoscuro")return"legacy-assets/imagenes/crt_dragon_sombra_g.jpg";
  return state.imageMap[k]||CARD_BACK_IMAGE;
}
function parseCards(text){
  state.catalog=text.trim().split(/\r?\n/).slice(1).filter(Boolean).map((line,i)=>{
    const p=line.split(";"),name=p[0],rar=Number(p[1])||1,quantity=Number(p[2])||1,level=Number(p[3])||1;
    const powerCard=isPowerName(name),abilityCard=isAbilityName(name);
    const fixedStats=Number(level)===1?LEVEL1_COMBAT_STATS[name]:undefined;
    return{id:i+1,name,rarity:rar,quantity,level,powerCard,abilityCard,
      cost:summonCost(name,level,powerCard),
      atk:(powerCard||abilityCard)?0:(fixedStats?fixedStats.atk:Math.max(1,Math.ceil(level*.52)+Math.floor(rar/30))),
      def:(powerCard||abilityCard)?0:(fixedStats?fixedStats.def:Math.max(1,Math.ceil(level*.40)+Math.floor((101-rar)/40)))
    };
  });
  state.byId=new Map(state.catalog.map(c=>[c.id,c]));
}
function applyImageIndex(j){
  for(const file of j.files||[]){
    let stem=file.replace(/\.(jpg|gif)$/i,""),isG=/_g$/i.test(stem);
    stem=stem.replace(/^crt_/i,"").replace(/_(g|h)$/i,"");
    const k=imageKey(stem.replace(/_/g," "));
    if(!state.imageMap[k]||isG)state.imageMap[k]="legacy-assets/imagenes/"+file;
  }
}

function cacheProfile(){
  if(!state.profile)return;
  try{localStorage.setItem(PROFILE_CACHE_KEY,JSON.stringify(state.profile))}catch{}
}
function cachedProfile(){
  try{return JSON.parse(localStorage.getItem(PROFILE_CACHE_KEY)||"null")}catch{return null}
}
function applyProfile(profile){
  if(!profile)return;
  state.profile={
    ...profile,
    level:clamp(Number(profile.level)||1,1,50),
    xp:Math.max(0,Number(profile.xp)||0),
    xpRequired:Math.max(0,Number(profile.xpRequired)||0),
    totalXp:Math.max(0,Number(profile.totalXp)||0),
    coins:Math.max(0,Number(profile.coins)||0),
    wins:Math.max(0,Number(profile.wins)||0),
    draws:Math.max(0,Number(profile.draws)||0),
    losses:Math.max(0,Number(profile.losses)||0),
    elo:Number.isFinite(Number(profile.elo))?Number(profile.elo):1000,
    rankedMatches:Math.max(0,Number(profile.rankedMatches)||0),
    eloEver2400:!!profile.eloEver2400,
    collection:profile.collection&&typeof profile.collection==="object"?profile.collection:{},
    deck:Array.isArray(profile.deck)?profile.deck.map(Number):[],
    packs:Math.max(0,Number(profile.packs)||0)
  };
  if(state.packLevel==null||state.packLevel>state.profile.level)state.packLevel=state.profile.level;
  localStorage.setItem(LAST_USER_KEY,state.profile.name||"");
  cacheProfile();
  if(state.socket&&state.socket.connected)state.socket.emit("profile:refresh");
}
function authErrorMessage(code){
  const map={
    username_invalid:"El usuario debe tener entre 3 y 20 caracteres y usar letras, números, _ o -.",
    password_invalid:"La contraseña debe tener al menos 8 caracteres.",
    username_taken:"Ese nombre de usuario ya está registrado.",
    invalid_credentials:"Usuario o contraseña incorrectos.",
    unauthorized:"La sesión ha caducado. Vuelve a iniciar sesión.",
    not_enough_gold:"No tienes oro suficiente.",
    no_cards_for_level:"No hay cartas disponibles para tu nivel.",
    card_above_player_level:"Tu nivel todavía no permite usar una de esas cartas.",
    not_enough_copies:"No posees suficientes copias para ese mazo.",
    no_free_copy:"Esa copia está siendo usada por el mazo.",
    basic_power_is_infinite:"Los Poderes básicos son infinitos y no se venden.",
    network_error:"No se pudo contactar con el servidor de cuentas.",
    pack_level_locked:"Ese nivel de sobre todavía está bloqueado.",
    deck_name_invalid:"Ponle un nombre al mazo.",
    deck_name_taken:"Ya tienes un mazo con ese nombre.",
    deck_limit_reached:"Has alcanzado el límite de 12 mazos guardados.",
    deck_not_found:"Ese mazo ya no existe.",
    basic_power_not_tradeable:"Los Poderes básicos de nivel 1 no pueden anunciarse ni intercambiarse.",
    market_listing_limit:"Has alcanzado el límite de 30 anuncios activos.",
    market_price_invalid:"Indica un precio de oro válido.",
    wanted_card_required:"Selecciona la carta que buscas a cambio.",
    wanted_card_not_found:"La carta solicitada ya no existe.",
    same_card_trade:"No puedes pedir exactamente la misma carta que ofreces.",
    wanted_card_above_player_level:"No puedes pedir una carta por encima de tu nivel.",
    wanted_card_above_seller_level:"El vendedor todavía no puede recibir esa carta.",
    no_free_wanted_card:"No tienes una copia libre de la carta solicitada.",
    market_listing_not_found:"Ese anuncio ya no está disponible.",
    market_not_owner:"Ese anuncio pertenece a otro jugador.",
    market_self_accept:"No puedes aceptar tu propio anuncio.",
    market_listing_invalid:"El anuncio no es válido.",
    market_kind_invalid:"El tipo de anuncio no es válido."
  };
  return map[code]||"No se pudo completar la operación.";
}
async function api(action,payload={},auth=true){
  const headers={"content-type":"application/json"};
  if(auth&&sessionToken)headers["x-rolplay-session"]=sessionToken;
  try{
    const res=await fetch(AUTH_API,{method:"POST",headers,body:JSON.stringify({action,...payload})});
    let data={};try{data=await res.json()}catch{}
    if(!res.ok||!data.ok)return{ok:false,error:data.error||"server_error",status:res.status};
    return data;
  }catch(e){
    return{ok:false,error:"network_error",network:true};
  }
}
function setAuthMode(mode){
  state.authMode=mode==="register"?"register":"login";
  document.querySelectorAll("[data-auth-mode]").forEach(b=>b.classList.toggle("active",b.dataset.authMode===state.authMode));
  const title=$("authTitle"),desc=$("authDesc"),submit=$("authSubmit"),confirm=$("confirmField");
  if(title)title.textContent=state.authMode==="register"?"Crear cuenta":"Entrar al salón";
  if(desc)desc.textContent=state.authMode==="register"
    ?"Empiezas en nivel 1, sin cartas coleccionables, con Poder básico infinito y 100 de oro para abrir tus primeros sobres."
    :"Entra con tu usuario y contraseña para recuperar tu progreso.";
  if(submit)submit.textContent=state.authMode==="register"?"Crear usuario":"Iniciar sesión";
  if(confirm)confirm.classList.toggle("hidden",state.authMode!=="register");
}
function showAuth(){
  $("appShell")?.classList.add("hidden");$("loginScreen")?.classList.remove("hidden");
  $("bootLoader")?.classList.add("hidden");$("loginForm")?.classList.remove("hidden");
  const last=localStorage.getItem(LAST_USER_KEY)||"";
  if($("loginName")&&!$("loginName").value)$("loginName").value=last;
  setAuthMode(state.authMode);
}
async function authenticateForm(){
  if(state.authBusy)return;
  const username=String($("loginName")?.value||"").trim();
  const password=String($("loginPassword")?.value||"");
  const confirm=String($("loginConfirm")?.value||"");
  if(state.authMode==="register"&&password!==confirm){toast("Las contraseñas no coinciden.","bad");return}
  state.authBusy=true;if($("authSubmit"))$("authSubmit").disabled=true;
  const result=await api(state.authMode==="register"?"register":"login",{username,password},false);
  state.authBusy=false;if($("authSubmit"))$("authSubmit").disabled=false;
  if(!result.ok){toast(authErrorMessage(result.error),"bad");return}
  sessionToken=result.token||"";localStorage.setItem(SESSION_KEY,sessionToken);
  applyProfile(result.profile);enterGame();
}
function enterGame(){
  if(!state.profile)return;
  $("loginScreen")?.classList.add("hidden");$("appShell")?.classList.remove("hidden");
  updateChrome();connectOnline();go("home");void syncPendingRewards();void loadDecks();
}
async function logout(){
  if(sessionToken)void api("logout",{},true);
  if(state.socket){state.socket.disconnect();state.socket=null}
  state.connected=false;state.duel=null;state.trade=freshTrade();state.profile=null;
  sessionToken="";localStorage.removeItem(SESSION_KEY);localStorage.removeItem(PROFILE_CACHE_KEY);
  showAuth();
}
function saveProfile(){
  cacheProfile();updateChrome();
}
function queueReward(payload){
  try{
    const q=JSON.parse(localStorage.getItem(PENDING_REWARDS_KEY)||"[]");
    if(!q.some(x=>x.rewardKey===payload.rewardKey))q.push(payload);
    localStorage.setItem(PENDING_REWARDS_KEY,JSON.stringify(q.slice(-30)));
  }catch{}
}
async function syncPendingRewards(){
  if(!sessionToken)return;
  let q=[];try{q=JSON.parse(localStorage.getItem(PENDING_REWARDS_KEY)||"[]")}catch{}
  if(!Array.isArray(q)||!q.length)return;
  const remaining=[];
  for(const reward of q){
    const r=await api("award_result",reward,true);
    if(r.ok&&r.profile)applyProfile(r.profile);else remaining.push(reward);
  }
  localStorage.setItem(PENDING_REWARDS_KEY,JSON.stringify(remaining));
  updateChrome();if(state.view==="profile"||state.view==="home")renderView();
}

function playSound(name){
  if(!state.sound)return;
  const files={click:"sonidos/click.WAV",turn:"sonidos/turn.wav",draw:"sonidos/n_cartas.wav",summon:"sonidos/invocar.WAV",power:"sonidos/poder.WAV",hit:"sonidos/lucha1.WAV",win:"sonidos/n_lvl.WAV"};
  const src=files[name];if(!src)return;
  try{const a=new Audio(src);a.volume=.28;a.play().catch(()=>{})}catch{}
}
function toast(message,type=""){
  const stack=$("toasts");if(!stack)return;
  const el=document.createElement("div");el.className="toast "+type;el.textContent=message;stack.appendChild(el);
  setTimeout(()=>el.remove(),3400);
}

async function boot(){
  try{
    const [cardsText,imageIndex]=await Promise.all([
      fetch("cards.csv").then(r=>{if(!r.ok)throw Error("cards");return r.text()}),
      fetch("legacy-assets/image-index.json").then(r=>r.json())
    ]);
    parseCards(cardsText);applyImageIndex(imageIndex);
  }catch(e){
    console.error(e);$("bootError")?.classList.remove("hidden");return;
  }
  if("serviceWorker"in navigator)navigator.serviceWorker.register("sw.js").catch(()=>{});
  if(sessionToken){
    const result=await api("me",{},true);
    if(result.ok&&result.profile){applyProfile(result.profile);enterGame();return}
    if(result.network){
      const cached=cachedProfile();
      if(cached){state.offlineSession=true;applyProfile(cached);enterGame();toast("Sin conexión: progreso cargado en modo offline.","bad");return}
    }
    sessionToken="";localStorage.removeItem(SESSION_KEY);
  }
  showAuth();
}

function syncDuelOrientation(active){
  const mobileViewport=(window.matchMedia&&window.matchMedia("(pointer: coarse)").matches)||navigator.maxTouchPoints>0||Math.min(window.innerWidth,window.innerHeight)<=900;
  if(active&&mobileViewport){
    if(duelOrientationLockActive)return;
    duelOrientationLockActive=true;
    try{
      const result=screen.orientation?.lock?.("landscape");
      if(result&&typeof result.catch==="function")result.catch(()=>{});
    }catch{}
    return;
  }
  if(!active&&duelOrientationLockActive){
    duelOrientationLockActive=false;
    try{screen.orientation?.unlock?.()}catch{}
  }
}

function duelPresentationKey(d=state.duel){
  if(!d)return"";
  return d.online?"online:"+(d.matchId||"unknown"):"local:"+(d.rewardKey||"training");
}
function fullscreenElement(){
  return document.fullscreenElement||document.webkitFullscreenElement||null;
}
function fullscreenApiAvailable(){
  const target=$("appShell")||document.documentElement;
  return !!(target&&(target.requestFullscreen||target.webkitRequestFullscreen));
}
function resetDuelFullscreenState(){
  duelFullscreenEnteredOnce=false;
  duelFullscreenDeadlineAt=0;
  duelFullscreenForfeitHandled=false;
  duelFullscreenMatchKey="";
  duelFullscreenAutoRequested=false;
  duelAwayReason="";
  duelLobbyAway=false;
  duelLastActivityAt=Date.now();
  duelIdleAllowanceMs=COMBAT_IDLE_BASE_MS;
  duelIdleWarn90Shown=false;
  duelIdleFinalCountdownVisible=false;
  duelActivityEmitAt=0;
}
function syncDuelFullscreenState(active){
  if(!active){
    resetDuelFullscreenState();
    const exit=document.exitFullscreen||document.webkitExitFullscreen;
    if(fullscreenElement()&&exit){
      try{
        const result=exit.call(document);
        if(result&&typeof result.catch==="function")result.catch(()=>{});
      }catch{}
    }
    return;
  }
  const key=duelPresentationKey();
  if(key&&key!==duelFullscreenMatchKey){
    duelFullscreenEnteredOnce=!!fullscreenElement();
    duelFullscreenDeadlineAt=0;
    duelFullscreenForfeitHandled=false;
    duelFullscreenMatchKey=key;
    duelFullscreenAutoRequested=false;
    duelAwayReason="";
    duelLastActivityAt=Date.now();
    duelIdleAllowanceMs=COMBAT_IDLE_BASE_MS;
    duelIdleWarn90Shown=false;
    duelIdleFinalCountdownVisible=false;
    duelActivityEmitAt=0;
  }
  if(fullscreenElement()){
    duelFullscreenEnteredOnce=true;
    duelFullscreenDeadlineAt=0;
    duelFullscreenForfeitHandled=false;
  }
}

function serverPlayerLeaveDeadline(){
  const d=state.duel;
  return d&&d.online?Number(d.playerLeaveDeadlineAt)||0:0;
}
function playerLeaveDeadline(){
  const local=Number(duelFullscreenDeadlineAt)||0;
  const server=serverPlayerLeaveDeadline();
  if(local&&server)return Math.min(local,server);
  return local||server;
}
function playerLeaveReason(){
  const d=state.duel;
  return String((d&&d.online&&d.playerLeaveReason)||duelAwayReason||"");
}
function playerIdleDeadline(){
  const d=state.duel;
  if(!d)return 0;
  const allowance=Math.max(COMBAT_IDLE_BASE_MS,Math.min(COMBAT_IDLE_MAX_MS,Number(d.playerIdleAllowanceMs)||duelIdleAllowanceMs||COMBAT_IDLE_BASE_MS));
  const localDeadline=duelLastActivityAt+allowance;
  const serverDeadline=d.online?(Number(d.playerIdleDeadlineAt)||0):0;
  return Math.max(localDeadline,serverDeadline);
}
function emitDuelPresence(stateName,reason=""){
  const d=state.duel;
  if(!d?.online||!state.connected||!state.socket||!d.matchId)return;
  state.socket.emit("duel:presence",{matchId:d.matchId,state:stateName,reason});
}
function markDuelActivity(kind="activity"){
  const d=state.duel;
  if(state.view!=="duel"||!d||d.gameOver)return;
  const now=Date.now();
  const hadGrace=!!playerLeaveDeadline();
  const hadFinalCountdown=duelIdleFinalCountdownVisible;
  if(kind==="gameAction"&&!d.online){
    duelIdleAllowanceMs=Math.min(COMBAT_IDLE_MAX_MS,duelIdleAllowanceMs+COMBAT_IDLE_ACTION_BONUS_MS);
    d.playerIdleAllowanceMs=duelIdleAllowanceMs;
  }
  duelLastActivityAt=now;
  duelIdleWarn90Shown=false;
  duelIdleFinalCountdownVisible=false;
  duelFullscreenDeadlineAt=0;
  duelFullscreenForfeitHandled=false;
  duelAwayReason="";
  if(d.online){
    d.playerLeaveDeadlineAt=0;
    d.playerLeaveReason="";
    if(state.connected&&state.socket&&(hadGrace||kind==="return"||now-duelActivityEmitAt>=5000)){
      duelActivityEmitAt=now;
      state.socket.emit("duel:activity",{matchId:d.matchId});
    }
  }
  if(hadGrace||hadFinalCountdown)renderView();
}

async function requestDuelFullscreen(silent=false){
  const d=state.duel;
  if(state.view!=="duel"||!d||d.gameOver)return false;
  const target=$("appShell")||document.documentElement;
  if(fullscreenElement()){
    duelFullscreenEnteredOnce=true;
    markDuelActivity("return");
    renderView();
    return true;
  }
  const request=target&&(target.requestFullscreen||target.webkitRequestFullscreen);
  if(!request){
    duelFullscreenEnteredOnce=true;
    markDuelActivity("return");
    return true;
  }
  try{
    let result;
    if(target.requestFullscreen)result=target.requestFullscreen({navigationUI:"hide"});
    else result=target.webkitRequestFullscreen();
    if(result&&typeof result.then==="function")await result;
    duelFullscreenEnteredOnce=true;
    markDuelActivity("return");
    document.body.classList.add("duel-native-fullscreen");
    syncDuelOrientation(true);
    renderView();
    return true;
  }catch{
    if(!silent)toast("No se pudo activar la pantalla completa.","bad");
    renderView();
    return false;
  }
}
function startDuelAwayCountdown(reason="fullscreen"){
  const d=state.duel;
  if(!d||d.gameOver)return;
  if(!playerLeaveDeadline()){
    duelFullscreenDeadlineAt=Date.now()+COMBAT_LEAVE_GRACE_MS;
    duelFullscreenForfeitHandled=false;
    duelAwayReason=reason;
    if(d.online)emitDuelPresence("away",reason);
    const msg=reason==="inactive"
      ?"Has agotado tu periodo de inactividad. Tienes 120 segundos para volver o realizar una acción."
      :reason==="lobby"
        ?"Has vuelto al lobby. Tienes 120 segundos para reanudar la partida o perderás por abandono."
        :"Has cerrado la pantalla completa. Vuelve antes de 120 segundos o perderás la partida.";
    toast(msg,"bad");
    renderView();
  }
}
function clearDuelAwayCountdown(){
  if(!duelFullscreenDeadlineAt&&!duelFullscreenForfeitHandled)return;
  duelFullscreenDeadlineAt=0;
  duelFullscreenForfeitHandled=false;
  duelAwayReason="";
  if(state.view==="duel"&&state.duel&&!state.duel.gameOver)renderView();
}
function forfeitDuelForLeavingScreen(){
  const d=state.duel;
  if(!d||d.gameOver||duelFullscreenForfeitHandled)return;
  duelFullscreenForfeitHandled=true;
  const reason=playerLeaveReason();
  duelFullscreenDeadlineAt=0;
  if(d.online){
    if(state.connected&&state.socket)state.socket.emit("duel:action",{matchId:d.matchId,type:"concede"});
    else toast("Se agotó el tiempo de gracia. La derrota se confirmará al reconectar.","bad");
  }else{
    const message=reason==="inactive"
      ?"Has superado 3 minutos de inactividad y los 120 segundos de gracia."
      :"Has permanecido fuera de la pantalla de combate durante 120 segundos.";
    finalizeLocalResult(d,"loss",message);
    checkLocalEnd();
    renderView();
  }
}
function updateDuelFullscreenCountdown(){
  const d=state.duel;
  if(!d||d.gameOver)return;
  const leaveDeadline=playerLeaveDeadline();
  if(state.view==="duel"&&!leaveDeadline){
    const idleDeadline=playerIdleDeadline();
    const idleLeft=Math.max(0,idleDeadline-Date.now());
    if(idleLeft<=90*1000&&idleLeft>10*1000&&!duelIdleWarn90Shown){
      duelIdleWarn90Shown=true;
      toast("Inactividad: te queda 1 minuto y 30 segundos para realizar una acción.","bad");
    }
    const shouldShowFinal=idleLeft>0&&idleLeft<=10*1000;
    if(shouldShowFinal!==duelIdleFinalCountdownVisible){
      duelIdleFinalCountdownVisible=shouldShowFinal;
      renderView();
    }
    const idleEl=document.querySelector("[data-duel-idle-countdown]");
    if(idleEl&&shouldShowFinal)idleEl.textContent=String(Math.max(1,Math.ceil(idleLeft/1000)));
    if(idleLeft<=0){
      duelIdleFinalCountdownVisible=false;
      startDuelAwayCountdown("inactive");
    }
  }
  const deadline=playerLeaveDeadline();
  const els=document.querySelectorAll("[data-duel-fullscreen-countdown],[data-duel-lobby-countdown]");
  if(!deadline){
    els.forEach(el=>{el.textContent=""});
    return;
  }
  const left=Math.max(0,deadline-Date.now());
  els.forEach(el=>{el.textContent=formatCombatGrace(left)});
  if(left<=0)forfeitDuelForLeavingScreen();
}

function updateChrome(){
  if(!state.profile)return;
  $("playerName").textContent=state.profile.name;$("playerAvatar").textContent=initial(state.profile.name);
  $("playerMeta").textContent="Nv "+playerLevel()+" · "+state.profile.xp+"/"+(state.profile.xpRequired||"MAX")+" XP";
  $("coins").textContent=state.profile.coins;
  const fill=$("playerXpFill");if(fill)fill.style.width=xpPercent()+"%";
  $("connectionDot").className="dot "+(state.connected?"online":"");
  $("connectionText").textContent=state.connected?"Online":state.offlineSession?"Offline":"Conectando";
  $("onlineBadge").textContent=state.users.length||0;
  const inCombat=state.view==="duel"&&!!state.duel;
  const shell=$("appShell");if(shell)shell.classList.toggle("duel-mode",inCombat);
  document.documentElement.classList.toggle("duel-viewport-lock",inCombat);
  document.body.classList.toggle("duel-viewport-lock",inCombat);
  if(!inCombat)document.body.classList.remove("duel-log-visible");
  syncDuelOrientation(inCombat);
  if(inCombat)syncDuelFullscreenState(true);
  else if(!state.duel||state.duel.gameOver)syncDuelFullscreenState(false);
  if(inCombat&&!duelFullscreenAutoRequested){
    duelFullscreenAutoRequested=true;
    requestAnimationFrame(()=>{void requestDuelFullscreen(true)});
  }
  const homeBtn=$("globalHomeBtn");if(homeBtn)homeBtn.hidden=inCombat;
  document.querySelectorAll("[data-nav]").forEach(b=>b.classList.toggle("active",b.dataset.nav===state.view));
}
function playerLevel(){return clamp(Number(state.profile?.level)||1,1,50)}
function xpPercent(){if(!state.profile||playerLevel()>=50)return 100;return clamp(Math.round((state.profile.xp/Math.max(1,state.profile.xpRequired))*100),0,100)}
function winrate(){
  const total=(state.profile?.wins||0)+(state.profile?.draws||0)+(state.profile?.losses||0);
  return total?Math.round(state.profile.wins/total*100):0;
}
function deckPowerCount(deck=state.profile?.deck||[]){return deck.filter(id=>card(id)?.powerCard).length}
function deckRuleMessage(deck=state.profile?.deck||[]){
  if(!state.activeDeckId)return"Guarda y selecciona un mazo antes de jugar.";
  if(deck.length<DECK_MIN)return"El mazo necesita al menos "+DECK_MIN+" cartas.";
  if(deck.length>DECK_MAX)return"El mazo no puede superar "+DECK_MAX+" cartas.";
  const powers=deckPowerCount(deck);
  if(powers<MIN_POWER_CARDS)return"El mazo necesita al menos "+MIN_POWER_CARDS+" cartas de Poder.";
  if(powers>MAX_POWER_CARDS)return"El mazo no puede contener más de "+MAX_POWER_CARDS+" cartas de Poder.";
  return"";
}
function deckValid(){
  if(!state.profile||!state.activeDeckId)return false;
  if(deckRuleMessage())return false;
  const count={};
  for(const id of state.profile.deck){
    const c=card(id);if(!c||c.level>playerLevel())return false;
    if(isBasicPower(c))continue;
    count[id]=(count[id]||0)+1;
  }
  return Object.keys(count).every(id=>count[id]<=owned(id));
}
function collectionTotal(){return Object.values(state.profile?.collection||{}).reduce((a,b)=>a+Number(b||0),0)}
function uniqueOwned(){return Object.keys(state.profile?.collection||{}).filter(id=>owned(id)>0).length}

function go(view){
  if(view==="duel"&&!state.duel)return;
  if(duelLobbyAway&&state.duel&&!state.duel.gameOver&&view!=="duel"&&view!=="home"){
    toast("Tienes una partida activa. Reanúdala antes de que termine la cuenta atrás.","bad");
    return;
  }
  if(state.view==="duel"&&state.duel&&!state.duel.gameOver&&view!=="duel"){
    toast("Usa el icono de lobby para salir temporalmente del combate.","bad");
    return;
  }
  closeModal();
  state.view=view;updateChrome();renderView();
  if(view==="deck")void loadDecks();
  if(view==="ranking")void loadRanking();
  if(view==="trade")void loadMarketListings();
  window.scrollTo({top:0,behavior:"smooth"});
}
function renderView(){
  const root=$("viewRoot");if(!root||!state.profile)return;
  const renderers={home:renderHome,play:renderPlay,ranking:renderRanking,collection:renderCollection,deck:renderDeck,shop:renderShop,trade:renderTrade,manual:renderManual,profile:renderProfile,duel:renderDuel};
  root.innerHTML=(renderers[state.view]||renderHome)();
}

function pageHead(kicker,title,desc,actions=""){
  return `<div class="page-head"><div><div class="kicker">${kicker}</div><h1>${title}</h1>${desc?`<p>${desc}</p>`:""}</div><div class="actions">${actions}</div></div>`;
}
function renderHome(){
  const deckReady=deckValid(),matches=state.matches.filter(m=>m.status==="waiting").length,empty=collectionTotal()===0;
  const duelDeadline=duelLobbyAway&&state.duel&&!state.duel.gameOver?playerLeaveDeadline():0;
  const duelLeft=Math.max(0,duelDeadline-Date.now());
  const activeDuelBanner=duelLobbyAway&&state.duel&&!state.duel.gameOver
    ? `<section class="lobby-duel-return" aria-live="polite"><div><span class="kicker">Partida en curso</span><b>Abandono en <strong data-duel-lobby-countdown>${formatCombatGrace(duelLeft)}</strong></b><small>Vuelve al combate antes de que termine la cuenta atrás.</small></div><button class="btn primary" data-action="resumeDuelFromLobby">Reanudar partida</button></section>`
    : "";
  const waiting=state.matches.filter(m=>m.status==="waiting");
  return `<div class="page home-page">
    ${activeDuelBanner}
    <div class="home-mobile-lobby">
      <section class="panel home-mobile-chat">
        <div class="panel-head"><h2>Chat</h2><span class="muted">${state.chat.length} mensajes</span></div>
        <div class="chat"><div class="chat-log" id="chatLogMobile">${renderChat()}</div>
          <form class="chat-send" id="chatForm"><input class="input" id="chatInput" maxlength="300" placeholder="Escribe en el salón…" autocomplete="off"><button class="btn primary" ${state.connected?"":"disabled"}>Enviar</button></form>
        </div>
      </section>
      <section class="panel home-mobile-searching">
        <div class="panel-head"><h2>Buscando partida</h2><span class="pill">${waiting.length}</span></div>
        <div class="panel-body"><div class="match-list mobile-match-list">${renderMatches(waiting)}</div></div>
      </section>
      <section class="panel home-mobile-online">
        <div class="panel-head"><h2>Conectados</h2><span class="pill">${state.users.length}</span></div>
        <div class="panel-body"><div class="online-list">${renderUsers()}</div></div>
      </section>
    </div>
    <div class="home-desktop-lobby">
      <div class="home-actions">
        ${empty?'<button class="btn primary" data-action="nav" data-view="shop">Abrir primeros sobres</button>':'<button class="btn primary" data-action="nav" data-view="play">Buscar partida</button>'}
        ${matches>0?'<button class="btn" data-action="nav" data-view="play">Unirse a partida</button>':""}
        <button class="btn" data-action="nav" data-view="deck">Construir mazo</button>
        <button class="btn" data-action="nav" data-view="collection">Colección</button>
        <button class="btn" data-action="nav" data-view="shop">Tienda</button>
        <button class="btn" data-action="nav" data-view="trade">Intercambios</button>
        <button class="btn" data-action="nav" data-view="ranking">Ranking</button>
        <button class="btn" data-action="nav" data-view="profile">Perfil</button>
      </div>
      <div class="xp-card">
        <div class="xp-row"><div><div class="kicker">Progresión</div><b>Nivel ${playerLevel()}</b></div><div class="muted">${playerLevel()>=50?"Nivel máximo":state.profile.xp+" / "+state.profile.xpRequired+" XP"}</div></div>
        <div class="xp-bar"><span style="width:${xpPercent()}%"></span></div>
      </div>
      <div class="grid four" style="margin-top:14px">
        <div class="stat-card"><small>Jugadores conectados</small><strong>${state.users.length}</strong><span class="muted">salón en tiempo real</span></div>
        <div class="stat-card"><small>Partidas abiertas</small><strong>${matches}</strong><span class="muted">retos esperando rival</span></div>
        <div class="stat-card"><small>Colección</small><strong>${uniqueOwned()}</strong><span class="muted">${collectionTotal()} cartas · Poder básico ∞</span></div>
        <div class="stat-card"><small>Mazo activo</small><strong>${state.profile.deck.length}</strong><span class="${deckReady?"good":"bad"}">${deckReady?"listo para jugar":"mínimo 20 cartas · 7 Poderes"}</span></div>
      </div>
      <div class="grid two" style="margin-top:14px">
        <section class="panel">
          <div class="panel-head"><h2>Salón online</h2><span class="pill"><span class="dot ${state.connected?"online":""}"></span>${state.connected?"Conectado":"Modo offline"}</span></div>
          <div class="panel-body"><div class="online-list">${renderUsers()}</div></div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Chat general</h2><span class="muted">${state.chat.length} mensajes</span></div>
          <div class="chat"><div class="chat-log" id="chatLog">${renderChat()}</div>
            <div class="chat-send"><input class="input" disabled placeholder="Chat disponible en el lobby móvil o desde esta vista"><button class="btn primary" disabled>Enviar</button></div>
          </div>
        </section>
      </div>
    </div>
  </div>`;
}

function renderManual(){
  return `<div class="page manual-page">
    ${pageHead("Reglamento","Manual de ARCANUM TCG","Reglas, combate, construcción de mazos, progresión, economía y competición. Este apartado reúne el reglamento vigente del juego.",
      '<button class="btn" data-action="nav" data-view="deck">Construir mazo</button><button class="btn primary" data-action="nav" data-view="play">Ir a jugar</button>')}
    <section class="manual-hero panel">
      <div class="manual-hero-copy">
        <div class="kicker">Referencia rápida</div>
        <h2>Lo esencial antes de jugar</h2>
        <p>Necesitas un mazo válido de <b>20 a 50 cartas</b>, con un mínimo de <b>7 cartas de Poder</b> y un máximo de 40. Cada jugador comienza con <b>30 PV</b> y una mano inicial de <b>7 cartas</b>. El jugador inicial se determina aleatoriamente y quien no empieza recibe una carta adicional, por lo que comienza con 8.</p>
      </div>
      <div class="manual-fast-grid">
        <div class="stat-card"><small>Mazo</small><strong>20+</strong><span class="muted">máximo 50 cartas</span></div>
        <div class="stat-card"><small>Vida inicial</small><strong>30</strong><span class="muted">PV</span></div>
        <div class="stat-card"><small>Mano inicial</small><strong>7</strong><span class="muted">+1 al segundo jugador</span></div>
        <div class="stat-card"><small>Fases</small><strong>6</strong><span class="muted">por turno</span></div>
      </div>
    </section>

    <nav class="manual-index panel" aria-label="Índice del manual">
      <a href="#manual-preparacion">1. Preparación</a>
      <a href="#manual-turno">2. Turno y fases</a>
      <a href="#manual-cartas">3. Tipos de carta</a>
      <a href="#manual-combate">4. Combate</a>
      <a href="#manual-final">5. Fin de partida</a>
      <a href="#manual-mazos">6. Mazos</a>
      <a href="#manual-progresion">7. Progresión</a>
      <a href="#manual-tienda">8. Sobres y rarezas</a>
      <a href="#manual-mercado">9. Intercambios</a>
      <a href="#manual-elo">10. Ranking ELO</a>
      <a href="#manual-nivel1">11. Nivel 1</a>
      <a href="#manual-tablero">12. Tablero y formato</a>
    </nav>

    <div class="manual-sections">
      <details id="manual-preparacion" class="manual-section panel" open>
        <summary><span><b>1. Preparación de la partida</b><small>Cómo comienza un duelo</small></span></summary>
        <div class="manual-body">
          <ul>
            <li>Cada jugador entra con un mazo válido de <b>20 a 50 cartas</b>, con entre <b>7 y 40 cartas de Poder</b>.</li>
            <li>Cada jugador comienza con <b>30 puntos vitales</b>.</li>
            <li>La mano inicial es de <b>7 cartas</b>.</li>
            <li>El jugador que empieza se selecciona <b>aleatoriamente</b>.</li>
            <li>El jugador que no empieza recibe <b>una carta adicional</b> antes de su primer turno.</li>
            <li>El mazo se baraja antes de repartir.</li>
          </ul>
          <div class="manual-note"><b>Importante:</b> si el mazo se queda sin cartas disponibles, la partida termina.</div>
        </div>
      </details>

      <details id="manual-turno" class="manual-section panel" open>
        <summary><span><b>2. Turno y seis fases</b><small>Las fases sin acciones disponibles avanzan automáticamente</small></span></summary>
        <div class="manual-body">
          <div class="manual-phase-grid">
            <div><b>1. Reagrupación</b><span>Se enderezan tus cartas giradas y vuelven a estar disponibles.</span></div>
            <div><b>2. Robo</b><span>Robas una carta de tu mazo.</span></div>
            <div><b>3. Poder</b><span>Puedes bajar como máximo <b>1 carta de Poder por turno</b>. Los Poderes en campo generan automáticamente sus puntos, hasta un máximo de <b>200</b>.</span></div>
            <div><b>4. Invocación</b><span>Invocas criaturas pagando su coste de Poder.</span></div>
            <div><b>5. Habilidades</b><span>Juegas hechizos o habilidades que puedas pagar.</span></div>
            <div><b>6. Ataque</b><span>Tocas una criatura para atacar: se gira inmediatamente y declara un único ataque. El rival puede tocar una sola criatura para defender o elegir <b>Dejar pasar</b> y recibir el ataque directamente en sus PV. Cada combate se resuelve antes de poder declarar el siguiente.</span></div>
          </div>
          <p>Cuando una fase no contiene ninguna acción posible para el jugador, el juego pasa automáticamente a la siguiente. Esto evita turnos muertos y acelera el ritmo de la partida.</p>
        </div>
      </details>

      <details id="manual-cartas" class="manual-section panel">
        <summary><span><b>3. Tipos de carta</b><small>Criaturas, Poder y habilidades</small></span></summary>
        <div class="manual-body">
          <div class="grid three">
            <div class="manual-rule"><b>Criaturas</b><p>Tienen Ataque y Defensa, pueden atacar, bloquear y ocupar el campo de batalla.</p></div>
            <div class="manual-rule"><b>Poder</b><p>Genera el recurso usado para invocar y activar cartas. El Poder de nivel 1 es básico e infinito para todos los jugadores.</p></div>
            <div class="manual-rule"><b>Habilidades / hechizos</b><p>Producen efectos directos como daño, curación, robo de cartas o modificación de Poder.</p></div>
          </div>
          <p>Las cartas muestran su información directamente en el diseño. Una criatura <b>2/3</b> tiene 2 de Ataque y 3 de Defensa.</p>
        </div>
      </details>

      <details id="manual-combate" class="manual-section panel" open>
        <summary><span><b>4. Combate, ataque y defensa</b><small>El Ataque de la atacante se compara con la Defensa de la bloqueadora</small></span></summary>
        <div class="manual-body">
          <ul>
            <li>Las criaturas no pueden atacar el turno en que son invocadas, salvo las de tipo <b>Berserker</b>.</li>
            <li>Los ataques se declaran de uno en uno. El atacante toca una criatura preparada y esta se gira inmediatamente. El defensor puede responder tocando una sola criatura preparada, que también se gira, o elegir <b>Dejar pasar</b> para no bloquear y recibir el daño directamente en sus PV. No pueden acumularse varios atacantes ni varios defensores pendientes al mismo tiempo.</li>
            <li>Tras resolver ese combate, el jugador atacante puede tocar otra criatura para iniciar un nuevo ataque o pasar directamente su turno. Una criatura normal solo ataca o defiende una vez por turno.</li>
            <li>El combate es <b>simultáneo</b>: se compara el ATQ de cada criatura con la DEF completa de la otra. El combate <b>no desgasta ni reduce</b> ATQ o DEF; una criatura que sobreviva conserva sus estadísticas completas para futuros combates, salvo efectos de cartas que indiquen expresamente una modificación.</li>
            <li>Si el ATQ atacante supera la DEF restante de la defensora, el exceso se descuenta de los PV del jugador defensor.</li>
            <li>Las criaturas con DEF igual o inferior a 0 son destruidas.</li>
          </ul>
          <div class="manual-example"><b>Ejemplo:</b> una criatura 2/1 ataca a una 1/1. Ambas reciben daño suficiente para ser destruidas y el punto de ATQ sobrante del atacante causa 1 PV al rival.</div>
          <div class="manual-note"><b>Poderes:</b> los puntos de Poder de las cartas que tienes en campo se activan automáticamente cada turno. No es necesario girarlas para generar el recurso base.</div>
        </div>
      </details>

      <details id="manual-final" class="manual-section panel">
        <summary><span><b>5. Fin de la partida</b><small>Victoria, derrota y desempate</small></span></summary>
        <div class="manual-body">
          <p>La partida termina cuando ocurre cualquiera de estas situaciones:</p>
          <ul>
            <li>Los puntos vitales de un jugador llegan a <b>0</b>.</li>
            <li>La pila de cartas disponibles del mazo de un jugador llega a <b>0</b>.</li>
            <li>Un jugador se rinde, abandona o es descalificado.</li>
            <li>Si un jugador sale o se desconecta de la página de combate, dispone de <b>2 minutos</b> para regresar. Si el plazo termina sin reconexión, pierde automáticamente la partida.</li>
            <li>La partida supera los <b>40 minutos</b>.</li>
          </ul>
          <p>Si al finalizar existe incertidumbre sobre el ganador, se usa este puntaje de desempate:</p>
          <div class="manual-formula">PV restantes + cartas en el campo de batalla + cartas restantes en el mazo + ATQ base de la carta de mayor nivel en tu campo</div>
          <p class="muted">Para el último término se usa el Ataque base de la carta, sin bonificaciones temporales.</p>
        </div>
      </details>

      <details id="manual-mazos" class="manual-section panel">
        <summary><span><b>6. Construcción de mazos</b><small>Mínimo 20 cartas, máximo 50</small></span></summary>
        <div class="manual-body">
          <ul>
            <li>El formato actual admite mazos de <b>20 a 50 cartas</b>.</li>
            <li>Solo se puede iniciar o aceptar una partida con al menos <b>20 cartas válidas</b>.</li>
            <li>El mazo debe contener entre <b>7 y 40 cartas de Poder</b>.</li>
            <li>Solo puedes incluir cartas cuyo nivel sea igual o inferior a tu nivel de jugador.</li>
            <li>Las cartas coleccionables requieren que poseas suficientes copias.</li>
            <li>El <b>Poder básico Nv 1</b> tiene copias infinitas y puede añadirse al mazo sin consumir colección.</li>
            <li>Puedes guardar hasta <b>12 mazos</b>.</li>
          </ul>
          <button class="btn" data-action="nav" data-view="deck">Abrir constructor de mazos</button>
        </div>
      </details>

      <details id="manual-progresion" class="manual-section panel">
        <summary><span><b>7. Cuenta, nivel y recompensas</b><small>Progresión de nivel 1 a 50</small></span></summary>
        <div class="manual-body">
          <ul>
            <li>Una cuenta nueva comienza en <b>Nivel 1</b>, sin cartas coleccionables, con Poder básico Nv 1 infinito y <b>100 de oro</b>.</li>
            <li>El nivel máximo actual es <b>50</b>.</li>
            <li>Subir de nivel amplía el nivel máximo de cartas y sobres que puedes utilizar.</li>
            <li>Las derrotas PvP pueden reducir la XP de la barra actual, pero <b>nunca hacen perder un nivel ya alcanzado</b>.</li>
          </ul>
          <div class="grid three">
            <div class="reward-card win"><div class="kicker">Victoria PvP</div><strong>+15 oro</strong><span>+40 XP contra rival del mismo nivel</span></div>
            <div class="reward-card draw"><div class="kicker">Empate PvP</div><strong>+5 oro</strong><span>+8 XP contra rival del mismo nivel</span></div>
            <div class="reward-card loss"><div class="kicker">Derrota PvP</div><strong>0 oro</strong><span>−15 XP contra rival del mismo nivel</span></div>
          </div>
          <p>La XP se ajusta por diferencia de nivel: victoria entre +20 y +70, empate entre +3 y +20 y derrota entre −5 y −30. El entrenamiento contra IA no concede XP, no modifica el ELO y no registra victorias, empates ni derrotas; una victoria de entrenamiento puede otorgar una pequeña recompensa de oro.</p>
        </div>
      </details>

      <details id="manual-tienda" class="manual-section panel">
        <summary><span><b>8. Sobres, niveles y rarezas</b><small>La colección se obtiene principalmente en la tienda</small></span></summary>
        <div class="manual-body">
          <ul>
            <li>Cada sobre cuesta actualmente <b>20 de oro</b> y contiene <b>5 cartas</b>.</li>
            <li>Puedes comprar sobres desde nivel 1 hasta tu nivel actual.</li>
            <li>Un sobre nunca entrega una carta de nivel superior al nivel del propio sobre.</li>
            <li>El Poder básico Nv 1 <b>no aparece en sobres</b> porque ya es infinito.</li>
            <li>Las rarezas actuales son: <b>Común, Poco común, Rara, Épica y Legendaria</b>.</li>
            <li>Las probabilidades exactas se calculan en el servidor según nivel, rareza y balance, y pueden consultarse antes de abrir cada sobre.</li>
          </ul>
          <button class="btn" data-action="nav" data-view="shop">Ver tienda y probabilidades</button>
        </div>
      </details>

      <details id="manual-mercado" class="manual-section panel">
        <summary><span><b>9. Mercado e intercambios</b><small>Venta por oro, anuncios e intercambio directo</small></span></summary>
        <div class="manual-body">
          <ul>
            <li>Puedes publicar una carta a cambio de <b>oro</b> o indicar qué carta buscas a cambio.</li>
            <li>Los anuncios quedan guardados y pueden aceptarse aunque el vendedor no esté conectado.</li>
            <li>Una carta anunciada queda reservada hasta cancelar el anuncio o completar la operación.</li>
            <li>El Poder básico Nv 1 no puede venderse ni intercambiarse.</li>
            <li>Cada jugador puede mantener hasta <b>30 anuncios activos</b>.</li>
            <li>También existe intercambio directo en tiempo real con cartas y oro, que requiere aceptación de ambos jugadores.</li>
          </ul>
          <button class="btn" data-action="nav" data-view="trade">Abrir intercambios</button>
        </div>
      </details>

      <details id="manual-elo" class="manual-section panel">
        <summary><span><b>10. Ranking y sistema ELO</b><small>Clasificación PvP basada en el cálculo FIDE</small></span></summary>
        <div class="manual-body">
          <p>El ranking usa la fórmula <b>K × (resultado real − resultado esperado)</b>. Victoria = 1, empate = 0,5 y derrota = 0. El resultado se redondea al entero más cercano.</p>
          <ul>
            <li><b>K=40</b> durante las primeras 30 partidas puntuadas.</li>
            <li><b>K=20</b> después, mientras el jugador no haya alcanzado 2400 ELO.</li>
            <li><b>K=10</b> desde el momento en que se alcanza 2400 ELO.</li>
            <li>Para jugadores por debajo de 2650, las diferencias superiores a 400 puntos se calculan como 400.</li>
            <li>Solo las partidas <b>PvP online</b> son puntuadas para ELO.</li>
          </ul>
          <button class="btn" data-action="nav" data-view="ranking">Ver ranking</button>
        </div>
      </details>

      <details id="manual-nivel1" class="manual-section panel">
        <summary><span><b>11. Criaturas de Nivel 1 conocidas</b><small>Valores base actuales de Ataque, Defensa y coste</small></span></summary>
        <div class="manual-body">
          <div class="manual-table-wrap"><table class="manual-table">
            <thead><tr><th>Carta</th><th>ATQ</th><th>DEF</th><th>Coste de Poder</th></tr></thead>
            <tbody>
              <tr><td>Duende</td><td>1</td><td>1</td><td>1</td></tr>
              <tr><td>Elfo Bardo</td><td>0</td><td>2</td><td>2</td></tr>
              <tr><td>Guerrero Menor</td><td>1</td><td>1</td><td>2</td></tr>
              <tr><td>Dophan</td><td>2</td><td>1</td><td>3</td></tr>
              <tr><td>Gorad Menor</td><td>1</td><td>2</td><td>3</td></tr>
              <tr><td>Mimit</td><td>0</td><td>3</td><td>3</td></tr>
              <tr><td>Mel</td><td>1</td><td>1</td><td>2</td></tr>
            </tbody>
          </table></div>
        </div>
      </details>

      <details id="manual-tablero" class="manual-section panel">
        <summary><span><b>12. Tablero, zonas y formato físico</b><small>Cómo se organiza el campo</small></span></summary>
        <div class="manual-body">
          <ul>
            <li>El tablero distingue <b>mazo, mano, zona de Poder y campo de batalla</b>.</li>
            <li>Las criaturas y amuletos ocupan el área principal del campo. Los hechizos o habilidades disponen de su zona de resolución.</li>
            <li>El diseño no necesita repetir fuera de la carta el nombre, Ataque o Defensa porque esa información ya está impresa en la propia carta.</li>
            <li>Todas las cartas y sus huecos deben conservar la proporción oficial <b>10 : 14,2</b>.</li>
            <li>El reverso oficial se utiliza para cartas ocultas, mano rival y mazos.</li>
          </ul>
          <p>Durante una partida, las cartas giradas representan acciones ya utilizadas. El estado visual debe coincidir siempre con el estado real del juego.</p>
        </div>
      </details>
    </div>
  </div>`;
}

function renderUsers(){
  if(!state.users.length)return'<div class="empty">No hay otros jugadores conectados todavía.</div>';
  return state.users.map(u=>`<div class="online-user"><div class="avatar">${initial(u.name)}</div><div style="min-width:0"><b>${esc(u.name)}</b><div class="muted" style="font-size:11px">Nivel ${u.level||1} · ELO ${u.elo||1000} · ${esc(u.status||"Disponible")}</div></div>${state.socket&&u.socketId===state.socket.id?'<span class="pill">Tú</span>':""}</div>`).join("");
}
function renderChat(){
  if(!state.chat.length)return'<div class="empty">El salón está tranquilo. Rompe el hielo.</div>';
  return state.chat.slice(-80).map(m=>m.system?`<div class="chat-msg system">${esc(m.text)}</div>`:`<div class="chat-msg"><b>${esc(m.from)}:</b> ${esc(m.text)}</div>`).join("");
}

function renderPlay(){
  const waiting=state.matches.filter(m=>m.status==="waiting");
  return `<div class="page">
    ${pageHead("Competición","Jugar","Crea un reto, entra en una partida existente o entrena contra la IA.",
      '<button class="btn" data-action="training" '+(deckValid()?"":"disabled")+' >Entrenamiento</button>')}
    <div class="grid two">
      <section class="panel">
        <div class="panel-head"><h2>Crear partida</h2><span class="pill ${deckValid()?"good":"bad"}">${state.profile.deck.length} cartas</span></div>
        <div class="panel-body">
          <div class="grid two">
            <div class="field"><label>Formato</label><div class="input" aria-label="Formato de mazo">Mazo estándar · 20–50 cartas</div></div>
            <div class="field"><label>Quién empieza</label><div class="input">Aleatorio</div></div>
          </div>
          <div class="actions" style="margin-top:14px"><button class="btn primary" data-action="createMatch" ${(state.connected&&deckValid())?"":"disabled"}>Crear reto online</button><span class="muted">${!deckValid()?deckRuleMessage():state.connected?"Visible para todos los jugadores conectados.":"Conecta con el servidor para crear retos."}</span></div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Entrenamiento</h2><span class="pill">IA local</span></div>
        <div class="panel-body"><p class="muted">Prueba tu mazo reglamentario sin esperar rival. El entrenamiento no concede XP, no modifica el ELO y no cuenta para victorias, empates ni derrotas.</p><button class="btn" data-action="training" ${deckValid()?"":"disabled"}>Iniciar entrenamiento</button></div>
      </section>
    </div>
    <section class="panel reward-panel" style="margin-top:14px">
      <div class="panel-head"><h2>Recompensas PvP</h2><span class="pill">Servidor autoritativo</span></div>
      <div class="panel-body">
        <div class="grid three">
          <div class="reward-card win"><div class="kicker">Victoria</div><strong>+15 oro</strong><span>+40 XP contra rival de tu mismo nivel</span></div>
          <div class="reward-card draw"><div class="kicker">Empate</div><strong>+5 oro</strong><span>+8 XP contra rival de tu mismo nivel</span></div>
          <div class="reward-card loss"><div class="kicker">Derrota</div><strong>0 oro</strong><span>−15 XP contra rival de tu mismo nivel</span></div>
        </div>
        <div class="reward-rules">
          <b>Ajuste por diferencia de nivel</b>
          <p>Victoria: ±4 XP por cada nivel de diferencia, mínimo +20 y máximo +70. Empate: ±2 XP por nivel, mínimo +3 y máximo +20. Derrota: pierdes menos contra rivales superiores y más contra rivales inferiores, entre −5 y −30 XP.</p>
          <p>Una derrota nunca te hace bajar de nivel: solo puede reducir la barra de XP del nivel actual hasta 0.</p>
        </div>
      </div>
    </section>
    <section class="panel" style="margin-top:14px">
      <div class="panel-head"><h2>Retos disponibles</h2><span class="pill">${waiting.length} abiertos</span></div>
      <div class="panel-body"><div class="match-list">${renderMatches(waiting)}</div></div>
    </section>
  </div>`;
}

function renderMatches(list){
  if(!list.length)return'<div class="empty">No hay retos abiertos. Puedes crear el primero.</div>';
  return list.map(m=>{
    const mine=state.socket&&m.hostSocketId===state.socket.id;
    return `<div class="match-row"><div class="match-player"><div class="avatar">${initial(m.player)}</div><div>${esc(m.player)}<div class="muted" style="font-size:11px">Nivel ${m.level||1}</div></div></div><b>${m.deckSize||DECK_MIN} cartas</b><span class="pill">Inicio aleatorio</span><span class="good">Esperando</span>${mine?'<button class="btn small danger" data-action="cancelMatch" data-id="'+m.id+'">Cancelar</button>':'<button class="btn small primary" data-action="joinMatch" data-id="'+m.id+'" data-size="'+m.deckSize+'">Unirse</button>'}</div>`;
  }).join("");
}

function collectionCards(){
  const q=norm(state.collectionQuery),mode=state.collectionMode,type=state.collectionType;
  return state.catalog.filter(c=>{
    if(mode==="owned"&&owned(c.id)<=0&&!isBasicPower(c))return false;
    if(type!=="all"&&cardType(c)!==type)return false;
    if(q&&!norm(c.name).includes(q))return false;
    return true;
  });
}
function renderCollection(){
  const list=collectionCards();
  return `<div class="page">
    <div class="toolbar"><input class="input" id="collectionSearch" value="${esc(state.collectionQuery)}" placeholder="Buscar carta…"><select class="select" id="collectionMode"><option value="owned" ${state.collectionMode==="owned"?"selected":""}>Mi colección</option><option value="all" ${state.collectionMode==="all"?"selected":""}>Catálogo completo</option></select><select class="select" id="collectionType"><option value="all">Todos los tipos</option><option ${state.collectionType==="Criatura"?"selected":""}>Criatura</option><option ${state.collectionType==="Poder"?"selected":""}>Poder</option><option ${state.collectionType==="Habilidad"?"selected":""}>Habilidad</option></select><span class="toolbar-spacer"></span><span class="muted">${list.length} resultados</span></div>
    <div class="card-grid">${list.map(c=>cardTile(c,{qty:owned(c.id),collection:true})).join("")||'<div class="empty">No hay cartas que coincidan.</div>'}</div>
  </div>`;
}
function cardTile(c,opt={}){
  const r=rarity(c),basic=isBasicPower(c),qty=basic?Infinity:(opt.qty||0),locked=c.level>playerLevel(),inDeck=deckCount(c.id);
  const qtyLabel=qty===Infinity?"∞":qty;
  const canAdd=!locked&&(basic||freeCopies(c.id)>0);
  const canSell=!basic&&freeCopies(c.id)>0;
  const addLabel=basic&&inDeck>0?"Al mazo · "+inDeck:"Al mazo";
  return `<article class="game-card r-${r.key}" data-action="cardDetail" data-id="${c.id}">
    <div class="card-art" style="background-image:url('${cardImage(c)}')"><span class="card-cost">${c.cost}</span>${qty?'<span class="card-qty '+(basic?'infinity-badge':'')+'">'+(basic?'∞ básico':'x'+qtyLabel)+'</span>':""}${locked?'<div class="level-lock">Requiere<br>Nivel '+c.level+'</div>':""}</div>
    <div class="card-info"><div class="card-name">${esc(c.name)}</div><div class="card-sub">${cardType(c)} · Nv ${c.level} · ${r.name}${basic?" · Infinito":""}</div></div>
    <div class="card-stats"><span>${c.powerCard?"Poder +"+powerValue(c):"ATQ "+c.atk}</span><span>${c.powerCard?"":"DEF "+c.def}</span></div>
    ${opt.collection?'<div class="card-actions"><button class="btn small" data-action="addDeck" data-id="'+c.id+'" '+(canAdd?"":"disabled")+'>'+addLabel+'</button><button class="btn small ghost" data-action="sellCard" data-id="'+c.id+'" '+(canSell?"":"disabled")+'>'+(basic?'No vendible':'Vender +'+Math.max(1,Math.floor(cardValue(c)/2)))+'</button></div>':""}
  </article>`;
}

function currentSavedDeck(){
  return state.savedDecks.find(d=>d.id===state.activeDeckId)||state.savedDecks.find(d=>d.isActive)||null;
}
async function loadDecks(){
  if(state.decksLoading||!sessionToken)return;
  state.decksLoading=true;
  const r=await api("list_decks",{},true);
  state.decksLoading=false;
  if(!r.ok){if(state.view==="deck")toast(authErrorMessage(r.error),"bad");return}
  state.savedDecks=Array.isArray(r.decks)?r.decks:[];
  const active=state.savedDecks.find(d=>d.isActive)||null;
  state.activeDeckId=active?.id||null;
  state.deckName=active?.name||"";
  if(state.view==="deck")renderView();
}
async function saveNamedDeck(copy=false){
  const input=$("deckNameInput");
  const name=String(input?.value||state.deckName||"").trim();
  if(!name){toast("Ponle un nombre al mazo.","bad");input?.focus();return}
  const r=await api("save_named_deck",{
    deckId:copy?null:state.activeDeckId,
    name,
    cards:state.profile.deck.slice()
  },true);
  if(!r.ok){toast(authErrorMessage(r.error),"bad");return}
  applyProfile(r.profile);
  state.savedDecks=Array.isArray(r.decks)?r.decks:[];
  state.activeDeckId=r.deck?.id||state.savedDecks.find(d=>d.isActive)?.id||null;
  state.deckName=r.deck?.name||name;
  toast(copy?"Copia del mazo guardada.":"Mazo guardado.","good");
  renderView();
}
async function activateSavedDeck(id){
  if(!id)return;
  const r=await api("activate_deck",{deckId:id},true);
  if(!r.ok){toast(authErrorMessage(r.error),"bad");return}
  applyProfile(r.profile);
  state.savedDecks=Array.isArray(r.decks)?r.decks:[];
  const active=state.savedDecks.find(d=>d.isActive)||null;
  state.activeDeckId=active?.id||null;
  state.deckName=active?.name||"";
  toast("Mazo activo: "+(active?.name||"seleccionado")+".","good");
  renderView();
}
async function newDeckDraft(){
  const r=await api("new_deck_draft",{},true);
  if(!r.ok){toast(authErrorMessage(r.error),"bad");return}
  applyProfile(r.profile);
  state.savedDecks=Array.isArray(r.decks)?r.decks:[];
  state.activeDeckId=null;
  state.deckName="";
  toast("Nuevo mazo listo. Añade cartas y ponle un nombre.");
  renderView();
}
async function deleteSavedDeck(){
  if(!state.activeDeckId)return;
  const active=currentSavedDeck();
  if(!confirm("¿Eliminar el mazo "+(active?.name||"seleccionado")+"?"))return;
  const r=await api("delete_deck",{deckId:state.activeDeckId},true);
  if(!r.ok){toast(authErrorMessage(r.error),"bad");return}
  state.savedDecks=Array.isArray(r.decks)?r.decks:[];
  state.activeDeckId=null;
  state.deckName="";
  toast("Mazo eliminado.");
  renderView();
}

function renderDeck(){
  const target=state.deckTarget,count=state.profile.deck.length,avg=count?state.profile.deck.reduce((n,id)=>n+(card(id)?.cost||0),0)/count:0;
  const pool=state.catalog.filter(c=>c.level<=playerLevel()&&(isBasicPower(c)||freeCopies(c.id)>0));
  const active=currentSavedDeck();
  const deckOptions=state.savedDecks.map(d=>`<option value="${d.id}" ${d.id===state.activeDeckId?"selected":""}>${esc(d.name)} · ${d.cards?.length||0} cartas</option>`).join("");
  return `<div class="page">
    ${pageHead("Estrategia","Constructor de mazos","El formato actual admite de 20 a 50 cartas, con entre 7 y 40 cartas de Poder.",
      '<button class="btn" data-action="newDeck">Nuevo mazo</button><button class="btn" data-action="autoDeck">Auto construir 20</button>'+(active&&deckValid()?'<button class="btn primary" data-action="nav" data-view="play">Jugar con este mazo</button>':'')+'<button class="btn danger" data-action="clearDeck">Vaciar</button>')}
    <section class="panel deck-library" style="margin-bottom:12px">
      <div class="panel-head"><h2>Mis mazos</h2><span class="pill">${state.savedDecks.length}/12 guardados</span></div>
      <div class="panel-body">
        <div class="deck-library-controls">
          <div class="field"><label>Mazo guardado</label><select class="select" id="savedDeckSelect"><option value="">${state.savedDecks.length?"Selecciona un mazo…":"Todavía no tienes mazos guardados"}</option>${deckOptions}</select></div>
          <div class="field"><label>Nombre del mazo</label><input class="input" id="deckNameInput" maxlength="30" value="${esc(state.deckName)}" placeholder="Ej. Guardia de mármol"></div>
          <div class="actions deck-save-actions">
            <button class="btn primary" data-action="saveNamedDeck">${active?"Guardar cambios":"Guardar mazo"}</button>
            ${active?'<button class="btn" data-action="saveDeckCopy">Guardar como nuevo</button><button class="btn danger" data-action="deleteDeck">Eliminar</button>':""}
          </div>
        </div>
        <p class="muted deck-save-status">${active?'Mazo activo: <b>'+esc(active.name)+'</b>. Los cambios de cartas se sincronizan automáticamente.':"Este es un mazo nuevo sin guardar. Ponle un nombre cuando quieras conservarlo."}</p>
      </div>
    </section>
    <div class="deck-layout">
      <section class="panel">
        <div class="panel-head"><h2>Mazo activo</h2><span class="pill ${deckValid()?"good":"bad"}">${count}/${DECK_MAX} cartas</span></div>
        <div class="panel-body">
          <div class="grid two"><div class="stat-card"><small>Coste medio</small><strong>${avg.toFixed(1)}</strong></div><div class="stat-card"><small>Poderes</small><strong>${state.profile.deck.filter(id=>card(id)?.powerCard).length}</strong></div></div>
          <div class="field" style="margin:14px 0"><label>Formato del mazo</label><div class="input">20–50 cartas · Poderes 7–40</div></div>
          <div class="deck-meter"><span style="width:${Math.min(100,count/DECK_MAX*100)}%"></span></div>
          <p class="muted" style="font-size:11px">Poder básico Nv 1: ∞ · Cartas utilizables: nivel ${playerLevel()} o inferior.</p>
          <div class="deck-list" style="margin-top:12px">${renderDeckRows()}</div>
        </div>
      </section>
      <section class="panel"><div class="panel-head"><h2>Cartas disponibles</h2><span class="muted">${pool.length} opciones utilizables</span></div><div class="panel-body"><div class="card-grid">${pool.map(c=>cardTile(c,{qty:isBasicPower(c)?Infinity:freeCopies(c.id),collection:true})).join("")||'<div class="empty">Abre sobres en la tienda para conseguir cartas.</div>'}</div></div></section>
    </div>
  </div>`;
}
function renderDeckRows(){
  if(!state.profile.deck.length)return'<div class="empty">Tu mazo está vacío. Añade Poder básico infinito y cartas obtenidas en sobres.</div>';

  // Todas las copias de una misma carta se muestran como una única pila.
  // Internamente el mazo conserva cada copia por separado para que robo,
  // validación, guardado y combate sigan funcionando exactamente igual.
  const stacks=new Map();
  state.profile.deck.forEach((rawId,index)=>{
    const id=Number(rawId),c=card(id);
    if(!c)return;
    const current=stacks.get(id);
    if(current)current.count+=1;
    else stacks.set(id,{id,count:1,firstIndex:index});
  });

  return [...stacks.values()]
    .sort((a,b)=>a.firstIndex-b.firstIndex)
    .map(row=>{
      const c=card(row.id);if(!c)return"";
      const basic=isBasicPower(c);
      const extra=c.powerCard
        ?(basic?"∞ disponibles":owned(c.id)+" en colección")
        :"Coste "+c.cost;
      return`<div class="deck-row card-stack"><img src="${cardImage(c)}"><div><b>${esc(c.name)}</b><small>${cardType(c)} · Nv ${c.level} · ${extra}</small></div><span class="pill deck-stack-count">×${row.count}</span><button class="btn small danger" data-action="removeDeckCard" data-id="${c.id}" title="Quitar una copia">−</button></div>`;
    }).join("");
}
async function persistDeck(candidate,successMessage=""){
  if(!sessionToken){toast("Necesitas una sesión activa para guardar el mazo.","bad");return false}
  candidate=candidate.map(Number).slice(0,DECK_MAX);
  const version=++deckWriteVersion;

  // Actualización optimista: el jugador ve la carta entrar al mazo en el mismo clic.
  state.profile.deck=candidate.slice();
  cacheProfile();
  renderView();

  const write=async()=>{
    const r=await api("save_deck",{deck:candidate},true);
    if(!r.ok){
      if(version===deckWriteVersion){
        const fresh=await api("me",{},true);
        if(fresh.ok)applyProfile(fresh.profile);
        toast(authErrorMessage(r.error),"bad");
        renderView();
      }
      return false;
    }
    // Una respuesta antigua nunca debe pisar un clic posterior.
    if(version===deckWriteVersion){
      applyProfile(r.profile);
      if(state.activeDeckId){
        const saved=state.savedDecks.find(d=>d.id===state.activeDeckId);
        if(saved){saved.cards=candidate.slice();saved.updatedAt=new Date().toISOString()}
      }
      if(successMessage)toast(successMessage,"good");
      renderView();
    }
    return true;
  };

  deckWriteQueue=deckWriteQueue.then(write,write);
  return deckWriteQueue;
}
async function autoDeck(){
  const target=DECK_SIZE;
  const basics=state.catalog.filter(c=>isBasicPower(c)&&c.level<=playerLevel());
  const available=[];
  for(const [id,q] of Object.entries(state.profile.collection)){
    const c=card(id);if(!c||c.level>playerLevel())continue;
    for(let i=0;i<Number(q||0);i++)available.push(Number(id));
  }
  const nonBasicPowers=available.filter(id=>card(id)?.powerCard&&!isBasicPower(card(id)));
  const others=available.filter(id=>!card(id)?.powerCard);
  nonBasicPowers.sort((a,b)=>(card(a)?.level||0)-(card(b)?.level||0));
  others.sort((a,b)=>(card(a)?.level||0)-(card(b)?.level||0));
  const deck=[],wantedPower=Math.min(MAX_POWER_CARDS,Math.max(MIN_POWER_CARDS,Math.ceil(target*.35)));
  for(const id of nonBasicPowers){if(deck.length>=wantedPower)break;deck.push(id)}
  let bi=0;while(deck.length<wantedPower&&basics.length){deck.push(basics[bi++%basics.length].id)}
  for(const id of others){if(deck.length>=target)break;deck.push(id)}
  for(const id of nonBasicPowers.slice(deck.filter(id=>card(id)?.powerCard&&!isBasicPower(card(id))).length)){if(deck.length>=target)break;deck.push(id)}
  bi=0;while(deck.length<target&&basics.length){deck.push(basics[bi++%basics.length].id)}
  if(deck.length<20){toast("No hay suficientes cartas disponibles para construir un mazo.","bad");return}
  await persistDeck(deck.slice(0,DECK_SIZE),"Mazo de 20 cartas construido y guardado.");
}
async function addDeck(id){
  const c=card(id);if(!c||c.level>playerLevel())return;
  if(state.profile.deck.length>=DECK_MAX){toast("El mazo ya tiene las "+DECK_MAX+" cartas máximas permitidas.","bad");return}
  if(c.powerCard&&deckPowerCount()>=MAX_POWER_CARDS){toast("El mazo ya tiene el máximo de "+MAX_POWER_CARDS+" cartas de Poder.","bad");return}
  if(!isBasicPower(c)&&freeCopies(id)<=0){toast("No tienes una copia libre de esa carta.","bad");return}
  const basic=isBasicPower(c);
  await persistDeck([...state.profile.deck,Number(id)],basic?"Poder añadido al mazo.":"Carta añadida al mazo.");
}
async function removeDeck(index){
  const next=state.profile.deck.slice();next.splice(Number(index),1);await persistDeck(next);
}
async function removeDeckCard(id){
  id=Number(id);
  const next=state.profile.deck.slice();
  const index=next.findIndex(x=>Number(x)===id);
  if(index<0)return;
  next.splice(index,1);
  await persistDeck(next);
}
async function clearDeck(){await persistDeck([],"Mazo vaciado.")}

function tierName(key){
  return key==="common"?"Común":key==="uncommon"?"Poco común":key==="rare"?"Rara":key==="epic"?"Épica":key==="legendary"?"Legendaria":key;
}
async function loadPackOdds(level){
  level=clamp(Number(level)||1,1,playerLevel());
  state.packLevel=level;
  state.packOddsLoading=true;
  if(state.view==="shop")renderView();
  const r=await api("pack_odds",{packLevel:level},true);
  state.packOddsLoading=false;
  if(!r.ok){state.packOdds=[];if(state.view==="shop")renderView();return}
  state.packOdds=Array.isArray(r.odds)?r.odds:[];
  if(state.view==="shop"&&state.packLevel===level)renderView();
}
function packTierSummary(){
  const sums={common:0,uncommon:0,rare:0,epic:0,legendary:0};
  for(const o of state.packOdds)sums[o.tier]=(sums[o.tier]||0)+Number(o.chance||0);
  return sums;
}
function renderPackOdds(){
  if(state.packOddsLoading)return'<div class="empty">Calculando probabilidades del sobre…</div>';
  if(!state.packOdds.length)return'<div class="empty">Selecciona un nivel de sobre para ver sus probabilidades.</div>';
  const sums=packTierSummary();
  const ordered=["common","uncommon","rare","epic","legendary"];
  const summary=ordered.map(t=>`<div class="stat-card"><small>${tierName(t)}</small><strong>${sums[t]<0.01&&sums[t]>0?sums[t].toFixed(3):sums[t].toFixed(1)}%</strong></div>`).join("");
  const rows=state.packOdds.map(o=>{
    const c=card(o.id);if(!c)return"";
    const chance=Number(o.chance)||0;
    const label=chance<0.01?chance.toFixed(4):chance<0.1?chance.toFixed(3):chance.toFixed(2);
    return`<div class="odds-row"><span><b>${esc(c.name)}</b><small class="muted">Nv ${c.level} · ${tierName(o.tier)} · ATQ ${c.atk} · DEF ${c.def} · coste ${c.cost}</small></span><strong>${label}%</strong></div>`;
  }).join("");
  return`<div class="grid five odds-summary">${summary}</div><div class="odds-list pack-odds-scroll" style="margin-top:12px">${rows}</div>
    <p class="muted" style="margin:10px 0 0">Las probabilidades proceden del mismo motor del servidor que realiza cada tirada y tienen en cuenta nivel del sobre, rareza y balance de juego. El Poder básico Nv 1 nunca aparece en sobres.</p>`;
}
function renderShop(){
  const lvl=state.packLevel||playerLevel();
  const opts=Array.from({length:playerLevel()},(_,i)=>i+1).map(n=>`<option value="${n}" ${n===lvl?"selected":""}>Sobre Nivel ${n}</option>`).join("");
  return `<div class="page">
    <div class="grid two">
      <section class="panel pack-hero"><div><div class="pack-card" aria-hidden="true"></div><h2>Sobre Nivel ${lvl}</h2><p class="muted">5 cartas coleccionables · niveles 1–${lvl} · 20 oro</p><div class="field" style="max-width:260px;margin:14px auto"><label>Nivel del sobre</label><select class="select" id="packLevelSelect">${opts}</select></div><button class="btn primary" data-action="buyPack" ${state.profile.coins<20?"disabled":""}>Abrir por 20 oro</button><p class="muted" style="max-width:460px">Cuanto mayor es el nivel del sobre, más peso reciben las cartas cercanas a ese nivel. El Poder básico Nv 1 sigue siendo infinito y nunca ocupa un hueco.</p></div></section>
      <section class="panel"><div class="panel-head"><h2>Última apertura</h2><span class="pill">${state.profile.packs||0} sobres abiertos</span></div><div class="panel-body">${state.lastPack.length?'<div class="reveal-grid">'+state.lastPack.map(c=>cardTile(c,{qty:owned(c.id)})).join("")+'</div>':'<div class="empty">Abre un sobre para revelar cartas aquí.</div>'}</div></section>
    </div>
    <section class="panel" style="margin-top:14px"><div class="panel-head"><h2>Economía del jugador</h2><span class="muted">Nivel ${playerLevel()}</span></div><div class="panel-body"><div class="grid three"><div class="stat-card"><small>Oro actual</small><strong>${state.profile.coins}</strong></div><div class="stat-card"><small>Cartas coleccionables</small><strong>${collectionTotal()}</strong></div><div class="stat-card"><small>Poder básico Nv 1</small><strong>∞</strong></div></div></div></section>
  </div>`;
}
async function buyPack(){
  if(state.profile.coins<20)return;
  const lvl=clamp(Number(state.packLevel)||1,1,playerLevel());
  const r=await api("buy_pack",{packLevel:lvl},true);
  if(!r.ok){toast(authErrorMessage(r.error),"bad");return}
  applyProfile(r.profile);
  state.packLevel=lvl;
  state.lastPack=(r.cards||[]).map(x=>card(x.id)).filter(Boolean);
  playSound("draw");toast("Sobre Nivel "+lvl+" abierto.","good");renderView();
}

async function sellCard(id){
  const c=card(id);if(!c||isBasicPower(c)||freeCopies(id)<=0)return;
  const r=await api("sell_card",{cardId:Number(id)},true);
  if(!r.ok){toast(authErrorMessage(r.error),"bad");return}
  applyProfile(r.profile);toast(c.name+" vendido por "+r.soldFor+" oro.","good");renderView();
}

function renderTrade(){
  const partners=state.users.filter(u=>!state.socket||u.socketId!==state.socket.id);
  const inventory=state.catalog.filter(c=>!isBasicPower(c)&&c.level<=playerLevel()&&freeCopies(c.id)>state.trade.mine.filter(x=>x===c.id).length).slice(0,120);
  const publishable=state.catalog.filter(c=>!isBasicPower(c)&&c.level<=playerLevel()&&freeCopies(c.id)>0).slice(0,180);
  const wanted=state.catalog.filter(c=>!isBasicPower(c)&&c.level<=playerLevel()).slice(0,285);
  const marketKind=state.marketKind==="trade"?"trade":"gold";
  return `<div class="page">
    <div class="grid two">
      <section class="panel">
        <div class="panel-head"><h2>Publicar anuncio</h2><span class="muted">${publishable.length} cartas libres</span></div>
        <div class="panel-body">
          <div class="field"><label>Carta que ofreces</label><select class="select" id="marketCard"><option value="">Selecciona una carta…</option>${publishable.map(c=>`<option value="${c.id}">${esc(c.name)} · Nv ${c.level} · libres ${freeCopies(c.id)}</option>`).join("")}</select></div>
          <div class="field" style="margin-top:10px"><label>Tipo de anuncio</label><select class="select" id="marketKind"><option value="gold" ${marketKind==="gold"?"selected":""}>Vender por oro</option><option value="trade" ${marketKind==="trade"?"selected":""}>Buscar intercambio</option></select></div>
          ${marketKind==="gold"
            ? '<div class="field" style="margin-top:10px"><label>Precio en oro</label><input class="input" id="marketPrice" type="number" min="1" step="1" placeholder="Ej. 25"></div>'
            : `<div class="field" style="margin-top:10px"><label>Carta que buscas</label><select class="select" id="marketWanted"><option value="">Selecciona la carta que quieres recibir…</option>${wanted.map(c=>`<option value="${c.id}">${esc(c.name)} · Nv ${c.level}</option>`).join("")}</select></div>`
          }
          <div class="actions" style="margin-top:14px"><button class="btn primary" data-action="marketPublish" ${publishable.length?"":"disabled"}>Publicar anuncio</button></div>
          <p class="muted" style="margin-bottom:0">La carta publicada queda reservada fuera de tu colección disponible hasta que canceles el anuncio o se complete la operación.</p>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Tablón de anuncios</h2><span class="pill">${state.marketListings.length} activos</span></div>
        <div class="panel-body trade-offer">${renderMarketListings()}</div>
      </section>
    </div>

    <div class="page-head" style="margin-top:26px"><div><div class="kicker">En tiempo real</div><h2 style="margin:4px 0 0">Intercambio directo</h2><p>Negocia cartas y oro con un jugador conectado. Ambos deben aceptar antes de aplicar el intercambio.</p></div></div>
    <div class="trade-layout">
      <section class="panel"><div class="panel-head"><h2>Tu reserva</h2><span class="muted">${inventory.length} disponibles</span></div><div class="panel-body trade-offer">${inventory.map(c=>`<div class="trade-item"><img src="${cardImage(c)}"><div><b>${esc(c.name)}</b><small class="muted">Nv ${c.level} · valor ${cardValue(c)} · libres ${freeCopies(c.id)-state.trade.mine.filter(x=>x===c.id).length}</small></div><button class="btn small" data-action="tradeAdd" data-id="${c.id}">+</button></div>`).join("")||'<div class="empty">No tienes cartas libres para intercambiar.</div>'}</div></section>
      <section class="panel"><div class="panel-head"><h2>Negociación</h2></div><div class="panel-body">
        <div class="field"><label>Jugador conectado</label><select class="select" id="tradePartner"><option value="">Selecciona jugador…</option>${partners.map(u=>`<option value="${esc(u.socketId)}" ${state.trade.partnerId===u.socketId?"selected":""}>${esc(u.name)} · Nivel ${u.level||1}</option>`).join("")}</select></div>
        ${partners.length?"":'<p class="muted">No hay otro jugador online ahora mismo.</p>'}
        <h3>Tu oferta</h3><div id="myOffer">${renderMyOffer()}</div>
        <div class="field" style="margin-top:10px"><label>Oro ofrecido</label><input class="input" id="tradeGold" type="number" min="0" max="${state.profile.coins}" value="${state.trade.ownGold||0}"></div>
        <div class="actions" style="margin-top:12px"><button class="btn primary" data-action="tradePropose" ${partners.length?"":"disabled"}>Proponer</button><button class="btn" data-action="tradeAccept" ${state.trade.ready?"":"disabled"}>Aceptar</button><button class="btn danger" data-action="tradeCancel">Cancelar</button></div>
        <p class="muted" style="margin-bottom:0">${esc(state.trade.status||"Selecciona un jugador y prepara una oferta.")}</p>
      </div></section>
      <section class="panel"><div class="panel-head"><h2>Oferta recibida</h2><span class="pill">${state.trade.theirGold||0} oro</span></div><div class="panel-body trade-offer">${renderTheirOffer()}</div></section>
    </div>
  </div>`;
}

function renderMarketListings(){
  if(state.marketLoading&&!state.marketListings.length)return'<div class="empty">Cargando anuncios…</div>';
  if(!state.marketListings.length)return'<div class="empty">Todavía no hay anuncios publicados.</div>';
  const me=String(state.profile?.id||"");
  return state.marketListings.map(l=>{
    const c=card(l.cardId)||{id:l.cardId,name:l.cardName||"Carta",level:l.cardLevel||1};
    const w=l.wantedCardId?card(l.wantedCardId):null;
    const own=String(l.sellerId)===me;
    const canReceive=(Number(c.level)||1)<=playerLevel();
    const price=Math.max(0,Number(l.priceGold)||0);
    const wantedId=Number(l.wantedCardId)||0;
    const canPay=l.kind==="gold"?state.profile.coins>=price:(wantedId&&freeCopies(wantedId)>0);
    const disabled=!own&&(!canReceive||!canPay);
    const terms=l.kind==="gold"
      ? `Vende por <b>${price} oro</b>`
      : `Busca <b>${esc(w?.name||l.wantedCardName||"otra carta")}</b>${w?` · Nv ${w.level}`:""}`;
    const reason=!canReceive?"Tu nivel no permite recibir esta carta.":(l.kind==="gold"&&!canPay?"No tienes oro suficiente.":(l.kind==="trade"&&!canPay?"No tienes una copia libre de la carta solicitada.":""));
    const action=own
      ? `<button class="btn small danger" data-action="marketCancel" data-id="${esc(l.id)}">Cancelar</button>`
      : `<button class="btn small ${disabled?"":"primary"}" data-action="marketAccept" data-id="${esc(l.id)}" ${disabled?"disabled":""}>${l.kind==="gold"?"Comprar":"Intercambiar"}</button>`;
    return `<div class="trade-item"><img src="${cardImage(c)}"><div><b>${esc(c.name)}</b><small class="muted">Nv ${c.level} · ${terms} · por ${esc(l.sellerName||"Jugador")}</small>${reason?`<small class="bad">${esc(reason)}</small>`:""}</div>${action}</div>`;
  }).join("");
}

async function loadMarketListings(silent=false){
  if(!sessionToken||state.marketLoading)return;
  state.marketLoading=true;
  if(state.view==="trade"&&!silent)renderView();
  const r=await api("market_list",{limit:100},true);
  state.marketLoading=false;
  if(!r.ok){
    if(!silent)toast(authErrorMessage(r.error),"bad");
    if(state.view==="trade")renderView();
    return;
  }
  state.marketListings=Array.isArray(r.listings)?r.listings:[];
  if(state.view==="trade")renderView();
}
async function publishMarketListing(){
  const cardId=Number($("marketCard")?.value)||0;
  const kind=$("marketKind")?.value==="trade"?"trade":"gold";
  state.marketKind=kind;
  if(!cardId){toast("Selecciona la carta que quieres anunciar.","bad");return}
  const payload={cardId,kind};
  if(kind==="gold"){
    const priceGold=Math.floor(Number($("marketPrice")?.value)||0);
    if(priceGold<1){toast("Indica un precio de oro válido.","bad");return}
    payload.priceGold=priceGold;
  }else{
    const wantedCardId=Number($("marketWanted")?.value)||0;
    if(!wantedCardId){toast("Selecciona la carta que buscas.","bad");return}
    if(wantedCardId===cardId){toast("Elige una carta distinta para el intercambio.","bad");return}
    payload.wantedCardId=wantedCardId;
  }
  const r=await api("market_publish",payload,true);
  if(!r.ok){toast(authErrorMessage(r.error),"bad");return}
  applyProfile(r.profile);
  toast(kind==="gold"?"Anuncio de venta publicado.":"Anuncio de intercambio publicado.","good");
  await loadMarketListings(true);
}
async function cancelMarketListing(listingId){
  const r=await api("market_cancel",{listingId},true);
  if(!r.ok){toast(authErrorMessage(r.error),"bad");return}
  applyProfile(r.profile);
  toast("Anuncio cancelado. La carta vuelve a estar disponible.","good");
  await loadMarketListings(true);
}
async function acceptMarketListing(listingId){
  const listing=state.marketListings.find(x=>x.id===listingId);
  const r=await api("market_accept",{listingId},true);
  if(!r.ok){toast(authErrorMessage(r.error),"bad");await loadMarketListings(true);return}
  applyProfile(r.profile);
  toast(listing?.kind==="gold"?"Compra completada.":"Intercambio completado.","good");
  await loadMarketListings(true);
}

function renderMyOffer(){
  if(!state.trade.mine.length)return'<div class="empty">Sin cartas en la oferta.</div>';
  return state.trade.mine.map((id,i)=>{const c=card(id);return`<div class="trade-item"><img src="${cardImage(c)}"><div><b>${esc(c.name)}</b><small class="muted">valor ${cardValue(c)}</small></div><button class="btn small danger" data-action="tradeRemove" data-index="${i}">×</button></div>`}).join("");
}
function renderTheirOffer(){
  if(!state.trade.theirs.length)return'<div class="empty">Todavía no hay contraoferta.</div>';
  return state.trade.theirs.map(id=>{const c=card(id);return c?`<div class="trade-item"><img src="${cardImage(c)}"><div><b>${esc(c.name)}</b><small class="muted">Nv ${c.level} · valor ${cardValue(c)}</small></div></div>`:""}).join("");
}
function tradeAdd(id){
  id=Number(id);const c=card(id);if(!c||isBasicPower(c)||freeCopies(id)<=state.trade.mine.filter(x=>x===id).length)return;
  state.trade.mine.push(id);state.trade.ready=false;renderView();
}
function tradeRemove(i){state.trade.mine.splice(Number(i),1);state.trade.ready=false;renderView()}
function proposeTrade(){
  if(!state.connected){toast("Necesitas conexión para intercambiar.","bad");return}
  const gold=clamp(Number($("tradeGold")?.value)||0,0,state.profile.coins);state.trade.ownGold=gold;
  const partner=$("tradePartner")?.value||state.trade.partnerId||"";state.trade.partnerId=partner;
  if(!partner){toast("Selecciona un jugador conectado.","bad");return}
  if(!state.trade.mine.length&&!gold){toast("Añade cartas u oro a la oferta.","bad");return}
  const u=state.users.find(x=>x.socketId===partner);state.trade.partnerName=u?.name||state.trade.partnerName||"Jugador";
  if(state.trade.mine.some(id=>(card(id)?.level||1)>(u?.level||50))){toast("La oferta contiene una carta superior al nivel del receptor.","bad");return}
  if(state.trade.onlineId){
    state.socket.emit("trade:offer",{tradeId:state.trade.onlineId,cards:state.trade.mine.slice(),gold});
    state.trade.status="Oferta actualizada. Ambos deberán volver a aceptar.";
  }else{
    state.socket.emit("trade:invite",{to:partner});state.trade.status="Solicitud enviada a "+state.trade.partnerName+"…";
  }
  renderView();
}
function acceptTrade(){
  if(!state.trade.ready||!state.trade.onlineId||!state.connected||!Number.isFinite(state.trade.revision))return;
  state.trade.ownGold=clamp(Number($("tradeGold")?.value)||state.trade.ownGold||0,0,state.profile.coins);
  state.socket.emit("trade:accept",{tradeId:state.trade.onlineId,revision:state.trade.revision});
  state.trade.status="Has aceptado. Esperando la confirmación del otro jugador…";renderView();
}
function handleSettledTrade(profile){
  applyProfile(profile);resetTrade();toast("Intercambio completado y guardado en tu cuenta.","good");if(state.view==="trade")renderView();else updateChrome();
}
function cancelTrade(){
  if(state.trade.onlineId&&state.connected)state.socket.emit("trade:cancel",{tradeId:state.trade.onlineId});
  resetTrade();toast("Intercambio cancelado.");renderView();
}
function resetTrade(){state.trade=freshTrade()}

async function loadRanking(){
  if(!sessionToken||state.rankingLoading)return;
  state.rankingLoading=true;
  if(state.view==="ranking")renderView();
  const r=await api("ranking",{limit:50},true);
  state.rankingLoading=false;
  if(!r.ok){
    if(state.view==="ranking"){toast("No se pudo cargar el ranking.","bad");renderView()}
    return;
  }
  state.ranking=Array.isArray(r.ranking)?r.ranking:[];
  state.myRank=Number(r.myRank)||null;
  if(state.view==="ranking")renderView();
}
function fideK(profile=state.profile){
  const elo=Number(profile?.elo)||1000;
  if(profile?.eloEver2400||elo>=2400)return 10;
  if((Number(profile?.rankedMatches)||0)<30)return 40;
  return 20;
}
function renderRanking(){
  const rows=state.ranking||[];
  const myElo=Number(state.profile?.elo)||1000;
  const myK=fideK(state.profile);
  const myRank=state.myRank||rows.find(x=>x.id===state.profile?.id)?.position||"—";
  const body=rows.map(p=>{
    const total=(Number(p.wins)||0)+(Number(p.draws)||0)+(Number(p.losses)||0);
    const wr=total?Math.round((Number(p.wins)||0)/total*100):0;
    const mine=p.id===state.profile?.id;
    return `<div class="ranking-row ${mine?"me":""}"><div class="rank-pos">#${p.position}</div><div class="rank-player"><div class="avatar">${initial(p.name)}</div><div><b>${esc(p.name)}</b><small>Nivel ${Number(p.level)||1}${mine?" · Tú":""}</small></div></div><div class="rank-elo">${Number(p.elo)||1000}</div><div class="rank-record">${Number(p.wins)||0}-${Number(p.draws)||0}-${Number(p.losses)||0}<small>${wr}% victorias</small></div><div class="rank-games">${Number(p.rankedMatches)||0}</div></div>`;
  }).join("");
  return `<div class="page">
    ${pageHead("Competición","Ranking","",'<button class="btn" data-action="refreshRanking">Actualizar</button>')}
    <div class="grid three ranking-summary">
      <div class="stat-card"><small>Tu ELO</small><strong>${myElo}</strong><span class="muted">K FIDE = ${myK}</span></div>
      <div class="stat-card"><small>Tu posición</small><strong>#${myRank}</strong><span class="muted">clasificación global</span></div>
      <div class="stat-card"><small>Partidas puntuadas</small><strong>${state.profile?.rankedMatches||0}</strong><span class="muted">solo PvP online</span></div>
    </div>
    <section class="panel" style="margin-top:14px">
      <div class="panel-head"><h2>Top 50</h2><span class="pill">${state.rankingLoading?"Actualizando…":rows.length+" jugadores"}</span></div>
      <div class="panel-body ranking-wrap">
        <div class="ranking-row ranking-head"><div>Pos.</div><div>Jugador</div><div>ELO</div><div>V-E-D</div><div>PvP</div></div>
        ${body||(state.rankingLoading?'<div class="empty">Cargando clasificación…</div>':'<div class="empty">Todavía no hay jugadores clasificados.</div>')}
      </div>
    </section>
  </div>`;
}

function renderProfile(){
  const total=state.profile.wins+state.profile.draws+state.profile.losses;
  return `<div class="page">
    <section class="panel profile-banner"><div><div class="kicker">Aprendiz</div><h1>${esc(state.profile.name)}</h1><p class="muted">Nivel ${playerLevel()} · ELO ${state.profile.elo||1000} · ${state.profile.wins} victorias · ${state.profile.draws} empates · ${state.profile.losses} derrotas</p></div></section>
    <div class="xp-card" style="margin-top:14px"><div class="xp-row"><div><b>Experiencia de Nivel ${playerLevel()}</b><div class="muted">XP ganada durante la carrera: ${state.profile.totalXp||0}</div></div><strong>${playerLevel()>=50?"MAX":state.profile.xp+" / "+state.profile.xpRequired}</strong></div><div class="xp-bar"><span style="width:${xpPercent()}%"></span></div><p class="muted" style="margin:7px 0 0">Las victorias y empates suben la barra. Las derrotas PvP pueden bajarla, pero nunca reducen un nivel ya alcanzado.</p></div>
    <div class="grid five" style="margin-top:14px"><div class="stat-card"><small>Victorias</small><strong>${state.profile.wins}</strong></div><div class="stat-card"><small>Empates</small><strong>${state.profile.draws}</strong></div><div class="stat-card"><small>Derrotas</small><strong>${state.profile.losses}</strong></div><div class="stat-card"><small>Win rate</small><strong>${winrate()}%</strong></div><div class="stat-card"><small>Oro</small><strong>${state.profile.coins}</strong></div></div>
    <div class="grid two" style="margin-top:14px">
      <section class="panel"><div class="panel-head"><h2>Ajustes de cuenta</h2></div><div class="panel-body"><label class="quick-row"><span class="quick-icon">♪</span><span><b>Sonidos del juego</b><small class="muted" style="display:block">Efectos originales recuperados</small></span><input type="checkbox" id="soundToggle" ${state.sound?"checked":""}></label><div class="actions" style="margin-top:12px"><button class="btn danger" data-action="logout">Cerrar sesión</button></div></div></section>
      <section class="panel"><div class="panel-head"><h2>Resumen</h2></div><div class="panel-body"><div class="quick-list"><div class="quick-row"><span class="quick-icon">◇</span><span><b>${uniqueOwned()} cartas distintas</b><small class="muted" style="display:block">${collectionTotal()} cartas coleccionables · Poder básico Nv 1 infinito</small></span></div><div class="quick-row"><span class="quick-icon">▦</span><span><b>${state.profile.packs||0} sobres</b><small class="muted" style="display:block">abiertos</small></span></div><div class="quick-row"><span class="quick-icon">⚔</span><span><b>${total} partidas PvP</b><small class="muted" style="display:block">victorias, empates y derrotas registradas</small></span></div></div></div></section>
    </div>
  </div>`;
}

function cardDetail(id){
  const c=card(id);if(!c)return;const r=rarity(c),basic=isBasicPower(c),locked=c.level>playerLevel(),free=freeCopies(c.id);
  $("modalRoot").innerHTML=`<div class="modal-backdrop" data-action="closeModal"><div class="modal" onclick="event.stopPropagation()"><div class="modal-head"><div><b>${esc(c.name)}</b><div class="muted" style="font-size:11px">${cardType(c)} · ${r.name}</div></div><button class="btn icon ghost" data-action="closeModal">×</button></div><div class="modal-body"><div class="card-detail"><img src="${cardImage(c)}"><div><div class="kicker">Nivel ${c.level}</div><h2>${esc(c.name)}</h2><div class="grid two"><div class="stat-card"><small>Coste</small><strong>${c.cost}</strong></div><div class="stat-card"><small>${c.powerCard?"Poder":"Ataque / Defensa"}</small><strong>${c.powerCard?"+"+powerValue(c):c.atk+" / "+c.def}</strong></div></div><p class="muted">${basic?"Poder básico de Nivel 1: tienes copias infinitas y no forma parte de tu colección.":locked?"Esta carta queda bloqueada hasta que alcances Nivel "+c.level+".":"Posees "+owned(c.id)+" copia(s), con "+free+" libre(s) fuera del mazo."}</p><div class="actions"><button class="btn primary" data-action="addDeck" data-id="${c.id}" ${(!locked&&state.profile.deck.length<DECK_MAX&&(!c.powerCard||deckPowerCount()<MAX_POWER_CARDS)&&(basic||free>0))?"":"disabled"}>Añadir al mazo</button><button class="btn" data-action="sellCard" data-id="${c.id}" ${(!basic&&free>0)?"":"disabled"}>${basic?"Poder infinito":"Vender una"}</button></div></div></div></div></div></div>`;
}

function openMobileMenu(){
  $("modalRoot").innerHTML=`<div class="modal-backdrop" data-action="closeModal"><div class="modal" style="max-width:420px" onclick="event.stopPropagation()"><div class="modal-head"><b>Más secciones</b><button class="btn icon ghost" data-action="closeModal">×</button></div><div class="modal-body"><div class="quick-list">
    <button class="quick-row btn" data-action="nav" data-view="shop"><span class="quick-icon">✦</span><span><b>Tienda</b><small class="muted" style="display:block">Sobres y economía</small></span></button>
    <button class="quick-row btn" data-action="nav" data-view="trade"><span class="quick-icon">⇄</span><span><b>Intercambios</b><small class="muted" style="display:block">Cartas y oro</small></span></button>
    <button class="quick-row btn" data-action="nav" data-view="ranking"><span class="quick-icon">♜</span><span><b>Ranking</b><small class="muted" style="display:block">Clasificación por ELO</small></span></button>
    <button class="quick-row btn" data-action="nav" data-view="manual"><span class="quick-icon">?</span><span><b>Manual</b><small class="muted" style="display:block">Reglas y referencia</small></span></button>\n    <button class="quick-row btn" data-action="nav" data-view="profile"><span class="quick-icon">◎</span><span><b>Perfil</b><small class="muted" style="display:block">Estadísticas y ajustes</small></span></button>
  </div></div></div></div>`;
}
function closeModal(){$("modalRoot").innerHTML=""}

function connectOnline(){
  if(state.connected||state.connecting||!state.profile||!sessionToken)return;
  state.connecting=true;
  const startSocket=()=>{
    if(!window.io){state.connecting=false;return}
    const socket=window.io(SERVER_URL,{transports:["websocket","polling"],timeout:8000});
    state.socket=socket;
    socket.on("connect",()=>{
      state.offlineSession=false;
      socket.emit("hello",{sessionToken});
    });
    socket.on("server:ready",()=>{
      state.connected=true;state.connecting=false;updateChrome();
      if(["home","play","trade"].includes(state.view))renderView();
    });
    socket.on("auth:error",async m=>{
      state.connected=false;state.connecting=false;toast(m?.message||"La sesión online no es válida.","bad");
      const refreshed=await api("me",{},true);
      if(!refreshed.ok&&refreshed.status===401)logout();
    });
    socket.on("disconnect",()=>{state.connected=false;updateChrome();if(state.view!=="duel")renderView()});
    socket.on("connect_error",()=>{state.connected=false;state.connecting=false;updateChrome()});
    socket.on("lobby:users",list=>{state.users=Array.isArray(list)?list:[];updateChrome();if(["home","trade"].includes(state.view))renderView()});
    socket.on("matches:list",list=>{state.matches=Array.isArray(list)?list:[];if(["home","play"].includes(state.view))renderView()});
    socket.on("chat:message",m=>{state.chat.push({from:m.from,text:m.text});if(state.view==="home")renderView()});
    socket.on("chat:system",m=>{state.chat.push({system:true,text:m.text});if(state.view==="home")renderView()});
    socket.on("match:created",()=>{toast("Reto online creado. Esperando rival.","good");if(state.view==="play")renderView()});
    socket.on("match:error",m=>toast(m?.message||"No se pudo entrar en la partida.","bad"));
    socket.on("match:ready",m=>{toast("Reto aceptado contra "+(m.opponent?.name||"otro jugador")+".","good")});
    socket.on("duel:snapshot",applyOnlineSnapshot);
    socket.on("profile:update",m=>{
      if(!m?.profile)return;
      const oldLevel=playerLevel();applyProfile(m.profile);
      const xp=Number(m.xpAwarded)||0,gold=Number(m.goldAwarded)||0,elo=Number(m.eloDelta)||0;
      const xpText=(xp>0?"+":"")+xp+" XP";
      const goldText=gold?(" · +"+gold+" oro"):"";
      const eloText=elo?(" · "+(elo>0?"+":"")+elo+" ELO"):" · 0 ELO";
      const resultText=m.matchResult==="win"?"Victoria":m.matchResult==="draw"?"Empate":m.matchResult==="loss"?"Derrota":"Recompensa";
      if(playerLevel()>oldLevel){playSound("win");toast("¡Nivel "+playerLevel()+" alcanzado! "+resultText+": "+xpText+goldText+eloText,"good")}
      else toast(resultText+": "+xpText+goldText+eloText,(xp<0||elo<0)?"bad":"good");
      updateChrome();if(["home","profile","play"].includes(state.view))renderView();
    });
    socket.on("trade:invited",m=>{
      const from=m.from?.name||"Otro jugador";
      if((state.trade.onlineId&&state.trade.onlineId!==m.tradeId)||(state.duel&&!state.duel.gameOver)){
        socket.emit("trade:cancel",{tradeId:m.tradeId});
        toast(from+" quiso intercambiar, pero ya estás ocupado.","bad");
        return;
      }
      state.trade=freshTrade();state.trade.onlineId=m.tradeId;state.trade.partnerId=m.from?.socketId||"";state.trade.partnerName=m.from?.name||"Jugador";state.trade.status=state.trade.partnerName+" quiere intercambiar contigo.";go("trade");
    });
    socket.on("trade:waiting",m=>{state.trade.onlineId=m.tradeId;state.trade.partnerId=m.to;state.trade.status="Solicitud aceptada por el servidor. Enviando oferta…";socket.emit("trade:offer",{tradeId:m.tradeId,cards:state.trade.mine.slice(),gold:state.trade.ownGold||0});if(state.view==="trade")renderView()});
    socket.on("trade:offer",m=>{if(m.tradeId!==state.trade.onlineId)return;state.trade.theirs=(m.cards||[]).map(Number).filter(id=>card(id));state.trade.theirGold=Math.max(0,Number(m.gold)||0);state.trade.revision=Number(m.revision);state.trade.ready=true;state.trade.status="Contraoferta recibida.";if(state.view==="trade")renderView()});
    socket.on("trade:offerAck",m=>{if(m.tradeId===state.trade.onlineId)state.trade.revision=Number(m.revision)});
    socket.on("trade:stale",m=>{if(m.tradeId!==state.trade.onlineId)return;state.trade.status=m.message||"La oferta ha cambiado. Revísala antes de aceptar.";toast(state.trade.status,"bad");if(state.view==="trade")renderView()});
    socket.on("trade:busy",m=>{if(state.trade.onlineId)return;state.trade.status=m?.message||"Ese jugador no puede intercambiar ahora.";toast(state.trade.status,"bad");if(state.view==="trade")renderView()});
    socket.on("trade:accepted",m=>{if(m.tradeId===state.trade.onlineId){state.trade.status="El otro jugador ha aceptado. Falta la segunda confirmación.";if(state.view==="trade")renderView()}});
    socket.on("trade:settled",m=>{if(m.tradeId===state.trade.onlineId&&m.profile)handleSettledTrade(m.profile)});
    socket.on("trade:error",m=>{if(m.tradeId===state.trade.onlineId){state.trade.ready=false;state.trade.status="Error: "+(m.message||"No se pudo completar el intercambio.");toast(state.trade.status,"bad");if(state.view==="trade")renderView()}});
    socket.on("trade:cancelled",m=>{if(m.tradeId===state.trade.onlineId){resetTrade();toast("El intercambio fue cancelado.","bad");if(state.view==="trade")renderView()}});
  };
  if(window.io){startSocket();return}
  const sc=document.createElement("script");sc.src=SERVER_URL+"/socket.io/socket.io.js";sc.async=true;sc.onload=startSocket;sc.onerror=()=>{state.connecting=false;toast("Servidor multijugador no disponible. Puedes seguir en modo offline.","bad")};document.head.appendChild(sc);
}

function createMatch(){
  if(!state.connected){toast("No hay conexión con el servidor.","bad");return}
  if(!deckValid()){toast(deckRuleMessage()||"Tu mazo no es válido para jugar.","bad");return}
  state.socket.emit("match:create",{deckSize:state.profile.deck.length,start:"random"});playSound("click");
}
function joinMatch(id){
  if(!state.connected)return;
  if(!deckValid()){toast(deckRuleMessage()||"Necesitas un mazo válido para entrar.","bad");return}
  state.socket.emit("match:join",{id});
}
function cancelMatch(id){if(state.connected)state.socket.emit("match:cancel",{id})}

function wireInstance(inst){
  const base=card(inst.cardId);if(!base)return null;
  return{...base,uid:inst.uid,exhausted:!!inst.exhausted,selected:!!inst.selected,defBonus:Number(inst.defBonus)||0,damage:Number(inst.damage)||0,
    summonedTurn:inst.summonedTurn==null?null:Number(inst.summonedTurn),attacksThisTurn:Number(inst.attacksThisTurn)||0,defensesThisTurn:Number(inst.defensesThisTurn)||0}
}
function pruneDeathGhosts(d){
  if(!d)return;
  const now=Date.now();
  const ghosts=d.deathGhosts||{player:[],enemy:[]};
  ghosts.player=(ghosts.player||[]).filter(c=>(Number(c.deathExpiresAt)||0)>now);
  ghosts.enemy=(ghosts.enemy||[]).filter(c=>(Number(c.deathExpiresAt)||0)>now);
  d.deathGhosts=ghosts;
}
function queueDeathGhost(d,zone,c,slotIndex){
  if(!d||!c||(zone!=="player"&&zone!=="enemy"))return;
  pruneDeathGhosts(d);
  const list=d.deathGhosts[zone];
  if(list.some(x=>x.uid===c.uid))return;
  const ghost={...c,deathGhost:true,deathSlot:Number.isFinite(slotIndex)?slotIndex:list.length,deathExpiresAt:Date.now()+CARD_DEATH_ANIMATION_MS};
  list.push(ghost);
  const duelKey=d.online?d.matchId:d.rewardKey;
  const wasOnline=!!d.online;
  setTimeout(()=>{
    const current=state.duel;
    if(!current)return;
    if(wasOnline&&current.matchId!==duelKey)return;
    if(!wasOnline&&current.rewardKey!==duelKey)return;
    pruneDeathGhosts(current);
    if(state.view==="duel")renderView();
  },CARD_DEATH_ANIMATION_MS+80);
}
function applyOnlineSnapshot(s){
  if(!s)return;
  const previous=state.duel&&state.duel.online&&state.duel.matchId===s.matchId?state.duel:null;
  const playerBoard=(s.playerBoard||[]).map(wireInstance).filter(Boolean);
  const ownBoardUids=new Set(playerBoard.map(c=>c.uid));
  const enemyBoard=(s.enemyBoard||[]).map(wireInstance).filter(c=>c&&!ownBoardUids.has(c.uid));
  const nextPlayerUids=new Set(playerBoard.map(c=>c.uid));
  const nextEnemyUids=new Set(enemyBoard.map(c=>c.uid));
  const removedPlayer=(previous?.playerBoard||[]).map((c,index)=>({c,index})).filter(x=>!nextPlayerUids.has(x.c.uid));
  const removedEnemy=(previous?.enemyBoard||[]).map((c,index)=>({c,index})).filter(x=>!nextEnemyUids.has(x.c.uid));
  state.duel={online:true,matchId:s.matchId,myTurn:!!s.myTurn,opponent:s.opponent?.name||"Rival",turn:Number(s.turn)||1,phase:Number(s.phase)||0,
    playerHp:Number(s.playerHp)||0,enemyHp:Number(s.enemyHp)||0,power:Number(s.power)||0,maxPower:Number(s.maxPower)||0,powerPlayed:!!s.powerPlayed,
    enemyPower:Number(s.enemyPower)||0,enemyMaxPower:Number(s.enemyMaxPower)||0,playerDeckCount:Number(s.playerDeckCount)||0,enemyDeckCount:Number(s.enemyDeckCount)||0,
    playerHand:(s.playerHand||[]).map(wireInstance).filter(Boolean),enemyHandCount:Number(s.enemyHandCount)||0,
    playerBoard,enemyBoard,
    playerPowers:(s.playerPowers||[]).map(wireInstance).filter(Boolean),enemyPowers:(s.enemyPowers||[]).map(wireInstance).filter(Boolean),
    gameOver:!!s.gameOver,result:s.result||null,won:s.won,defending:!!s.defending,attackDeclared:!!s.attackDeclared,pendingAttack:s.pendingAttack||null,drawOfferIncoming:!!s.drawOfferIncoming,drawOfferOutgoing:!!s.drawOfferOutgoing,blockAssignments:{},attackTargets:{},
    damageDealt:Number(s.damageDealt)||0,log:s.log||[],resultApplied:previous?.resultApplied||false,
    deathGhosts:previous?.deathGhosts||{player:[],enemy:[]},
    playerIdleAllowanceMs:Number(s.playerIdleAllowanceMs)||COMBAT_IDLE_BASE_MS,playerIdleDeadlineAt:Number(s.playerIdleDeadlineAt)||0,
    playerLeaveDeadlineAt:Number(s.playerLeaveDeadlineAt)||0,playerLeaveReason:String(s.playerLeaveReason||""),
    opponentDisconnectDeadlineAt:Number(s.opponentDisconnectDeadlineAt)||0,
    opponentLeaveDeadlineAt:Number(s.opponentLeaveDeadlineAt??s.opponentDisconnectDeadlineAt)||0,opponentLeaveReason:String(s.opponentLeaveReason||""),
    serverNow:Number(s.serverNow)||Date.now()
  };
  duelIdleAllowanceMs=Math.max(COMBAT_IDLE_BASE_MS,Math.min(COMBAT_IDLE_MAX_MS,Number(state.duel.playerIdleAllowanceMs)||COMBAT_IDLE_BASE_MS));
  removedPlayer.forEach(x=>queueDeathGhost(state.duel,"player",x.c,x.index));
  removedEnemy.forEach(x=>queueDeathGhost(state.duel,"enemy",x.c,x.index));
  pruneDeathGhosts(state.duel);
  const showDrawOffer=!!s.drawOfferIncoming&&!previous?.drawOfferIncoming;
  if(state.duel.gameOver)duelLobbyAway=false;
  if(!duelLobbyAway&&state.view!=="duel")state.view="duel";
  updateChrome();renderView();
  if(showDrawOffer&&state.view==="duel")requestAnimationFrame(openDrawResponseModal);
}

function formatCombatGrace(ms){
  const total=Math.max(0,Math.ceil(ms/1000)),m=Math.floor(total/60),sec=String(total%60).padStart(2,"0");
  return m+":"+sec;
}
function updateCombatGraceCountdown(){
  const el=document.querySelector("[data-combat-grace-countdown]");
  const d=state.duel,deadline=Number(d?.opponentDisconnectDeadlineAt)||0;
  if(!el||!deadline)return;
  const left=Math.max(0,deadline-Date.now());
  el.textContent=left>0?formatCombatGrace(left):"0:00";
}
function renderDuel(){
  const d=state.duel;if(!d)return'<div class="page"><div class="empty">No hay duelo activo.</div></div>';
  const phase=PHASES[d.phase]||PHASES[0];
  const opponentDeadline=Number(d.opponentLeaveDeadlineAt??d.opponentDisconnectDeadlineAt)||0;
  const disconnectLeft=Math.max(0,opponentDeadline-Date.now());
  const opponentReason=String(d.opponentLeaveReason||"disconnect");
  const opponentTitle=opponentReason==="inactive"?"Rival inactivo":opponentReason==="lobby"?"Rival en el lobby":opponentReason==="fullscreen"?"Rival fuera de combate":"Rival desconectado";
  const opponentText=opponentReason==="inactive"?"Lleva más de 3 minutos inactivo. Si no actúa a tiempo, pierde la partida.":opponentReason==="lobby"?"Ha vuelto al lobby. Si no reanuda a tiempo, pierde la partida.":opponentReason==="fullscreen"?"Ha cerrado la pantalla completa. Si no vuelve a tiempo, pierde la partida.":"Si no se reconecta a tiempo, pierde la partida.";
  const disconnectWarning=disconnectLeft>0?`<div class="duel-disconnect-warning"><b>${opponentTitle}</b><span>${opponentText} <strong data-combat-grace-countdown>${formatCombatGrace(disconnectLeft)}</strong></span></div>`:"";
  const awayDeadline=playerLeaveDeadline();
  const awayLeft=Math.max(0,awayDeadline-Date.now());
  const awayReason=playerLeaveReason();
  const awayText=awayReason==="inactive"?"Llevas más de 3 minutos inactivo. Vuelve o realiza una acción":awayReason==="lobby"?"Has vuelto al lobby. Reanuda la partida":"Has salido de la pantalla completa. Vuelve a la partida";
  const awayWarning=awayLeft>0?`<div class="duel-disconnect-warning"><b>${awayReason==="inactive"?"Inactividad detectada":"Vuelve a la partida"}</b><span>${awayText} · <strong data-duel-fullscreen-countdown>${formatCombatGrace(awayLeft)}</strong></span></div>`:"";
  const idleLeft=!awayDeadline?Math.max(0,playerIdleDeadline()-Date.now()):0;
  const idleFinalWarning=idleLeft>0&&idleLeft<=10*1000?`<div class="duel-disconnect-warning"><b>Inactividad</b><span>Realiza una acción en <strong data-duel-idle-countdown>${Math.max(1,Math.ceil(idleLeft/1000))}</strong>s</span></div>`:"";
  const fullscreenButton=fullscreenApiAvailable()&&!fullscreenElement()&&!d.gameOver
    ? '<button class="btn icon ghost duel-fullscreen-button" data-action="enterDuelFullscreen" title="Volver a pantalla completa" aria-label="Volver a pantalla completa">⛶</button>'
    : "";
  const lobbyButton=!d.gameOver
    ? '<button class="btn icon ghost duel-lobby-button" data-action="returnToLobby" title="Volver al lobby" aria-label="Volver al lobby">⌂</button>'
    : "";
  return `<div class="duel-page">
    ${disconnectWarning}
    ${awayWarning}
    ${idleFinalWarning}
    <div class="duel-top duel-turn-strip">
      <div class="duel-turn-state"><div class="kicker">Turno ${d.turn}</div><b>${d.online?(d.myTurn?"Tu turno":"Turno rival"):(d.aiActing?(d.aiMessage||"Turno del Guardián"):"Tu turno")}</b></div>
      <div class="duel-top-actions">${fullscreenButton}${lobbyButton}</div>
    </div>
    <div class="board">
      <section class="board-zone enemy-zone">
        <div class="zone-title"><span>Rival · ${d.enemyHandCount??d.enemyHand?.length??0} cartas en mano</span></div>
        <div class="hidden-cards-strip">${hiddenCardBacks(d.enemyHandCount??d.enemyHand?.length??0)}</div>
        ${powerLane(d.enemyPowers||[],"Poder rival","enemyPower")}
        <div class="battle-row">${battleCards(d.enemyBoard||[],"enemy")}</div>
        <div class="duel-deck-rail enemy-deck-rail">
          <div class="duel-deck-column enemy-deck-column">${deckBack(d.enemyDeckCount??d.enemyDeck?.length??0,"Mazo rival")}<div class="deck-player-meta"><b>${esc(d.opponent||"Guardián")}</b><span>${d.enemyHp} PV</span><div class="deck-hp-bar" aria-label="${d.enemyHp} de 30 puntos de vida"><i style="width:${clamp(d.enemyHp/30*100,0,100)}%"></i></div></div></div>
        </div>
      </section>
      <div class="phase-track duel-phase-divider" aria-label="Fases del turno">${PHASES.map((p,i)=>`<div class="phase-step ${i===d.phase?"active":""}">${i+1}. ${p}</div>`).join("")}</div>
      <section class="board-zone player-zone">${powerLane(d.playerPowers||[],"Tu Poder","playerPower")}<div class="battle-row">${battleCards(d.playerBoard||[],"player")}</div></section>
      <div class="duel-bottom">
        <section class="board-zone hand-zone">
          <div class="zone-title"><span>Tu mano</span></div>
          <div class="player-hand-layout">
            <div class="player-hand-strip"><div class="battle-row">${battleCards(d.playerHand||[],"hand")}</div></div>
            <div class="duel-deck-rail player-deck-rail">
              <div class="duel-deck-column player-deck-column">${deckBack(d.playerDeckCount??d.playerDeck?.length??0,"Tu mazo")}<div class="deck-player-meta"><b>${esc(state.profile.name)}</b><span>${d.playerHp} PV</span><div class="deck-hp-bar" aria-label="${d.playerHp} de 30 puntos de vida"><i style="width:${clamp(d.playerHp/30*100,0,100)}%"></i></div></div></div>
            </div>
          </div>
          <div class="duel-controls"><div class="duel-controls-left">${duelControls(d)}</div>${duelMatchActions(d)}</div>
        </section>
      </div>
      <aside class="duel-log-keyboard" aria-label="Registro de combate"><div class="duel-log-window-head"><b>Registro de combate</b><span>${phase}</span></div><div class="duel-log">${(d.log||[]).slice(-30).map(x=>`<div>${esc(x)}</div>`).join("")||'<div>El duelo ha comenzado.</div>'}</div></aside>
    </div>
  </div>`;
}
function duelMatchActions(d){
  if(!d||d.gameOver)return"";
  const drawDisabled=!d.online||d.drawOfferOutgoing;
  return `<div class="duel-match-actions" aria-label="Acciones de partida"><button class="btn small danger" data-action="concede">Rendirse</button><button class="btn small" data-action="drawButton" ${drawDisabled?"disabled":""}>Tablas</button></div>`;
}
function openDrawResponseModal(){
  const d=state.duel;
  if(!d?.online||!d.drawOfferIncoming||d.gameOver)return;
  const root=$("modalRoot");if(!root)return;
  root.innerHTML=`<div class="modal-backdrop" data-action="closeModal"><div class="modal duel-draw-response-modal" onclick="event.stopPropagation()"><div class="modal-head"><b>¿Aceptar tablas?</b><button class="btn icon ghost" data-action="closeModal">×</button></div><div class="modal-body"><div class="actions duel-draw-response-buttons"><button class="btn" data-action="rejectDraw">Rechazar</button><button class="btn primary" data-action="acceptDraw">Aceptar</button></div></div></div></div>`;
}
function drawButton(){
  const d=state.duel;if(!d||d.gameOver||!d.online)return;
  if(d.drawOfferIncoming){openDrawResponseModal();return}
  if(d.drawOfferOutgoing)return;
  offerDraw();
}

function hiddenCardBacks(count){
  const total=Math.max(0,Number(count)||0),shown=Math.min(total,10);
  if(!shown)return'<div class="hidden-hand-empty">Sin cartas ocultas</div>';
  return `<div class="hidden-hand" aria-label="${total} cartas ocultas">${Array.from({length:shown},()=>'<div class="hidden-card-back" aria-hidden="true"></div>').join("")}${total>shown?`<span class="hidden-card-more">+${total-shown}</span>`:""}</div>`;
}
function deckBack(count,label){
  const total=Math.max(0,Number(count)||0);
  return `<div class="duel-deck-back ${total?"":"empty"}" title="${esc(label||"Mazo")} · ${total} cartas" aria-label="${esc(label||"Mazo")} con ${total} cartas"><span>${total}</span></div>`;
}
function powerLane(list,label,zone){
  const cards=list||[],total=powerTotal(cards),groups=[],byType=new Map();
  for(const c of cards){
    const key=norm(c?.name||"")+"::"+powerValue(c);
    let group=byType.get(key);
    if(!group){
      group={sample:c,count:0,exhausted:0};
      byType.set(key,group);
      groups.push(group);
    }
    group.count++;
    if(c.exhausted)group.exhausted++;
  }
  return `<div class="power-lane"><span class="power-lane-label">${esc(label)} · ${total}</span><div class="power-lane-cards">${groups.length?groups.map(group=>{
    const c=group.sample,count=group.count,value=powerValue(c),stackPower=count*value,allExhausted=group.exhausted===count;
    return `<div class="power-mini power-stack ${allExhausted?"exhausted":""}" style="background-image:url('${cardImage(c)}')" title="${esc(c.name)} · ${count} carta${count===1?"":"s"} · +${stackPower} Poder automático">${count>1?`<b class="power-stack-count">×${count}</b>`:""}<span>+${value}</span></div>`;
  }).join(""):'<span class="power-empty">Sin Poder en juego</span>'}</div></div>`;
}
function currentDef(c){return Math.max(0,(Number(c?.def)||0)+(Number(c?.defBonus)||0))}
function cardCanAttackUi(d,c){
  if(!d||!c||(Number(c.atk)||0)<=0)return false;
  if(c.exhausted)return false;
  if(c.summonedTurn===d.turn&&!c.berserker)return false;
  return true;
}
function battleCards(list,zone){
  const cards=(list||[]).map(c=>({card:c,dying:false}));
  if(zone==="player"||zone==="enemy"){
    pruneDeathGhosts(state.duel);
    const ghosts=[...(state.duel?.deathGhosts?.[zone]||[])].sort((a,b)=>(a.deathSlot||0)-(b.deathSlot||0));
    ghosts.forEach(g=>cards.splice(Math.max(0,Math.min(cards.length,Number(g.deathSlot)||0)),0,{card:g,dying:true}));
  }
  if(!cards.length)return'<div class="battle-empty" aria-hidden="true"></div>';
  return cards.map(entry=>{
    const c=entry.card,dying=entry.dying;
    const clickable=!dying&&duelCardClickable(c,zone);
    const handPlayable=!dying&&zone==="hand"&&clickable;
    const attacked=!dying&&(Number(c.attacksThisTurn)||0)>0;
    const defended=!dying&&(Number(c.defensesThisTurn)||0)>0;
    const defense=currentDef(c);
    const label=c.powerCard
      ? `${c.name} · Poder +${powerValue(c)}`
      : `${c.name} · Ataque ${c.atk} · Defensa ${defense}`;
    const stateHint=handPlayable?" · jugable ahora":[attacked?"ataque declarado":"",defended?"defensa declarada":""].filter(Boolean).map(x=>" · "+x).join("");
    return `<article class="battle-card ${dying?"dying":""} ${clickable?"clickable":""} ${handPlayable?"hand-playable":""} ${attacked?"attacked":""} ${defended?"defended":""} ${!dying&&c.selected?"selected":""} ${!dying&&c.exhausted?"exhausted":""}" ${clickable?'data-action="duelCard" data-zone="'+zone+'" data-uid="'+c.uid+'"':""} ${dying?"":'data-detail="'+c.id+'"'} title="${esc(dying?c.name+" · destruida":label+stateHint)}" aria-label="${esc(dying?c.name+" destruida":label+stateHint)}"><div class="battle-art" style="background-image:url('${cardImage(c)}')"></div>${attacked?'<span class="battle-attack-label" aria-hidden="true">ATAQUE</span>':""}${defended?'<span class="battle-defense-label" aria-hidden="true">DEFENSA</span>':""}${dying?'<span class="battle-death-label">Destruida</span>':""}</article>`;
  }).join("");
}
function duelCardClickable(c,zone){
  const d=state.duel;if(!d||d.gameOver)return false;
  const powerPlayed=d.online?d.powerPlayed:d.playerPowerPlayed;
  if(zone==="hand"){
    if((d.online&&!d.myTurn)||(!d.online&&d.aiActing))return false;
    return(d.phase===2&&c.powerCard&&!powerPlayed)||(d.phase===3&&!c.powerCard&&!c.abilityCard&&c.cost<=d.power)||(d.phase===4&&c.abilityCard&&c.cost<=d.power);
  }
  if(zone==="player"){
    if(d.phase!==5)return false;
    if(d.defending)return localCanDefend(c);
    if(d.online&&!d.myTurn)return false;
    if(!d.online&&d.aiActing)return false;
    return !d.attackDeclared&&!d.pendingAttack&&cardCanAttackUi(d,c);
  }
  return false;
}
function renderCombatPrompt(d){
  return "";
}
function duelControls(d){
  if(d.gameOver){const label=d.result==="draw"?"Empate":d.result==="loss"||d.won===false?"Derrota":"Victoria";return`<div class="turn-wait">${label} · <button class="btn small" data-action="leaveDuel">Volver al salón</button></div>`};
  const prompt=d.phase===5?renderCombatPrompt(d):"";
  if(d.defending)return`<div style="width:100%">${prompt}<div class="actions duel-phase-action-row"><button class="btn" data-action="passDefense">Dejar pasar</button></div></div>`;
  if(!d.online&&d.aiActing)return`<div class="turn-wait">${esc(d.aiMessage||"Turno del Guardián")}…</div>`;
  if(d.online&&!d.myTurn)return'<div class="turn-wait">Esperando la acción del rival…</div>';
  if(d.attackDeclared)return`<div style="width:100%">${prompt}</div>`;
  return`<div style="width:100%">${prompt}<div class="actions duel-phase-action-row"><button class="btn primary" data-action="nextPhase">${d.phase===5?"Pasar turno":"Siguiente fase"}</button></div></div>`;
}

function training(){
  const size=state.profile.deck.length;
  const playerIds=deckValid()?state.profile.deck.slice():[];
  if(!deckValid()){toast(deckRuleMessage()||"Tu mazo no es válido para entrenar.","bad");go("deck");return}
  const lvl=playerLevel();
  const powers=state.catalog.filter(c=>c.powerCard&&c.level<=lvl);
  const creatures=state.catalog.filter(c=>!c.powerCard&&!c.abilityCard&&c.level<=lvl);
  const abilities=state.catalog.filter(c=>c.abilityCard&&c.level<=lvl);
  const enemy=[];
  const pickStrong=(pool)=>{
    if(!pool.length)return null;
    const ranked=[...pool].sort((a,b)=>aiDraftScore(b)-aiDraftScore(a));
    const top=ranked.slice(0,Math.max(1,Math.ceil(ranked.length*.45)));
    return top[Math.floor(Math.random()*top.length)];
  };
  const powerTarget=Math.min(MAX_POWER_CARDS,Math.max(MIN_POWER_CARDS,Math.round(size*.35)));
  const abilityTarget=abilities.length?Math.min(size-powerTarget,Math.max(2,Math.round(size*.15))):0;
  const creatureTarget=size-powerTarget-abilityTarget;
  for(let i=0;i<powerTarget;i++){const c=pickStrong(powers);if(c)enemy.push(c.id)}
  for(let i=0;i<abilityTarget;i++){const c=pickStrong(abilities);if(c)enemy.push(c.id)}
  for(let i=0;i<creatureTarget;i++){const c=pickStrong(creatures.length?creatures:(abilities.length?abilities:powers));if(c)enemy.push(c.id)}
  while(enemy.length<size){const c=pickStrong([...powers,...abilities,...creatures]);if(!c)break;enemy.push(c.id)}

  const playerStarts=Math.random()<.5;
  const startedAt=Date.now();
  const d={online:false,opponent:"Guardián Nv "+lvl,turn:1,phase:0,playerHp:30,enemyHp:30,power:0,maxPower:0,enemyPower:0,enemyMaxPower:0,
    playerDeck:shuffle(playerIds).map(makeInst),enemyDeck:shuffle(enemy).map(makeInst),playerHand:[],enemyHand:[],playerBoard:[],enemyBoard:[],playerPowers:[],enemyPowers:[],
    playerPowerPlayed:false,enemyPowerPlayed:false,aiActing:false,aiMessage:"",pendingAttack:null,defending:false,attackTargets:{},playerDeckOut:false,enemyDeckOut:false,
    gameOver:false,won:null,result:null,damageDealt:0,rewardKey:"training:"+uid(),rewardPending:false,startedAt,deadlineAt:startedAt+MATCH_LIMIT_MS,
    log:["Entrenamiento iniciado. El jugador inicial se decide al azar."]};
  state.duel=d;
  drawLocal("player",7);drawLocal("enemy",7);
  drawLocal(playerStarts?"enemy":"player",1);
  d.log.push(playerStarts?"Empiezas tú. El Guardián recibe la octava carta inicial.":"Empieza el Guardián. Recibes la octava carta inicial.");
  state.view="duel";updateChrome();playSound("turn");renderView();

  window.setTimeout(()=>{if(state.duel===d&&!d.gameOver){checkLocalEnd(true);renderView()}},MATCH_LIMIT_MS+50);
  if(playerStarts)advanceLocalAutomaticPhases();
  else{d.aiActing=true;d.aiMessage="El Guardián comienza la partida";renderView();void runEnemyTurn(d)}
}
function makeInst(id){const c=card(id);return c?{...c,uid:uid(),exhausted:false,selected:false,damage:0,defBonus:0,summonedTurn:null,attacksThisTurn:0,defensesThisTurn:0}:null}
function drawLocal(side,n=1){
  const d=state.duel;
  for(let i=0;i<n;i++){
    const deck=d[side+"Deck"];
    if(!deck.length){d[side+"DeckOut"]=true;break}
    d[side+"Hand"].push(deck.pop());
    if(!deck.length){d[side+"DeckOut"]=true;break}
  }
}
function localPlay(uid){
  const d=state.duel,i=d.playerHand.findIndex(c=>c.uid===uid);if(i<0)return;const c=d.playerHand[i];
  if(d.phase===2&&c.powerCard&&!d.playerPowerPlayed){
    d.playerHand.splice(i,1);c.exhausted=false;d.playerPowers.push(c);d.maxPower=powerTotal(d.playerPowers);d.power=d.maxPower;d.playerPowerPlayed=true;
    d.log.push("Pones "+c.name+" en tu zona de Poder. Poder disponible: "+d.power+".");playSound("power")
  }
  else if(d.phase===3&&!c.powerCard&&!c.abilityCard&&c.cost<=d.power){
    d.power-=c.cost;d.playerHand.splice(i,1);c.summonedTurn=d.turn;c.damage=0;c.attacksThisTurn=0;c.defensesThisTurn=0;d.playerBoard.push(c);
    d.log.push("Invocas "+c.name+". No puede atacar este turno salvo que tenga Berserker.");playSound("summon")
  }
  else if(d.phase===4&&c.abilityCard&&c.cost<=d.power){d.power-=c.cost;d.playerHand.splice(i,1);resolveLocalAbility(c,"player")}
  advanceLocalAutomaticPhases();
  renderView();
}
function resolveLocalAbility(c,side){
  const d=state.duel,foe=side==="player"?"enemy":"player",n=norm(c.name);
  if(n.startsWith("fuente de vida")){d[side+"Hp"]+=3;d.log.push(c.name+": +3 PV.")}
  else if(n.startsWith("veneno")){d[foe+"Hp"]-=3;if(side==="player")d.damageDealt+=3;d.log.push(c.name+": 3 PV de daño.")}
  else if(n.startsWith("drenador")){d[foe+"Hp"]-=2;if(side==="player")d.damageDealt+=2;d[side+"Hp"]+=2;d.log.push(c.name+": drena 2 PV.")}
  else if(n.startsWith("poder mental")){drawLocal(side,1);d.log.push(c.name+": carta adicional.")}
  else if(n.startsWith("poderador")){d[side==="player"?"power":"enemyPower"]=Math.min(d[side==="player"?"maxPower":"enemyMaxPower"],d[side==="player"?"power":"enemyPower"]+2)}
  else{drawLocal(side,1);d.log.push(c.name+" se resuelve.")}
  checkLocalEnd();
}
function localCanAttack(d,c){
  return !!(c&&!c.exhausted&&(Number(c.atk)||0)>0&&(c.summonedTurn!==d.turn||c.berserker));
}
function localCanDefend(c){return !!(c&&(!c.exhausted||c.defender))}
function resolveLocalSingleAttack(side,attacker,defender){
  const d=state.duel,foe=side==="player"?"enemy":"player";
  const liveAttacker=d?.[side+"Board"]?.find(x=>x.uid===attacker?.uid);
  if(!d||!liveAttacker)return false;
  const aAtk=Math.max(0,Number(liveAttacker.atk)||0);
  if(!defender){
    d[foe+"Hp"]-=aAtk;if(side==="player")d.damageDealt+=aAtk;
    d.log.push(liveAttacker.name+" ataca directamente y causa "+aAtk+" PV.");playSound("hit");
    return true;
  }
  const liveDefender=d[foe+"Board"].find(x=>x.uid===defender.uid);
  if(!liveDefender||!localCanDefend(liveDefender))return false;
  const bDef=currentDef(liveDefender),bAtk=Math.max(0,Number(liveDefender.atk)||0),aDef=currentDef(liveAttacker);
  liveDefender.exhausted=true;liveDefender.defensesThisTurn=(liveDefender.defensesThisTurn||0)+1;
  const defenderDestroyed=aAtk>=bDef;
  const attackerDestroyed=bAtk>=aDef;
  const overflow=Math.max(0,aAtk-bDef);
  if(overflow){d[foe+"Hp"]-=overflow;if(side==="player")d.damageDealt+=overflow}
  d.log.push(liveAttacker.name+" ("+aAtk+" ATQ / "+aDef+" DEF) combate con "+liveDefender.name+" ("+bAtk+" ATQ / "+bDef+" DEF). Las estadísticas no se desgastan."+(overflow?" "+overflow+" de daño atraviesa al jugador.":""));
  if(defenderDestroyed){
    const deathIndex=d[foe+"Board"].findIndex(x=>x.uid===liveDefender.uid);
    queueDeathGhost(d,foe,liveDefender,deathIndex);
    d[foe+"Board"]=d[foe+"Board"].filter(x=>x.uid!==liveDefender.uid);
    d.log.push(liveDefender.name+" es destruida.");
  }
  if(attackerDestroyed){
    const deathIndex=d[side+"Board"].findIndex(x=>x.uid===liveAttacker.uid);
    queueDeathGhost(d,side,liveAttacker,deathIndex);
    d[side+"Board"]=d[side+"Board"].filter(x=>x.uid!==liveAttacker.uid);
    d.log.push(liveAttacker.name+" es destruida por el contraataque.");
  }
  return true;
}
function declareLocalAttack(uid){
  const d=state.duel,c=d?.playerBoard?.find(x=>x.uid===uid);
  if(!d||d.aiActing||d.defending||d.pendingAttack||d.phase!==5||!c||!localCanAttack(d,c))return;
  c.exhausted=true;c.attacksThisTurn=(c.attacksThisTurn||0)+1;c.selected=false;
  d.log.push(c.name+" declara un ataque.");
  const available=d.enemyBoard.filter(localCanDefend);
  const defender=chooseAiBlock(c,available,d.enemyHp)||null;
  resolveLocalSingleAttack("player",c,defender);
  if(checkLocalEnd())return renderView();
  advanceLocalAutomaticPhases();
  renderView();
}
function declareLocalEnemyAttack(attacker){
  const d=state.duel;
  if(!d||!attacker||!localCanAttack(d,attacker))return Promise.resolve();
  attacker.exhausted=true;attacker.attacksThisTurn=(attacker.attacksThisTurn||0)+1;attacker.selected=false;
  d.pendingAttack={side:"enemy",attackerUid:attacker.uid,attackerName:attacker.name};
  d.log.push("El Guardián ataca con "+attacker.name+".");
  const defenders=d.playerBoard.filter(localCanDefend);
  if(!defenders.length){
    resolveLocalSingleAttack("enemy",attacker,null);
    d.pendingAttack=null;
    renderView();
    return Promise.resolve();
  }
  d.defending=true;
  d.aiMessage="Elige una carta para defender";
  renderView();
  return new Promise(resolve=>{d._defenseResolver=resolve});
}
function localDefend(uid){
  const d=state.duel;
  if(!d||!d.defending||!d.pendingAttack||d.pendingAttack.side!=="enemy")return;
  const defender=d.playerBoard.find(x=>x.uid===uid);
  if(!defender||!localCanDefend(defender))return;
  const attacker=d.enemyBoard.find(x=>x.uid===d.pendingAttack.attackerUid);
  if(attacker)resolveLocalSingleAttack("enemy",attacker,defender);
  d.pendingAttack=null;d.defending=false;d.aiActing=true;d.aiMessage="El Guardián continúa su ataque";
  const resume=d._defenseResolver;d._defenseResolver=null;
  renderView();
  if(resume)resume();
}
function localPassDefense(){
  const d=state.duel;
  if(!d||!d.defending||!d.pendingAttack||d.pendingAttack.side!=="enemy")return;
  const attacker=d.enemyBoard.find(x=>x.uid===d.pendingAttack.attackerUid);
  if(attacker)resolveLocalSingleAttack("enemy",attacker,null);
  d.pendingAttack=null;d.defending=false;d.aiActing=true;d.aiMessage="El Guardián continúa su ataque";
  const resume=d._defenseResolver;d._defenseResolver=null;
  renderView();
  if(resume)resume();
}

function localPhaseHasAction(d){
  if(!d||d.gameOver||d.aiActing||d.pendingAttack)return false;
  if(d.phase===2)return !d.playerPowerPlayed&&d.playerHand.some(c=>c.powerCard);
  if(d.phase===3)return d.playerHand.some(c=>!c.powerCard&&!c.abilityCard&&c.cost<=d.power);
  if(d.phase===4)return d.playerHand.some(c=>c.abilityCard&&c.cost<=d.power);
  if(d.phase===5)return d.playerBoard.some(c=>localCanAttack(d,c));
  return false;
}
function startLocalEnemyTurn(d){
  if(!d||d.gameOver||d.aiActing)return;
  d.aiActing=true;
  d.phase=0;
  d.aiMessage="El Guardián prepara su turno";
  d.log.push("Tu turno ha terminado. Ahora juega el Guardián.");
  renderView();
  void runEnemyTurn(d);
}
function advanceLocalAutomaticPhases(){
  const d=state.duel;
  if(!d||d.online||d.gameOver||d.aiActing)return;
  let guard=0;
  while(guard++<8&&!d.gameOver&&!d.aiActing){
    if(localPhaseHasAction(d))return;
    if(d.phase===5){startLocalEnemyTurn(d);return}
    d.phase++;
    if(d.phase===1){
      drawLocal("player",1);
      playSound("draw");
      if(checkLocalEnd())return;
    }
    if(d.phase===2){
      d.maxPower=powerTotal(d.playerPowers);
      d.power=d.maxPower;
    }
  }
}
function localHighestLevelAttack(d,side){
  const list=[...(d[side+"Board"]||[]),...(d[side+"Powers"]||[])];
  if(!list.length)return 0;
  const level=Math.max(...list.map(c=>Number(c.level)||0));
  return Math.max(0,...list.filter(c=>(Number(c.level)||0)===level).map(c=>Number(c.atk)||0));
}
function localScore(d,side){
  return Math.max(0,Number(d[side+"Hp"])||0)+(d[side+"Board"]||[]).length+(d[side+"Powers"]||[]).length+(d[side+"Deck"]||[]).length+localHighestLevelAttack(d,side);
}
function nextLocalPhase(){
  const d=state.duel;if(!d||d.gameOver||d.aiActing||d.defending||d.pendingAttack)return;
  if(d.phase===5){
    startLocalEnemyTurn(d);
    return;
  }
  d.phase++;
  if(d.phase===1){drawLocal("player",1);playSound("draw");if(checkLocalEnd())return renderView()}
  if(d.phase===2){d.maxPower=powerTotal(d.playerPowers);d.power=d.maxPower}
  advanceLocalAutomaticPhases();
  renderView();
}

function aiUnitValue(c){
  if(!c)return 0;
  return Math.max(.5,(Number(c.atk)||0)*1.8+(Number(c.def)||0)*1.35+(Number(c.level)||1)*.25);
}
function aiDraftScore(c){
  if(!c)return 0;
  if(c.powerCard)return 6+powerValue(c)*4+(Number(c.level)||1)*.15;
  if(c.abilityCard)return 5+(Number(c.level)||1)*.5+(Number(c.rarity)||0)*.01;
  const cost=Math.max(1,Number(c.cost)||1);
  return aiUnitValue(c)/cost+(Number(c.atk)||0)*.45+(Number(c.def)||0)*.25;
}
function aiSummonScore(c,d){
  const maxEnemyAtk=Math.max(0,...(d.playerBoard||[]).filter(x=>!x.exhausted).map(x=>Number(x.atk)||0));
  const maxEnemyDef=Math.max(0,...(d.playerBoard||[]).filter(x=>!x.exhausted).map(x=>Number(x.def)||0));
  let score=aiUnitValue(c)-(Number(c.cost)||0)*.3;
  if((Number(c.atk)||0)>=maxEnemyDef&&maxEnemyDef>0)score+=2.4;
  if((Number(c.def)||0)>maxEnemyAtk&&maxEnemyAtk>0)score+=2.1;
  if(d.playerHp<=10)score+=(Number(c.atk)||0)*.65;
  return score;
}
function aiAbilityScore(c,d){
  const n=norm(c?.name||"");
  const missing=Math.max(0,30-d.enemyHp);
  if(n.startsWith("veneno"))return d.playerHp<=3?100:(d.playerHp<=10?13:8);
  if(n.startsWith("drenador"))return d.playerHp<=2?100:8+Math.min(5,missing*.35);
  if(n.startsWith("fuente de vida"))return missing<=0?-4:(d.enemyHp<=10?14:5+Math.min(5,missing*.35));
  if(n.startsWith("poder mental"))return d.enemyHand.length<=4?8:5;
  if(n.startsWith("poderador"))return d.enemyPower<d.enemyMaxPower?6:-2;
  return 3;
}
function chooseAiBlock(attacker,defenders,hp){
  if(!attacker||!defenders.length)return null;
  const survivors=defenders.filter(c=>(Number(c.def)||0)>(Number(attacker.atk)||0)).sort((a,b)=>aiUnitValue(a)-aiUnitValue(b));
  if(survivors.length)return survivors[0];
  const expendable=[...defenders].sort((a,b)=>aiUnitValue(a)-aiUnitValue(b));
  const cheapest=expendable[0];
  if(!cheapest)return null;
  if((Number(attacker.atk)||0)>=hp)return cheapest;
  if((Number(attacker.atk)||0)>=3&&aiUnitValue(cheapest)<=(Number(attacker.atk)||0)*1.9)return cheapest;
  return null;
}
function resolveLocalAttack(){
  // Compatibilidad con el resolvedor antiguo: cada combate usa exactamente
  // la misma regla simultánea que resolveLocalSingleAttack.
  const d=state.duel;
  if(!d)return;
  const attackers=d.playerBoard.filter(c=>c.selected&&!c.exhausted);
  for(const attacker of attackers){
    const live=d.playerBoard.find(c=>c.uid===attacker.uid);
    if(!live||!localCanAttack(d,live))continue;
    live.exhausted=true;
    live.attacksThisTurn=(live.attacksThisTurn||0)+1;
    live.selected=false;
    const available=d.enemyBoard.filter(localCanDefend);
    const defender=chooseAiBlock(live,available,d.enemyHp)||available[0]||null;
    resolveLocalSingleAttack("player",live,defender);
    if(checkLocalEnd())break;
  }
}
function aiPause(ms){return new Promise(resolve=>window.setTimeout(resolve,ms))}
function aiStillActive(d){return state.duel===d&&!d.gameOver}
function aiBestPower(d){
  return [...d.enemyHand].filter(c=>c.powerCard).sort((a,b)=>powerValue(b)-powerValue(a)||aiDraftScore(b)-aiDraftScore(a))[0]||null;
}
function aiBestAbility(d,minScore=0){
  return [...d.enemyHand].filter(c=>c.abilityCard&&c.cost<=d.enemyPower)
    .map(c=>({c,score:aiAbilityScore(c,d)})).filter(x=>x.score>=minScore)
    .sort((a,b)=>b.score-a.score||a.c.cost-b.c.cost)[0]?.c||null;
}
function aiBestSummon(d){
  return [...d.enemyHand].filter(c=>!c.powerCard&&!c.abilityCard&&c.cost<=d.enemyPower)
    .sort((a,b)=>aiSummonScore(b,d)-aiSummonScore(a,d)||a.cost-b.cost)[0]||null;
}
function aiChooseAttackers(d){
  const ready=d.enemyBoard.filter(c=>localCanAttack(d,c));
  const defenders=d.playerBoard.filter(localCanDefend);
  if(!ready.length)return [];
  if(!defenders.length)return ready;
  const totalAtk=ready.reduce((n,c)=>n+(Number(c.atk)||0),0);
  const maxDef=Math.max(0,...defenders.map(currentDef));
  const maxPlayerAtk=Math.max(0,...defenders.map(c=>Number(c.atk)||0));
  const pressure=d.playerHp<=10||totalAtk>=d.playerHp;
  const overrun=ready.length>defenders.length;
  let chosen=ready.filter(c=>{
    const atk=Number(c.atk)||0,def=currentDef(c);
    const canTrade=defenders.some(x=>atk>=currentDef(x));
    const canBeStonewalled=defenders.some(x=>currentDef(x)>atk);
    const defensiveAnchor=def>maxPlayerAtk&&atk<=1&&d.enemyHp<=12;
    if(defensiveAnchor&&!pressure)return false;
    if(!canBeStonewalled)return true;
    if(canTrade)return true;
    if(overrun)return true;
    if(pressure&&atk>=2)return true;
    return atk>maxDef;
  });
  if(!chosen.length&&overrun)chosen=ready;
  return chosen;
}
function aiAttackTargets(d,attackers){
  const targets={},available=d.playerBoard.filter(localCanDefend).slice();
  for(const a of attackers){
    if(!available.length)break;
    available.sort((x,y)=>{
      const xKill=(Number(a.atk)||0)>=currentDef(x)?1:0,yKill=(Number(a.atk)||0)>=currentDef(y)?1:0;
      return yKill-xKill||currentDef(x)-currentDef(y)||aiUnitValue(x)-aiUnitValue(y);
    });
    const target=available.shift();if(target)targets[a.uid]=target.uid;
  }
  return targets;
}
async function runEnemyTurn(d){
  try{
    if(!aiStillActive(d))return;
    d.enemyBoard.forEach(c=>{c.exhausted=false;c.selected=false;c.attacksThisTurn=0;c.defensesThisTurn=0});
    d.enemyPowers.forEach(c=>c.exhausted=false);
    d.enemyPowerPlayed=false;
    d.enemyPower=0;
    d.enemyMaxPower=powerTotal(d.enemyPowers);
    d.phase=1;
    d.aiMessage="Fase de robo";
    drawLocal("enemy",1);
    d.log.push("El Guardián roba una carta.");
    playSound("draw");renderView();
    if(checkLocalEnd())return;
    await aiPause(450);if(!aiStillActive(d))return;

    d.phase=2;
    d.aiMessage="Fase de Poder";
    const p=aiBestPower(d);
    if(p&&!d.enemyPowerPlayed){
      d.enemyHand=d.enemyHand.filter(x=>x.uid!==p.uid);
      p.exhausted=false;
      d.enemyPowers.push(p);
      d.enemyPowerPlayed=true;
      d.enemyMaxPower=powerTotal(d.enemyPowers);
      d.log.push("El Guardián pone "+p.name+" en su zona de Poder.");
      playSound("power");renderView();
      await aiPause(400);if(!aiStillActive(d))return;
    }
    d.enemyMaxPower=powerTotal(d.enemyPowers);
    d.enemyPower=d.enemyMaxPower;
    d.log.push("Los Poderes del Guardián generan automáticamente "+d.enemyPower+" Poder.");
    renderView();

    d.phase=3;
    d.aiMessage="Fase de invocación";
    let safe=50;
    while(safe--){
      const unit=aiBestSummon(d);if(!unit)break;
      d.enemyPower-=unit.cost;
      d.enemyHand=d.enemyHand.filter(x=>x.uid!==unit.uid);
      unit.exhausted=false;unit.selected=false;unit.summonedTurn=d.turn;unit.damage=0;unit.attacksThisTurn=0;unit.defensesThisTurn=0;
      d.enemyBoard.push(unit);
      d.log.push("El Guardián invoca "+unit.name+" ("+unit.atk+"/"+unit.def+").");
      playSound("summon");renderView();
      await aiPause(280);if(!aiStillActive(d))return;
    }

    d.phase=4;
    d.aiMessage="Fase de habilidades";
    for(let i=0;i<3;i++){
      const ability=aiBestAbility(d,3);if(!ability)break;
      d.enemyPower-=ability.cost;
      d.enemyHand=d.enemyHand.filter(x=>x.uid!==ability.uid);
      d.log.push("El Guardián usa "+ability.name+".");
      resolveLocalAbility(ability,"enemy");
      renderView();
      if(checkLocalEnd())return;
      await aiPause(350);if(!aiStillActive(d))return;
    }

    d.phase=5;
    d.aiMessage="Fase de ataque";
    const attackers=aiChooseAttackers(d);
    if(attackers.length){
      for(const attacker of attackers){
        if(!aiStillActive(d)||!localCanAttack(d,attacker))continue;
        await declareLocalEnemyAttack(attacker);
        if(!aiStillActive(d))return;
        if(checkLocalEnd())return;
        await aiPause(350);
      }
    }else{
      d.log.push("El Guardián decide no atacar este turno.");
      renderView();
    }
    await aiPause(450);
    if(aiStillActive(d))void finishEnemyTurn(d);
  }catch(err){
    console.error("Training AI error",err);
    if(state.duel===d&&!d.gameOver){
      d.log.push("El Guardián ha terminado su turno.");
      void finishEnemyTurn(d);
    }
  }
}
async function finishEnemyTurn(d){
  if(state.duel!==d||d.gameOver)return;
  d.aiActing=true;
  d.aiMessage="El Guardián termina su turno";
  d.log.push("El turno del Guardián ha terminado.");
  renderView();
  await aiPause(650);
  if(state.duel!==d||d.gameOver)return;
  d.turn++;
  d.phase=0;
  d.playerBoard.forEach(c=>{c.exhausted=false;c.selected=false;c.attacksThisTurn=0;c.defensesThisTurn=0});
  d.playerPowers.forEach(c=>c.exhausted=false);
  d.playerPowerPlayed=false;
  d.maxPower=powerTotal(d.playerPowers);
  d.power=0;
  d.enemyPower=0;
  d.aiActing=false;
  d.aiMessage="";
  d.log.push("Comienza tu turno "+d.turn+". Tus cartas se enderezan.");
  playSound("turn");
  advanceLocalAutomaticPhases();
  renderView();
}
async function awardTraining(d){
  const payload={rewardKey:d.rewardKey,win:!!d.won,damage:Math.min(30,Math.max(0,d.damageDealt||0)),mode:"training"};
  const oldLevel=playerLevel(),r=await api("award_result",payload,true);
  if(!r.ok){
    if(r.network){queueReward(payload);toast("La recompensa de entrenamiento se sincronizará cuando vuelva la conexión.","bad")}
    else toast(authErrorMessage(r.error),"bad");
    return;
  }
  applyProfile(r.profile);updateChrome();
  if(playerLevel()>oldLevel){playSound("win");toast("¡Subes a Nivel "+playerLevel()+"! Tus próximos sobres ya pueden incluir cartas de ese nivel.","good")}
  else if(r.goldAwarded)toast("+"+r.goldAwarded+" oro · entrenamiento sin XP, ELO ni estadísticas PvP","good");
  else toast("Entrenamiento completado · sin XP, ELO ni estadísticas PvP","good");
  if(state.view==="duel")renderView();
}
function finalizeLocalResult(d,result,message){
  if(d.gameOver)return;
  d.gameOver=true;d.result=result;d.won=result==="win";
  d.log.push(message);
}
function checkLocalEnd(forceScore=false){
  const d=state.duel;if(!d||d.online)return false;
  if(!d.gameOver){
    const timeUp=forceScore||(d.deadlineAt&&Date.now()>=d.deadlineAt);
    const playerLost=d.playerHp<=0||d.playerDeckOut;
    const enemyLost=d.enemyHp<=0||d.enemyDeckOut;
    if(timeUp||(playerLost&&enemyLost)){
      const ps=localScore(d,"player"),es=localScore(d,"enemy");
      if(ps===es)finalizeLocalResult(d,"draw","Empate por puntuación: "+ps+" a "+es+".");
      else if(ps>es)finalizeLocalResult(d,"win","Victoria por puntuación: "+ps+" a "+es+".");
      else finalizeLocalResult(d,"loss","Derrota por puntuación: "+ps+" a "+es+".");
    }else if(playerLost)finalizeLocalResult(d,"loss",d.playerDeckOut?"Tu mazo se ha quedado sin cartas.":"Tus PV han llegado a 0.");
    else if(enemyLost)finalizeLocalResult(d,"win",d.enemyDeckOut?"El mazo rival se ha quedado sin cartas.":"Los PV del rival han llegado a 0.");
  }
  if(d.gameOver){
    if(!d.resultApplied){d.resultApplied=true;if(d.won)playSound("win");void awardTraining(d)}
    return true;
  }
  return false;
}

function duelCard(zone,uid){
  const d=state.duel;if(!d)return;
  if(d.online){
    if(zone==="hand"){
      if(d.myTurn)state.socket.emit("duel:action",{matchId:d.matchId,type:"play",uid});
    }else if(zone==="player"){
      if(d.defending)state.socket.emit("duel:action",{matchId:d.matchId,type:"defend",uid});
      else if(d.myTurn&&!d.attackDeclared)state.socket.emit("duel:action",{matchId:d.matchId,type:"attack",uid});
    }
    return;
  }
  if(zone==="hand"){
    if(!d.aiActing)localPlay(uid);
  }else if(zone==="player"){
    if(d.defending)localDefend(uid);
    else if(!d.aiActing)declareLocalAttack(uid);
  }
}
function nextPhase(){
  const d=state.duel;if(!d)return;
  if(d.online){
    if(d.myTurn&&!d.attackDeclared&&!d.pendingAttack)state.socket.emit("duel:action",{matchId:d.matchId,type:"nextPhase"});
  }else if(!d.aiActing&&!d.defending&&!d.pendingAttack)nextLocalPhase();
}
function passDefense(){
  const d=state.duel;if(!d||!d.defending)return;
  if(d.online){
    if(state.connected)state.socket.emit("duel:action",{matchId:d.matchId,type:"passDefense"});
  }else localPassDefense();
}
function concede(){
  const d=state.duel;if(!d||d.gameOver)return;
  if(!confirm("¿Seguro que quieres rendirte? La partida contará como derrota."))return;
  if(d.online){
    if(!state.connected){toast("No hay conexión con el servidor. No se ha enviado la rendición.","bad");return}
    state.socket.emit("duel:action",{matchId:d.matchId,type:"concede"});
    return;
  }
  finalizeLocalResult(d,"loss","Te has rendido. El Guardián gana la partida.");
  checkLocalEnd();
  renderView();
}
function offerDraw(){
  const d=state.duel;if(!d||d.gameOver)return;
  if(!d.online){toast("Las tablas solo pueden pedirse en partidas contra otro jugador.");return}
  if(state.connected&&!d.drawOfferIncoming&&!d.drawOfferOutgoing)state.socket.emit("duel:action",{matchId:d.matchId,type:"offerDraw"});
}
function respondDraw(accept){const d=state.duel;if(d?.online&&state.connected&&d.drawOfferIncoming){closeModal();state.socket.emit("duel:action",{matchId:d.matchId,type:"respondDraw",accept:!!accept})}}
function returnToLobbyFromDuel(){
  const d=state.duel;
  if(state.view!=="duel"||!d||d.gameOver)return;
  duelLobbyAway=true;
  startDuelAwayCountdown("lobby");
  closeModal();
  state.view="home";
  document.body.classList.remove("duel-native-fullscreen","duel-log-visible");
  syncDuelOrientation(false);
  const exit=document.exitFullscreen||document.webkitExitFullscreen;
  if(fullscreenElement()&&exit){
    try{
      const result=exit.call(document);
      if(result&&typeof result.catch==="function")result.catch(()=>{});
    }catch{}
  }
  updateChrome();
  renderView();
  window.scrollTo({top:0,behavior:"smooth"});
}
function resumeDuelFromLobby(){
  const d=state.duel;
  if(!d||d.gameOver)return;
  duelLobbyAway=false;
  state.view="duel";
  markDuelActivity("return");
  updateChrome();
  renderView();
  void requestDuelFullscreen(false);
}
function leaveDuel(){duelLobbyAway=false;state.duel=null;document.body.classList.remove("duel-native-fullscreen");syncDuelFullscreenState(false);go("home")}

document.addEventListener("click",e=>{
  const authTab=e.target.closest("[data-auth-mode]");
  if(authTab){setAuthMode(authTab.dataset.authMode);return}
  const el=e.target.closest("[data-action]");if(!el)return;
  const a=el.dataset.action;
  if(state.view==="duel"&&state.duel&&!state.duel.gameOver&&DUEL_GAME_ACTIONS.has(a))markDuelActivity("gameAction");
  if(a!=="cardDetail")playSound("click");
  if(a==="nav")go(el.dataset.view);
  else if(a==="mobileMenu")openMobileMenu();
  else if(a==="training")training();
  else if(a==="createMatch")createMatch();
  else if(a==="joinMatch")joinMatch(el.dataset.id);
  else if(a==="cancelMatch")cancelMatch(el.dataset.id);
  else if(a==="cardDetail")cardDetail(Number(el.dataset.id));
  else if(a==="closeModal")closeModal();
  else if(a==="addDeck"){e.stopPropagation();addDeck(Number(el.dataset.id));closeModal()}
  else if(a==="sellCard"){e.stopPropagation();sellCard(Number(el.dataset.id));closeModal()}
  else if(a==="removeDeck")removeDeck(Number(el.dataset.index));
  else if(a==="removeDeckCard")removeDeckCard(Number(el.dataset.id));
  else if(a==="newDeck")newDeckDraft();
  else if(a==="saveNamedDeck")saveNamedDeck(false);
  else if(a==="saveDeckCopy")saveNamedDeck(true);
  else if(a==="deleteDeck")deleteSavedDeck();
  else if(a==="autoDeck")autoDeck();
  else if(a==="clearDeck")clearDeck()
  else if(a==="buyPack")buyPack();
  else if(a==="marketRefresh")void loadMarketListings();
  else if(a==="marketPublish")void publishMarketListing();
  else if(a==="marketAccept")void acceptMarketListing(el.dataset.id);
  else if(a==="marketCancel")void cancelMarketListing(el.dataset.id);
  else if(a==="tradeAdd")tradeAdd(Number(el.dataset.id));
  else if(a==="tradeRemove")tradeRemove(Number(el.dataset.index));
  else if(a==="tradePropose")proposeTrade();
  else if(a==="tradeAccept")acceptTrade();
  else if(a==="tradeCancel")cancelTrade();
  else if(a==="duelCard")duelCard(el.dataset.zone,el.dataset.uid);
  else if(a==="nextPhase")nextPhase();
  else if(a==="passDefense")passDefense();
  else if(a==="concede")concede();
  else if(a==="drawButton")drawButton();
  else if(a==="offerDraw")offerDraw();
  else if(a==="acceptDraw")respondDraw(true);
  else if(a==="rejectDraw")respondDraw(false);
  else if(a==="enterDuelFullscreen"){markDuelActivity("return");void requestDuelFullscreen(false);}
  else if(a==="returnToLobby")returnToLobbyFromDuel();
  else if(a==="resumeDuelFromLobby")resumeDuelFromLobby();
  else if(a==="resumeDuelActivity")markDuelActivity("return");
  else if(a==="restartTraining")training();
  else if(a==="leaveDuel")leaveDuel();
  else if(a==="refreshRanking")void loadRanking();
  else if(a==="logout")logout();
});
document.addEventListener("input",e=>{
  if(e.target.id==="collectionSearch"){
    const pos=e.target.selectionStart||e.target.value.length;
    state.collectionQuery=e.target.value;renderView();
    requestAnimationFrame(()=>{const n=$("collectionSearch");if(n){n.focus();try{n.setSelectionRange(pos,pos)}catch{}}});
  } else if(e.target.id==="deckNameInput"){
    state.deckName=e.target.value;
  }
});
document.addEventListener("change",e=>{
  if(e.target.id==="collectionMode"){state.collectionMode=e.target.value;renderView()}
  else if(e.target.id==="collectionType"){state.collectionType=e.target.value;renderView()}
  else if(e.target.id==="savedDeckSelect"){if(e.target.value)void activateSavedDeck(e.target.value)}
  else if(e.target.id==="packLevelSelect"){state.packLevel=clamp(Number(e.target.value)||1,1,playerLevel());renderView()}
  else if(e.target.id==="marketKind"){state.marketKind=e.target.value==="trade"?"trade":"gold";renderView()}
  else if(e.target.id==="soundToggle"){state.sound=e.target.checked;localStorage.setItem("rolplay.sound",state.sound?"on":"off");saveProfile();toast(state.sound?"Sonidos activados.":"Sonidos desactivados.")}
});
document.addEventListener("submit",e=>{
  if(e.target.id==="loginForm"){e.preventDefault();authenticateForm()}
  if(e.target.id==="chatForm"){e.preventDefault();const input=$("chatInput"),text=input?.value.trim();if(!text)return;if(state.connected)state.socket.emit("chat:send",{text});else{state.chat.push({from:state.profile.name,text});renderView()}}
});
$("logoutBtn")?.addEventListener("click",logout);

document.addEventListener("keydown",e=>{
  if(e.defaultPrevented||e.ctrlKey||e.metaKey||e.altKey)return;
  const tag=e.target?.tagName;
  if(tag==="INPUT"||tag==="TEXTAREA"||tag==="SELECT"||e.target?.isContentEditable)return;
  if(e.target?.closest?.("#ve-root"))return;
  if(e.key==="Escape"){
    document.body.classList.remove("duel-log-visible");
    return;
  }
  if(String(e.key).toLowerCase()!=="r")return;
  if(state.view!=="duel"||!state.duel)return;
  e.preventDefault();
  document.body.classList.toggle("duel-log-visible");
});

function handleDuelFullscreenChange(){
  const active=!!fullscreenElement();
  document.body.classList.toggle("duel-native-fullscreen",active);
  if(state.view!=="duel"||!state.duel||state.duel.gameOver)return;
  if(active){
    duelFullscreenEnteredOnce=true;
    markDuelActivity("return");
    syncDuelOrientation(true);
  }else if(duelFullscreenEnteredOnce){
    startDuelAwayCountdown("fullscreen");
    syncDuelOrientation(true);
  }
  renderView();
}
document.addEventListener("fullscreenchange",handleDuelFullscreenChange);
document.addEventListener("webkitfullscreenchange",handleDuelFullscreenChange);
document.addEventListener("visibilitychange",()=>{
  if(state.view!=="duel"||!state.duel||state.duel.gameOver)return;
  if(!document.hidden)markDuelActivity("return");
});
window.addEventListener("focus",()=>markDuelActivity("return"));
document.addEventListener("pointerdown",()=>markDuelActivity("activity"),{passive:true});
document.addEventListener("keydown",()=>markDuelActivity("activity"));
window.setInterval(()=>{
  updateCombatGraceCountdown();
  updateDuelFullscreenCountdown();
},1000);
boot();
})();