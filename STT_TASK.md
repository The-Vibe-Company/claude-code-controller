
You are working on the `companion` project (https://github.com/cedricfarinazzo/companion), a Web UI for Claude Code sessions.

## Feature Request: Offline Speech-to-Text Input (revised approach)

Add a push-to-talk / voice input button to the session chat input bar. The transcription must run **fully offline, with zero server involvement** — everything runs in the browser using WebAssembly.

## Why this approach (important context)

The previous approach using `nodejs-whisper` (a whisper.cpp Node.js binding) was considered but abandoned because it has reliability issues and complex native build requirements. 

**The chosen approach: Transformers.js v3 running Whisper in the browser via WASM.**

`@huggingface/transformers` (v3+) runs Whisper directly in the browser using ONNX Runtime + WebAssembly — no server, no Python, no native binaries, no ffmpeg, no build step. The model is downloaded once from HuggingFace on first use and cached in the browser (IndexedDB). After that, everything runs fully offline.

This is architecturally cleaner for companion: the server stays untouched, the feature is purely a frontend addition.

## Chosen stack

- **`@huggingface/transformers`** v3 (npm: `@huggingface/transformers`) — Whisper via ONNX/WASM in browser
- Model: `onnx-community/whisper-tiny.en` (default, ~40MB) — fast on CPU/WASM
- Optional upgrade: `onnx-community/whisper-base.en` (~80MB) for better accuracy
- Audio capture: browser `MediaRecorder` API or `AudioContext` + `AudioWorklet`
- No server changes required

## Implementation

### 1. Install dependency (frontend only)

```bash
cd web
bun add @huggingface/transformers
```

### 2. Whisper Web Worker

Create `web/src/workers/whisper.worker.ts`:

Run the model in a Web Worker to avoid blocking the UI thread.

```ts
import { pipeline, env } from '@huggingface/transformers';

// Cache model in IndexedDB (offline after first download)
env.allowLocalModels = false; // use HuggingFace Hub
env.useBrowserCache = true;

let transcriber: Awaited<ReturnType<typeof pipeline>> | null = null;

self.onmessage = async (e) => {
  const { type, audio, model } = e.data;

  if (type === 'load') {
    self.postMessage({ type: 'loading' });
    transcriber = await pipeline(
      'automatic-speech-recognition',
      model ?? 'onnx-community/whisper-tiny.en',
      { device: 'wasm', dtype: 'q8' } // quantized, CPU-safe
    );
    self.postMessage({ type: 'ready' });
  }

  if (type === 'transcribe' && transcriber) {
    const result = await transcriber(audio, {
      language: 'english',
      task: 'transcribe',
    });
    self.postMessage({ type: 'result', text: (result as { text: string }).text });
  }
};
```

### 3. React hook: `useWhisper`

Create `web/src/hooks/useWhisper.ts` to manage the worker lifecycle, recording state, and transcription:

States to expose:
- `status`: `'idle' | 'loading-model' | 'ready' | 'recording' | 'transcribing' | 'error'`
- `startRecording()`: request mic permission, start capturing audio
- `stopRecording()`: stop capture, send Float32Array audio buffer to worker, await result
- `transcript`: the transcribed string (cleared on next recording start)
- `error`: error message string or null

Audio pipeline:
- `getUserMedia({ audio: true })` → `AudioContext` at 16kHz → `AudioWorkletNode` (or `ScriptProcessorNode` fallback) → accumulate raw Float32 samples
- On `stopRecording()`: pass the Float32Array directly to the Whisper pipeline (Transformers.js accepts raw Float32 audio at 16kHz natively — no WAV encoding needed)

Worker management:
- Instantiate the worker once on hook mount using `new Worker(new URL('../workers/whisper.worker.ts', import.meta.url), { type: 'module' })`
- Send `{ type: 'load' }` on first use (lazy load — not on app start)
- Terminate worker on unmount

### 4. Frontend — Mic button UI

Add a microphone button to the chat input component (find where the send button is in `web/src/`):

States and their visual appearance:
- `idle` / `ready`: 🎤 microphone icon, clickable
- `loading-model`: spinner + "Loading model…" tooltip (only happens once, first use)
- `recording`: pulsing red circle + "Recording…" label, click to stop
- `transcribing`: spinner + "Transcribing…", disabled
- `error`: brief toast notification, resets to idle after 3s

On transcription success: **append the transcript text to the current input field value**, placing cursor at end. User can edit before sending.

Permission handling:
- If `navigator.mediaDevices` is unavailable (non-HTTPS, old browser): hide the button entirely, show a tooltip on hover explaining why
- If mic permission denied: show a clear inline error message

### 5. Model configuration

Allow users to select the model size via a setting (or env variable `VITE_WHISPER_MODEL`). Sensible defaults and tradeoffs to document:

| Model | Size | Speed (CPU/WASM) | Accuracy |
|---|---|---|---|
| `whisper-tiny.en` | ~40MB | Fast (~3-5s) | Good |
| `whisper-base.en` | ~80MB | Medium (~8s) | Better |
| `whisper-small.en` | ~240MB | Slow (~20s+) | Best |

Default: `whisper-tiny.en`. Document in README.

### 6. COOP/COEP headers (important!)

Transformers.js WASM with SharedArrayBuffer (used for threading) requires cross-origin isolation. The Bun/Hono server must serve the following headers for all responses:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Add these headers to the existing Hono server or Vite dev server config. Check if they're already set. Note: these headers may break loading of cross-origin resources (images, iframes) — verify nothing else in the app breaks.

If SharedArrayBuffer is unavailable (COOP/COEP not set), Transformers.js falls back to single-threaded WASM which is slower but still works — handle this gracefully.

## Constraints
- **Zero server changes** (no new endpoints, no server-side dependencies)
- **No Python, no native binaries, no ffmpeg**
- Model runs in browser only — audio never leaves the user's machine
- TypeScript types must stay valid (`bun run typecheck` must pass)
- Match existing UI style — check what CSS/component framework is used before writing any component code
- The Web Worker must be properly typed (use `/// <reference lib="webworker" />`)

## Start here
1. Read `CLAUDE.md` to understand project structure and conventions
2. Find the chat input component in `web/src/` (where the send button lives)
3. Check Vite config for Worker support and whether COOP/COEP headers are already configured
4. Install `@huggingface/transformers` and implement the worker + hook + UI in that order
5. Test: open a session, click mic, speak, verify text appears in input box after release
6. Test offline: disable network after model is cached, verify transcription still works
```