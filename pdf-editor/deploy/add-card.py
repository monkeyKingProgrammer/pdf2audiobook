from pathlib import Path
from datetime import datetime, timezone
import shutil

path = Path('/var/www/weiwei-root/index.html')
html = path.read_text()
if 'https://pdfeditor.weiwei.website' not in html:
    anchor = '      <div class="grid">'
    if anchor not in html:
        raise RuntimeError('Tool directory anchor not found')
    card = '''
        <article class="card">
          <div class="meta">Document Tool</div>
          <h3>Folio PDF Editor</h3>
          <p>Edit PDF text, permanently redact content, remove images, rotate pages, and save a clean copy.</p>
          <a class="button secondary" href="https://pdfeditor.weiwei.website">pdfeditor.weiwei.website</a>
        </article>'''
    backup = path.with_name('index.before-folio-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '.html')
    shutil.copy2(path, backup)
    path.write_text(html.replace(anchor, anchor + card, 1))
    print('Added tool card. Backup:', backup)
else:
    print('Tool already listed.')
