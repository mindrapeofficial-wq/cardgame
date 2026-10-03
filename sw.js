<<<<<<< HEAD
const CACHE="arcanum-tcg-v96";
const CORE=["./","index.html","modern.css","theme.css","rules.js","app.js","cards.csv","legal.css","privacy-ui.js","play-billing-ui.js","audio.js","audio.css","social-auth.js","messages-ui.js","messages.css","notifications-ui.js","privacidad.html","terminos.html","aviso-legal.html","eliminar-cuenta.html","delete-account.js","legacy-assets/image-index.json","legacy-assets/imagenes/icono.png","legacy-assets/imagenes/crt_back.jpg","assets/arcanum-game-table.webp","assets/arcanum-card-back.webp","assets/arcanum-login-background.webp","assets/arcanum-logo-oficial.webp","assets/icons/arcanum-a-64.png"];
const FRESH=new Set(["/","/index.html","/modern.css","/theme.css","/rules.js","/app.js","/cards.csv","/legal.css","/privacy-ui.js","/play-billing-ui.js","/audio.js","/audio.css","/social-auth.js","/messages-ui.js","/messages.css","/notifications-ui.js","/privacidad.html","/terminos.html","/aviso-legal.html","/eliminar-cuenta.html","/delete-account.js","/legacy-assets/image-index.json"]);
=======
const CACHE="arcanum-tcg-v95";
const CORE=["./","index.html","modern.css","theme.css","rules.js","app.js","cards.csv","legal.css","privacy-ui.js","play-billing-ui.js","audio.js","audio.css","privacidad.html","terminos.html","aviso-legal.html","eliminar-cuenta.html","delete-account.js","legacy-assets/image-index.json","legacy-assets/imagenes/icono.png","legacy-assets/imagenes/crt_back.jpg","assets/arcanum-game-table.webp","assets/arcanum-card-back.webp","assets/arcanum-login-background.webp","assets/arcanum-logo-oficial.webp","assets/icons/arcanum-a-64.png"];
const FRESH=new Set(["/","/index.html","/modern.css","/theme.css","/rules.js","/app.js","/cards.csv","/legal.css","/privacy-ui.js","/play-billing-ui.js","/audio.js","/audio.css","/privacidad.html","/terminos.html","/aviso-legal.html","/eliminar-cuenta.html","/delete-account.js","/legacy-assets/image-index.json"]);
>>>>>>> ecf6d64 (Yeimis: first legendary card, exclusive reward for linking Discord)

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
  // Auth codes and callbacks are transient and must never enter an offline cache.
  if(url.pathname==='/oauth-callback.html'||url.searchParams.has('oauth_code'))return;
  // Let the browser stream audio byte ranges without caching a partial response.
  if(event.request.headers.has("range")||url.pathname.startsWith("/assets/audio/"))return;

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

