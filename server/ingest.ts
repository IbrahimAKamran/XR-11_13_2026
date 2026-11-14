/**
 * FieldAssist ingest server (runs on the Mac).
 *
 * The miniapp's background layer on the phone sends JSON over plain HTTP POST
 * (the transport that works from the Mentra App's background runtime on iOS):
 *   POST /ingest/hello   {runId, userId, packageName}
 *   POST /ingest/event   {runId, type: "transcript", text, isFinal, language?, source?, t}
 *                        {runId, type: "vad", speaking, silentForMs?, t}
 *                        {runId, type: "end", reason}
 *   POST /ingest/audio   {runId, chunks: [{seq, data (base64), sampleRate?, format?, t}, ...]}
 * A WebSocket on any path carrying the same objects as text frames is also
 * accepted, for clients where WebSockets work.
 *
 * Transcript lines are printed so you can see the phone -> Mac path is alive.
 * Audio is decoded from base64 and written to recordings/<utc-time>-<runId>.wav
 * (16-bit PCM, sample rate from the phone or 16000 if it does not say) or to a
 * raw .lc3 file when the phone's mic mode is LC3. One file per run id; a run
 * is finalized on an "end" event or after IDLE_MS without audio. A mid-stream
 * format or sample-rate change starts a "-partN" file so the header stays true.
 *
 * Start with: bun run ingest   (or INGEST_PORT=3100 bun run server/ingest.ts)
 */
import {closeSync, mkdirSync, openSync, writeSync} from "node:fs"
import {join} from "node:path"
import {WavFile} from "./wav"

const PORT = Number(process.env.INGEST_PORT ?? 3100)
const RECORDINGS_DIR = process.env.INGEST_DIR ?? join(import.meta.dir, "..", "recordings")
const DEFAULT_SAMPLE_RATE = 16000
const STATS_INTERVAL_MS = 1000
const IDLE_MS = 15_000

interface AudioFrame {
  seq: number
  data: string
  sampleRate?: number
  format?: string
  t: number
}
type Event =
  | {type: "transcript"; text: string; isFinal: boolean; language?: string; source?: string; t: number}
  | {type: "vad"; speaking: boolean; silentForMs?: number; t: number}
  | {type: "end"; reason: string}

interface Run {
  runId: string
  startedAt: number
  lastSeen: number
  wav: WavFile | null
  rawFd: number | null
  rawPath: string | null
  rawBytes: number
  sinkFailed: boolean
  segment: number
  format: string | null
  sampleRate: number | null
  chunks: number
  bytes: number
  lastSeq: number
  missing: number
  windowChunks: number
  windowBytes: number
  windowStart: number
  posts: number
}

// Local time with milliseconds, so these lines align with the dev sidecar's
// [MentraJS] lines (also local time). Recording file names use UTC.
const stamp = (): string => {
  const d = new Date()
  const p = (n: number, w = 2): string => String(n).padStart(w, "0")
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}
const log = (line: string): void => console.log(`${stamp()} [ingest] ${line}`)

const runs = new Map<string, Run>()

function getRun(runId: string): Run {
  let run = runs.get(runId)
  if (!run) {
    run = {
      runId,
      startedAt: Date.now(),
      lastSeen: Date.now(),
      wav: null,
      rawFd: null,
      rawPath: null,
      rawBytes: 0,
      sinkFailed: false,
      segment: 0,
      format: null,
      sampleRate: null,
      chunks: 0,
      bytes: 0,
      lastSeq: 0,
      missing: 0,
      windowChunks: 0,
      windowBytes: 0,
      windowStart: Date.now(),
      posts: 0,
    }
    runs.set(runId, run)
    log(`run ${runId} started`)
  }
  run.lastSeen = Date.now()
  return run
}

function fileStem(run: Run): string {
  const t = new Date(run.startedAt).toISOString().replace(/[:.]/g, "-").slice(0, 19)
  const part = run.segment > 0 ? `-part${run.segment + 1}` : ""
  return join(RECORDINGS_DIR, `${t}-${run.runId}${part}`)
}

