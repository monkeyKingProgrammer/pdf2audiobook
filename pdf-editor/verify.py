"""Integration checks against a running editor, using disposable in-memory PDFs."""
import io
import json
import urllib.request
import pymupdf as fitz
import sys

base = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8792'

def request(path, data=None, method=None):
    payload = json.dumps(data).encode() if data is not None else None
    return urllib.request.urlopen(urllib.request.Request(base + '/api/' + path, data=payload, headers={'Content-Type': 'application/json'}, method=method)).read()

def upload(data):
    boundary = 'folio-verification-boundary'
    body = b'--' + boundary.encode() + b'\r\nContent-Disposition: form-data; name="file"; filename="verification.pdf"\r\nContent-Type: application/pdf\r\n\r\n' + data + b'\r\n--' + boundary.encode() + b'--\r\n'
    req = urllib.request.Request(base + '/api/documents', data=body, headers={'Content-Type': 'multipart/form-data; boundary=' + boundary})
    return json.load(urllib.request.urlopen(req))

source = fitz.open()
first = source.new_page(width=500, height=700)
first.insert_text((50, 70), 'CONFIDENTIAL SECRET', fontsize=16)
first.insert_text((50, 120), 'Original sentence', fontsize=12)
first.insert_text((50, 160), 'Keep this sentence', fontsize=12)
pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 80, 60), False)
pix.clear_with(120)
first.insert_image(fitz.Rect(50, 210, 210, 330), pixmap=pix)
first.insert_text((60, 250), 'Preserve overlapping text', fontsize=10)
source.new_page().insert_text((50, 70), 'DELETE THIS PAGE')
source.new_page().insert_text((50, 70), 'Final page')
document = upload(source.tobytes())
token = document['id']

def edit(**operation):
    return json.loads(request(f'documents/{token}/edit', operation))

edit(action='redact', page=0, rect=[45, 45, 300, 80], fill='#151b19')
edit(action='replace', page=0, rect=[45, 100, 300, 130], text='Revised sentence', size=12)
edit(action='delete-image', page=0, rect=[50, 210, 210, 330])
result = edit(action='delete-page', page=1)
assert result['pages'] == 2
saved = request(f'documents/{token}/download')
with fitz.open(stream=saved, filetype='pdf') as result:
    text = ''.join(page.get_text() for page in result)
    assert 'CONFIDENTIAL' not in text and 'SECRET' not in text
    assert 'Original sentence' not in text
    assert 'Revised sentence' in text and 'Keep this sentence' in text
    assert 'Preserve overlapping text' in text
    assert 'DELETE THIS PAGE' not in text and len(result) == 2
    assert not result[0].get_image_info(), 'Removed image is still present'
    print('PASS: permanent text removal, text replacement, image removal, page deletion, fresh PDF export')
undo = json.loads(request(f'documents/{token}/undo', method='POST'))
assert undo['pages'] == 3
edit(action='rotate', page=0)
page = json.loads(request(f'documents/{token}/pages/0'))
assert page['width'] == 700 and page['height'] == 500
request(f'documents/{token}', method='DELETE')
print('PASS: undo restores page; rotation normalizes page coordinates; session closes')
