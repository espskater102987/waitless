const CFG={appName:"WaitLess",fallback:[33.6971,-117.1853]/*Menifee CA*/,radius:8000,maxRadius:15000,maxDist:300};
const dev=new URLSearchParams(location.search).get("dev")==="1";
const $=s=>document.querySelector(s);
let device=localStorage.getItem("dev_id");if(!device){device=(crypto.randomUUID?crypto.randomUUID():Math.random().toString(36).slice(2)+Date.now().toString(36));localStorage.setItem("dev_id",device)}
let loaded=false,lastErr=0,me=null,places=[],filter="all",sortBy="wait",q="",markers=[];
const map=L.map("map",{zoomControl:false}).setView(CFG.fallback,14);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,className:"tiles",attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'}).addTo(map);
let meDot=null;
function toast(t){const e=$("#toast");e.textContent=t;e.classList.remove("hidden");clearTimeout(e._t);e._t=setTimeout(()=>e.classList.add("hidden"),3000)}
function color(m){return m==null?"n":m<=7?"g":m<=17?"y":"r"}
function fmt(m){return m==null?"—":m<1?"0 min":m>=30?"30+ min":Math.round(m)+" min"}
function ago(a){return a<1?"just now":a<60?`${Math.round(a)} min ago`:`${(a/60).toFixed(1)} h ago`}
function best(p){const v=[p.status.drive_thru,p.status.inside].filter(Boolean).map(s=>s.minutes);return v.length?Math.min(...v):null}
function pill(s,label,p){if(s)return `<div><span class="pill ${color(s.minutes)}">${fmt(s.minutes)}</span> ${label}<br>${ago(s.last_ago_min)}</div>`;
 if(p.typical_min!=null&&label==="drive-thru")return `<div><span class="pill e">~${p.typical_min} min</span> est.</div>`;return ""}
function kindName(k){return k==="fast_food"?"Fast food":k==="cafe"?"Café":"Restaurant"}
function dist(m){return m<1000?m+" m":(m/1609).toFixed(1)+" mi"}
function visible(){const B=map.getBounds();return places.filter(p=>B.contains([p.lat,p.lon])&&(filter==="all"||p.kind===filter)&&(!q||p.name.toLowerCase().includes(q)))}
function render(){
 markers.forEach(m=>m.remove());markers=[];
 for(const p of visible()){const b=best(p);const c=b==null?"#c7c7cc":getComputedStyle(document.body).getPropertyValue(`--${color(b)}`);
  const m=L.marker([p.lat,p.lon],{icon:L.divIcon({className:"",html:`<div class="dot" style="background:${c}"></div>`,iconSize:[18,18]})}).addTo(map).on("click",()=>openPlace(p));markers.push(m)}
 const items=visible().slice().sort((a,b)=>sortBy==="dist"?a.distance_m-b.distance_m:((best(a)??999)-(best(b)??999))||a.distance_m-b.distance_m);
 $("#items").innerHTML=items.map(p=>`<li data-id="${p.id}"><div><div class="nm">${esc(p.name)}</div><div class="sub">${kindName(p.kind)} · ${dist(p.distance_m)}</div></div><div class="pills">${pill(p.status.drive_thru,"drive-thru",p)}${pill(p.status.inside,"inside",p)}${!p.status.drive_thru&&!p.status.inside&&p.typical_min==null?"No recent reports":""}</div></li>`).join("")||(loaded?`<li class="msg">${places.length?"No matches.":"No places found yet."}<br><button id=\"retry\">Retry</button></li>`:'<li class="msg">Loading places…</li>');
 const rb=$("#retry");if(rb)rb.onclick=()=>load(me||CFG.fallback);
 document.querySelectorAll("#items li[data-id]").forEach(li=>li.onclick=()=>openPlace(places.find(p=>p.id===li.dataset.id)))}
function esc(s){return s.replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))}
function hav(a,b,c,d){const R=6371e3,r=Math.PI/180,x=Math.sin((c-a)*r/2)**2+Math.cos(a*r)*Math.cos(c*r)*Math.sin((d-b)*r/2)**2;return 2*R*Math.asin(Math.sqrt(x))}
function statusRow(p,mode,label){const s=p.status[mode];
 if(!s){const est=mode==="drive_thru"&&p.typical_min!=null?`<div class="est">Rough estimate for this time of day: ~${p.typical_min} min (not a report)</div>`:"";
  return `<div class="row"><div><b>${label}</b><div class="sub" style="margin:0">No recent reports</div>${est}</div></div>`}
 return `<div class="row"><div><b>${label}</b> <span class="pill ${color(s.minutes)}">${fmt(s.minutes)}</span><div class="sub" style="margin:0">Reported ${ago(s.last_ago_min)} · ${s.reports} report${s.reports>1?"s":""}${s.cars!=null?` · ${s.cars} cars`:""}</div></div><button class="thumb" data-r="${s.last_report_id}">👍 Still right</button></div>`}
