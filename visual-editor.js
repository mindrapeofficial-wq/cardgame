
(function(){
"use strict";
var STORAGE_KEY="arcanum.visualDesign.v1";
var MODE_KEY="arcanum.visualEditor.mode";
var rules={};
var selected=null;
var hover=null;
var scope="class";
var mode="select";
var root=null;
var styleEl=null;
var badge=null;

function loadRules(){
  try{rules=JSON.parse(localStorage.getItem(STORAGE_KEY)||"{}")||{}}catch(e){rules={}}
}
function saveRules(){
  localStorage.setItem(STORAGE_KEY,JSON.stringify(rules));
}
function cssText(){
  return Object.keys(rules).map(function(selector){
    var obj=rules[selector]||{};
    var body=Object.keys(obj).filter(function(k){return obj[k]!==""&&obj[k]!=null}).map(function(k){
      return k+":"+obj[k]+" !important";
    }).join(";");
    return body?selector+"{"+body+"}":"";
  }).filter(Boolean).join("\n");
}
function applyRules(){
  if(!styleEl){
    styleEl=document.createElement("style");
    styleEl.id="ve-user-styles";
    document.head.appendChild(styleEl);
  }
  styleEl.textContent=cssText();
}
function safeClass(el){
  if(!el||!el.classList)return"";
  var ignored=/^(ve-|active$|hidden$|selected$|good$|bad$|online$|clickable$|exhausted$|primary$|danger$|ghost$|small$|icon$|muted$|faint$|gold$)/;
  return Array.from(el.classList).find(function(c){return !ignored.test(c)})||"";
}
function cssEscape(v){
  if(window.CSS&&CSS.escape)return CSS.escape(v);
  return String(v).replace(/[^a-zA-Z0-9_-]/g,function(ch){return"\\"+ch});
}
function uniquePath(el){
  if(!el||el===document.body)return"body";
  if(el.id)return"#"+cssEscape(el.id);
  var parts=[];
  var node=el;
  while(node&&node.nodeType===1&&node!==document.body&&parts.length<5){
    var tag=node.tagName.toLowerCase();
    var cls=safeClass(node);
    var part=tag+(cls?"."+cssEscape(cls):"");
    var parent=node.parentElement;
    if(parent){
      var peers=Array.from(parent.children).filter(function(x){
        return x.tagName===node.tagName&&(!cls||x.classList.contains(cls));
      });
      if(peers.length>1)part+=":nth-of-type("+(Array.from(parent.children).filter(function(x){return x.tagName===node.tagName}).indexOf(node)+1)+")";
    }
    parts.unshift(part);
    if(parent&&parent.id){parts.unshift("#"+cssEscape(parent.id));break}
    node=parent;
  }
  return parts.join(" > ");
}
function classSelector(el){
  if(!el)return"";
  if(el.id)return"#"+cssEscape(el.id);
  var cls=safeClass(el);
  if(cls)return"."+cssEscape(cls);
  return uniquePath(el);
}
function selectorFor(el){
  return scope==="single"?uniquePath(el):classSelector(el);
}
function getRule(selector){
  if(!rules[selector])rules[selector]={};
  return rules[selector];
}
function readProp(prop){
  if(!selected)return"";
  var selector=selectorFor(selected);
  if(rules[selector]&&rules[selector][prop]!=null)return rules[selector][prop];
  return getComputedStyle(selected).getPropertyValue(prop).trim();
}
function setProp(prop,value){
  if(!selected)return;
  var selector=selectorFor(selected);
  var r=getRule(selector);
  value=String(value||"").trim();
  if(value==="")delete r[prop];else r[prop]=value;
  if(!Object.keys(r).length)delete rules[selector];
  applyRules();saveRules();refreshPanel();
}
function normalizeSize(v){
  v=String(v||"").trim();
  if(!v)return"";
  if(/^-?\d+(\.\d+)?$/.test(v))return v+"px";
  return v;
}
function select(el){
  if(selected)selected.classList.remove("ve-target");
  selected=el;
  if(selected)selected.classList.add("ve-target");
  refreshPanel();
}
function refreshPanel(){
  if(!root)return;
  var cur=root.querySelector("[data-ve-current]");
  if(cur)cur.textContent=selected?selectorFor(selected):"Haz clic en un elemento de la página";
  root.querySelectorAll("[data-ve-prop]").forEach(function(input){
    var prop=input.getAttribute("data-ve-prop");
    if(!selected){input.value="";return}
    var value=readProp(prop);
    if(input.type==="color"){
      var rgb=getComputedStyle(selected).getPropertyValue(prop).trim();
      input.value=toHex(rgb)||"#111111";
    }else{
      input.value=value;
    }
  });
  var scopeEl=root.querySelector("[data-ve-scope]");
  if(scopeEl)scopeEl.value=scope;
}
function toHex(color){
  if(!color)return"";
  if(/^#[0-9a-f]{6}$/i.test(color))return color;
  var m=color.match(/rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/i);
  if(!m)return"";
  return"#"+[m[1],m[2],m[3]].map(function(n){return Number(n).toString(16).padStart(2,"0")}).join("");
}
function activate(){
  document.body.classList.add("ve-enabled","ve-select-mode");
  mode="select";
  localStorage.setItem(MODE_KEY,"on");
  if(root)root.setAttribute("aria-hidden","false");
  updateModeButtons();
}
function deactivate(){
  document.body.classList.remove("ve-enabled","ve-select-mode");
  mode="interact";
  localStorage.setItem(MODE_KEY,"off");
  select(null);
  clearHover();
  updateModeButtons();
}
function clearHover(){
  if(hover)hover.classList.remove("ve-hover");
  hover=null;
  if(badge)badge.remove();
  badge=null;
}
function updateModeButtons(){
  if(!root)return;
  root.querySelectorAll("[data-ve-mode]").forEach(function(b){
    b.classList.toggle("active",b.getAttribute("data-ve-mode")===mode);
  });
  document.body.classList.toggle("ve-select-mode",mode==="select");
}
function exportCss(){
  var text="/* ARCANUM visual overrides */\n"+cssText()+"\n";
  var blob=new Blob([text],{type:"text/css"});
  var a=document.createElement("a");
  a.href=URL.createObjectURL(blob);
  a.download="arcanum-design-overrides.css";
  document.body.appendChild(a);a.click();a.remove();
  setTimeout(function(){URL.revokeObjectURL(a.href)},1000);
}
function exportJson(){
  var blob=new Blob([JSON.stringify(rules,null,2)],{type:"application/json"});
  var a=document.createElement("a");
  a.href=URL.createObjectURL(blob);
  a.download="arcanum-visual-design.json";
  document.body.appendChild(a);a.click();a.remove();
  setTimeout(function(){URL.revokeObjectURL(a.href)},1000);
}
function resetAll(){
  if(!confirm("¿Restablecer todos los cambios visuales guardados en este navegador?"))return;
  rules={};saveRules();applyRules();refreshPanel();
}
function resetSelection(){
  if(!selected)return;
  delete rules[selectorFor(selected)];
  saveRules();applyRules();refreshPanel();
}
function build(){
  document.body.classList.add("ve-available");
  root=document.createElement("aside");
  root.id="ve-root";
  root.setAttribute("aria-hidden","true");
  root.innerHTML=
    '<div class="ve-head"><strong>ARCANUM · Editor visual</strong><small>LIVE</small></div>'+
    '<div class="ve-section">'+
      '<span class="ve-label">Modo</span>'+
      '<div class="ve-row"><button class="ve-btn active" data-ve-mode="select">Seleccionar</button><button class="ve-btn" data-ve-mode="interact">Interactuar</button></div>'+
      '<div class="ve-help">Seleccionar bloquea los clics del juego para editar. Interactuar te deja navegar sin cerrar el editor.</div>'+
    '</div>'+
    '<div class="ve-section">'+
      '<span class="ve-label">Elemento</span>'+
      '<div class="ve-current" data-ve-current>Haz clic en un elemento de la página</div>'+
      '<div class="ve-row"><select class="ve-select" data-ve-scope><option value="class">Todos los iguales</option><option value="single">Solo este</option></select><button class="ve-btn danger" data-ve-reset-one>Limpiar elemento</button></div>'+
    '</div>'+
    '<div class="ve-section">'+
      '<span class="ve-label">Tamaño y espacio</span>'+
      '<div class="ve-row"><input class="ve-input" data-ve-prop="width" placeholder="Ancho: auto / 320px"><input class="ve-input" data-ve-prop="max-width" placeholder="Ancho máx."></div>'+
      '<div class="ve-row"><input class="ve-input" data-ve-prop="min-height" placeholder="Alto mín."><input class="ve-input" data-ve-prop="gap" placeholder="Separación"></div>'+
      '<div class="ve-row"><input class="ve-input" data-ve-prop="padding" placeholder="Padding"><input class="ve-input" data-ve-prop="margin" placeholder="Margin"></div>'+
      '<div class="ve-row"><input class="ve-input" data-ve-prop="border-radius" placeholder="Radio borde"><input class="ve-input" data-ve-prop="font-size" placeholder="Texto"></div>'+
    '</div>'+
    '<div class="ve-section">'+
      '<span class="ve-label">Color</span>'+
      '<div class="ve-row"><label class="ve-color"><input type="color" data-ve-color="background-color"><span>Fondo</span></label><label class="ve-color"><input type="color" data-ve-color="color"><span>Texto</span></label></div>'+
      '<div class="ve-row"><label class="ve-color"><input type="color" data-ve-color="border-color"><span>Borde</span></label><input class="ve-input" data-ve-prop="opacity" placeholder="Opacidad 0-1"></div>'+
    '</div>'+
    '<div class="ve-section">'+
      '<span class="ve-label">Posición fina</span>'+
      '<div class="ve-row"><input class="ve-input" data-ve-prop="left" placeholder="Izq. ej. 10px"><input class="ve-input" data-ve-prop="top" placeholder="Arriba ej. -5px"></div>'+
      '<div class="ve-row"><select class="ve-select" data-ve-prop="position"><option value="">Posición actual</option><option value="relative">relative</option><option value="absolute">absolute</option><option value="sticky">sticky</option><option value="fixed">fixed</option></select><input class="ve-input" data-ve-prop="z-index" placeholder="z-index"></div>'+
    '</div>'+
    '<div class="ve-section">'+
      '<span class="ve-label">Guardar / exportar</span>'+
      '<div class="ve-actions"><button class="ve-btn primary" data-ve-save>Guardar</button><button class="ve-btn" data-ve-export-css>Exportar CSS</button><button class="ve-btn" data-ve-export-json>Exportar diseño</button><button class="ve-btn danger" data-ve-reset>Restablecer todo</button></div>'+
      '<div class="ve-help">Guardar conserva los cambios en este navegador. Exportar diseño crea un archivo que puedes pasarme para convertirlo en el diseño oficial del juego.</div>'+
    '</div>'+
    '<div class="ve-section"><button class="ve-btn" data-ve-close>Cerrar editor</button><div class="ve-help">Atajo: Ctrl + Shift + D</div></div>';
  document.body.appendChild(root);

  var fab=document.createElement("button");
  fab.className="ve-fab";
  fab.textContent="✦ Editor visual";
  fab.addEventListener("click",activate);
  document.body.appendChild(fab);

  root.addEventListener("click",function(e){
    e.stopPropagation();
    var m=e.target.closest("[data-ve-mode]");
    if(m){mode=m.getAttribute("data-ve-mode");updateModeButtons();return}
    if(e.target.closest("[data-ve-save]")){saveRules();applyRules();return}
    if(e.target.closest("[data-ve-export-css]")){exportCss();return}
    if(e.target.closest("[data-ve-export-json]")){exportJson();return}
    if(e.target.closest("[data-ve-reset]")){resetAll();return}
    if(e.target.closest("[data-ve-reset-one]")){resetSelection();return}
    if(e.target.closest("[data-ve-close]")){deactivate();return}
  });
  root.addEventListener("change",function(e){
    e.stopPropagation();
    if(e.target.matches("[data-ve-scope]")){scope=e.target.value;refreshPanel();return}
    var cp=e.target.getAttribute("data-ve-color");
    if(cp){setProp(cp,e.target.value);return}
    var prop=e.target.getAttribute("data-ve-prop");
    if(prop)setProp(prop,normalizeSize(e.target.value));
  });
  root.addEventListener("keydown",function(e){
    if(e.key==="Enter"&&e.target.matches("[data-ve-prop]")){
      e.preventDefault();e.target.blur();
    }
  });

  if(location.search.indexOf("design=1")>=0||localStorage.getItem(MODE_KEY)==="on")activate();
}
document.addEventListener("pointerover",function(e){
  if(!document.body.classList.contains("ve-enabled")||mode!=="select"||!root)return;
  if(root.contains(e.target)||e.target.classList.contains("ve-fab"))return;
  if(hover&&hover!==e.target)hover.classList.remove("ve-hover");
  hover=e.target;hover.classList.add("ve-hover");
  if(!badge){badge=document.createElement("div");badge.className="ve-badge";document.body.appendChild(badge)}
  badge.textContent=classSelector(hover);
  var r=hover.getBoundingClientRect();
  badge.style.left=Math.max(6,Math.min(innerWidth-270,r.left))+"px";
  badge.style.top=Math.max(6,r.top-27)+"px";
},true);
document.addEventListener("pointerout",function(e){
  if(mode!=="select"||!hover)return;
  if(e.target===hover){hover.classList.remove("ve-hover");hover=null;if(badge){badge.remove();badge=null}}
},true);
document.addEventListener("click",function(e){
  if(!document.body.classList.contains("ve-enabled")||mode!=="select"||!root)return;
  if(root.contains(e.target)||e.target.classList.contains("ve-fab"))return;
  e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();
  select(e.target);
},true);
document.addEventListener("keydown",function(e){
  if(e.ctrlKey&&e.shiftKey&&String(e.key).toLowerCase()==="d"){
    e.preventDefault();
    if(document.body.classList.contains("ve-enabled"))deactivate();else activate();
  }
});
loadRules();
applyRules();
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",build);else build();
})();
