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
const DECK_SIZE=20;
let sessionToken=localStorage.getItem(SESSION_KEY)||"";
let deckWriteQueue=Promise.resolve();
let deckWriteVersion=0;
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
  ranking:[],rankingLoading:false,myRank:null
};

function freshTrade(){return{mine:[],theirs:[],theirGold:0,ownGold:0,onlineId:null,partnerId:"",partnerName:"",ready:false,accepted:false}}
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
function powerTotal(list){return(list||[]).reduce((n,c)=>n+powerValue(c),0)}
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
    deck_not_found:"Ese mazo ya no existe."
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

function updateChrome(){
  if(!state.profile)return;
  $("playerName").textContent=state.profile.name;$("playerAvatar").textContent=initial(state.profile.name);
  $("playerMeta").textContent="Nv "+playerLevel()+" · "+state.profile.xp+"/"+(state.profile.xpRequired||"MAX")+" XP";
  $("coins").textContent=state.profile.coins;
  const fill=$("playerXpFill");if(fill)fill.style.width=xpPercent()+"%";
  $("connectionDot").className="dot "+(state.connected?"online":"");
  $("connectionText").textContent=state.connected?"Online":state.offlineSession?"Offline":"Conectando";
  $("onlineBadge").textContent=state.users.length||0;
  document.querySelectorAll("[data-nav]").forEach(b=>b.classList.toggle("active",b.dataset.nav===state.view));
}
function playerLevel(){return clamp(Number(state.profile?.level)||1,1,50)}
function xpPercent(){if(!state.profile||playerLevel()>=50)return 100;return clamp(Math.round((state.profile.xp/Math.max(1,state.profile.xpRequired))*100),0,100)}
function winrate(){
  const total=(state.profile?.wins||0)+(state.profile?.draws||0)+(state.profile?.losses||0);
  return total?Math.round(state.profile.wins/total*100):0;
}
function deckValid(){
  if(!state.profile||!state.activeDeckId||state.profile.deck.length!==DECK_SIZE)return false;
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
  closeModal();
  state.view=view;updateChrome();renderView();
  if(view==="shop")void loadPackOdds(state.packLevel||playerLevel());
  if(view==="deck")void loadDecks();
  if(view==="ranking")void loadRanking();
  window.scrollTo({top:0,behavior:"smooth"});
}
function renderView(){
  const root=$("viewRoot");if(!root||!state.profile)return;
  const renderers={home:renderHome,play:renderPlay,ranking:renderRanking,collection:renderCollection,deck:renderDeck,shop:renderShop,trade:renderTrade,profile:renderProfile,duel:renderDuel};
  root.innerHTML=(renderers[state.view]||renderHome)();
}

