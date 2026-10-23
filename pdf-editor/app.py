import io
import time
import secrets
import threading
from pathlib import Path
import pymupdf as fitz
from fastapi import FastAPI, UploadFile, HTTPException
from fastapi.responses import Response, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

app = FastAPI(docs_url=None, redoc_url=None)
sessions = {}
lock = threading.RLock()
MAX_SIZE = 40 * 1024 * 1024
TTL = 3600

def expire_sessions():
    while True:
        time.sleep(60)
        with lock:
            cutoff = time.time() - TTL
            for key in list(sessions):
                if sessions[key]['time'] < cutoff:
                    del sessions[key]

threading.Thread(target=expire_sessions, daemon=True).start()

def get_session(token):
    now = time.time()
    for key in list(sessions):
        if now - sessions[key]['time'] > TTL:
            del sessions[key]
    if token not in sessions:
        raise HTTPException(404, 'Document expired. Please reopen your PDF.')
    sessions[token]['time'] = now
    return sessions[token]

def snapshot(doc):
    return doc.tobytes(garbage=4, deflate=True, clean=True)

@app.get('/api/health')
def health():
    return {'ok': True}

@app.post('/api/documents')
async def upload(file: UploadFile):
    raw = await file.read(MAX_SIZE + 1)
    if len(raw) > MAX_SIZE:
        raise HTTPException(413, 'Please choose a PDF smaller than 40 MB.')
    try:
        with fitz.open(stream=raw, filetype='pdf') as doc:
            if doc.needs_pass:
                raise HTTPException(400, 'Unlock this password-protected PDF before opening it.')
            if not len(doc) or len(doc) > 1000:
                raise HTTPException(400, 'Choose a PDF with 1–1000 pages.')
            for page in doc:
                if page.rotation:
                    page.remove_rotation()
            raw = snapshot(doc)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(400, 'This file could not be opened as a PDF.')
    token = secrets.token_urlsafe(24)
    with lock:
        get_session_cleanup = time.time()
        for key in list(sessions):
            if get_session_cleanup - sessions[key]['time'] > TTL:
                del sessions[key]
        if sum(len(s['data']) for s in sessions.values()) + len(raw) > 250 * 1024 * 1024:
            raise HTTPException(503, 'The editor is busy. Please try again shortly.')
        sessions[token] = {'data': raw, 'history': [], 'time': time.time(), 'name': file.filename or 'document.pdf'}
    return {'id': token, **document_info(token)}

def document_info(token):
    session = get_session(token)
    with fitz.open(stream=session['data'], filetype='pdf') as doc:
        return {'name': session['name'], 'pages': len(doc), 'undo': bool(session['history'])}

@app.get('/api/documents/{token}')
def info(token: str):
    with lock:
        return document_info(token)

@app.get('/api/documents/{token}/pages/{number}')
def page_info(token: str, number: int):
    with lock:
        session = get_session(token)
        with fitz.open(stream=session['data'], filetype='pdf') as doc:
            if not 0 <= number < len(doc):
                raise HTTPException(404, 'Page not found.')
            page = doc[number]
            blocks = []
            for block in page.get_text('dict')['blocks']:
                if block['type'] == 0:
                    for line in block['lines']:
                        for span in line['spans']:
                            if span['text'].strip():
                                blocks.append({'rect': span['bbox'], 'text': span['text'], 'size': span['size'], 'color': '#%06x' % span['color']})
            images = [{'rect': list(image['bbox'])} for image in page.get_image_info() if not fitz.Rect(image['bbox']).is_empty]
            return {'width': page.rect.width, 'height': page.rect.height, 'text': blocks, 'images': images}

@app.get('/api/documents/{token}/pages/{number}/image')
def page_image(token: str, number: int, thumb: bool = False):
    with lock:
        with fitz.open(stream=get_session(token)['data'], filetype='pdf') as doc:
            if not 0 <= number < len(doc):
                raise HTTPException(404, 'Page not found.')
            page = doc[number]
            scale = min((150 if thumb else 1500) / page.rect.width, 2)
            return Response(page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False).tobytes('png'), media_type='image/png', headers={'Cache-Control': 'no-store'})

