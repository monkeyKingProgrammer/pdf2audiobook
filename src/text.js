export function cleanPageText(value) {
  return value
    .replace(/([a-z])[-\u00ad]\s*\n\s*([a-z])/gi, '$1$2')
    .replace(/\r/g, '')
    .replace(/([^.!?:;])\n(?=[a-z“‘(])/g, '$1 ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ +\n/g, '\n')
    .trim();
}

export function normalizeBookText(pages) {
  const cleaned = pages.map((page) => cleanPageText(page)).filter(Boolean);
  const edgeLines = new Map();
  cleaned.forEach((page) => {
    const lines = page.split('\n').map((line) => line.trim()).filter(Boolean);
    [...lines.slice(0, 2), ...lines.slice(-2)].forEach((line) => {
      if (line.length < 90) edgeLines.set(line, (edgeLines.get(line) || 0) + 1);
    });
  });
  const repeatThreshold = Math.max(3, Math.ceil(cleaned.length * 0.35));
  return cleaned.map((page) => page
    .split('\n')
    .filter((line) => (edgeLines.get(line.trim()) || 0) < repeatThreshold)
    .join('\n'))
    .join('\n\n')
    .replace(/\n\s*\d{1,4}\s*\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function chunkText(text, limit = 2800) {
  const source = text.trim();
  if (!source) return [];
  const paragraphs = source.split(/\n{2,}/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const chunks = [];
  let current = '';

  const push = () => { if (current) chunks.push(current.trim()); current = ''; };
  for (const paragraph of paragraphs) {
    const sentences = paragraph.match(/[^.!?]+[.!?]+[”’\"]?|[^.!?]+$/g) || [paragraph];
    for (let sentence of sentences) {
      sentence = sentence.trim();
      while (sentence.length > limit) {
        push();
        let cut = sentence.lastIndexOf(' ', limit);
        if (cut < limit * 0.55) cut = limit;
        chunks.push(sentence.slice(0, cut).trim());
        sentence = sentence.slice(cut).trim();
      }
      if (current && current.length + sentence.length + 1 > limit) push();
      current += `${current ? ' ' : ''}${sentence}`;
    }
    if (current && current.length > limit * 0.72) push();
  }
  push();
  return chunks;
}

export function estimateMinutes(text, wordsPerMinute = 155) {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return Math.max(1, Math.round(words / wordsPerMinute));
}

export function selectPageRange(pages, from, to) {
  if (!pages.length) return [];
  const start = Math.max(1, Math.min(pages.length, Math.floor(Number(from) || 1)));
  const end = Math.max(start, Math.min(pages.length, Math.floor(Number(to) || pages.length)));
  return pages.slice(start - 1, end);
}