function pageHead(kicker,title,desc,actions=""){
  return `<div class="page-head"><div><div class="kicker">${kicker}</div><h1>${title}</h1><p>${desc}</p></div><div class="actions">${actions}</div></div>`;
}
function renderHome(){
  const deckReady=deckValid(),matches=state.matches.filter(m=>m.status==="waiting").length,empty=collectionTotal()===0;
  return `<div class="page">
    <div class="home-actions">
      ${empty?'<button class="btn primary" data-action="nav" data-view="shop">Abrir primeros sobres</button>':'<button class="btn primary" data-action="nav" data-view="play">Buscar partida</button>'}
      ${matches>0?'<button class="btn" data-action="nav" data-view="play">Unirse a partida</button>':""}
      <button class="btn" data-action="nav" data-view="deck">Construir mazo</button>
    </div>
    <div class="xp-card">
      <div class="xp-row"><div><div class="kicker">Progresión</div><b>Nivel ${playerLevel()}</b></div><div class="muted">${playerLevel()>=50?"Nivel máximo":state.profile.xp+" / "+state.profile.xpRequired+" XP"}</div></div>
      <div class="xp-bar"><span style="width:${xpPercent()}%"></span></div>
    </div>
    <div class="grid four" style="margin-top:14px">
      <div class="stat-card"><small>Jugadores conectados</small><strong>${state.users.length}</strong><span class="muted">salón en tiempo real</span></div>
      <div class="stat-card"><small>Partidas abiertas</small><strong>${matches}</strong><span class="muted">retos esperando rival</span></div>
      <div class="stat-card"><small>Colección</small><strong>${uniqueOwned()}</strong><span class="muted">${collectionTotal()} cartas · Poder básico ∞</span></div>
      <div class="stat-card"><small>Mazo activo</small><strong>${state.profile.deck.length}</strong><span class="${deckReady?"good":"bad"}">${deckReady?"listo para jugar":"requiere exactamente 20 cartas"}</span></div>
    </div>
    <div class="grid two" style="margin-top:14px">
      <section class="panel">
        <div class="panel-head"><h2>Salón online</h2><span class="pill"><span class="dot ${state.connected?"online":""}"></span>${state.connected?"Conectado":"Modo offline"}</span></div>
        <div class="panel-body"><div class="online-list">${renderUsers()}</div></div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Chat general</h2><span class="muted">${state.chat.length} mensajes</span></div>
        <div class="chat"><div class="chat-log" id="chatLog">${renderChat()}</div>
          <form class="chat-send" id="chatForm"><input class="input" id="chatInput" maxlength="300" placeholder="Escribe en el salón…" autocomplete="off"><button class="btn primary" ${state.connected?"":"disabled"}>Enviar</button></form>
        </div>
      </section>
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
        <div class="panel-head"><h2>Crear partida</h2><span class="pill ${deckValid()?"good":"bad"}">${state.profile.deck.length}/${DECK_SIZE} cartas</span></div>
        <div class="panel-body">
          <div class="grid two">
            <div class="field"><label>Formato</label><div class="input" aria-label="Formato de mazo">Mazo estándar · ${DECK_SIZE} cartas</div></div>
            <div class="field"><label>Quién empieza</label><select class="select" id="matchStart"><option value="normal">Creador</option><option value="random">Aleatorio</option></select></div>
          </div>
          <div class="actions" style="margin-top:14px"><button class="btn primary" data-action="createMatch" ${(state.connected&&deckValid())?"":"disabled"}>Crear reto online</button><span class="muted">${!state.activeDeckId?"Guarda y selecciona un mazo antes de jugar.":!deckValid()?"El mazo activo debe tener exactamente "+DECK_SIZE+" cartas válidas.":state.connected?"Visible para todos los jugadores conectados.":"Conecta con el servidor para crear retos."}</span></div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Entrenamiento</h2><span class="pill">IA local</span></div>
        <div class="panel-body"><p class="muted">Prueba tu mazo de 20 cartas sin esperar rival. El entrenamiento da recompensas pequeñas y nunca resta XP.</p><button class="btn" data-action="training" ${deckValid()?"":"disabled"}>Iniciar entrenamiento</button></div>
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
    return `<div class="match-row"><div class="match-player"><div class="avatar">${initial(m.player)}</div><div>${esc(m.player)}<div class="muted" style="font-size:11px">Nivel ${m.level||1}</div></div></div><b>${DECK_SIZE} cartas</b><span class="pill">${m.start==="random"?"Aleatorio":"Normal"}</span><span class="good">Esperando</span>${mine?'<button class="btn small danger" data-action="cancelMatch" data-id="'+m.id+'">Cancelar</button>':'<button class="btn small primary" data-action="joinMatch" data-id="'+m.id+'" data-size="'+m.deckSize+'">Unirse</button>'}</div>`;
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
    ${pageHead("Biblioteca","Colección","Explora las 285 cartas recuperadas. Vende duplicados, inspecciona detalles o llévalas al constructor de mazos.")}
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
    ${pageHead("Estrategia","Constructor de mazos","Todos los mazos de ARCANUM TCG tienen exactamente 20 cartas.",
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
        <div class="panel-head"><h2>Mazo activo</h2><span class="pill ${count===DECK_SIZE?"good":"bad"}">${count}/${DECK_SIZE} cartas</span></div>
        <div class="panel-body">
          <div class="grid two"><div class="stat-card"><small>Coste medio</small><strong>${avg.toFixed(1)}</strong></div><div class="stat-card"><small>Poderes</small><strong>${state.profile.deck.filter(id=>card(id)?.powerCard).length}</strong></div></div>
          <div class="field" style="margin:14px 0"><label>Formato del mazo</label><div class="input">20 cartas exactas</div></div>
          <div class="deck-meter"><span style="width:${Math.min(100,count/DECK_SIZE*100)}%"></span></div>
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
  candidate=candidate.map(Number).slice(0,DECK_SIZE);
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
  const deck=[],wantedPower=Math.ceil(target*.30);
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
  if(state.profile.deck.length>=DECK_SIZE){toast("El mazo ya tiene las 20 cartas permitidas.","bad");return}
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
    ${pageHead("Mercado","Tienda","Cada sobre tiene nivel propio. Solo puedes comprar niveles ya desbloqueados y nunca puede salir una carta por encima del nivel del sobre.")}
    <div class="grid two">
      <section class="panel pack-hero"><div><div class="pack-card">R</div><h2>Sobre Nivel ${lvl}</h2><p class="muted">5 cartas coleccionables · niveles 1–${lvl} · 20 oro</p><div class="field" style="max-width:260px;margin:14px auto"><label>Nivel del sobre</label><select class="select" id="packLevelSelect">${opts}</select></div><button class="btn primary" data-action="buyPack" ${state.profile.coins<20?"disabled":""}>Abrir por 20 oro</button><p class="muted" style="max-width:460px">Cuanto mayor es el nivel del sobre, más peso reciben las cartas cercanas a ese nivel. El Poder básico Nv 1 sigue siendo infinito y nunca ocupa un hueco.</p></div></section>
      <section class="panel"><div class="panel-head"><h2>Última apertura</h2><span class="pill">${state.profile.packs||0} sobres abiertos</span></div><div class="panel-body">${state.lastPack.length?'<div class="reveal-grid">'+state.lastPack.map(c=>cardTile(c,{qty:owned(c.id)})).join("")+'</div>':'<div class="empty">Abre un sobre para revelar cartas aquí.</div>'}</div></section>
    </div>
    <section class="panel" style="margin-top:14px"><div class="panel-head"><h2>Economía del jugador</h2><span class="muted">Nivel ${playerLevel()}</span></div><div class="panel-body"><div class="grid three"><div class="stat-card"><small>Oro actual</small><strong>${state.profile.coins}</strong></div><div class="stat-card"><small>Cartas coleccionables</small><strong>${collectionTotal()}</strong></div><div class="stat-card"><small>Poder básico Nv 1</small><strong>∞</strong></div></div></div></section>
    <section class="panel" style="margin-top:14px"><div class="panel-head"><h2>Probabilidades · Sobre Nivel ${lvl}</h2><span class="pill">por hueco del sobre</span></div><div class="panel-body">${renderPackOdds()}</div></section>
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
  void loadPackOdds(lvl);
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
  return `<div class="page">
    ${pageHead("Comercio","Intercambios","Negocia cartas y oro con jugadores conectados. El intercambio se aplica de forma persistente a ambas cuentas solo cuando los dos aceptan.")}
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
  if(!state.trade.ready||!state.trade.onlineId||!state.connected)return;
  state.trade.ownGold=clamp(Number($("tradeGold")?.value)||state.trade.ownGold||0,0,state.profile.coins);
  state.socket.emit("trade:accept",{tradeId:state.trade.onlineId});
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
    ${pageHead("Competición","Ranking","Cálculo FIDE: resultado real menos resultado esperado, multiplicado por el coeficiente K del jugador.",'<button class="btn" data-action="refreshRanking">Actualizar</button>')}
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
    <div class="reward-rules" style="margin-top:14px"><b>Cómo cambia el ELO</b><p>Cada partida usa la probabilidad esperada de la tabla FIDE. Victoria = 1, empate = 0,5 y derrota = 0. El cambio es K × (resultado − expectativa), redondeado al entero más cercano. K=40 durante las primeras 30 partidas puntuadas, K=20 después mientras no se haya alcanzado 2400, y K=10 desde el momento en que se alcanzan 2400. Para jugadores por debajo de 2650, una diferencia superior a 400 puntos se calcula como 400.</p></div>
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
  $("modalRoot").innerHTML=`<div class="modal-backdrop" data-action="closeModal"><div class="modal" onclick="event.stopPropagation()"><div class="modal-head"><div><b>${esc(c.name)}</b><div class="muted" style="font-size:11px">${cardType(c)} · ${r.name}</div></div><button class="btn icon ghost" data-action="closeModal">×</button></div><div class="modal-body"><div class="card-detail"><img src="${cardImage(c)}"><div><div class="kicker">Nivel ${c.level}</div><h2>${esc(c.name)}</h2><div class="grid two"><div class="stat-card"><small>Coste</small><strong>${c.cost}</strong></div><div class="stat-card"><small>${c.powerCard?"Poder":"Ataque / Defensa"}</small><strong>${c.powerCard?"+"+powerValue(c):c.atk+" / "+c.def}</strong></div></div><p class="muted">${basic?"Poder básico de Nivel 1: tienes copias infinitas y no forma parte de tu colección.":locked?"Esta carta queda bloqueada hasta que alcances Nivel "+c.level+".":"Posees "+owned(c.id)+" copia(s), con "+free+" libre(s) fuera del mazo."}</p><div class="actions"><button class="btn primary" data-action="addDeck" data-id="${c.id}" ${(!locked&&state.profile.deck.length<DECK_SIZE&&(basic||free>0))?"":"disabled"}>Añadir al mazo</button><button class="btn" data-action="sellCard" data-id="${c.id}" ${(!basic&&free>0)?"":"disabled"}>${basic?"Poder infinito":"Vender una"}</button></div></div></div></div></div></div>`;
}

