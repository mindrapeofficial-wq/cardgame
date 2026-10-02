const CACHE="arcanum-tcg-v74";
const CORE=["./","index.html","modern.css","theme.css","rules.js","app.js","cards.csv","legacy-assets/image-index.json","legacy-assets/imagenes/icono.png","legacy-assets/imagenes/crt_back.jpg","assets/arcanum-game-table.webp","assets/arcanum-card-back.webp","assets/arcanum-login-background.webp","assets/arcanum-logo-oficial.webp","assets/icons/arcanum-a-64.png"];
const FRESH=new Set(["/","/index.html","/modern.css","/theme.css","/rules.js","/app.js","/cards.csv","/legacy-assets/image-index.json"]);

self.addEventListener("install",event=>{
  event.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting()));
});

self.addEventListener("activate",event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});

self.addEventListener("fetch",event=>{
  if(event.request.method!=="GET")return;
  const url=new URL(event.request.url);
  if(url.origin!==location.origin)return;

  if(FRESH.has(url.pathname)){
    event.respondWith(
      fetch(event.request).then(res=>{
        if(res&&res.status===200){const copy=res.clone();caches.open(CACHE).then(c=>c.put(event.request,copy))}
        return res;
      }).catch(()=>caches.match(event.request).then(hit=>hit||caches.match("index.html")))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(hit=>hit||fetch(event.request).then(res=>{
      if(res&&res.status===200){const copy=res.clone();caches.open(CACHE).then(c=>c.put(event.request,copy))}
      return res;
    }))
  );
});