class Edit(BaseModel):
    action: str
    page: int = 0
    rect: list[float] | None = None
    text: str = Field(default='', max_length=10000)
    size: float = Field(default=12, ge=5, le=100)
    color: str = '#202625'
    fill: str = '#ffffff'

def rgb(value):
    try:
        return tuple(int(value.lstrip('#')[i:i+2], 16) / 255 for i in (0, 2, 4))
    except Exception:
        raise HTTPException(400, 'Invalid color.')

@app.post('/api/documents/{token}/edit')
def edit(token: str, operation: Edit):
    with lock:
        session = get_session(token)
        with fitz.open(stream=session['data'], filetype='pdf') as doc:
            if not 0 <= operation.page < len(doc):
                raise HTTPException(400, 'Page not found.')
            page = doc[operation.page]
            if operation.action == 'delete-page':
                if len(doc) == 1:
                    raise HTTPException(400, 'Keep at least one page in the document.')
                doc.delete_page(operation.page)
            elif operation.action == 'rotate':
                page.set_rotation(90)
                page.remove_rotation()
            else:
                if operation.action not in ['redact', 'replace', 'add-text', 'delete-image']:
                    raise HTTPException(400, 'Unknown edit action.')
                if not operation.rect or len(operation.rect) != 4:
                    raise HTTPException(400, 'Select an area on the page.')
                rect = fitz.Rect(operation.rect) & page.rect
                if rect.is_empty or rect.width < 1 or rect.height < 1:
                    raise HTTPException(400, 'Select a larger area on the page.')
                if operation.action != 'add-text':
                    page.add_redact_annot(rect, fill=rgb(operation.fill), cross_out=False)
                    page.apply_redactions(images=2, graphics=2 if operation.action == 'redact' else 0, text=0 if operation.action != 'delete-image' else 1)
                if operation.action in ['replace', 'add-text']:
                    if not operation.text.strip():
                        raise HTTPException(400, 'Enter the text to insert.')
                    if any(ord(char) > 255 for char in operation.text):
                        raise HTTPException(400, 'Text insertion currently supports Latin characters. Use plain quotation marks and hyphens.')
                    font = fitz.Font('helv')
                    single_line = '\n' not in operation.text and font.text_length(operation.text, fontsize=operation.size) <= rect.width and rect.height >= operation.size * (font.ascender - font.descender)
                    if single_line:
                        page.insert_text((rect.x0, rect.y0 + operation.size * font.ascender), operation.text, fontsize=operation.size, fontname='helv', color=rgb(operation.color))
                        result = 0
                    else:
                        result = page.insert_textbox(rect, operation.text, fontsize=operation.size, fontname='helv', color=rgb(operation.color), lineheight=1)
                    if result < 0:
                        raise HTTPException(400, 'The text does not fit. Enlarge the selection or reduce the font size.')
            updated = snapshot(doc)
        session['history'].append(session['data'])
        while len(session['history']) > 10 or (len(session['history']) > 1 and sum(map(len, session['history'])) > 60 * 1024 * 1024):
            session['history'].pop(0)
        session['data'] = updated
        return document_info(token)

@app.post('/api/documents/{token}/undo')
def undo(token: str):
    with lock:
        session = get_session(token)
        if session['history']:
            session['data'] = session['history'].pop()
        return document_info(token)

@app.get('/api/documents/{token}/download')
def download(token: str):
    with lock:
        # A fresh rewrite excludes undo snapshots and unreachable PDF objects.
        with fitz.open(stream=get_session(token)['data'], filetype='pdf') as doc:
            doc.set_metadata({})
            if doc.get_xml_metadata():
                doc.del_xml_metadata()
            data = snapshot(doc)
        return Response(data, media_type='application/pdf', headers={'Content-Disposition': 'attachment; filename="edited-document.pdf"', 'Cache-Control': 'no-store'})

@app.delete('/api/documents/{token}')
def close(token: str):
    with lock:
        sessions.pop(token, None)
    return {'ok': True}

app.mount('/', StaticFiles(directory=Path(__file__).parent / 'static', html=True), name='static')
