'use strict';
const $ = id => document.getElementById(id);
const state = {original:null, corrected:null, mode:'normal', sample:false, revision:0, correctedRevision:0, busy:false, request:null};
const notes = {
  normal:'Original colors, with no simulation applied.',
  deuteranopia:'Approximate view with absent medium-wavelength (M) cone function.',
  protanopia:'Approximate view with absent long-wavelength (L) cone function.',
  tritanopia:'Approximate severe blue-yellow deficiency view; this model does not precisely represent tritanopia.'
};
function status(message, kind='') { $('status').textContent=message; $('status').className='status '+kind; }
function controls() {
  $('fix').disabled=!state.original || ! $('endpoint').value.trim() || state.busy;
  $('fix').textContent=state.busy?'Recoloring…':'Recolor chart →';
  $('corrected-upload').disabled=!state.original || state.busy;
  $('download').disabled=!state.corrected;
  $('source-badge').textContent=state.sample?'Prepared sample':state.original?'Your chart':'No image loaded';
}
function renderOne(id, item) {
  const canvas=$(id); canvas.hidden=!item;
  $(id==='before'?'before-empty':'after-empty').hidden=!!item;
  if (!item) return;
  canvas.width=item.width; canvas.height=item.height;
  const pixels=ChartSafeSimulation.simulate(item.pixels.data,state.mode);
  canvas.getContext('2d').putImageData(new ImageData(pixels,item.width,item.height),0,0);
  canvas.setAttribute('aria-label',`${id==='before'?'Original':'Recolored'} chart, ${state.mode==='normal'?'normal vision':state.mode+' simulation'}. Visual chart preview; data transcription is not available.`);
}
function render() {
  renderOne('before',state.original); renderOne('after',state.corrected);
  $('vision-note').textContent=notes[state.mode];
  $('original-meta').textContent=state.original?`${state.original.width} × ${state.original.height}`:'Awaiting PNG';
  $('corrected-meta').textContent=state.corrected?(state.sample?'Prepared example':'PNG loaded'):'Awaiting result';
  controls();
}
async function decodePNG(blob, name='chart.png') {
  if (!blob.size || blob.size>10*1024*1024) throw new Error('Choose a non-empty PNG up to 10 MB.');
  const header=new Uint8Array(await blob.slice(0,24).arrayBuffer());
  if (![137,80,78,71,13,10,26,10].every((v,i)=>header[i]===v) || header.length<24) throw new Error('This file is not a PNG. Export your chart as PNG and try again.');
  const view=new DataView(header.buffer); const width=view.getUint32(16), height=view.getUint32(20);
  if (!width || !height || width*height>8000000 || width>8192 || height>8192) throw new Error('Choose a PNG up to 8 megapixels and 8192 pixels per side.');
  const bitmap=await createImageBitmap(blob);
  try {
    const c=document.createElement('canvas'); c.width=bitmap.width;c.height=bitmap.height;
    const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(bitmap,0,0);
    return {width:c.width,height:c.height,pixels:ctx.getImageData(0,0,c.width,c.height),blob,name};
  } finally { bitmap.close(); }
}
function invalidate() {
  state.revision++; state.correctedRevision++; state.request?.abort(); state.request=null; state.busy=false;
}
async function loadOriginal(file) {
  if (!file) return;
  invalidate();const rev=state.revision;
  // Clear immediately: a rejected upload must not leave an old correction looking current.
  state.original=null; state.corrected=null;state.sample=false;render();status('Opening PNG…','busy');
  try {const item=await decodePNG(file,file.name);if(rev!==state.revision)return;state.original=item;render();status('Chart loaded. Switch views or add a corrected PNG.');}
  catch(e){if(rev===state.revision){render();status(e.message,'error');}}
}
async function loadCorrected(file) {
  if (!file || !state.original || state.busy)return;
  const rev=state.revision, ticket=++state.correctedRevision;
  state.corrected=null;render();
  try {
    const item=await decodePNG(file,file.name);
    if(rev!==state.revision || ticket!==state.correctedRevision)return;
    if(item.width!==state.original.width || item.height!==state.original.height)throw new Error('The corrected PNG must have the same dimensions as the original.');
    state.corrected=item;state.sample=false;render();status('Corrected PNG loaded. Compare the colors and check that the chart data still matches.');
  } catch(e){if(rev===state.revision && ticket===state.correctedRevision)status(e.message,'error');}
}
function drawSample(colors) {
  const c=document.createElement('canvas');c.width=960;c.height=640;const x=c.getContext('2d');
  x.fillStyle='#fff';x.fillRect(0,0,960,640);x.fillStyle='#253b36';x.font='bold 30px Arial';x.fillText('Community workshop attendance',70,66);x.fillStyle='#64736c';x.font='18px Arial';x.fillText('Illustrative data · participants per month',70,99);
  for(let n=0;n<=100;n+=25){const y=510-n*3.2;x.strokeStyle='#e5e8e4';x.lineWidth=1;x.beginPath();x.moveTo(95,y);x.lineTo(890,y);x.stroke();x.fillStyle='#63716a';x.font='17px Arial';x.fillText(n,48,y+6);}
  const data=[[50,70],[65,60],[75,90],[90,80]];
  data.forEach((values,i)=>{values.forEach((v,j)=>{x.fillStyle=colors[j];x.fillRect(145+i*190+j*57,510-v*3.2,44,v*3.2);});x.fillStyle='#45564e';x.font='19px Arial';x.fillText(['Jan','Feb','Mar','Apr'][i],165+i*190,543);});
  ['Workshop A','Workshop B'].forEach((label,i)=>{x.fillStyle=colors[i];x.fillRect(255+i*245,588,18,18);x.fillStyle='#394b42';x.font='19px Arial';x.fillText(label,284+i*245,604);});
  return new Promise(resolve=>c.toBlob(resolve,'image/png'));
}
async function sample() {
  invalidate();const rev=state.revision;state.original=null;state.corrected=null;state.sample=true;render();status('Preparing example…','busy');
  try {
    const blobs=await Promise.all([drawSample(['#c45c50','#729545']),drawSample(['#0072b2','#e69f00'])]);
    const images=await Promise.all(blobs.map((b,i)=>decodePNG(b,i?'sample-recolored.png':'sample-original.png')));
    if(rev!==state.revision)return;[state.original,state.corrected]=images;render();
    status('Sample pair loaded: the same chart with two prepared palettes. No automatic correction was run.');
  } catch(e){if(rev===state.revision)status(e.message,'error');}
}
async function fix() {
  if(!state.original || state.busy)return;
  let endpoint;
  try {endpoint=new URL($('endpoint').value.trim());if(!['http:','https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password)throw new Error();}
  catch{status('Enter a full HTTP or HTTPS API endpoint without credentials.','error');return;}
  if(location.protocol==='https:' && endpoint.protocol==='http:'){status('This page uses HTTPS. Use an HTTPS API, or run both frontend and API locally over HTTP.','error');return;}
  const rev=state.revision;const request=new AbortController();state.request=request;state.busy=true;state.corrected=null;state.correctedRevision++;render();status('Sending your chart to the recoloring service…','busy');
  const timer=setTimeout(()=>request.abort(),90000);
  try {
    const body=new FormData();body.append('image',state.original.blob,state.original.name);
    const response=await fetch(endpoint.href,{method:'POST',body,signal:request.signal,credentials:'omit'});
    if(!response.ok)throw new Error(`Service returned HTTP ${response.status}. Ask your teammate to check the backend logs.`);
    if(!(response.headers.get('content-type')||'').toLowerCase().startsWith('image/png'))throw new Error('The service must return an image/png response. Check docs/INTEGRATION.md with Deb.');
    const item=await decodePNG(await response.blob(),'corrected.png');
    if(rev!==state.revision)return;
    if(item.width!==state.original.width || item.height!==state.original.height)throw new Error('The service changed the image dimensions. Expected a PNG matching the original size.');
    state.corrected=item;state.sample=false;status('Recolored PNG received. Compare the views and check the chart data.');
  } catch(e){if(rev===state.revision)status(e.name==='AbortError'?'The service timed out after 90 seconds. Try again once the backend is ready.':e instanceof TypeError?'Could not reach the service. Check its address, that it is running, and its CORS settings.':e.message,'error');}
  finally {clearTimeout(timer);if(rev===state.revision){state.busy=false;state.request=null;render();}}
}
$('upload').addEventListener('change',e=>{loadOriginal(e.target.files[0]);e.target.value='';});
$('corrected-upload').addEventListener('change',e=>{loadCorrected(e.target.files[0]);e.target.value='';});
$('sample').addEventListener('click',sample);$('fix').addEventListener('click',fix);$('endpoint').addEventListener('input',controls);
document.querySelectorAll('input[name="vision"]').forEach(r=>r.addEventListener('change',()=>{state.mode=r.value;render();}));
['dragenter','dragover'].forEach(event=>$('dropzone').addEventListener(event,e=>{e.preventDefault();$('dropzone').classList.add('dragging');}));
['dragleave','drop'].forEach(event=>$('dropzone').addEventListener(event,e=>{e.preventDefault();$('dropzone').classList.remove('dragging');}));
$('dropzone').addEventListener('drop',e=>loadOriginal(e.dataTransfer.files[0]));
window.addEventListener('dragover',e=>e.preventDefault());window.addEventListener('drop',e=>e.preventDefault());
$('download').addEventListener('click',()=>{if(!state.corrected)return;const url=URL.createObjectURL(state.corrected.blob);const a=document.createElement('a');a.href=url;a.download='chartsafe-corrected.png';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
render();