function openSink(run: Run, frame: AudioFrame, firstBytes: number): void {
  run.format = frame.format ?? null
  run.sampleRate = frame.sampleRate ?? null
  const isLc3 = (frame.format ?? "").toLowerCase().includes("lc3")
  if (isLc3) {
    run.rawPath = `${fileStem(run)}.lc3`
    mkdirSync(RECORDINGS_DIR, {recursive: true})
    run.rawFd = openSync(run.rawPath, "w")
    log(`audio format=${frame.format} sampleRate=${frame.sampleRate ?? "unknown"} firstChunkBytes=${firstBytes}`)
    log(`LC3 frames are saved raw to ${run.rawPath}; they need an LC3 decoder (liblc3). The phone's mic mode decides PCM vs LC3`)
  } else {
    const sampleRate = frame.sampleRate ?? DEFAULT_SAMPLE_RATE
    run.wav = new WavFile(`${fileStem(run)}.wav`, {sampleRate, channels: 1, bitsPerSample: 16})
    log(
      `audio format=${frame.format ?? "unknown (assuming 16-bit mono PCM)"} ` +
        `sampleRate=${frame.sampleRate ?? `unknown (assuming ${DEFAULT_SAMPLE_RATE})`} firstChunkBytes=${firstBytes} -> ${run.wav.path}`,
    )
  }
}

function closeSinks(run: Run): string {
  if (run.wav) {
    const summary = `${run.wav.path} (${run.wav.seconds.toFixed(1)}s, ${(run.wav.bytes / 1024).toFixed(0)} kB)`
    run.wav.close()
    run.wav = null
    return summary
  }
  if (run.rawFd !== null) {
    closeSync(run.rawFd)
    run.rawFd = null
    const summary = `${run.rawPath} (${(run.rawBytes / 1024).toFixed(0)} kB raw LC3)`
    run.rawBytes = 0
    return summary
  }
  return run.sinkFailed ? "recording failed (see error above)" : "no audio received"
}

function onFrame(run: Run, frame: AudioFrame): void {
  const pcm = Buffer.from(frame.data, "base64")
  run.chunks++
  run.bytes += pcm.byteLength
  if (run.lastSeq > 0 && frame.seq > run.lastSeq + 1) run.missing += frame.seq - run.lastSeq - 1
  run.lastSeq = Math.max(run.lastSeq, frame.seq)
  if (run.sinkFailed) return
  try {
    if (run.wav === null && run.rawFd === null) {
      openSink(run, frame, pcm.byteLength)
    } else if ((frame.sampleRate ?? null) !== run.sampleRate || (frame.format ?? null) !== run.format) {
      log(`audio format/sampleRate changed ${run.format}/${run.sampleRate} -> ${frame.format}/${frame.sampleRate}; closed ${closeSinks(run)}`)
      run.segment++
      openSink(run, frame, pcm.byteLength)
    }
    if (run.wav) run.wav.append(pcm)
    else if (run.rawFd !== null) {
      writeSync(run.rawFd, pcm)
      run.rawBytes += pcm.byteLength
    }
  } catch (err) {
    // Disk problem (permissions, full disk, bad INGEST_DIR). Log once, keep the
    // transcript check alive, stop trying to write audio for this run.
    run.sinkFailed = true
    log(`cannot write audio: ${(err as Error).message}. Audio from run ${run.runId} is discarded; fix INGEST_DIR/disk and restart`)
    try {
      closeSinks(run)
    } catch {
      /* ignore */
    }
    return
  }
  run.windowChunks++
  run.windowBytes += pcm.byteLength
}

function maybeStats(run: Run): void {
  const now = Date.now()
  if (now - run.windowStart < STATS_INTERVAL_MS || run.windowChunks === 0) return
  const secs = (now - run.windowStart) / 1000
  const total = run.wav ? `${run.wav.seconds.toFixed(1)}s` : `${(run.rawBytes / 1024).toFixed(0)} kB`
  log(
    `audio ${(run.windowChunks / secs).toFixed(0)} chunks/s ${(run.windowBytes / secs / 1024).toFixed(1)} kB/s total=${total}` +
      `${run.missing ? ` missing=${run.missing}` : ""}`,
  )
  run.windowChunks = 0
  run.windowBytes = 0
  run.windowStart = now
}