function openPlace(p){
 const sh=$("#sheet"),c=$("#sheetbody");
 c.innerHTML=`<h2>${esc(p.name)}</h2><div class="sub">${kindName(p.kind)} · ${dist(p.distance_m)} away</div>${statusRow(p,"drive_thru","🚗 Drive-thru")}${statusRow(p,"inside","🚶 Inside / counter")}
 <button class="big" id="rep">Report wait</button><button class="big ghost" id="cls">Close</button>`;
 sh.classList.remove("hidden");$("#cls").onclick=close;
 c.querySelectorAll(".thumb").forEach(b=>b.onclick=async()=>{const r=await post("/api/confirm",{report_id:+b.dataset.r});if(r.ok){toast("Thanks for confirming!");b.disabled=true;b.textContent="👍 Confirmed";p.status=r.status}else toast(r.error)});
 $("#rep").onclick=()=>reportFlow(p)}
function close(){$("#sheet").classList.add("hidden")}
$("#sheet").onclick=e=>{if(e.target.id==="sheet")close()};
function reportFlow(p){
 if(!dev&&(!me||hav(me[0],me[1],p.lat,p.lon)>CFG.maxDist)){toast(`You need to be within ${CFG.maxDist} m of ${p.name} to report.`);return}
 const c=$("#sheetbody");c.innerHTML=`<h2>${esc(p.name)}</h2><div class="sub">Where are you waiting?</div><div class="grid" style="grid-template-columns:1fr 1fr"><button data-m="drive_thru">🚗 Drive-thru</button><button data-m="inside">🚶 Inside</button></div><button class="big ghost" id="cls">Cancel</button>`;
 $("#cls").onclick=close;c.querySelectorAll("[data-m]").forEach(b=>b.onclick=()=>step2(p,b.dataset.m))}
function step2(p,mode){const c=$("#sheetbody");let cars=null;
 c.innerHTML=`<h2>${mode==="drive_thru"?"🚗 Drive-thru":"🚶 Inside"} wait</h2><div class="sub">How's the wait? Tap one — that's it.</div><div class="grid">${[[0,"No wait"],[5,"~5"],[10,"~10"],[15,"~15"],[20,"20+"]].map(([v,l])=>`<button data-w="${v}">${l}${v?" min":""}</button>`).join("")}</div>
 ${mode==="drive_thru"?`<div class="sub">Cars in line (optional)</div><div class="grid" style="grid-template-columns:repeat(5,1fr)">${[1,3,5,8,12].map(n=>`<button data-c="${n}">${n===12?"12+":n}</button>`).join("")}</div><div class="sub">Pick cars first, then the wait.</div>`:""}<button class="big ghost" id="cls">Cancel</button>`;
 $("#cls").onclick=close;
 c.querySelectorAll("[data-c]").forEach(b=>b.onclick=()=>{c.querySelectorAll("[data-c]").forEach(x=>x.classList.remove("on"));b.classList.add("on");cars=+b.dataset.c});
 c.querySelectorAll("[data-w]").forEach(b=>b.onclick=async()=>{const pos=me||[p.lat,p.lon];
  const r=await post("/api/report",{place_id:p.id,mode,wait_min:+b.dataset.w,cars,lat:pos[0],lon:pos[1],dev});
  if(r.ok){p.status=r.status;toast("Thanks! Report added.");close();render();setTimeout(()=>stillWaiting(p,mode),10*60000)}else toast(r.error)})}
async function post(u,b){try{const r=await fetch(u,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...b,device})});return await r.json()}catch(e){return{error:"Network error"}}}
async function load(center,tries=0,radius=CFG.radius){if(!loaded){$("#items").innerHTML='<li class="msg">Loading places…</li>'}
 try{const r=await fetch(`/api/places?lat=${center[0]}&lon=${center[1]}&radius=${Math.round(radius)}`);const d=await r.json();
  if(d.places&&d.places.length){places=d.places;loaded=true;render();return}
  if(tries<3){$("#items").innerHTML='<li class="msg">Still loading places… (map data service is slow)</li>';setTimeout(()=>load(center,tries+1,radius),4000*(tries+1));return}
  loaded=true;render()}
 catch(e){if(tries<3){$("#items").innerHTML='<li class="msg">Waking up the server…</li>';setTimeout(()=>load(center,tries+1,radius),5000);return}
  loaded=true;render();toast("Couldn't load places")}}
