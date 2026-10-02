
(function(){
"use strict";
var STORAGE_KEY="arcanum.visualDesign.v1";
var IMAGE_KEY="arcanum.visualImages.v1";
var MODE_KEY="arcanum.visualEditor.mode";
var PANEL_SIDE_KEY="arcanum.visualEditor.side";
var PANEL_MIN_KEY="arcanum.visualEditor.minimized";
var PANEL_X_KEY="arcanum.visualEditor.x";
var rules={};
var imageRules={};
var selected=null;
var hover=null;
var scope="class";
var mode="select";
var root=null;
var styleEl=null;
var badge=null;
var dragState=null;
var panelSide=localStorage.getItem(PANEL_SIDE_KEY)==="left"?"left":"right";
var panelMinimized=localStorage.getItem(PANEL_MIN_KEY)==="1";
var resizeBase=null;
var resizeSaveTimer=null;
var panelDragState=null;
var panelX=(function(){var n=parseFloat(localStorage.getItem(PANEL_X_KEY)||"");return Number.isFinite(n)?n:null})();

function loadRules(){
  try{rules=JSON.parse(localStorage.getItem(STORAGE_KEY)||"{}")||{}}catch(e){rules={}}
  try{imageRules=JSON.parse(localStorage.getItem(IMAGE_KEY)||"{}")||{}}catch(e){imageRules={}}
}
function saveRules(){
  try{
    localStorage.setItem(STORAGE_KEY,JSON.stringify(rules));
    localStorage.setItem(IMAGE_KEY,JSON.stringify(imageRules));
    return true;
  }catch(e){
    setStatus("No se pudo guardar. La imagen puede ser demasiado pesada para el navegador.","bad");
    return false;
  }
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
  applyImageRules();
}
function setStatus(message,type){
  if(!root)return;
  var el=root.querySelector("[data-ve-status]");
  if(!el)return;
  el.textContent=message||"";
  el.classList.toggle("good",type==="good");
  el.classList.toggle("bad",type==="bad");
}
function rememberOriginal(el,target){
  if(target==="src"&&el.tagName==="IMG"&&!el.hasAttribute("data-ve-original-src")){
    el.setAttribute("data-ve-original-src",el.getAttribute("src")||"");
  }
  if(target==="background"&&!el.hasAttribute("data-ve-original-bg")){
    el.setAttribute("data-ve-original-bg",el.style.backgroundImage||"");
  }
}
function restoreImageFor(selector,entry){
  try{
    document.querySelectorAll(selector).forEach(function(el){
      if(entry&&entry.target==="src"&&el.tagName==="IMG"&&el.hasAttribute("data-ve-original-src")){
        var old=el.getAttribute("data-ve-original-src")||"";
        if(old)el.setAttribute("src",old);else el.removeAttribute("src");
        el.removeAttribute("data-ve-original-src");
      }
      if(entry&&entry.target==="background"&&el.hasAttribute("data-ve-original-bg")){
        var bg=el.getAttribute("data-ve-original-bg")||"";
        if(bg)el.style.setProperty("background-image",bg);else el.style.removeProperty("background-image");
        el.removeAttribute("data-ve-original-bg");
      }
    });
  }catch(e){}
}
function applyImageRules(){
  Object.keys(imageRules).forEach(function(selector){
    var entry=imageRules[selector];
    if(!entry||!entry.value)return;
    try{
      document.querySelectorAll(selector).forEach(function(el){
        if(entry.target==="src"&&el.tagName==="IMG"){
          rememberOriginal(el,"src");
          if(el.getAttribute("src")!==entry.value)el.setAttribute("src",entry.value);
        }else{
          rememberOriginal(el,"background");
          el.style.setProperty("background-image",'url("'+String(entry.value).replace(/"/g,'\\\"')+'")',"important");
        }
      });
    }catch(e){}
  });
}
function removeImageOverride(selector){
  var entry=imageRules[selector];
  if(!entry)return;
  restoreImageFor(selector,entry);
  delete imageRules[selector];
}
function selectedImageValue(){
  if(!selected)return"";
  var selector=selectorFor(selected);
  if(imageRules[selector]&&imageRules[selector].value)return imageRules[selector].value;
  if(selected.tagName==="IMG")return selected.currentSrc||selected.getAttribute("src")||"";
  var bg=getComputedStyle(selected).backgroundImage||"";
  var m=bg.match(/^url\(["']?(.*?)["']?\)$/i);
  return m?m[1]:"";
}
function setImageValue(value){
  if(!selected)return;
  value=String(value||"").trim();
  if(!value)return;
  if(/^javascript:/i.test(value)){setStatus("Esa URL no es válida.","bad");return}
  var selector=selectorFor(selected);
  var entry={target:selected.tagName==="IMG"?"src":"background",value:value};
  imageRules[selector]=entry;
  applyImageRules();
  if(!saveRules()){
    restoreImageFor(selector,entry);
    delete imageRules[selector];
    return;
  }
  refreshPanel();
  setStatus("Imagen aplicada y guardada.","good");
}
function imageFileToDataUrl(file){
  return new Promise(function(resolve,reject){
    if(!file||!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type||""))return reject(new Error("Formato no compatible"));
    if(file.size>12*1024*1024)return reject(new Error("La imagen supera 12 MB"));
    var reader=new FileReader();
    reader.onerror=function(){reject(new Error("No se pudo leer la imagen"))};
    reader.onload=function(){
      var raw=String(reader.result||"");
      if(file.type==="image/gif"&&file.size<=900000){resolve(raw);return}
      var img=new Image();
      img.onerror=function(){reject(new Error("No se pudo procesar la imagen"))};
      img.onload=function(){
        var maxSide=1600;
        var scale=Math.min(1,maxSide/Math.max(img.naturalWidth||1,img.naturalHeight||1));
        var w=Math.max(1,Math.round((img.naturalWidth||1)*scale));
        var h=Math.max(1,Math.round((img.naturalHeight||1)*scale));
        var canvas=document.createElement("canvas");
        canvas.width=w;canvas.height=h;
        var ctx=canvas.getContext("2d");
        ctx.drawImage(img,0,0,w,h);
        var quality=.9;
        var out=canvas.toDataURL("image/webp",quality);
        while(out.length>900000&&quality>.5){
          quality-=.1;
          out=canvas.toDataURL("image/webp",quality);
        }
        resolve(out);
      };
      img.src=raw;
    };
    reader.readAsDataURL(file);
  });
}
function imageFitProp(){
  return selected&&selected.tagName==="IMG"?"object-fit":"background-size";
}
function imagePositionProp(){
  return selected&&selected.tagName==="IMG"?"object-position":"background-position";
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
function pxValue(v){
  var n=parseFloat(String(v||"").trim());
  return Number.isFinite(n)?n:0;
}
function ensureMoveRule(){
  if(!selected)return null;
  var selector=selectorFor(selected);
  var r=getRule(selector);
  var computed=getComputedStyle(selected);
  if((r.position||computed.position||"static")==="static")r.position="relative";
  if(r.left==null||r.left==="")r.left=(pxValue(computed.left)||0)+"px";
  if(r.top==null||r.top==="")r.top=(pxValue(computed.top)||0)+"px";
  return {selector:selector,rule:r};
}
function nudgeSelected(dx,dy){
  var move=ensureMoveRule();
  if(!move)return;
  move.rule.left=(pxValue(move.rule.left)+dx)+"px";
  move.rule.top=(pxValue(move.rule.top)+dy)+"px";
  applyRules();saveRules();refreshPanel();setStatus("Posición actualizada.","good");
}
function beginDrag(e){
  if(mode!=="move"||!selected||!root)return;
  if(root.contains(e.target)||e.target.classList.contains("ve-fab"))return;
  if(!(e.target===selected||selected.contains(e.target)))return;
  var move=ensureMoveRule();
  if(!move)return;
  dragState={
    pointerId:e.pointerId,
    selector:move.selector,
    startX:e.clientX,
    startY:e.clientY,
    left:pxValue(move.rule.left),
    top:pxValue(move.rule.top)
  };
  selected.classList.add("ve-dragging");
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
}
function dragMove(e){
  if(!dragState||e.pointerId!==dragState.pointerId)return;
  var r=getRule(dragState.selector);
  r.position=r.position&&r.position!=="static"?r.position:"relative";
  r.left=(dragState.left+(e.clientX-dragState.startX))+"px";
  r.top=(dragState.top+(e.clientY-dragState.startY))+"px";
  applyRules();
  e.preventDefault();
  e.stopPropagation();
}
function finishDrag(e){
  if(!dragState||e.pointerId!==dragState.pointerId)return;
  if(selected)selected.classList.remove("ve-dragging");
  dragState=null;
  saveRules();
  refreshPanel();
  setStatus("Posición guardada.","good");
  e.preventDefault();
  e.stopPropagation();
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
  if(selected){
    selected.classList.add("ve-target");
    var rect=selected.getBoundingClientRect();
    resizeBase={
      el:selected,
      width:Math.max(1,rect.width||pxValue(getComputedStyle(selected).width)||1),
      height:Math.max(1,rect.height||pxValue(getComputedStyle(selected).height)||1)
    };
  }else resizeBase=null;
  refreshPanel();
}
function clampNumber(n,min,max){return Math.min(max,Math.max(min,n))}
function scheduleResizeSave(){
  clearTimeout(resizeSaveTimer);
  resizeSaveTimer=setTimeout(function(){saveRules()},140);
}
function setResizeRule(width,height){
  if(!selected)return;
  var selector=selectorFor(selected);
  var r=getRule(selector);
  if(Number.isFinite(width))r.width=Math.max(1,Math.round(width))+"px";
  if(Number.isFinite(height))r.height=Math.max(1,Math.round(height))+"px";
  applyRules();
  scheduleResizeSave();
}
function resizeSelected(kind,value){
  if(!selected||!resizeBase)return;
  value=Number(value);
  if(!Number.isFinite(value))return;
  if(kind==="scale"){
    var factor=clampNumber(value,10,400)/100;
    setResizeRule(resizeBase.width*factor,resizeBase.height*factor);
  }else if(kind==="width"){
    setResizeRule(value,NaN);
  }else if(kind==="height"){
    setResizeRule(NaN,value);
  }
  refreshResizeControls();
}
function resetSelectedSize(){
  if(!selected)return;
  var selector=selectorFor(selected);
  var r=rules[selector];
  if(r){
    delete r.width;
    delete r.height;
    if(!Object.keys(r).length)delete rules[selector];
  }
  applyRules();saveRules();
  var rect=selected.getBoundingClientRect();
  resizeBase={el:selected,width:Math.max(1,rect.width||1),height:Math.max(1,rect.height||1)};
  refreshPanel();
  setStatus("Tamaño restaurado.","good");
}
function refreshResizeControls(){
  if(!root)return;
  var scale=root.querySelector('[data-ve-resize="scale"]');
  var width=root.querySelector('[data-ve-resize="width"]');
  var height=root.querySelector('[data-ve-resize="height"]');
  var scaleOut=root.querySelector("[data-ve-scale-out]");
  var widthOut=root.querySelector("[data-ve-width-out]");
  var heightOut=root.querySelector("[data-ve-height-out]");
  [scale,width,height].forEach(function(input){if(input)input.disabled=!selected});
  if(!selected||!resizeBase){
    if(scale)scale.value=100;
    if(width)width.value=100;
    if(height)height.value=100;
    if(scaleOut)scaleOut.textContent="100%";
    if(widthOut)widthOut.textContent="—";
    if(heightOut)heightOut.textContent="—";
    return;
  }
  var rect=selected.getBoundingClientRect();
  var w=Math.max(1,Math.round(rect.width));
  var h=Math.max(1,Math.round(rect.height));
  var maxW=Math.max(300,Math.round(resizeBase.width*3),w);
  var maxH=Math.max(300,Math.round(resizeBase.height*3),h);
  if(width){width.min=10;width.max=maxW;width.value=clampNumber(w,10,maxW)}
  if(height){height.min=10;height.max=maxH;height.value=clampNumber(h,10,maxH)}
  var pct=Math.round(((rect.width/resizeBase.width)+(rect.height/resizeBase.height))*50);
  pct=clampNumber(pct,25,250);
  if(scale)scale.value=pct;
  if(scaleOut)scaleOut.textContent=pct+"%";
  if(widthOut)widthOut.textContent=w+" px";
  if(heightOut)heightOut.textContent=h+" px";
}
function clampPanelX(x){
  if(!root)return 8;
  var width=Math.max(180,root.getBoundingClientRect().width||340);
  return Math.max(8,Math.min(window.innerWidth-width-8,Number(x)||8));
}
function applyPanelState(){
  if(!root)return;
  var free=Number.isFinite(panelX);
  root.classList.toggle("ve-free-position",free);
  root.classList.toggle("ve-side-left",!free&&panelSide==="left");
  root.classList.toggle("ve-side-right",!free&&panelSide!=="left");
  root.classList.toggle("ve-minimized",!!panelMinimized);
  if(free){
    panelX=clampPanelX(panelX);
    root.style.left=panelX+"px";
    root.style.right="auto";
  }else{
    root.style.removeProperty("left");
    root.style.removeProperty("right");
  }
  var sideBtn=root.querySelector("[data-ve-side]");
  var minBtn=root.querySelector("[data-ve-minimize]");
  if(sideBtn){
    sideBtn.textContent=panelSide==="left"?"→":"←";
    sideBtn.title=panelSide==="left"?"Mover editor a la derecha":"Mover editor a la izquierda";
  }
  if(minBtn){
    minBtn.textContent=panelMinimized?"□":"—";
    minBtn.title=panelMinimized?"Restaurar editor":"Minimizar editor";
  }
  var fab=document.querySelector(".ve-fab");
  if(fab)fab.classList.toggle("ve-fab-left",panelSide==="left");
}
function togglePanelSide(){
  panelX=null;
  localStorage.removeItem(PANEL_X_KEY);
  panelSide=panelSide==="left"?"right":"left";
  localStorage.setItem(PANEL_SIDE_KEY,panelSide);
  applyPanelState();
}
function beginPanelDrag(e){
  if(!root||!document.body.classList.contains("ve-enabled"))return;
  var head=e.target.closest&&e.target.closest(".ve-head");
  if(!head||!root.contains(head))return;
  if(e.target.closest("button,input,select,a"))return;
  if(e.button!=null&&e.button!==0)return;
  var rect=root.getBoundingClientRect();
  panelDragState={
    pointerId:e.pointerId,
    startX:e.clientX,
    startLeft:rect.left,
    width:rect.width
  };
  panelX=rect.left;
  root.classList.add("ve-panel-dragging","ve-free-position");
  root.classList.remove("ve-side-left","ve-side-right");
  root.style.left=rect.left+"px";
  root.style.right="auto";
  try{head.setPointerCapture(e.pointerId)}catch(err){}
  e.preventDefault();
  e.stopPropagation();
}
function movePanelDrag(e){
  if(!panelDragState||e.pointerId!==panelDragState.pointerId||!root)return;
  var next=panelDragState.startLeft+(e.clientX-panelDragState.startX);
  var max=Math.max(8,window.innerWidth-panelDragState.width-8);
  panelX=Math.max(8,Math.min(max,next));
  root.style.left=panelX+"px";
  root.style.right="auto";
  e.preventDefault();
  e.stopPropagation();
}
function finishPanelDrag(e){
  if(!panelDragState||e.pointerId!==panelDragState.pointerId||!root)return;
  root.classList.remove("ve-panel-dragging");
  panelDragState=null;
  panelX=clampPanelX(panelX);
  root.style.left=panelX+"px";
  root.style.right="auto";
  localStorage.setItem(PANEL_X_KEY,String(Math.round(panelX)));
  setStatus("Posición del editor guardada.","good");
  e.preventDefault();
  e.stopPropagation();
}
function togglePanelMinimize(){
  panelMinimized=!panelMinimized;
  localStorage.setItem(PANEL_MIN_KEY,panelMinimized?"1":"0");
  applyPanelState();
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
  var preview=root.querySelector("[data-ve-image-preview]");
  var imageUrl=root.querySelector("[data-ve-image-url]");
  var fit=root.querySelector("[data-ve-fit]");
  var pos=root.querySelector("[data-ve-image-position]");
  if(preview){
    var val=selectedImageValue();
    preview.classList.toggle("empty",!val);
    preview.style.backgroundImage=val?'url("'+String(val).replace(/"/g,'\\\"')+'")':"";
    preview.textContent=val?"":"Selecciona una imagen o un bloque con fondo";
  }
  if(imageUrl)imageUrl.value="";
  if(fit){
    if(!selected)fit.value="";
    else{
      var fp=imageFitProp();
      var fv=readProp(fp);
      fit.value=["cover","contain","100% 100%","auto"].indexOf(fv)>=0?fv:"";
    }
  }
  refreshResizeControls();
  if(pos){
    if(!selected)pos.value="";
    else{
      var pp=imagePositionProp();
      var pv=readProp(pp);
      pos.value=["center","top","bottom","left","right"].indexOf(pv)>=0?pv:"";
    }
  }
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
  document.body.classList.remove("ve-enabled","ve-select-mode","ve-move-mode");
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
  document.body.classList.toggle("ve-move-mode",mode==="move");
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
async function exportJson(){
  var payload={version:3,exportedAt:new Date().toISOString(),styles:rules,images:imageRules};
  var json=JSON.stringify(payload,null,2);
  var blob=new Blob([json],{type:"application/json;charset=utf-8"});
  var fileName="arcanum-visual-design.json";

  if(window.showSaveFilePicker){
    try{
      var handle=await window.showSaveFilePicker({
        suggestedName:fileName,
        types:[{description:"Diseño ARCANUM",accept:{"application/json":[".json"]}}]
      });
      var writable=await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      setStatus("Diseño guardado como archivo JSON.","good");
      return;
    }catch(e){
      if(e&&e.name==="AbortError"){
        setStatus("Guardado cancelado.","bad");
        return;
      }
    }
  }

  try{
    var url=URL.createObjectURL(blob);
    var a=document.createElement("a");
    a.href=url;
    a.download=fileName;
    a.style.display="none";
    document.body.appendChild(a);
    a.click();
    setTimeout(function(){
      try{a.remove()}catch(e){}
      try{URL.revokeObjectURL(url)}catch(e){}
    },5000);
    setStatus("Descarga iniciada. Revisa la carpeta Descargas.","good");
  }catch(e){
    try{
      await navigator.clipboard.writeText(json);
      setStatus("El navegador bloqueó la descarga. He copiado el diseño al portapapeles.","good");
    }catch(err){
      setStatus("No se pudo descargar. Usa el botón Copiar diseño.","bad");
    }
  }
}
async function copyJson(){
  var payload={version:3,exportedAt:new Date().toISOString(),styles:rules,images:imageRules};
  var json=JSON.stringify(payload,null,2);
  try{
    await navigator.clipboard.writeText(json);
    setStatus("Diseño copiado al portapapeles.","good");
  }catch(e){
    var box=document.createElement("textarea");
    box.value=json;
    box.setAttribute("readonly","");
    box.style.position="fixed";
    box.style.left="-9999px";
    document.body.appendChild(box);
    box.select();
    var ok=false;
    try{ok=document.execCommand("copy")}catch(err){}
    box.remove();
    setStatus(ok?"Diseño copiado al portapapeles.":"No se pudo copiar el diseño.",ok?"good":"bad");
  }
}
function resetAll(){
  if(!confirm("¿Restablecer todos los cambios visuales guardados en este navegador?"))return;
  Object.keys(imageRules).forEach(function(selector){restoreImageFor(selector,imageRules[selector])});
  rules={};imageRules={};saveRules();applyRules();refreshPanel();setStatus("Diseño restablecido.","good");
}
function resetSelection(){
  if(!selected)return;
  var selector=selectorFor(selected);
  delete rules[selector];
  removeImageOverride(selector);
  saveRules();applyRules();refreshPanel();setStatus("Elemento restablecido.","good");
}
function build(){
  document.body.classList.add("ve-available");
  root=document.createElement("aside");
  root.id="ve-root";
  root.setAttribute("aria-hidden","true");
  root.innerHTML=
    '<div class="ve-head"><strong>ARCANUM · Editor visual</strong><small>LIVE</small><div class="ve-head-actions"><button class="ve-head-btn" data-ve-side title="Mover editor al otro lado">←</button><button class="ve-head-btn" data-ve-minimize title="Minimizar editor">—</button></div></div>'+
    '<div class="ve-section">'+
      '<span class="ve-label">Modo</span>'+
      '<div class="ve-row three"><button class="ve-btn active" data-ve-mode="select">Seleccionar</button><button class="ve-btn" data-ve-mode="move">Mover</button><button class="ve-btn" data-ve-mode="interact">Interactuar</button></div>'+
      '<div class="ve-help">Selecciona un elemento y usa Mover para arrastrarlo directamente por la página. Interactuar devuelve los clics normales al juego.</div>'+
    '</div>'+
    '<div class="ve-section">'+
      '<span class="ve-label">Elemento</span>'+
      '<div class="ve-current" data-ve-current>Haz clic en un elemento de la página</div>'+
      '<div class="ve-row"><select class="ve-select" data-ve-scope><option value="class">Todos los iguales</option><option value="single">Solo este</option></select><button class="ve-btn danger" data-ve-reset-one>Limpiar elemento</button></div>'+
    '</div>'+
    '<div class="ve-section">'+
      '<span class="ve-label">Redimensionar</span>'+
      '<div class="ve-resize-line"><div><b>Escala</b><output data-ve-scale-out>100%</output></div><input type="range" min="25" max="250" value="100" step="1" data-ve-resize="scale"></div>'+
      '<div class="ve-resize-line"><div><b>Ancho</b><output data-ve-width-out>—</output></div><input type="range" min="10" max="1200" value="100" step="1" data-ve-resize="width"></div>'+
      '<div class="ve-resize-line"><div><b>Alto</b><output data-ve-height-out>—</output></div><input type="range" min="10" max="1200" value="100" step="1" data-ve-resize="height"></div>'+
      '<button class="ve-btn" data-ve-reset-size>Restaurar tamaño</button>'+
      '<div class="ve-help">La escala mantiene la proporción. Ancho y alto permiten afinar cada dimensión por separado.</div>'+
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
      '<span class="ve-label">Imagen</span>'+
      '<div class="ve-image-preview empty" data-ve-image-preview>Selecciona una imagen o un bloque con fondo</div>'+
      '<input class="ve-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-ve-image-file>'+
      '<div class="ve-row"><button class="ve-btn primary" data-ve-upload-image>Subir mi imagen</button><button class="ve-btn danger" data-ve-remove-image>Quitar sustitución</button></div>'+
      '<div class="ve-row ve-image-url-row"><input class="ve-input" data-ve-image-url placeholder="URL de imagen"><button class="ve-btn" data-ve-apply-image-url>Aplicar URL</button></div>'+
      '<div class="ve-row"><select class="ve-select" data-ve-fit><option value="">Ajuste actual</option><option value="cover">Cubrir</option><option value="contain">Encajar</option><option value="100% 100%">Estirar</option><option value="auto">Tamaño original</option></select><select class="ve-select" data-ve-image-position><option value="">Posición actual</option><option value="center">Centro</option><option value="top">Arriba</option><option value="bottom">Abajo</option><option value="left">Izquierda</option><option value="right">Derecha</option></select></div>'+
      '<div class="ve-help">En una etiqueta IMG sustituye su archivo. En bloques como .card-art sustituye la imagen de fondo. La imagen subida queda incluida al exportar el diseño.</div>'+
      '<div class="ve-status" data-ve-status></div>'+
    '</div>'+
    '<div class="ve-section">'+
      '<span class="ve-label">Posición fina</span>'+
      '<div class="ve-row"><input class="ve-input" data-ve-prop="left" placeholder="Izq. ej. 10px"><input class="ve-input" data-ve-prop="top" placeholder="Arriba ej. -5px"></div>'+
      '<div class="ve-row"><select class="ve-select" data-ve-prop="position"><option value="">Posición actual</option><option value="relative">relative</option><option value="absolute">absolute</option><option value="sticky">sticky</option><option value="fixed">fixed</option></select><input class="ve-input" data-ve-prop="z-index" placeholder="z-index"></div>'+
      '<div class="ve-nudge"><button class="ve-btn" data-ve-nudge="0,-10">↑</button><button class="ve-btn" data-ve-nudge="-10,0">←</button><button class="ve-btn" data-ve-nudge="0,10">↓</button><button class="ve-btn" data-ve-nudge="10,0">→</button></div>'+
      '<div class="ve-help">En modo Mover puedes arrastrar el elemento. Las flechas lo desplazan 10 px; las flechas del teclado, 1 px.</div>'+
    '</div>'+
    '<div class="ve-section">'+
      '<span class="ve-label">Guardar / exportar</span>'+
      '<div class="ve-actions"><button class="ve-btn primary" data-ve-save>Guardar</button><button class="ve-btn" data-ve-export-json>Descargar diseño</button><button class="ve-btn" data-ve-copy-json>Copiar diseño</button><button class="ve-btn danger" data-ve-reset>Restablecer todo</button></div>'+
      '<button class="ve-btn ve-css-export" data-ve-export-css>Exportar CSS</button>'+
      '<div class="ve-help">Guardar conserva los cambios solo en este navegador. Para publicarlos, usa Exportar diseño y pásame ese archivo: lo integro en el repositorio y Render publica la versión oficial.</div>'+
    '</div>'+
    '<div class="ve-section"><button class="ve-btn" data-ve-close>Cerrar editor</button><div class="ve-help">Atajo: Ctrl + Shift + D</div></div>';
  document.body.appendChild(root);
  applyPanelState();

  var fab=document.createElement("button");
  fab.className="ve-fab";
  fab.textContent="✦ Editor visual";
  fab.addEventListener("click",activate);
  document.body.appendChild(fab);
  applyPanelState();

  root.addEventListener("pointerdown",function(e){
    beginPanelDrag(e);
  });
  root.addEventListener("pointermove",function(e){
    movePanelDrag(e);
  });
  root.addEventListener("pointerup",function(e){
    finishPanelDrag(e);
  });
  root.addEventListener("pointercancel",function(e){
    finishPanelDrag(e);
  });
  root.addEventListener("click",function(e){
    e.stopPropagation();
    if(e.target.closest("[data-ve-side]")){togglePanelSide();return}
    if(e.target.closest("[data-ve-minimize]")){togglePanelMinimize();return}
    if(e.target.closest("[data-ve-reset-size]")){resetSelectedSize();return}
    var m=e.target.closest("[data-ve-mode]");
    if(m){
      var next=m.getAttribute("data-ve-mode");
      if(next==="move"&&!selected){setStatus("Selecciona primero el elemento que quieres mover.","bad");return}
      mode=next;clearHover();updateModeButtons();return
    }
    var nudge=e.target.closest("[data-ve-nudge]");
    if(nudge){
      if(!selected){setStatus("Selecciona primero un elemento.","bad");return}
      var p=nudge.getAttribute("data-ve-nudge").split(",").map(Number);
      nudgeSelected(p[0]||0,p[1]||0);return
    }
    if(e.target.closest("[data-ve-save]")){saveRules();applyRules();setStatus("Cambios guardados en este navegador.","good");return}
    if(e.target.closest("[data-ve-upload-image]")){
      var fileInput=root.querySelector("[data-ve-image-file]");
      if(!selected){setStatus("Primero selecciona el elemento donde quieres poner la imagen.","bad");return}
      if(fileInput)fileInput.click();
      return;
    }
    if(e.target.closest("[data-ve-apply-image-url]")){
      if(!selected){setStatus("Primero selecciona un elemento.","bad");return}
      var urlInput=root.querySelector("[data-ve-image-url]");
      var url=urlInput?urlInput.value.trim():"";
      if(!url){setStatus("Pega una URL de imagen primero.","bad");return}
      setImageValue(url);return;
    }
    if(e.target.closest("[data-ve-remove-image]")){
      if(!selected){setStatus("Primero selecciona un elemento.","bad");return}
      var selector=selectorFor(selected);
      removeImageOverride(selector);saveRules();applyRules();refreshPanel();setStatus("Sustitución de imagen eliminada.","good");return;
    }
    if(e.target.closest("[data-ve-export-css]")){exportCss();return}
    if(e.target.closest("[data-ve-export-json]")){exportJson();return}
    if(e.target.closest("[data-ve-copy-json]")){copyJson();return}
    if(e.target.closest("[data-ve-reset]")){resetAll();return}
    if(e.target.closest("[data-ve-reset-one]")){resetSelection();return}
    if(e.target.closest("[data-ve-close]")){deactivate();return}
  });
  root.addEventListener("input",function(e){
    e.stopPropagation();
    var resize=e.target.getAttribute&&e.target.getAttribute("data-ve-resize");
    if(resize){resizeSelected(resize,e.target.value);return}
  });
  root.addEventListener("change",function(e){
    e.stopPropagation();
    if(e.target.matches("[data-ve-scope]")){scope=e.target.value;refreshPanel();return}
    if(e.target.matches("[data-ve-image-file]")){
      var file=e.target.files&&e.target.files[0];
      if(!file||!selected)return;
      setStatus("Procesando imagen…","");
      imageFileToDataUrl(file).then(function(data){
        setImageValue(data);
        e.target.value="";
      }).catch(function(err){
        setStatus(err&&err.message?err.message:"No se pudo cargar la imagen.","bad");
        e.target.value="";
      });
      return;
    }
    if(e.target.matches("[data-ve-fit]")){
      if(!selected)return;
      var fitValue=e.target.value;
      if(fitValue)setProp(imageFitProp(),fitValue);else setProp(imageFitProp(),"");
      return;
    }
    if(e.target.matches("[data-ve-image-position]")){
      if(!selected)return;
      var posValue=e.target.value;
      if(posValue)setProp(imagePositionProp(),posValue);else setProp(imagePositionProp(),"");
      return;
    }
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

  var observer=new MutationObserver(function(){
    if(!Object.keys(imageRules).length)return;
    requestAnimationFrame(applyImageRules);
  });
  observer.observe(document.body,{childList:true,subtree:true});
  window.addEventListener("resize",function(){
    if(Number.isFinite(panelX)){panelX=clampPanelX(panelX);applyPanelState()}
  });
  if(location.search.indexOf("design=1")>=0||localStorage.getItem(MODE_KEY)==="on")activate();
}
document.addEventListener("pointerdown",function(e){
  beginDrag(e);
},true);
document.addEventListener("pointermove",function(e){
  dragMove(e);
},true);
document.addEventListener("pointerup",function(e){
  finishDrag(e);
},true);
document.addEventListener("pointercancel",function(e){
  finishDrag(e);
},true);
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
  if(!document.body.classList.contains("ve-enabled")||!root)return;
  if(root.contains(e.target)||e.target.classList.contains("ve-fab"))return;
  if(mode==="select"){
    e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();
    select(e.target);
    return;
  }
  if(mode==="move"){
    e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();
  }
},true);
document.addEventListener("keydown",function(e){
  if(e.ctrlKey&&e.shiftKey&&String(e.key).toLowerCase()==="d"){
    e.preventDefault();
    if(document.body.classList.contains("ve-enabled"))deactivate();else activate();
    return;
  }
  if(document.body.classList.contains("ve-enabled")&&mode==="move"&&selected&&["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].indexOf(e.key)>=0){
    if(root&&root.contains(document.activeElement))return;
    e.preventDefault();
    var step=e.shiftKey?10:1;
    if(e.key==="ArrowUp")nudgeSelected(0,-step);
    if(e.key==="ArrowDown")nudgeSelected(0,step);
    if(e.key==="ArrowLeft")nudgeSelected(-step,0);
    if(e.key==="ArrowRight")nudgeSelected(step,0);
  }
});
loadRules();
applyRules();
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",build);else build();
})();
