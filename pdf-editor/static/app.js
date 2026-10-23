const $ = id => document.getElementById(id);
let doc = null, page = 0, revision = 0, tool = 'select', geometry = null, selection = null, dragging = null, zoom = 100;
let sourceFile = null, appliedEdits = [], recovery = null;
const descriptions = {
  select: ['Make it yours.', 'Click a text block to inspect it, or choose a tool above to get started.'],
  replace: ['Refine the words.', 'Click existing text to replace it. You can also draw a larger box for longer text.'],
  'add-text': ['A few new words.', 'Draw a box on the page, then type your text and choose its size.'],
  redact: ['Gone for good.', 'Draw over the content you want removed. The underlying text and covered image pixels are permanently removed from the saved copy.'],
  'delete-image': ['Keep it simple.', 'Click an image to remove its visible pixels on this page. Text overlapping the image is preserved.']
};
async function api(path, options = {}) {
  let response = await fetch('/api/' + path, options);
  if (response.status === 404 && sourceFile && path.startsWith('documents/')) {
    const detail = await response.clone().json().catch(() => ({}));
    if (detail.detail === 'Document expired. Please reopen your PDF.') {
      const expiredId = path.split('/')[1];
      await recoverDocument(expiredId);
      path = path.replace(`documents/${expiredId}`, `documents/${doc.id}`);
      response = await fetch('/api/' + path, options);
    }
  }
  if (!response.ok) { let error; try { error = (await response.json()).detail; } catch { error = 'The request could not be completed.'; } throw new Error(typeof error === 'string' ? error : 'Please check your selection and settings.'); }
  return response.json();
}
async function recoverDocument(expiredId) {
  if (doc.id !== expiredId) return;
  if (!recovery) {
    recovery = (async () => {
      const data = new FormData(); data.append('file', sourceFile);
      const response = await fetch('/api/documents', {method:'POST', body:data});
      if (!response.ok) throw new Error('Could not restore this session. Your edits have not been applied. Try again or reopen the PDF.');
      const restored = await response.json();
      for (const operation of appliedEdits) {
        const replay = await fetch(`/api/documents/${restored.id}/edit`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(operation)});
        if (!replay.ok) throw new Error('Could not restore previous edits. Reopen the PDF before continuing.');
        Object.assign(restored, await replay.json());
      }
      doc = restored; revision++;
    })().finally(() => { recovery = null; });
  }
  await recovery;
}
let noticeTimer;
function message(text, error = false) {
  clearTimeout(noticeTimer); $('notice').textContent = text; $('notice').hidden = false;
  $('notice').setAttribute('role', error ? 'alert' : 'status');
  if (!error) noticeTimer = setTimeout(() => $('notice').hidden = true, 8000);
}
async function busy(task) { $('notice').hidden = true; $('busy').hidden = false; try { await task(); } catch (error) { message(error.message, true); } finally { $('busy').hidden = true; } }
function url(number, thumb = false) { return `/api/documents/${doc.id}/pages/${number}/image?thumb=${thumb}&v=${revision}`; }
function thumbnails() {
  $('thumbnails').replaceChildren();
  for (let number = 0; number < doc.pages; number++) {
    const button = document.createElement('button'); button.className = 'thumbnail' + (number === page ? ' active' : ''); button.title = `Go to page ${number + 1}`;
    const image = document.createElement('img'); image.loading = 'lazy'; image.src = url(number, true); image.alt = `Page ${number + 1}`;
    const label = document.createElement('span'); label.textContent = String(number + 1).padStart(2, '0');
    button.append(image, label); button.onclick = () => busy(() => loadPage(number)); $('thumbnails').append(button);
  }
}
function setSelection(rect, object = null) {
  selection = rect;
  $('selected-info').hidden = !rect;
  $('edit-fields').hidden = !rect || !['replace', 'add-text'].includes(tool);
  $('fill-field').hidden = !rect || !['redact', 'replace', 'delete-image'].includes(tool);
  if (object?.text !== undefined) { $('edit-text').value = object.text; $('font-size').value = Math.max(5, Math.floor(Math.min(object.size, (rect[3] - rect[1]) / 1.375) * 10) / 10); $('text-color').value = object.color; }
  if (rect) {
    $('dimensions').textContent = `${Math.round(rect[2] - rect[0])} × ${Math.round(rect[3] - rect[1])} pt on page ${page + 1}`;
    const box = $('selection'); box.hidden = false;
    Object.assign(box.style, {left: rect[0] / geometry.width * 100 + '%', top: rect[1] / geometry.height * 100 + '%', width: (rect[2] - rect[0]) / geometry.width * 100 + '%', height: (rect[3] - rect[1]) / geometry.height * 100 + '%'});
  } else { $('selection').hidden = true; }
}
function setTool(next) {
  tool = next; setSelection(null);
  document.querySelectorAll('[data-tool]').forEach(button => button.classList.toggle('active', button.dataset.tool === tool));
  $('tool-title').textContent = descriptions[tool][0]; $('tool-help').textContent = descriptions[tool][1];
  $('tool-tip').hidden = ['redact', 'delete-image'].includes(tool);
  $('surface').style.cursor = ['redact', 'add-text', 'replace'].includes(tool) ? 'crosshair' : 'default';
  $('fill').value = tool === 'redact' ? '#151b19' : '#ffffff';
  renderObjects();
}
function renderObjects() {
  $('objects').replaceChildren(); if (!geometry) return;
  const objects = tool === 'delete-image' ? geometry.images : ['select', 'replace'].includes(tool) ? geometry.text : [];
  for (const object of objects) {
    const [x0,y0,x1,y1] = object.rect;
    const button = document.createElement('button'); button.className = 'object' + (tool === 'delete-image' ? ' image' : '');
    button.title = object.text || 'Select image to remove'; button.setAttribute('aria-label', object.text ? `Edit text: ${object.text}` : 'Select image');
    Object.assign(button.style, {left:x0/geometry.width*100+'%',top:y0/geometry.height*100+'%',width:(x1-x0)/geometry.width*100+'%',height:(y1-y0)/geometry.height*100+'%'});
    button.onpointerdown = event => event.stopPropagation();
    button.onclick = event => {
      event.stopPropagation();
      if (tool === 'select') setTool('replace');
      const rect = [...object.rect];
      setSelection(rect, object);
    };
    $('objects').append(button);
  }
}
async function loadPage(number) {
  page = Math.max(0, Math.min(number, doc.pages - 1));
  geometry = await api(`documents/${doc.id}/pages/${page}`);
  const image = new Image(); image.src = url(page); await image.decode(); $('page-image').src = image.src;
  $('surface').style.maxWidth = 780 * zoom / 100 + 'px'; $('surface').style.width = zoom > 100 ? 780 * zoom / 100 + 'px' : '100%';
  setSelection(null); renderObjects();
  $('page-label').textContent = `Page ${page + 1} of ${doc.pages}`; $('count').textContent = doc.pages;
  $('previous').disabled = page === 0; $('next').disabled = page === doc.pages - 1; $('undo').disabled = !doc.undo;
  $('delete-page').disabled = doc.pages <= 1;
  document.querySelectorAll('.thumbnail').forEach((item, index) => item.classList.toggle('active', index === page));
}
async function openFile(file) {
  if (!file) return;
  await busy(async () => {
    const data = new FormData(); data.append('file', file);
    const next = await api('documents', {method:'POST',body:data});
    if (doc) fetch(`/api/documents/${doc.id}`, {method:'DELETE'});
    doc = next; sourceFile = file; appliedEdits = []; page = 0; revision = 0;
    $('filename').textContent = doc.name; $('welcome').hidden = true; $('workspace').hidden = false; $('save').disabled = false;
    thumbnails(); await loadPage(0); setTool('select');
  });
  $('file').value = '';
}
async function mutate(operation) {
  await busy(async () => {
    const edit = {page, ...operation};
    const result = await api(`documents/${doc.id}/edit`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(edit)});
    appliedEdits.push(edit);
    doc = {...doc,...result}; revision++; thumbnails(); await loadPage(page);
    message(operation.action === 'redact' ? 'Content permanently removed from the working copy. Save a copy to download.' : 'Change applied. You can undo it before leaving.');
  });
}
$('file').onchange = event => openFile(event.target.files[0]);
$('open').onclick = () => $('file').click(); $('drop').onclick = () => $('file').click();
$('drop').onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') $('file').click(); };
$('drop').ondragover = event => {event.preventDefault(); $('drop').classList.add('dragging');};
$('drop').ondragleave = () => $('drop').classList.remove('dragging');
$('drop').ondrop = event => {event.preventDefault(); $('drop').classList.remove('dragging'); openFile(event.dataTransfer.files[0]);};
document.querySelectorAll('[data-tool]').forEach(button => button.onclick = () => setTool(button.dataset.tool));
function point(event) { const rect = $('surface').getBoundingClientRect(); return [Math.max(0,Math.min(geometry.width,(event.clientX-rect.left)/rect.width*geometry.width)),Math.max(0,Math.min(geometry.height,(event.clientY-rect.top)/rect.height*geometry.height))]; }
$('surface').onpointerdown = event => {
  if (!geometry || !['redact','add-text','replace'].includes(tool) || event.button !== 0) return;
  dragging = point(event); $('surface').setPointerCapture(event.pointerId); setSelection(null);
};
$('surface').onpointermove = event => {
  if (!dragging) return;
  const end = point(event); setSelection([Math.min(dragging[0],end[0]),Math.min(dragging[1],end[1]),Math.max(dragging[0],end[0]),Math.max(dragging[1],end[1])]);
};
$('surface').onpointerup = () => { if (dragging && selection && (selection[2]-selection[0]<3 || selection[3]-selection[1]<3)) setSelection(null); dragging = null; };
$('surface').onpointercancel = () => {dragging=null;setSelection(null);};
$('cancel-selection').onclick = () => setSelection(null);
$('apply').onclick = () => selection && mutate({action:tool==='select'?'replace':tool,rect:selection,text:$('edit-text').value,size:Number($('font-size').value),color:$('text-color').value,fill:$('fill').value});
$('delete-page').onclick = () => { if (confirm(`Delete page ${page+1} from your working copy?`)) mutate({action:'delete-page'}); };
$('rotate').onclick = () => mutate({action:'rotate'});
$('undo').onclick = () => busy(async () => { doc={...doc,...await api(`documents/${doc.id}/undo`,{method:'POST'})}; appliedEdits.pop(); revision++; thumbnails(); await loadPage(page); });
$('previous').onclick = () => busy(() => loadPage(page-1)); $('next').onclick = () => busy(() => loadPage(page+1));
function setZoom(value) {zoom=Math.max(50,Math.min(200,value));$('zoom-label').textContent=zoom+'%';$('surface').style.maxWidth=780*zoom/100+'px';$('surface').style.width=zoom>100?780*zoom/100+'px':'100%';}
$('zoom-in').onclick = () => setZoom(zoom+25); $('zoom-out').onclick = () => setZoom(zoom-25);
$('save').onclick = () => busy(async () => {
  await api(`documents/${doc.id}`);
  const response=await fetch(`/api/documents/${doc.id}/download`); if(!response.ok)throw new Error('Could not save the PDF. Your session may have expired.');
  const url=URL.createObjectURL(await response.blob()); const link=document.createElement('a');link.href=url;link.download=doc.name.replace(/\.pdf$/i,'')+'-edited.pdf';link.click();setTimeout(()=>URL.revokeObjectURL(url),5000);
});
setInterval(async () => {
  if (!doc || !sourceFile || $('busy').hidden === false) return;
  const previousId = doc.id;
  try {
    await api(`documents/${doc.id}`);
    if (doc.id !== previousId) { thumbnails(); if (!selection) await loadPage(page); }
  } catch (error) { message(error.message, true); }
}, 5 * 60 * 1000);