let follow=true,watchId=null,accCircle=null,firstFix=true,dwell=null;
const DWELL_M=75,DWELL_MS=+(new URLSearchParams(location.search).get("dwellms")||90000),ASK_GAP=3600000;
function asked(){try{return JSON.parse(localStorage.getItem("asked")||"{}")}catch(e){return{}}}
function markAsked(id,ms){const a=asked();a[id]=Date.now()+ms;localStorage.setItem("asked",JSON.stringify(a))}
let lastAcc=999;setInterval(()=>me&&checkDwell(lastAcc),+(new URLSearchParams(location.search).get("dwellms")?2000:15000));
function onPos(pos){const c=pos.coords;lastAcc=c.accuracy;me=[c.latitude,c.longitude];
 if(!meDot){meDot=L.circleMarker(me,{radius:8,color:"#fff",weight:3,fillColor:"#0a84ff",fillOpacity:1,className:"me"}).addTo(map);
  accCircle=L.circle(me,{radius:c.accuracy,color:"#0a84ff",weight:0,fillOpacity:.12,interactive:false}).addTo(map)}
 else{meDot.setLatLng(me);accCircle.setLatLng(me).setRadius(c.accuracy)}
 if(firstFix){firstFix=false;map.setView(me,15);loadView()}else if(follow)map.panTo(me,{animate:true});
 checkDwell(c.accuracy)}
function checkDwell(acc){if(acc>100||!places.length||!$("#sheet").classList.contains("hidden"))return;
 let near=null,nd=1e9;for(const p of places){const d=hav(me[0],me[1],p.lat,p.lon);if(d<nd){nd=d;near=p}}
 if(!near||nd>DWELL_M){dwell=null;return}
 if((asked()[near.id]||0)>Date.now())return;
 if(!dwell||dwell.id!==near.id){dwell={id:near.id,t:Date.now()};return}
 if(Date.now()-dwell.t>=DWELL_MS){dwell=null;askCheckin(near)}}
function askCheckin(p){const c=$("#sheetbody");markAsked(p.id,ASK_GAP);
 c.innerHTML=`<div class="ci">📍</div><h2>Are you at ${esc(p.name)}?</h2><div class="sub">Share the wait and help people nearby.</div><div class="grid" style="grid-template-columns:1fr 1fr"><button id="ciNo">No</button><button id="ciYes" class="on">Yes</button></div>`;
 $("#sheet").classList.remove("hidden");
 $("#ciNo").onclick=()=>{markAsked(p.id,6*ASK_GAP);close()};
 $("#ciYes").onclick=()=>{p.drive_thru?reportFlow(p):step2(p,"inside")}}
function stillWaiting(p,mode){if(!me||hav(me[0],me[1],p.lat,p.lon)>DWELL_M)return;const c=$("#sheetbody");
 c.innerHTML=`<h2>Still waiting at ${esc(p.name)}?</h2><div class="sub">Update the wait if it changed.</div><div class="grid" style="grid-template-columns:1fr 1fr"><button id="swNo">I'm done</button><button id="swYes" class="on">Update</button></div>`;
 $("#sheet").classList.remove("hidden");$("#swNo").onclick=close;$("#swYes").onclick=()=>step2(p,mode)}
function locate(){follow=true;$("#locate").classList.add("on");if(me)map.setView(me,Math.max(map.getZoom(),15));
 if(watchId!=null)return;if(!navigator.geolocation){loadView();return}
 watchId=navigator.geolocation.watchPosition(onPos,()=>{if(firstFix){firstFix=false;toast("Location off — showing Menifee");loadView()}},{enableHighAccuracy:true,maximumAge:5000,timeout:15000})}
map.on("dragstart",()=>{follow=false;$("#locate").classList.remove("on")});
$("#locate").onclick=locate;
const LS=$("#list");$("#grab").onclick=()=>LS.classList.toggle("full");
{let y0=null;$("#grab").addEventListener("touchstart",e=>{y0=e.touches[0].clientY},{passive:true});
 $("#grab").addEventListener("touchend",e=>{if(y0==null)return;const dy=e.changedTouches[0].clientY-y0;if(dy<-30)LS.classList.add("full");else if(dy>30)LS.classList.remove("full");y0=null})}
document.querySelectorAll("#filter button").forEach(b=>b.onclick=()=>{document.querySelectorAll("#filter button").forEach(x=>x.classList.remove("on"));b.classList.add("on");filter=b.dataset.f;render()});
document.querySelectorAll("#sort button").forEach(b=>b.onclick=()=>{document.querySelectorAll("#sort button").forEach(x=>x.classList.remove("on"));b.classList.add("on");sortBy=b.dataset.s;render()});
$("#search").oninput=e=>{q=e.target.value.toLowerCase().trim();render()};
if(location.hash==="#list")LS.classList.add("full");
let mvT=null,lastC=null,tooFar=false;function loadView(){const c=map.getCenter(),b=map.getBounds();const r=c.distanceTo(b.getNorthEast());
 if(r>CFG.maxRadius){tooFar=true;markers.forEach(m=>m.remove());markers=[];$("#items").innerHTML='<li class="msg">Zoom in to see restaurants</li>';return}
 tooFar=false;lastC=[c.lat,c.lng,Math.max(500,r)];load(lastC.slice(0,2),0,lastC[2])}
map.on("moveend",()=>{clearTimeout(mvT);mvT=setTimeout(loadView,700)});
setInterval(()=>tooFar?0:lastC?load(lastC.slice(0,2),0,lastC[2]):load(me||CFG.fallback),60000);
locate();
if("serviceWorker" in navigator)navigator.serviceWorker.register("sw.js");
