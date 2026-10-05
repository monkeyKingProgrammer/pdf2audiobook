import fs from 'node:fs';

const target = process.argv[2];
if (!target) throw new Error('Usage: node add-main-site-card.mjs /path/to/index.html');

const href = 'https://pdf2audiobook.weiwei.website';
const html = fs.readFileSync(target, 'utf8');
if (html.includes(href)) {
  console.log('PDF to Audiobook card already exists.');
  process.exit(0);
}

const anchor = `        <article class="card">
          <div class="meta">Wei Platform</div>`;
const card = `        <article class="card">
          <div class="meta">Document &amp; Audio Tool</div>
          <h3>PDF to Audiobook</h3>
          <p>Turn clear PDFs or scanned books into natural-sounding audio, with OCR and page-range processing.</p>
          <a class="button secondary" href="${href}">pdf2audiobook.weiwei.website</a>
        </article>
`;

if (!html.includes(anchor)) throw new Error('Could not find the Wei Platform card insertion point.');
fs.writeFileSync(target, html.replace(anchor, card + anchor), 'utf8');
console.log('Added PDF to Audiobook card.');
