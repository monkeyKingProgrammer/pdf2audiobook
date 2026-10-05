import { useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { createWorker } from 'tesseract.js';
import {
  BookOpen, Check, ChevronDown, CircleAlert, Download, FileAudio, FileText,
  Gauge, Headphones, LoaderCircle, Pause, Play, RotateCcw, ScanText, Settings2,
  Sparkles, Upload, WandSparkles, X,
} from 'lucide-react';
import { chunkText, estimateMinutes, normalizeBookText } from './text.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = `${new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()}?module=1`;

const curatedEdgeVoices = [
  ['en-US-AvaMultilingualNeural', 'Ava', 'Warm, expressive · US'],
  ['en-US-AndrewMultilingualNeural', 'Andrew', 'Calm, grounded · US'],
  ['en-US-EmmaMultilingualNeural', 'Emma', 'Bright, conversational · US'],
  ['en-US-BrianMultilingualNeural', 'Brian', 'Natural, confident · US'],
  ['en-GB-SoniaNeural', 'Sonia', 'Clear, composed · UK'],
  ['en-GB-RyanNeural', 'Ryan', 'Rich, relaxed · UK'],
  ['ms-MY-YasminNeural', 'Yasmin', 'Natural · Malay'],
  ['ms-MY-OsmanNeural', 'Osman', 'Natural · Malay'],
  ['zh-CN-XiaoxiaoNeural', 'Xiaoxiao', 'Warm · Mandarin'],
].map(([id, name, description]) => ({ id, name, description }));

const openAIVoices = [
  ['marin', 'Marin', 'Natural and articulate'], ['cedar', 'Cedar', 'Warm and grounded'],
  ['coral', 'Coral', 'Friendly and expressive'], ['onyx', 'Onyx', 'Deep and measured'],
  ['nova', 'Nova', 'Bright and energetic'], ['sage', 'Sage', 'Balanced and calm'],
].map(([id, name, description]) => ({ id, name, description }));

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  return `${m}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

function fileTitle(name = '') {
  return name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractPageText(content) {
  let text = '';
  for (const item of content.items) {
    if (!('str' in item)) continue;
    text += item.str;
    text += item.hasEOL ? '\n' : ' ';
  }
  return text.replace(/ +\n/g, '\n').trim();
}

async function renderPageForOcr(page) {
  const viewport = page.getViewport({ scale: 2.15 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  await page.render({ canvasContext: context, viewport }).promise;
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < image.data.length; i += 4) {
    const gray = image.data[i] * 0.299 + image.data[i + 1] * 0.587 + image.data[i + 2] * 0.114;
    const boosted = Math.max(0, Math.min(255, (gray - 128) * 1.32 + 128));
    image.data[i] = image.data[i + 1] = image.data[i + 2] = boosted;
  }
  context.putImageData(image, 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

function Step({ number, label, active, complete }) {
  return <div className={`step ${active ? 'active' : ''} ${complete ? 'complete' : ''}`}>
    <span className="step-dot">{complete ? <Check size={14} strokeWidth={3} /> : number}</span>
    <span>{label}</span>
  </div>;
}

function App() {
  const [stage, setStage] = useState('upload');
  const [file, setFile] = useState(null);
  const [filePageCount, setFilePageCount] = useState(0);
  const [inspecting, setInspecting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [ocrMode, setOcrMode] = useState('auto');
  const [ocrLanguage, setOcrLanguage] = useState('eng');
  const [progress, setProgress] = useState({ page: 0, total: 0, message: '' });
  const [pages, setPages] = useState([]);
  const [bookText, setBookText] = useState('');
  const [error, setError] = useState('');
  const [provider, setProvider] = useState('edge');
  const [voice, setVoice] = useState('en-US-AvaMultilingualNeural');
  const [rate, setRate] = useState(-5);
  const [apiKey, setApiKey] = useState('');
  const [endpoint, setEndpoint] = useState('http://127.0.0.1:8000/v1/audio/speech');
  const [customModel, setCustomModel] = useState('tts-1');
  const [instructions, setInstructions] = useState('Read like a warm, engaging audiobook narrator. Use natural pacing and subtle emotion.');
  const [scope, setScope] = useState('whole');
  const [pageFrom, setPageFrom] = useState(1);
  const [pageTo, setPageTo] = useState(1);
  const [audioUrls, setAudioUrls] = useState({});
  const [generating, setGenerating] = useState(null);
  const [buildProgress, setBuildProgress] = useState(null);
  const [currentChunk, setCurrentChunk] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const fileInput = useRef(null);
  const audio = useRef(null);
  const cancelled = useRef(false);

  const narrationText = bookText;
  const chunks = useMemo(() => chunkText(narrationText, provider === 'edge' ? 2600 : 3800), [narrationText, provider]);
  const words = useMemo(() => bookText.trim() ? bookText.trim().split(/\s+/).length : 0, [bookText]);
  const voices = provider === 'openai' ? openAIVoices : curatedEdgeVoices;
  const title = fileTitle(file?.name) || 'Untitled book';

  useEffect(() => {
    return () => Object.values(audioUrls).forEach((url) => URL.revokeObjectURL(url));
  }, []); // URLs are cleaned when the app unmounts.

  useEffect(() => {
    setAudioUrls((old) => {
      Object.values(old).forEach((url) => URL.revokeObjectURL(url));
      return {};
    });
    setCurrentChunk(0);
    setPlaying(false);
  }, [provider, voice, rate, bookText]);

  function reset() {
    cancelled.current = true;
    setStage('upload'); setFile(null); setFilePageCount(0); setInspecting(false); setPages([]); setBookText(''); setError('');
    setProgress({ page: 0, total: 0, message: '' }); setBuildProgress(null);
    setScope('whole'); setPageFrom(1); setPageTo(1);
  }

  async function inspectFile(candidate) {
    if (!candidate) return;
    if (candidate.type !== 'application/pdf' && !candidate.name.toLowerCase().endsWith('.pdf')) {
      setError('Please choose a PDF file.'); return;
    }
    setError(''); setInspecting(true); setFile(null); setFilePageCount(0);
    try {
      const bytes = new Uint8Array(await candidate.arrayBuffer());
      const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
      setFile(candidate); setFilePageCount(pdf.numPages); setScope('whole'); setPageFrom(1); setPageTo(pdf.numPages);
    } catch (reason) {
      setError(reason?.message || 'This PDF could not be opened.');
    } finally {
      setInspecting(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function processFile() {
    if (!file || !filePageCount) return;
    setError(''); setStage('processing'); cancelled.current = false;
    let worker;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
      const output = [];
      const firstPage = scope === 'pages' ? pageFrom : 1;
      const lastPage = scope === 'pages' ? pageTo : pdf.numPages;
      const selectedTotal = lastPage - firstPage + 1;
      setProgress({ page: 0, total: selectedTotal, message: 'Preparing selected pages…' });
      for (let number = firstPage; number <= lastPage; number += 1) {
        if (cancelled.current) return;
        const completed = number - firstPage;
        const page = await pdf.getPage(number);
        const content = await page.getTextContent();
        let text = extractPageText(content);
        const meaningful = text.replace(/\W/g, '').length;
        const needsOcr = ocrMode === 'always' || (ocrMode === 'auto' && meaningful < 70);
        let usedOcr = false;
        if (needsOcr) {
          setProgress({ page: completed, total: selectedTotal, message: `Reading scan on PDF page ${number}…` });
          if (!worker) {
            worker = await createWorker(ocrLanguage, 1, {
              logger: (event) => {
                if (event.status === 'recognizing text') {
                  setProgress({ page: completed + event.progress, total: selectedTotal, message: `Reading scan on PDF page ${number}…` });
                }
              },
            });
          }
          const image = await renderPageForOcr(page);
          const result = await worker.recognize(image, { rotateAuto: true });
          if (result.data.text.trim().length > text.trim().length) text = result.data.text;
          usedOcr = true;
        }
        output.push({ number, text, usedOcr });
        setProgress({ page: completed + 1, total: selectedTotal, message: `PDF page ${number} · ${completed + 1} of ${selectedTotal} selected` });
      }
      if (worker) await worker.terminate();
      const normalized = normalizeBookText(output.map((page) => page.text));
      if (!normalized) throw new Error('No readable text was found. Try “OCR every page” with the correct language.');
      setPages(output); setBookText(normalized); setStage('review');
    } catch (reason) {
      if (worker) await worker.terminate().catch(() => {});
      setError(reason?.message || 'This PDF could not be read.'); setStage('upload');
    }
  }

  function changeProvider(next) {
    setProvider(next);
    if (next === 'openai') setVoice('marin');
    else if (next === 'edge') setVoice('en-US-AvaMultilingualNeural');
    else setVoice('default');
  }

  function updatePageFrom(value) {
    const next = Math.max(1, Math.min(filePageCount, Number(value) || 1));
    setPageFrom(next);
    if (next > pageTo) setPageTo(next);
  }

  function updatePageTo(value) {
    const next = Math.max(1, Math.min(filePageCount, Number(value) || 1));
    setPageTo(next);
    if (next < pageFrom) setPageFrom(next);
  }

  async function synthesize(index) {
    if (audioUrls[index]) return audioUrls[index];
    if (!chunks[index]) throw new Error('Nothing to narrate.');
    setGenerating(index); setError('');
    try {
      const response = await fetch('/api/speech', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: chunks[index], provider, voice, rate, apiKey,
          endpoint: provider === 'custom' ? endpoint : undefined,
          model: provider === 'custom' ? customModel : undefined,
          instructions: provider === 'openai' ? instructions : undefined,
        }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Could not create speech.');
      }
      const url = URL.createObjectURL(await response.blob());
      setAudioUrls((old) => ({ ...old, [index]: url }));
      return url;
    } finally { setGenerating(null); }
  }

  async function playChunk(index = currentChunk) {
    try {
      if (playing && index === currentChunk) { audio.current?.pause(); setPlaying(false); return; }
      const url = await synthesize(index);
      setCurrentChunk(index);
      if (audio.current.src !== url) audio.current.src = url;
      await audio.current.play(); setPlaying(true);
      if (index + 1 < chunks.length && !audioUrls[index + 1]) synthesize(index + 1).catch(() => {});
    } catch (reason) { setError(reason.message); setPlaying(false); }
  }

  async function previewVoice() {
    const original = chunks;
    if (!original.length) return;
    await playChunk(0);
  }

  async function buildAudiobook() {
    setError('');
    try {
      const blobs = [];
      for (let i = 0; i < chunks.length; i += 1) {
        setBuildProgress({ current: i + 1, total: chunks.length });
        const url = await synthesize(i);
        blobs.push(await (await fetch(url)).blob());
      }
      const combined = new Blob(blobs, { type: 'audio/mpeg' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(combined);
      const rangeSuffix = scope === 'pages' ? `-pages-${pageFrom}-${pageTo}` : '';
      link.download = `${title || 'audiobook'}${rangeSuffix}.mp3`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 3000);
    } catch (reason) { setError(reason.message); }
    finally { setBuildProgress(null); }
  }

  const uploadView = <main className="upload-view">
    <section className="intro">
      <div className="eyebrow"><Sparkles size={14} /> Your books, finally heard</div>
      <h1>Turn any PDF into<br /><em>a voice worth listening to.</em></h1>
      <p>From crisp digital books to faded scans. Sonora finds the words, cleans the page, and reads it back with a natural voice.</p>
    </section>
    <section className="upload-card">
      <div
        className={`drop-zone ${dragging ? 'dragging' : ''} ${file ? 'has-file' : ''}`}
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => { event.preventDefault(); setDragging(false); inspectFile(event.dataTransfer.files[0]); }}
        onClick={() => fileInput.current?.click()}
      >
        <input ref={fileInput} hidden type="file" accept="application/pdf,.pdf" onChange={(event) => inspectFile(event.target.files[0])} />
        <span className="upload-icon">{inspecting ? <LoaderCircle className="spin" size={26} /> : file ? <Check size={26} /> : <Upload size={26} />}</span>
        <h2>{inspecting ? 'Checking your PDF…' : file ? file.name : 'Drop your PDF here'}</h2>
        <p>{file ? `${filePageCount} pages · click to choose a different file` : 'or click to choose a file'}</p>
        <span className="file-hint">{file ? 'PDF ready' : 'PDF · digital or scanned'}</span>
      </div>
      {file && <div className="preflight-scope">
        <div className="preflight-title"><span><BookOpen size={17} /> Pages to process</span><small>Save time on large books</small></div>
        <div className="light-scope-toggle">
          <button className={scope === 'whole' ? 'selected' : ''} onClick={() => setScope('whole')}>Whole book <small>{filePageCount} pages</small></button>
          <button className={scope === 'pages' ? 'selected' : ''} onClick={() => setScope('pages')}>Page range <small>Choose pages</small></button>
        </div>
        {scope === 'pages' && <div className="light-range-fields">
          <label><span>From page</span><input aria-label="First page" type="number" min="1" max={filePageCount} value={pageFrom} onChange={(event) => updatePageFrom(event.target.value)} /></label>
          <span>—</span>
          <label><span>To page</span><input aria-label="Last page" type="number" min="1" max={filePageCount} value={pageTo} onChange={(event) => updatePageTo(event.target.value)} /></label>
          <small>{pageTo - pageFrom + 1} pages selected</small>
        </div>}
        <button className="prepare-button" onClick={processFile}><WandSparkles size={17} /> {scope === 'pages' ? `Process pages ${pageFrom}–${pageTo}` : `Process all ${filePageCount} pages`}</button>
      </div>}
      <div className="scan-controls">
        <label><span><ScanText size={17} /> Page reading</span>
          <select value={ocrMode} onChange={(event) => setOcrMode(event.target.value)}>
            <option value="auto">Smart detect (recommended)</option><option value="always">OCR every page</option><option value="never">Embedded text only</option>
          </select>
        </label>
        <label><span>OCR language</span>
          <select value={ocrLanguage} onChange={(event) => setOcrLanguage(event.target.value)}>
            <option value="eng">English</option><option value="msa">Malay</option><option value="chi_sim">Chinese (Simplified)</option><option value="ind">Indonesian</option><option value="spa">Spanish</option><option value="fra">French</option><option value="deu">German</option>
          </select>
        </label>
      </div>
      <div className="privacy"><span><Check size={13} /></span><p><b>Your PDF stays on this device.</b><br />Only small text passages go to the selected voice service.</p></div>
    </section>
  </main>;

  const processingView = <main className="processing-view">
    <div className="book-orbit"><BookOpen size={34} /><span /></div>
    <div className="eyebrow"><WandSparkles size={14} /> Preparing your book</div>
    <h1>{title}</h1>
    <p>{progress.message}</p>
    <div className="progress-track"><span style={{ width: `${progress.total ? (progress.page / progress.total) * 100 : 2}%` }} /></div>
    <small>{Math.floor(progress.page)} / {progress.total || '—'} pages</small>
    <button className="text-button" onClick={reset}>Cancel</button>
  </main>;

  const reviewView = <main className="studio">
    <section className="manuscript">
      <div className="section-head">
        <div><div className="eyebrow"><Check size={13} /> Book ready</div><h1>{title}</h1></div>
        <button className="icon-button" title="Choose another PDF" onClick={reset}><RotateCcw size={17} /></button>
      </div>
      <div className="book-meta">
        <span><FileText size={15} /> {pages.length} pages</span><span>{words.toLocaleString()} words</span><span>≈ {estimateMinutes(bookText)} min</span>
        {pages.some((page) => page.usedOcr) && <span className="ocr-tag"><ScanText size={14} /> OCR enhanced</span>}
      </div>
      <div className="editor-wrap">
        <div className="editor-label"><span>Cleaned manuscript</span><small>You can fix names or OCR mistakes before listening</small></div>
        <textarea value={bookText} onChange={(event) => setBookText(event.target.value)} spellCheck="true" />
      </div>
    </section>

    <aside className="voice-panel">
      <div className="panel-title"><span><Headphones size={20} /></span><div><h2>Voice studio</h2><p>Shape how your book sounds</p></div></div>
      <label className="field"><span>Voice engine</span><div className="select-shell"><select value={provider} onChange={(event) => changeProvider(event.target.value)}>
        <option value="edge">Neural · free</option><option value="openai">OpenAI · most natural</option><option value="custom">VibeVoice / custom server</option>
      </select><ChevronDown size={16} /></div></label>

      <div className="prepared-scope"><Check size={14} /><span>{scope === 'pages' ? `PDF pages ${pageFrom}–${pageTo} prepared` : `Whole book prepared · ${filePageCount} pages`}</span></div>

      {provider !== 'custom' && <label className="field"><span>Narrator</span><div className="select-shell voice-select"><select value={voice} onChange={(event) => setVoice(event.target.value)}>
        {voices.map((item) => <option key={item.id} value={item.id}>{item.name} — {item.description}</option>)}
      </select><ChevronDown size={16} /></div></label>}

      {provider === 'custom' && <div className="custom-fields">
        <label className="field"><span>OpenAI-compatible speech endpoint</span><input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="http://127.0.0.1:8000/v1/audio/speech" /></label>
        <div className="field-row"><label className="field"><span>Model</span><input value={customModel} onChange={(event) => setCustomModel(event.target.value)} /></label><label className="field"><span>Voice</span><input value={voice} onChange={(event) => setVoice(event.target.value)} /></label></div>
      </div>}

      {provider === 'openai' && <>
        <label className="field"><span>API key <i>not stored</i></span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Uses OPENAI_API_KEY if blank" /></label>
        <label className="field"><span>Narration direction</span><textarea className="direction" value={instructions} onChange={(event) => setInstructions(event.target.value)} /></label>
      </>}

      <label className="field speed"><span><span><Gauge size={15} /> Reading pace</span><b>{rate > 0 ? '+' : ''}{rate}%</b></span><input type="range" min="-30" max="30" step="5" value={rate} onChange={(event) => setRate(Number(event.target.value))} /></label>
      <button className="preview-button" onClick={previewVoice} disabled={generating !== null}>
        {generating === 0 ? <LoaderCircle className="spin" size={17} /> : <Play size={16} fill="currentColor" />} Hear a sample
      </button>
      <div className="engine-note"><Sparkles size={15} /><p>{provider === 'edge' ? 'Natural neural voices with no API key. Internet is required.' : provider === 'openai' ? 'Premium expressive narration. Usage is billed by OpenAI.' : 'Connects to VibeVoice or any server implementing OpenAI’s speech endpoint.'}</p></div>
      <button className="build-button" onClick={buildAudiobook} disabled={Boolean(buildProgress) || !chunks.length}>
        {buildProgress ? <LoaderCircle className="spin" size={18} /> : <Download size={18} />}
        {buildProgress ? `Creating part ${buildProgress.current} of ${buildProgress.total}` : scope === 'pages' ? `Create pages ${pageFrom}–${pageTo} MP3` : 'Create whole book MP3'}
      </button>
    </aside>
  </main>;

  return <div className="app-shell">
    <header>
      <button className="brand" onClick={reset}><span><FileAudio size={19} /></span> SONORA</button>
      <nav><Step number="1" label="Add book" active={stage === 'upload'} complete={stage !== 'upload'} /><i /><Step number="2" label="Prepare" active={stage === 'processing'} complete={stage === 'review'} /><i /><Step number="3" label="Listen" active={stage === 'review'} /></nav>
      <button className="header-action" title="Voice settings"><Settings2 size={18} /></button>
    </header>
    {error && <div className="error-banner"><CircleAlert size={17} /><span>{error}</span><button onClick={() => setError('')}><X size={16} /></button></div>}
    {stage === 'upload' ? uploadView : stage === 'processing' ? processingView : reviewView}

    {stage === 'review' && <div className="player-bar">
      <div className="mini-cover">{title.slice(0, 1).toUpperCase()}</div>
      <div className="now-playing"><b>{title}</b><span>Part {currentChunk + 1} of {chunks.length}</span></div>
      <button className="play-button" onClick={() => playChunk()} disabled={generating !== null}>{generating === currentChunk ? <LoaderCircle className="spin" /> : playing ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}</button>
      <span className="time">{formatTime(currentTime)}</span>
      <input className="seek" type="range" min="0" max={duration || 1} value={currentTime} onChange={(event) => { audio.current.currentTime = event.target.value; setCurrentTime(Number(event.target.value)); }} />
      <span className="time">{formatTime(duration)}</span>
      <span className="chunk-count">{Object.keys(audioUrls).length}/{chunks.length} ready</span>
    </div>}
    <audio ref={audio} onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)} onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => { if (currentChunk + 1 < chunks.length) playChunk(currentChunk + 1); else setPlaying(false); }} />
  </div>;
}

export default App;