function onEvent(run: Run, ev: Event): void {
  switch (ev.type) {
    case "transcript": {
      const kind = ev.isFinal ? "FINAL  " : "interim"
      const src = `${ev.source ?? "?"}${ev.language ? ` ${ev.language}` : ""}`
      log(`${kind} [${src}] ${ev.text}`)
      return
    }
    case "vad":
      log(ev.speaking ? "speech started" : `speech stopped${ev.silentForMs != null ? ` (quiet for ${ev.silentForMs}ms)` : ""}`)
      return
    case "end":
      finishRun(run, `phone session ended: ${ev.reason}`)
      return
    default:
      log(`run ${run.runId}: unknown event type ${(ev as {type?: string}).type}`)
  }
}

function finishRun(run: Run, why: string): void {
  const summary = closeSinks(run)
  log(`${why}; run ${run.runId}: ${run.chunks} chunks, ${(run.bytes / 1024).toFixed(0)} kB in ${run.posts} posts -> ${summary}`)
  runs.delete(run.runId)
}

setInterval(() => {
  const now = Date.now()
  for (const run of runs.values()) {
    if (now - run.lastSeen > IDLE_MS) finishRun(run, `no data for ${IDLE_MS / 1000}s`)
  }
}, 5000)

/** Handle one JSON object from either transport. Returns a short reply. */
function handle(obj: unknown, via: string): string {
  if (!obj || typeof obj !== "object") return "ignored: not an object"
  const o = obj as Record<string, unknown>
  const runId = typeof o.runId === "string" ? o.runId : "unknown"
  if (typeof o.userId === "string" && typeof o.packageName === "string") {
    const run = getRun(runId)
    log(`hello run=${runId} userId=${o.userId} package=${o.packageName} via=${via}`)
    run.posts++
    return "ok"
  }
  if (Array.isArray(o.chunks)) {
    const run = getRun(runId)
    run.posts++
    for (const f of o.chunks as AudioFrame[]) {
      if (f && typeof f.data === "string") onFrame(run, f)
    }
    maybeStats(run)
    return `ok ${o.chunks.length}`
  }
  if (typeof o.type === "string") {
    const run = getRun(runId)
    run.posts++
    onEvent(run, o as Event)
    return "ok"
  }
  return "ignored: unknown shape"
}

const server = Bun.serve<{id: number}>({
  hostname: "0.0.0.0",
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url)
    if (url.pathname === "/health") return Response.json({ok: true, service: "fieldassist-ingest", runs: [...runs.keys()]})
    if ((req.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
      const protocol = (req.headers.get("sec-websocket-protocol") ?? "").split(",")[0].trim()
      const headers: Record<string, string> = protocol ? {"Sec-WebSocket-Protocol": protocol} : {}
      if (srv.upgrade(req, {data: {id: Date.now()}, headers})) return undefined
      log(`WebSocket upgrade rejected for ${url.pathname}`)
      return new Response("WebSocket upgrade failed", {status: 400})
    }
    if (req.method === "POST" && url.pathname.startsWith("/ingest")) {
      let obj: unknown
      try {
        obj = await req.json()
      } catch {
        log(`POST ${url.pathname}: body is not JSON`)
        return new Response("not JSON", {status: 400})
      }
      return new Response(handle(obj, "http"), {headers: {"content-type": "text/plain"}})
    }
    return new Response("fieldassist ingest: POST JSON to /ingest/{hello,event,audio}\n")
  },
  websocket: {
    open(ws) {
      log(`WebSocket client connected from ${ws.remoteAddress}`)
    },
    message(ws, raw) {
      let obj: unknown
      try {
        obj = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw))
      } catch {
        log(`WebSocket: ignoring non-JSON frame`)
        return
      }
      handle(obj, "ws")
    },
    close() {
      log(`WebSocket client disconnected`)
    },
    // Without this, an exception in a handler is uncaught and ends the process.
    error(err) {
      log(`WebSocket handler error: ${(err as Error).message}`)
    },
  },
})

// Create the folder up front so it is visible before the first chunk arrives.
mkdirSync(RECORDINGS_DIR, {recursive: true})
log(`listening on http://0.0.0.0:${server.port}/ingest  (recordings -> ${RECORDINGS_DIR})`)
log(`waiting for the phone; transcript lines and audio stats will appear here`)
