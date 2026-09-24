import { createRequire } from 'node:module'; import { spawn } from 'node:child_process';
const { chromium } = createRequire(import.meta.url)(process.env.PW_PATH);
const B='http://localhost:3222';
const srv=spawn('node',['server.js'],{cwd:'/home/claude/chaska-backend',env:{...process.env,PORT:3222,DEMO_OTP:'1',DB_FILE:':memory:',OFFER_SECONDS:'12'},stdio:'ignore'});
await new Promise(r=>setTimeout(r,900));
let pass=0,fail=0;const ok=(c,m)=>{c?pass++:(fail++,console.log('FAIL:',m))};
const br=await chromium.launch();
const spy=`window.__v=0;window.__o=0;const _v=()=>{window.__v++;return true};navigator.vibrate=_v;const A=window.AudioContext;if(A){const c=A.prototype.createOscillator;A.prototype.createOscillator=function(){window.__o++;return c.call(this)}}`;
const errs=[];
const mk=async(perm=[])=>{perm=[...perm,'notifications'];const c=await br.newContext({viewport:{width:420,height:820},hasTouch:false,permissions:perm,geolocation:{latitude:26.47,longitude:84.45}});const p=await c.newPage();await p.addInitScript(spy);p.on('pageerror',e=>errs.push(e.message));return p};
const login=async(p,url,phone)=>{await p.goto(B+url);await p.fill('#lp',phone);await p.click('text=Get OTP');await p.waitForSelector('#lo');await p.fill('#lo','1234');await p.click('text=Verify');};
try{
 // owner
 const ow=await mk(); await login(ow,'/owner','9939834950'); await ow.waitForSelector('text=Recent orders'); ok(true,'owner in');
 const bad=await mk(); await bad.goto(B+'/owner'); await bad.fill('#lp','9123456789'); bad.once('dialog',d=>{ok(/registered/.test(d.message()),'wrong number msg');d.dismiss()}); await bad.click('text=Get OTP'); await bad.waitForTimeout(400);
 // separation: customer page has no owner/rider code
 const cu=await mk(['geolocation']); await cu.goto(B+'/'); const html=await cu.content(); ok(!/Owner App|Rider App|Swipe to accept|GO\(\)/.test(html),'customer page has no owner/rider UI');
 await cu.waitForSelector('.card'); ok((await cu.$$('.card')).length>0,'menu visible');
 // rider online first
 const rd=await mk(['geolocation']); await login(rd,'/rider','9000000001'); await rd.waitForSelector('.tg'); await rd.click('.tg'); await rd.waitForSelector('text=Online');
 // customer orders
 await cu.click('.card >> nth=0 >> text=Add to cart'); await cu.click('#cb'); await cu.fill('#on','Ram'); await cu.fill('#op','9876543210'); await cu.fill('#oa','Main road Gopalganj near chowk'); await cu.click('#ls'); await cu.waitForSelector('text=Location added'); await cu.click('text=Place Order');
 await cu.waitForSelector('text=Order placed');
 const oid=(await cu.textContent('#mb b'));ok(/^CH\d+$/.test(oid),'order id '+oid);
 // rider popup arrives automatically (no owner action)
 await rd.waitForSelector('.sheet',{timeout:8000}); ok(true,'POPUP appeared right after order');
 ok(await rd.isVisible('.sheet svg'),'map in popup'); const txt=await rd.textContent('.sheet'); ok(/km/.test(txt)&&/₹\d+/.test(txt),'distance + earning shown: '+txt.slice(0,110).replace(/\s+/g,' '));
 const c1=parseInt(await rd.textContent('#cd')); ok(c1>0&&c1<=12,'countdown shown: '+c1+'s');
 await rd.waitForTimeout(2600); const c2=parseInt(await rd.textContent('#cd')); ok(c2<c1,'countdown ticking: '+c1+'→'+c2); const v=await rd.evaluate(()=>window.__v), o=await rd.evaluate(()=>window.__o); ok(v>=2,'vibration repeated: '+v); ok(o>=2,'sound oscillators played: '+o);
 // swipe accept with mouse drag
 const h=await rd.$('.sw b'),bb=await h.boundingBox(),sw=await (await rd.$('.sw')).boundingBox();
 await rd.mouse.move(bb.x+24,bb.y+24);await rd.mouse.down();await rd.mouse.move(bb.x+120,bb.y+24,{steps:5});await rd.mouse.move(sw.x+sw.width-10,bb.y+24,{steps:8});await rd.mouse.up();
 await rd.waitForSelector('.sheet',{state:'detached',timeout:6000}); ok(true,'popup closed after swipe'); ok(await rd.isVisible('text=Restaurant ki taraf jaiye'),'active order shown');
 const st=await rd.evaluate(()=>window.__v); 
 const mf=await (await fetch(B+'/rider.webmanifest')).json(); ok(mf.display=='standalone'&&mf.icons.length==2,'PWA manifest ok'); const sr=await fetch(B+'/sw.js'); ok(sr.ok&&/showNotification/.test(await sr.text()),'service worker served');
 const swr=await rd.evaluate(async()=>{const r=await navigator.serviceWorker.getRegistration('/');return !!r}); ok(swr,'service worker registered in rider app');
 // owner sees rider assigned, moves order along
 await ow.click('text=Orders'); await ow.waitForSelector('text=Rahul',{timeout:8000}); ok(true,'owner sees rider Rahul');
 await ow.click('text=→ Accepted'); await ow.waitForSelector('text=→ Preparing'); await ow.click('text=→ Preparing');
 await rd.waitForSelector('text=Swipe: Picked up',{timeout:8000}); ok(true,'rider gets pickup swipe after Preparing');
 const sw2=async(label)=>{const h=await rd.$('.sw b'),bb=await h.boundingBox(),s=await (await rd.$('.sw')).boundingBox();await rd.mouse.move(bb.x+24,bb.y+24);await rd.mouse.down();await rd.mouse.move(s.x+s.width-10,bb.y+24,{steps:10});await rd.mouse.up();};
 await sw2(); await rd.waitForSelector('text=Swipe: Delivered',{timeout:8000}); ok(true,'pickup done');
 await cu.waitForSelector('text=Out for delivery',{timeout:9000}); ok(true,'customer sees Out for delivery'); ok(await cu.isVisible('#trk svg'),'customer live map');
 await sw2(); await cu.waitForSelector('#trk >> text=Delivered',{timeout:9000}); ok(true,'customer sees Delivered');
 await rd.waitForSelector('text=+₹',{timeout:8000}); ok(true,'rider history earning');
 ok(errs.length===0,'no JS errors: '+errs.join('|'));
}catch(e){fail++;console.log('ERROR',e.message.split('\n')[0])}
console.log(`\n${pass} passed, ${fail} failed`);await br.close();srv.kill();process.exit(fail?1:0);
