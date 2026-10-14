const CFG={appName:"WaitLess",fallback:[33.6971,-117.1853]/*Menifee CA*/,radius:3000,maxDist:300};
const dev=new URLSearchParams(location.search).get("dev")==="1";
const $=s=>document.querySelector(s);
let device=localStorage.getItem("dev_id");if(!device){device=(crypto.randomUUID?crypto.randomUUID():Math.random().toString(36).slice(2)+Date.now().toString(36));localStorage.setItem("dev_id",device)}
let me=null,places=[],filter="all",sortBy="wait",q="",markers=[];
const map=L.map("map",{zoomControl:false}).setView(CFG.fallback,14);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:"© OpenStreetMap"}).addTo(map);
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
function visible(){return places.filter(p=>(filter==="all"||p.kind===filter)&&(!q||p.name.toLowerCase().includes(q)))}
function render(){
 markers.forEach(m=>m.remove());markers=[];
 for(const p of visible()){const b=best(p);const c=b==null?"#c7c7cc":getComputedStyle(document.body).getPropertyValue(`--${color(b)}`);
  const m=L.marker([p.lat,p.lon],{icon:L.divIcon({className:"",html:`<div class="dot" style="background:${c}"></div>`,iconSize:[22,22]})}).addTo(map).on("click",()=>openPlace(p));markers.push(m)}
 const items=visible().slice().sort((a,b)=>sortBy==="dist"?a.distance_m-b.distance_m:((best(a)??999)-(best(b)??999))||a.distance_m-b.distance_m);
 $("#items").innerHTML=items.map(p=>`<li data-id="${p.id}"><div><div class="nm">${esc(p.name)}</div><div class="sub">${kindName(p.kind)} · ${dist(p.distance_m)}</div></div><div class="pills">${pill(p.status.drive_thru,"drive-thru",p)}${pill(p.status.inside,"inside",p)}${!p.status.drive_thru&&!p.status.inside&&p.typical_min==null?"No recent reports":""}</div></li>`).join("")||"<li>No places found.</li>";
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
 c.innerHTML=`<h2>${mode==="drive_thru"?"🚗 Drive-thru":"🚶 Inside"} wait</h2><div class="sub">Tap the wait — that's it.</div><div class="grid">${[[0,"None"],[5,"~5"],[10,"~10"],[15,"~15"],[20,"~20"],[30,"30+"]].map(([v,l])=>`<button data-w="${v}">${l}${v?" min":""}</button>`).join("")}</div>
 ${mode==="drive_thru"?`<div class="sub">Cars in line (optional)</div><div class="grid" style="grid-template-columns:repeat(5,1fr)">${[1,3,5,8,12].map(n=>`<button data-c="${n}">${n===12?"12+":n}</button>`).join("")}</div><div class="sub">Pick cars first, then the wait.</div>`:""}<button class="big ghost" id="cls">Cancel</button>`;
 $("#cls").onclick=close;
 c.querySelectorAll("[data-c]").forEach(b=>b.onclick=()=>{c.querySelectorAll("[data-c]").forEach(x=>x.classList.remove("on"));b.classList.add("on");cars=+b.dataset.c});
 c.querySelectorAll("[data-w]").forEach(b=>b.onclick=async()=>{const pos=me||[p.lat,p.lon];
  const r=await post("/api/report",{place_id:p.id,mode,wait_min:+b.dataset.w,cars,lat:pos[0],lon:pos[1],dev});
  if(r.ok){p.status=r.status;toast("Thanks! Report added.");close();render()}else toast(r.error)})}
async function post(u,b){try{const r=await fetch(u,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...b,device})});return await r.json()}catch(e){return{error:"Network error"}}}
async function load(center){try{const r=await fetch(`/api/places?lat=${center[0]}&lon=${center[1]}&radius=${CFG.radius}`);places=(await r.json()).places||[];render()}catch(e){toast("Couldn't load places")}}
function locate(){if(!navigator.geolocation){load(CFG.fallback);return}
 navigator.geolocation.getCurrentPosition(p=>{me=[p.coords.latitude,p.coords.longitude];map.setView(me,15);
  if(meDot)meDot.remove();meDot=L.circleMarker(me,{radius:8,color:"#fff",weight:3,fillColor:"#0a84ff",fillOpacity:1}).addTo(map);load(me)},
  ()=>{toast("Location off — showing Menifee");load(CFG.fallback)},{enableHighAccuracy:true,timeout:8000})}
$("#locate").onclick=locate;
document.querySelectorAll("nav button").forEach(b=>b.onclick=()=>{document.querySelectorAll("nav button,.view").forEach(x=>x.classList.remove("on"));b.classList.add("on");$("#"+b.dataset.v).classList.add("on");map.invalidateSize()});
document.querySelectorAll("#filter button").forEach(b=>b.onclick=()=>{document.querySelectorAll("#filter button").forEach(x=>x.classList.remove("on"));b.classList.add("on");filter=b.dataset.f;render()});
document.querySelectorAll("#sort button").forEach(b=>b.onclick=()=>{document.querySelectorAll("#sort button").forEach(x=>x.classList.remove("on"));b.classList.add("on");sortBy=b.dataset.s;render()});
$("#search").oninput=e=>{q=e.target.value.toLowerCase().trim();render()};
if(location.hash==="#list")document.querySelector('nav [data-v=list]').click();
setInterval(()=>load(me||CFG.fallback),60000);
locate();
if("serviceWorker" in navigator)navigator.serviceWorker.register("sw.js");