function openMobileMenu(){
  $("modalRoot").innerHTML=`<div class="modal-backdrop" data-action="closeModal"><div class="modal" style="max-width:420px" onclick="event.stopPropagation()"><div class="modal-head"><b>Más secciones</b><button class="btn icon ghost" data-action="closeModal">×</button></div><div class="modal-body"><div class="quick-list">
    <button class="quick-row btn" data-action="nav" data-view="shop"><span class="quick-icon">✦</span><span><b>Tienda</b><small class="muted" style="display:block">Sobres y economía</small></span></button>
    <button class="quick-row btn" data-action="nav" data-view="trade"><span class="quick-icon">⇄</span><span><b>Intercambios</b><small class="muted" style="display:block">Cartas y oro</small></span></button>
    <button class="quick-row btn" data-action="nav" data-view="ranking"><span class="quick-icon">♜</span><span><b>Ranking</b><small class="muted" style="display:block">Clasificación por ELO</small></span></button>
    <button class="quick-row btn" data-action="nav" data-view="profile"><span class="quick-icon">◎</span><span><b>Perfil</b><small class="muted" style="display:block">Estadísticas y ajustes</small></span></button>
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
      state.trade=freshTrade();state.trade.onlineId=m.tradeId;state.trade.partnerId=m.from?.socketId||"";state.trade.partnerName=m.from?.name||"Jugador";state.trade.status=state.trade.partnerName+" quiere intercambiar contigo.";go("trade");
    });
    socket.on("trade:waiting",m=>{state.trade.onlineId=m.tradeId;state.trade.partnerId=m.to;state.trade.status="Solicitud aceptada por el servidor. Enviando oferta…";socket.emit("trade:offer",{tradeId:m.tradeId,cards:state.trade.mine.slice(),gold:state.trade.ownGold||0});if(state.view==="trade")renderView()});
    socket.on("trade:offer",m=>{if(m.tradeId!==state.trade.onlineId)return;state.trade.theirs=(m.cards||[]).map(Number).filter(id=>card(id));state.trade.theirGold=Math.max(0,Number(m.gold)||0);state.trade.ready=true;state.trade.status="Contraoferta recibida.";if(state.view==="trade")renderView()});
    socket.on("trade:accepted",m=>{if(m.tradeId===state.trade.onlineId){state.trade.status="El otro jugador ha aceptado. Falta la segunda confirmación.";if(state.view==="trade")renderView()}});
    socket.on("trade:settled",m=>{if(m.tradeId===state.trade.onlineId&&m.profile)handleSettledTrade(m.profile)});
    socket.on("trade:error",m=>{if(m.tradeId===state.trade.onlineId){state.trade.ready=false;state.trade.status="Error: "+(m.message||"No se pudo completar el intercambio.");toast(state.trade.status,"bad");if(state.view==="trade")renderView()}});
    socket.on("trade:cancelled",m=>{if(m.tradeId===state.trade.onlineId){resetTrade();toast("El intercambio fue cancelado.","bad");if(state.view==="trade")renderView()}});
  };
  if(window.io){startSocket();return}
  const sc=document.createElement("script");sc.src=SERVER_URL+"/socket.io/socket.io.js";sc.async=true;sc.onload=startSocket;sc.onerror=()=>{state.connecting=false;toast("Servidor multijugador no disponible. Puedes seguir en modo offline.","bad")};document.head.appendChild(sc);
}

function createMatch(){
  const start=$("matchStart")?.value||"normal";
  if(!state.connected){toast("No hay conexión con el servidor.","bad");return}
  if(!deckValid()){toast("Tu mazo debe tener exactamente "+DECK_SIZE+" cartas válidas para jugar.","bad");return}
  state.socket.emit("match:create",{deckSize:DECK_SIZE,start});playSound("click");
}
function joinMatch(id){
  if(!state.connected)return;
  if(!deckValid()){toast("Necesitas un mazo válido de exactamente "+DECK_SIZE+" cartas para entrar.","bad");return}
  state.socket.emit("match:join",{id});
}
function cancelMatch(id){if(state.connected)state.socket.emit("match:cancel",{id})}

function wireInstance(inst){
  const base=card(inst.cardId);if(!base)return null;
  return{...base,uid:inst.uid,exhausted:!!inst.exhausted,selected:!!inst.selected,defBonus:Number(inst.defBonus)||0,def:(base.def||0)+(Number(inst.defBonus)||0)}
}
function applyOnlineSnapshot(s){
  if(!s)return;
  const previous=state.duel&&state.duel.online&&state.duel.matchId===s.matchId?state.duel:null;
  const playerBoard=(s.playerBoard||[]).map(wireInstance).filter(Boolean);
  const ownBoardUids=new Set(playerBoard.map(c=>c.uid));
  const enemyBoard=(s.enemyBoard||[]).map(wireInstance).filter(c=>c&&!ownBoardUids.has(c.uid));
  state.duel={online:true,matchId:s.matchId,myTurn:!!s.myTurn,opponent:s.opponent?.name||"Rival",turn:Number(s.turn)||1,phase:Number(s.phase)||0,
    playerHp:Number(s.playerHp)||0,enemyHp:Number(s.enemyHp)||0,power:Number(s.power)||0,maxPower:Number(s.maxPower)||0,powerPlayed:!!s.powerPlayed,
    enemyPower:Number(s.enemyPower)||0,enemyMaxPower:Number(s.enemyMaxPower)||0,playerDeckCount:Number(s.playerDeckCount)||0,enemyDeckCount:Number(s.enemyDeckCount)||0,
    playerHand:(s.playerHand||[]).map(wireInstance).filter(Boolean),enemyHandCount:Number(s.enemyHandCount)||0,
    playerBoard,enemyBoard,
    playerPowers:(s.playerPowers||[]).map(wireInstance).filter(Boolean),enemyPowers:(s.enemyPowers||[]).map(wireInstance).filter(Boolean),
    gameOver:!!s.gameOver,result:s.result||null,won:s.won,defending:!!s.defending,attackDeclared:!!s.attackDeclared,blockAssignments:s.blockAssignments||{},
    damageDealt:Number(s.damageDealt)||0,log:s.log||[],resultApplied:previous?.resultApplied||false
  };
  if(state.view!=="duel")state.view="duel";updateChrome();renderView();
}

function renderDuel(){
  const d=state.duel;if(!d)return'<div class="page"><div class="empty">No hay duelo activo.</div></div>';
  const phase=PHASES[d.phase]||PHASES[0];
  return `<div class="duel-page">
    <div class="duel-top">
      <div class="fighter"><div class="avatar">${initial(state.profile.name)}</div><div><b>${esc(state.profile.name)}</b><div class="muted">PV ${d.playerHp} · Poder ${d.power}/${d.maxPower}</div><div class="hpbar"><span style="width:${clamp(d.playerHp/30*100,0,100)}%"></span></div></div></div>
      <div style="text-align:center"><div class="kicker">Turno ${d.turn}</div><b>${d.online?(d.defending?"Defiende el ataque":d.attackDeclared?"Esperando defensa":d.myTurn?"Tu turno":"Turno rival"):(d.aiActing?"Turno del Guardián":"Entrenamiento")}</b></div>
      <div class="fighter enemy"><div><b>${esc(d.opponent||"Guardián")}</b><div class="muted">PV ${d.enemyHp} · Poder ${d.enemyPower||0}/${d.enemyMaxPower||0}</div><div class="hpbar"><span style="width:${clamp(d.enemyHp/30*100,0,100)}%"></span></div></div><div class="avatar">${initial(d.opponent||"G")}</div></div>
    </div>
    <div class="phase-track">${PHASES.map((p,i)=>`<div class="phase-step ${i===d.phase?"active":""}">${i+1}. ${p}</div>`).join("")}</div>
    <div class="board">
      <section class="board-zone"><div class="zone-title"><span>Rival · ${d.enemyHandCount??d.enemyHand?.length??0} cartas en mano</span><span>Mazo ${d.enemyDeckCount??d.enemyDeck?.length??0}</span></div><div class="hidden-cards-strip">${hiddenCardBacks(d.enemyHandCount??d.enemyHand?.length??0)}${deckBack(d.enemyDeckCount??d.enemyDeck?.length??0,"Mazo rival")}</div>${powerLane(d.enemyPowers||[],"Poder rival","enemyPower")}<div class="battle-row">${battleCards(d.enemyBoard||[],"enemy")}</div></section>
      <section class="board-zone"><div class="zone-title"><span>Tu campo</span><span>${phase}</span></div>${powerLane(d.playerPowers||[],"Tu Poder","playerPower")}<div class="battle-row">${battleCards(d.playerBoard||[],"player")}</div></section>
      <div class="duel-bottom">
        <section class="board-zone hand-zone"><div class="zone-title"><span>Tu mano</span><span>Mazo ${d.playerDeckCount??d.playerDeck?.length??0}</span></div><div class="player-hand-strip"><div class="battle-row">${battleCards(d.playerHand||[],"hand")}</div>${deckBack(d.playerDeckCount??d.playerDeck?.length??0,"Tu mazo")}</div><div class="duel-controls">${duelControls(d)}</div></section>
        <details class="duel-log-drawer"><summary><span>Registro de combate</span><span class="duel-log-phase">${phase}</span></summary><div class="duel-log">${(d.log||[]).slice(-30).map(x=>`<div>${esc(x)}</div>`).join("")||'<div>El duelo ha comenzado.</div>'}</div></details>
      </div>
    </div>
  </div>`;
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
  const cards=list||[],total=powerTotal(cards),d=state.duel;
  return `<div class="power-lane"><span class="power-lane-label">${esc(label)} · ${total}</span><div class="power-lane-cards">${cards.length?cards.map(c=>{
    const clickable=zone==="playerPower"&&d&&!d.gameOver&&d.phase===2&&(!d.online||d.myTurn)&&!d.defending&&!d.attackDeclared&&!c.exhausted;
    return `<div class="power-mini ${clickable?"clickable":""} ${c.exhausted?"exhausted":""}" ${clickable?'data-action="duelPower" data-uid="'+c.uid+'"':""} style="background-image:url('${cardImage(c)}')" title="${esc(c.name)} · +${powerValue(c)} Poder"><span>+${powerValue(c)}</span></div>`;
  }).join(""):'<span class="power-empty">Sin Poder en juego</span>'}</div></div>`;
}
function battleCards(list,zone){
  if(!list?.length)return'<div class="battle-empty" aria-hidden="true"></div>';
  return list.map(c=>{
    const clickable=duelCardClickable(c,zone);
    const label=c.powerCard
      ? \`${c.name} · Poder +${powerValue(c)}\`
      : \`${c.name} · Ataque ${c.atk} · Defensa ${c.def}\`;
    return \`<article class="battle-card ${clickable?"clickable":""} ${c.selected?"selected":""} ${c.exhausted?"exhausted":""}" ${clickable?'data-action="duelCard" data-zone="'+zone+'" data-uid="'+c.uid+'"':""} data-detail="${c.id}" title="${esc(label)}" aria-label="${esc(label)}"><div class="battle-art" style="background-image:url('${cardImage(c)}')"></div></article>\`;
  }).join("");
}
function duelCardClickable(c,zone){
  const d=state.duel;if(!d||d.gameOver||(!d.online&&d.aiActing))return false;
  if(d.online&&(d.defending||d.attackDeclared))return false;
  if(d.online&&!d.myTurn)return false;
  if(zone==="hand")return(d.phase===2&&c.powerCard&&!d.powerPlayed)||(d.phase===3&&!c.powerCard&&!c.abilityCard&&c.cost<=d.power)||(d.phase===4&&c.abilityCard&&c.cost<=d.power);
  if(zone==="player")return d.phase===5&&!c.exhausted;
  return false;
}
function duelControls(d){
  if(d.gameOver){const label=d.result==="draw"?"Empate":d.result==="loss"||d.won===false?"Derrota":"Victoria";return`<div class="turn-wait">${label} · <button class="btn small" data-action="leaveDuel">Volver al salón</button></div>`};
  if(d.online&&d.defending)return renderDefenseControls(d);
  if(d.online&&d.attackDeclared)return'<div class="turn-wait">El rival está asignando defensores…</div>';
  if(!d.online&&d.aiActing)return'<div class="turn-wait">Turno del Guardián… Tus atacantes permanecen girados y no pueden defender.</div>';
  if(d.online&&!d.myTurn)return'<div class="turn-wait">Esperando la acción del rival…</div>';
  return`<button class="btn danger" data-action="${d.online?"concede":"restartTraining"}">${d.online?"Retirarse":"Reiniciar"}</button><span style="flex:1"></span><button class="btn primary" data-action="nextPhase">${d.phase===5?"Declarar ataque":"Siguiente fase"}</button>`;
}
function renderDefenseControls(d){
  const attackers=(d.enemyBoard||[]).filter(c=>c.selected);
  const assigned=new Set(Object.values(d.blockAssignments||{}));
  const defenders=(d.playerBoard||[]).filter(c=>!c.exhausted||assigned.has(c.uid));
  if(!attackers.length)return'<div class="turn-wait">El ataque rival se está resolviendo…</div>';
  return`<div style="width:100%"><div class="turn-wait" style="margin-bottom:8px">Asigna un defensor a cada atacante o déjalo pasar.</div>
    <div class="grid" style="gap:6px">${attackers.map(a=>`<label class="quick-row"><span><b>${esc(a.name)}</b><small class="muted" style="display:block">ATQ ${a.atk}</small></span><select class="select" data-block-attacker="${a.uid}"><option value="">Sin bloquear</option>${defenders.map(dfc=>`<option value="${dfc.uid}" ${d.blockAssignments?.[a.uid]===dfc.uid?"selected":""}>${esc(dfc.name)} · DEF ${dfc.def}</option>`).join("")}</select></label>`).join("")}</div>
    <div class="actions" style="margin-top:8px"><button class="btn danger" data-action="concede">Retirarse</button><span style="flex:1"></span><button class="btn primary" data-action="resolveDefense">Resolver defensa</button></div>
  </div>`;
}

function training(){
  const size=DECK_SIZE;
  const playerIds=deckValid()?state.profile.deck.slice():[];
  if(playerIds.length!==DECK_SIZE){toast("Tu mazo debe tener exactamente "+DECK_SIZE+" cartas válidas para entrenar.","bad");go("deck");return}
  const lvl=playerLevel();
  const powers=state.catalog.filter(c=>c.powerCard&&c.level<=lvl);
  const creatures=state.catalog.filter(c=>!c.powerCard&&!c.abilityCard&&c.level<=lvl);
  const abilities=state.catalog.filter(c=>c.abilityCard&&c.level<=lvl);
  const enemy=[],powerTarget=Math.ceil(size*.30);
  while(enemy.length<size){
    let pool=enemy.length<powerTarget?powers:(creatures.length?creatures:abilities);
    if(!pool.length)pool=powers;
    enemy.push(pool[Math.floor(Math.random()*pool.length)].id);
  }
  state.duel={online:false,opponent:"Guardián Nv "+lvl,turn:1,phase:0,playerHp:30,enemyHp:30,power:0,maxPower:0,enemyPower:0,enemyMaxPower:0,
    playerDeck:shuffle(playerIds).map(makeInst),enemyDeck:shuffle(enemy).map(makeInst),playerHand:[],enemyHand:[],playerBoard:[],enemyBoard:[],playerPowers:[],enemyPowers:[],
    playerPowerPlayed:false,enemyPowerPlayed:false,aiActing:false,gameOver:false,won:null,damageDealt:0,rewardKey:"training:"+uid(),rewardPending:false,log:["Entrenamiento iniciado con 7 cartas por jugador."]};
  drawLocal("player",7);drawLocal("enemy",7);state.view="duel";updateChrome();playSound("turn");renderView();
}
function makeInst(id){const c=card(id);return c?{...c,uid:uid(),exhausted:false,selected:false}:null}
function drawLocal(side,n=1){
  const d=state.duel;for(let i=0;i<n;i++){const deck=d[side+"Deck"];if(deck.length)d[side+"Hand"].push(deck.pop());else{d.gameOver=true;d.won=side==="enemy";d.log.push(side==="player"?"Te has quedado sin cartas.":"El rival se ha quedado sin cartas.")}}
}
function localPlay(uid){
  const d=state.duel,i=d.playerHand.findIndex(c=>c.uid===uid);if(i<0)return;const c=d.playerHand[i];
  if(d.phase===2&&c.powerCard&&!d.playerPowerPlayed){d.playerHand.splice(i,1);c.exhausted=false;d.playerPowers.push(c);d.maxPower=powerTotal(d.playerPowers);d.playerPowerPlayed=true;d.log.push("Pones "+c.name+" en tu zona de Poder.");playSound("power")}
  else if(d.phase===3&&!c.powerCard&&!c.abilityCard&&c.cost<=d.power){d.power-=c.cost;d.playerHand.splice(i,1);d.playerBoard.push(c);d.log.push("Invocas "+c.name+".");playSound("summon")}
  else if(d.phase===4&&c.abilityCard&&c.cost<=d.power){d.power-=c.cost;d.playerHand.splice(i,1);resolveLocalAbility(c,"player")}
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
function tapLocalPower(uid){
  const d=state.duel,c=d?.playerPowers?.find(x=>x.uid===uid);
  if(!d||d.phase!==2||!c||c.exhausted)return;
  c.exhausted=true;
  d.power+=powerValue(c);
  d.maxPower=powerTotal(d.playerPowers);
  d.log.push("Giras "+c.name+" y generas +"+powerValue(c)+" Poder.");
  playSound("power");renderView();
}
function toggleLocalAttack(uid){const c=state.duel.playerBoard.find(x=>x.uid===uid);if(c&&!c.exhausted){c.selected=!c.selected;renderView()}}
function nextLocalPhase(){
  const d=state.duel;if(d.gameOver||d.aiActing)return;
  if(d.phase===5){
    resolveLocalAttack();
    if(checkLocalEnd())return renderView();

    d.aiActing=true;
    d.log.push("Tu ataque ha terminado. Ahora juega el Guardián.");
    renderView();

    const duelRef=d;
    window.setTimeout(()=>{
      if(state.duel!==duelRef||d.gameOver)return;
      enemyTurn();
      if(checkLocalEnd()){d.aiActing=false;renderView();return}
      d.log.push("El turno del Guardián ha terminado.");
      renderView();

      window.setTimeout(()=>{
        if(state.duel!==duelRef||d.gameOver)return;
        d.turn++;
        d.phase=0;
        d.playerBoard.forEach(c=>{c.exhausted=false;c.selected=false});
        d.playerPowers.forEach(c=>{c.exhausted=false});
        d.playerPowerPlayed=false;
        d.maxPower=powerTotal(d.playerPowers);
        d.power=0;
        d.aiActing=false;
        d.log.push("Comienza tu turno "+d.turn+". Tus cartas se enderezan.");
        playSound("turn");
        renderView();
      },1200);
    },900);
    return;
  }
  d.phase++;
  if(d.phase===1){drawLocal("player",1);playSound("draw");if(checkLocalEnd())return renderView()}
  if(d.phase===2){d.maxPower=powerTotal(d.playerPowers);d.power=0}
  renderView();
}
function resolveLocalAttack(){
  const d=state.duel,atk=d.playerBoard.filter(c=>c.selected&&!c.exhausted),blocks=d.enemyBoard.filter(c=>!c.exhausted).sort((a,b)=>b.def-a.def);
  atk.forEach((a,i)=>{
    a.exhausted=true;
    const b=blocks[i];
    if(b&&d.enemyBoard.includes(b)){
      b.exhausted=true;
      d.log.push(a.name+" ("+a.atk+" ATQ) ataca la defensa "+b.def+" de "+b.name+".");
      if(a.atk>=b.def){d.enemyBoard=d.enemyBoard.filter(x=>x.uid!==b.uid);d.log.push(b.name+" es destruida.")}
      else{d.playerBoard=d.playerBoard.filter(x=>x.uid!==a.uid);d.log.push(a.name+" no supera la DEF y es destruida.")}
    } else {
      d.enemyHp-=a.atk;d.damageDealt+=a.atk;d.log.push(a.name+" causa "+a.atk+" PV.");playSound("hit");
    }
    const survivor=d.playerBoard.find(x=>x.uid===a.uid);if(survivor)survivor.selected=false;
  });
}
function enemyTurn(){
  const d=state.duel;
  d.enemyBoard.forEach(c=>c.exhausted=false);
  d.enemyPowers.forEach(c=>c.exhausted=false);
  d.enemyPowerPlayed=false;
  drawLocal("enemy",1);
  if(d.gameOver)return;

  const p=d.enemyHand.find(c=>c.powerCard);
  if(p){
    d.enemyHand=d.enemyHand.filter(x=>x.uid!==p.uid);
    p.exhausted=false;
    d.enemyPowers.push(p);
    d.log.push("El Guardián pone "+p.name+" en su zona de Poder.");
  }

  d.enemyPowers.forEach(c=>c.exhausted=true);
  d.enemyMaxPower=powerTotal(d.enemyPowers);
  d.enemyPower=d.enemyMaxPower;

  const ability=d.enemyHand.find(c=>c.abilityCard&&c.cost<=d.enemyPower);
  if(ability){
    d.enemyPower-=ability.cost;
    d.enemyHand=d.enemyHand.filter(x=>x.uid!==ability.uid);
    d.log.push("El Guardián usa "+ability.name+".");
    resolveLocalAbility(ability,"enemy");
  }

  let safe=20;
  while(safe--){
    const opts=d.enemyHand.filter(c=>!c.powerCard&&!c.abilityCard&&c.cost<=d.enemyPower);
    if(!opts.length)break;
    opts.sort((a,b)=>(b.atk+b.def)-(a.atk+a.def));
    const unit=opts[0];
    d.enemyPower-=unit.cost;
    d.enemyHand=d.enemyHand.filter(x=>x.uid!==unit.uid);
    d.enemyBoard.push(unit);
    d.log.push("El Guardián invoca "+unit.name+".");
  }

  const attackers=d.enemyBoard.filter(c=>!c.exhausted);
  const blocks=d.playerBoard.filter(c=>!c.exhausted).sort((a,b)=>b.def-a.def);
  attackers.forEach((a,i)=>{
    a.exhausted=true;
    const b=blocks[i];
    if(b&&d.playerBoard.includes(b)){
      b.exhausted=true;
      d.log.push(a.name+" ("+a.atk+" ATQ) ataca la defensa "+b.def+" de "+b.name+".");
      if(a.atk>=b.def){
        d.playerBoard=d.playerBoard.filter(x=>x.uid!==b.uid);
        d.log.push(b.name+" es destruida.");
      }else{
        d.enemyBoard=d.enemyBoard.filter(x=>x.uid!==a.uid);
        d.log.push(a.name+" no supera la DEF y es destruida.");
      }
    }else{
      d.playerHp-=a.atk;
      d.log.push(a.name+" del Guardián causa "+a.atk+" PV.");
    }
  });
  if(attackers.length)d.log.push("El Guardián ha declarado ataque con "+attackers.length+" criatura(s).");
}
async function awardTraining(d){
  const payload={rewardKey:d.rewardKey,win:!!d.won,damage:Math.min(30,Math.max(0,d.damageDealt||0)),mode:"training"};
  const oldLevel=playerLevel(),r=await api("award_result",payload,true);
  if(!r.ok){
    if(r.network){queueReward(payload);toast("La recompensa de XP se sincronizará cuando vuelva la conexión.","bad")}
    else toast(authErrorMessage(r.error),"bad");
    return;
  }
  applyProfile(r.profile);updateChrome();
  if(playerLevel()>oldLevel){playSound("win");toast("¡Subes a Nivel "+playerLevel()+"! Tus próximos sobres ya pueden incluir cartas de ese nivel.","good")}
  else toast("+"+r.xpAwarded+" XP"+(r.goldAwarded?" · +"+r.goldAwarded+" oro":""),"good");
  if(state.view==="duel")renderView();
}
function checkLocalEnd(){
  const d=state.duel;if(d.enemyHp<=0||d.playerHp<=0||d.gameOver){
    if(!d.gameOver){d.gameOver=true;d.won=d.enemyHp<=0;d.log.push(d.won?"Victoria.":"Derrota.")}
    if(!d.resultApplied){d.resultApplied=true;if(d.won)playSound("win");void awardTraining(d)}
    return true
  }
  return false
}

function duelPower(uid){
  const d=state.duel;if(!d||d.gameOver||(!d.online&&d.aiActing)||d.phase!==2)return;
  if(d.online){if(d.myTurn)state.socket.emit("duel:action",{matchId:d.matchId,type:"tapPower",uid});return}
  tapLocalPower(uid);
}
function duelCard(zone,uid){
  const d=state.duel;if(!d||(!d.online&&d.aiActing))return;if(d.online){if(!d.myTurn)return;if(zone==="hand")state.socket.emit("duel:action",{matchId:d.matchId,type:"play",uid});else if(zone==="player")state.socket.emit("duel:action",{matchId:d.matchId,type:"toggleAttack",uid});return}
  if(zone==="hand")localPlay(uid);else if(zone==="player")toggleLocalAttack(uid);
}
function nextPhase(){const d=state.duel;if(!d||(!d.online&&d.aiActing))return;if(d.online){if(d.myTurn)state.socket.emit("duel:action",{matchId:d.matchId,type:"nextPhase"})}else nextLocalPhase()}
function concede(){const d=state.duel;if(d?.online&&state.connected)state.socket.emit("duel:action",{matchId:d.matchId,type:"concede"})}
function leaveDuel(){state.duel=null;go("home")}

document.addEventListener("click",e=>{
  const authTab=e.target.closest("[data-auth-mode]");
  if(authTab){setAuthMode(authTab.dataset.authMode);return}
  const el=e.target.closest("[data-action]");if(!el)return;
  const a=el.dataset.action;
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
  else if(a==="tradeAdd")tradeAdd(Number(el.dataset.id));
  else if(a==="tradeRemove")tradeRemove(Number(el.dataset.index));
  else if(a==="tradePropose")proposeTrade();
  else if(a==="tradeAccept")acceptTrade();
  else if(a==="tradeCancel")cancelTrade();
  else if(a==="duelCard")duelCard(el.dataset.zone,el.dataset.uid);
  else if(a==="duelPower")duelPower(el.dataset.uid);
  else if(a==="nextPhase")nextPhase();
  else if(a==="concede")concede();
  else if(a==="resolveDefense"){const d=state.duel;if(d?.online&&d.defending&&state.connected)state.socket.emit("duel:action",{matchId:d.matchId,type:"resolveDefense"})}
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
  else if(e.target.id==="packLevelSelect"){void loadPackOdds(Number(e.target.value)||1)}
  else if(e.target.id==="soundToggle"){state.sound=e.target.checked;localStorage.setItem("rolplay.sound",state.sound?"on":"off");saveProfile();toast(state.sound?"Sonidos activados.":"Sonidos desactivados.")}
  else if(e.target.matches("[data-block-attacker]")){
    const d=state.duel;if(d?.online&&d.defending&&state.connected)state.socket.emit("duel:action",{matchId:d.matchId,type:"assignBlock",attackerUid:e.target.dataset.blockAttacker,defenderUid:e.target.value||""});
  }
});
document.addEventListener("submit",e=>{
  if(e.target.id==="loginForm"){e.preventDefault();authenticateForm()}
  if(e.target.id==="chatForm"){e.preventDefault();const input=$("chatInput"),text=input?.value.trim();if(!text)return;if(state.connected)state.socket.emit("chat:send",{text});else{state.chat.push({from:state.profile.name,text});renderView()}}
});
$("logoutBtn")?.addEventListener("click",logout);

boot();
})();