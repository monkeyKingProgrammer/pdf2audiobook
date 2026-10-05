import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EdgeTTS, Constants } from '@andresaya/edge-tts';

const app = express();
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const fallbackVoices = [
  { ShortName: 'en-US-AvaMultilingualNeural', FriendlyName: 'Ava — warm & expressive', Gender: 'Female', Locale: 'en-US' },
  { ShortName: 'en-US-AndrewMultilingualNeural', FriendlyName: 'Andrew — calm & grounded', Gender: 'Male', Locale: 'en-US' },
  { ShortName: 'en-GB-SoniaNeural', FriendlyName: 'Sonia — clear British', Gender: 'Female', Locale: 'en-GB' },
  { ShortName: 'en-GB-RyanNeural', FriendlyName: 'Ryan — rich British', Gender: 'Male', Locale: 'en-GB' },
  { ShortName: 'ms-MY-YasminNeural', FriendlyName: 'Yasmin — Bahasa Melayu', Gender: 'Female', Locale: 'ms-MY' },
  { ShortName: 'zh-CN-XiaoxiaoNeural', FriendlyName: 'Xiaoxiao — Mandarin', Gender: 'Female', Locale: 'zh-CN' },
];

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, openaiConfigured: Boolean(process.env.OPENAI_API_KEY) });
});

app.get('/api/voices', async (_req, res) => {
  try {
    const voices = await new EdgeTTS().getVoices();
    res.json({ voices });
  } catch {
    res.json({ voices: fallbackVoices, fallback: true });
  }
});

function safeUrl(raw) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) endpoints are supported.');
  return url;
}

app.post('/api/speech', async (req, res) => {
  const { text, provider = 'edge', voice, rate = 0, apiKey, endpoint, model, instructions } = req.body || {};
  if (!text?.trim()) return res.status(400).json({ error: 'Text is required.' });
  if (text.length > 5000) return res.status(400).json({ error: 'Text chunk is too long.' });

  try {
    if (provider === 'edge') {
      const tts = new EdgeTTS();
      await tts.synthesize(text, voice || 'en-US-AvaMultilingualNeural', {
        rate: Number(rate),
        pitch: 0,
        volume: 100,
        outputFormat: Constants.OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3,
      });
      const audio = tts.toBuffer();
      res.set({ 'Content-Type': 'audio/mpeg', 'Content-Length': audio.length, 'Cache-Control': 'no-store' });
      return res.send(audio);
    }

    const isOpenAI = provider === 'openai';
    const target = isOpenAI
      ? new URL('https://api.openai.com/v1/audio/speech')
      : safeUrl(endpoint || 'http://127.0.0.1:8000/v1/audio/speech');
    const token = apiKey || (isOpenAI ? process.env.OPENAI_API_KEY : process.env.TTS_API_KEY);
    if (isOpenAI && !token) return res.status(400).json({ error: 'Add an OpenAI API key in Voice settings or set OPENAI_API_KEY.' });

    const payload = {
      model: model || (isOpenAI ? 'gpt-4o-mini-tts' : 'tts-1'),
      voice: voice || (isOpenAI ? 'marin' : 'default'),
      input: text,
      response_format: 'mp3',
    };
    if (isOpenAI && instructions?.trim()) payload.instructions = instructions.trim();
    const response = await fetch(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`Voice service returned ${response.status}: ${detail}`);
    }
    const audio = Buffer.from(await response.arrayBuffer());
    res.set({ 'Content-Type': response.headers.get('content-type') || 'audio/mpeg', 'Content-Length': audio.length, 'Cache-Control': 'no-store' });
    return res.send(audio);
  } catch (error) {
    console.error('Speech generation failed:', error);
    return res.status(502).json({ error: error.message || 'Speech generation failed.' });
  }
});

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(root, 'dist')));
  app.use((_req, res) => res.sendFile(path.join(root, 'dist', 'index.html')));
}

app.listen(port, host, () => console.log(`Sonora API listening on http://${host}:${port}`));
