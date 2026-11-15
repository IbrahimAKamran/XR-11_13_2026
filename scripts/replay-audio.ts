/**
 * Plays a recorded audio file into the ingest server exactly the way the phone
 * does: a hello, then 16 kHz mono 16-bit PCM in 100 ms chunks posted every
 * 250 ms to /ingest/audio, then an end event. Everything downstream runs for
 * real: the WAV recording, Deepgram with speaker labels (if DEEPGRAM_API_KEY
 * is set), SQLite, /dashboard and the PICoVoice app at /app.
 *
 *   bun run replay <file> [<file> ...] [--fast] [--url http://localhost:3100]
 *
 * Any format ffmpeg can read works (.m4a voice memos, .wav, .mp3). Each file
 * becomes its own conversation. --fast sends at 4x real time; leave it off
 * when Deepgram is on, so the live stream sees realistic timing.
 */
import {spawnSync} from "node:child_process"
import {basename} from "node:path"

const SAMPLE_RATE = 16000
const CHUNK_MS = 100
const POST_EVERY_MS = 250

const args = process.argv.slice(2)
const fast = args.includes("--fast")
const urlIdx = args.indexOf("--url")
const base = (urlIdx >= 0 ? args[urlIdx + 1] : `http://localhost:${process.env.INGEST_PORT ?? 3100}`).replace(/\/+$/, "")
const files = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--url")
if (!files.length) {
  console.error("usage: bun run replay <audio file> [more files] [--fast] [--url http://<mac-ip>:3100]")
  process.exit(1)
}

function decode(file: string): Buffer {
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "-"], {maxBuffer: 1 << 30})
  if (r.error) throw new Error(`ffmpeg not found (brew install ffmpeg): ${r.error.message}`)
  if (r.status !== 0) throw new Error(`ffmpeg could not read ${file}: ${r.stderr.toString().trim()}`)
  return r.stdout
}

async function post(path: string, body: object): Promise<void> {
  const res = await fetch(base + path, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body)})
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

for (const file of files) {
  const pcm = decode(file)
  const runId = `replay-${basename(file).replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 40)}-${Date.now().toString(36)}`
  const chunkBytes = (SAMPLE_RATE * 2 * CHUNK_MS) / 1000
  const total = Math.ceil(pcm.length / chunkBytes)
  console.log(`${basename(file)}: ${(pcm.length / 2 / SAMPLE_RATE).toFixed(1)} s -> run ${runId} at ${base}${fast ? " (4x)" : ""}`)
  await post("/ingest/hello", {runId, userId: "replay", packageName: "replay-audio"})
  const t0 = Date.now()
  let seq = 0
  while (seq < total) {
    const chunks = []
    const perPost = POST_EVERY_MS / CHUNK_MS
    for (let i = 0; i < perPost && seq < total; i++, seq++) {
      const data = pcm.subarray(seq * chunkBytes, Math.min(pcm.length, (seq + 1) * chunkBytes))
      chunks.push({seq: seq + 1, data: data.toString("base64"), sampleRate: SAMPLE_RATE, format: "pcm_s16le", t: t0 + seq * CHUNK_MS})
    }
    await post("/ingest/audio", {runId, chunks})
    // Pace to (sped-up) real time based on audio sent, not on loop count.
    const due = t0 + (seq * CHUNK_MS) / (fast ? 4 : 1)
    const wait = due - Date.now()
    if (wait > 0) await sleep(wait)
  }
  // Let the transcriber flush its last words before the run is closed.
  await sleep(fast ? 1500 : 3000)
  await post("/ingest/event", {runId, type: "end", reason: "replay finished"})
  console.log(`  done: ${total} chunks. Open /app (Live) or /dashboard to see it.`)
}
