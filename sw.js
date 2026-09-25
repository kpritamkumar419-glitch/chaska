self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(clients.claim()));
self.addEventListener('push',e=>e.waitUntil((async()=>{
  const l=await clients.matchAll({type:'window',includeUncontrolled:true});
  if(l.some(c=>c.visibilityState==='visible'))return; // app khula hai: app khud sound bajata hai
  await self.registration.showNotification('🔔 Nayi delivery request!',{body:'Tap karein aur jaldi accept karein – time limit hai',tag:'offer',renotify:true,requireInteraction:true,vibrate:[400,150,400,150,400],icon:'/icon-192.png',badge:'/icon-192.png',data:{url:'/rider'}});
})()));
self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(l=>{for(const c of l){if(c.url.includes('/rider')&&'focus' in c)return c.focus()}return clients.openWindow('/rider')}))});
