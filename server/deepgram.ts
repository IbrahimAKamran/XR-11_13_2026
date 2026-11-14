/**
 * Deepgram live transcription with diarization, fed with the phone's PCM.
 *
 * Contract (developers.deepgram.com, reference "listen streaming"):
 *   wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000&channels=1
 *     &model=nova-3&diarize_model=latest&interim_results=true&smart_format=true
 *     &utterance_end_ms=1000&vad_events=true&language=en
 *   header  Authorization: Token <DEEPGRAM_API_KEY>
 *   client -> binary frames of PCM; text frames {"type":"KeepAlive"} every 3-5 s
 *             when idle (10 s without audio or KeepAlive closes the socket);
 *             {"type":"CloseStream"} to flush and end.
 *   server -> {"type":"Results", start, duration, is_final, speech_final,
 *              channel:{alternatives:[{transcript, confidence, words:[{word,
 *              punctuated_word, start, end, confidence, speaker}]}]}}
 *             {"type":"UtteranceEnd", last_word_end (-1 = stale, ignore)}
 *             {"type":"SpeechStarted"}  {"type":"Metadata", duration, ...}
 * Diarization: `diarize_model=latest` is the documented form (`diarize=true` is
 * deprecated, and sending both is rejected). Streaming returns only `speaker`.
 */

export interface DgWord {
  word: string
  start: number
  end: number
  confidence: number
  punctuated_word?: string
  speaker?: number
}
export interface DgResults {
  type: "Results"
  channel_index?: number[]
  start: number
  duration: number
  is_final: boolean
  speech_final: boolean
  channel: {alternatives: Array<{transcript: string; confidence: number; words: DgWord[]}>}
}

/** One run of consecutive words by the same speaker. Times are seconds of audio. */
export interface Segment {
  speaker: number | null
  text: string
  tStart: number
  tEnd: number
  confidence: number
}

/** Split a Results message into per-speaker segments (empty when no text). */
export function segmentsFromResults(msg: DgResults, timeBase = 0): Segment[] {
  const alt = msg.channel?.alternatives?.[0]
  const transcript = alt?.transcript?.trim() ?? ""
  if (!alt || !transcript) return []
  const words = alt.words ?? []
  if (!words.length) {
    return [{speaker: null, text: transcript, tStart: timeBase + msg.start, tEnd: timeBase + msg.start + msg.duration, confidence: alt.confidence ?? 0}]
  }
  const out: Segment[] = []
  let cur: Segment | null = null
  let confSum = 0
  let confN = 0
  const finish = (): void => {
    if (!cur) return
    cur.confidence = confN ? confSum / confN : 0
    out.push(cur)
  }
  for (const w of words) {
    const speaker = typeof w.speaker === "number" ? w.speaker : null
    const token = w.punctuated_word ?? w.word
    if (!cur || cur.speaker !== speaker) {
      finish()
      cur = {speaker, text: token, tStart: timeBase + w.start, tEnd: timeBase + w.end, confidence: 0}
      confSum = w.confidence ?? 0
      confN = 1
    } else {
      cur.text += ` ${token}`
      cur.tEnd = timeBase + w.end
      confSum += w.confidence ?? 0
      confN++
    }
  }
  finish()
  return out
}

export interface UrlOptions {
  sampleRate: number
  model?: string
  language?: string
  /** Extra query string, e.g. "keyterm=Mentra". Keys here override the defaults. */
  extraParams?: string
}

/** Build the streaming URL. `extraParams` can override any default key. */
export function buildDeepgramUrl(base: string, o: UrlOptions): string {
  const params = new URLSearchParams({
    model: o.model ?? "nova-3",
    encoding: "linear16",
    sample_rate: String(o.sampleRate),
    channels: "1",
    diarize_model: "latest",
    interim_results: "true",
    smart_format: "true",
    utterance_end_ms: "1000",
    vad_events: "true",
    language: o.language ?? "en",
  })
  const extra = new URLSearchParams(o.extraParams ?? "")
  for (const [k, v] of extra) params.set(k, v)
  // Deepgram rejects requests that carry both diarize and diarize_model.
  if (extra.has("diarize") && !extra.has("diarize_model")) params.delete("diarize_model")
  return `${base}${base.includes("?") ? "&" : "?"}${params.toString()}`
}

export interface TranscriberOptions extends UrlOptions {
  apiKey: string
  /** Override for tests. Default wss://api.deepgram.com/v1/listen */
  url?: string
  onFinal: (seg: Segment, speechFinal: boolean) => void
  onInterim: (seg: Segment) => void
  onEvent: (line: string) => void
}

const KEEPALIVE_MS = 4000
const RECONNECT_MS = 1500
const RECONNECT_MAX_MS = 30_000
const CLOSE_GRACE_MS = 3000
const MAX_QUEUE_SECONDS = 60
const FAILURES_BEFORE_WARNING = 4

/**
 * One Deepgram connection per run. Audio sent before the socket opens is
 * queued (up to MAX_QUEUE_SECONDS; older audio is dropped and the time base
 * advanced, so times stay aligned with the WAV); a dropped socket is reopened
 * with backoff and segment times keep counting from the audio already sent.
 */
export function createDeepgramTranscriber(opts: TranscriberOptions) {
  const url = buildDeepgramUrl(opts.url ?? "wss://api.deepgram.com/v1/listen", opts)
  const bytesPerSecond = opts.sampleRate * 2

  let ws: WebSocket | null = null
  let state: "connecting" | "open" | "closed" = "connecting"
  let closing = false
  let queue: Uint8Array[] = []
  let queuedBytes = 0
  let warnedQueueDrop = false
  let bytesSentThisConnection = 0
  let timeBase = 0 // seconds of audio that precede this connection's first byte
  let lastSendAt = Date.now()
  let keepalive: ReturnType<typeof setInterval> | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let failures = 0 // consecutive connections that closed without opening
  let closeResolve: (() => void) | null = null

  const connect = (): void => {
    state = "connecting"
    timeBase += bytesSentThisConnection / bytesPerSecond
    bytesSentThisConnection = 0
    let socket: WebSocket
    try {
      // Bun's WebSocket client accepts {headers}; the DOM typings in tsconfig
      // only know the protocols overload, hence the cast.
      const BunWebSocket = WebSocket as unknown as new (u: string, o: {headers: Record<string, string>}) => WebSocket
      socket = new BunWebSocket(url, {headers: {Authorization: `Token ${opts.apiKey}`}})
    } catch (e) {
      opts.onEvent(`deepgram: cannot open socket: ${(e as Error).message}`)
      scheduleReconnect()
      return
    }
    ws = socket
    socket.binaryType = "arraybuffer"
    socket.onopen = () => {
      if (ws !== socket) return
      state = "open"
      failures = 0
      opts.onEvent(`deepgram connected (${opts.model ?? "nova-3"}, ${opts.sampleRate} Hz, diarize_model=latest)`)
      for (const chunk of queue) sendNow(chunk)
      queue = []
      queuedBytes = 0
    }
    socket.onmessage = (ev) => {
      try {
        onMessage(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer))
      } catch (e) {
        opts.onEvent(`deepgram handler error: ${(e as Error).message}`)
      }
    }
    socket.onerror = (ev: unknown) => {
      const m = (ev as {message?: string} | null)?.message
      opts.onEvent(`deepgram socket error${m ? `: ${m}` : ""} (check DEEPGRAM_API_KEY and the query params)`)
    }
    socket.onclose = (ev) => {
      if (ws !== socket) return
      ws = null
      state = "closed"
      if (closing) {
        closeResolve?.()
        return
      }
      if (bytesSentThisConnection === 0) failures++
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MS * 2 ** Math.min(failures, 5))
      opts.onEvent(`deepgram socket closed (code ${ev.code}${ev.reason ? `, ${ev.reason}` : ""}); reconnecting in ${(delay / 1000).toFixed(1)}s`)
      if (failures === FAILURES_BEFORE_WARNING) {
        opts.onEvent(`deepgram handshake failed ${failures} times in a row: check DEEPGRAM_API_KEY and DEEPGRAM_EXTRA_PARAMS, then restart run.sh (recording continues meanwhile)`)
      }
      scheduleReconnect(delay)
    }
  }

  const scheduleReconnect = (delay = RECONNECT_MS): void => {
    if (closing || reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
  }

  const sendNow = (pcm: Uint8Array): void => {
    if (!ws || ws.readyState !== 1) return
    ws.send(pcm)
    bytesSentThisConnection += pcm.byteLength
    lastSendAt = Date.now()
  }

  const onMessage = (text: string): void => {
    let msg: {type?: string} & Record<string, unknown>
    try {
      msg = JSON.parse(text)
    } catch {
      return
    }
    switch (msg.type) {
      case "Results": {
        const r = msg as unknown as DgResults
        const segs = segmentsFromResults(r, timeBase)
        if (r.is_final) for (const s of segs) opts.onFinal(s, r.speech_final)
        else if (segs.length) opts.onInterim(segs[segs.length - 1])
        return
      }
      case "UtteranceEnd": {
        const t = Number(msg.last_word_end)
        if (!(t >= 0)) return // -1 is Deepgram's "stale, ignore" marker
        opts.onEvent(`utterance end at ${(timeBase + t).toFixed(1)}s`)
        return
      }
      case "SpeechStarted":
        return
      case "Metadata":
        opts.onEvent(`deepgram stream ended: ${Number(msg.duration ?? 0).toFixed(1)}s of audio processed`)
        return
      default:
        opts.onEvent(`deepgram message: ${text.slice(0, 200)}`)
    }
  }

  keepalive = setInterval(() => {
    if (ws && ws.readyState === 1 && Date.now() - lastSendAt >= KEEPALIVE_MS) {
      ws.send(JSON.stringify({type: "KeepAlive"}))
      lastSendAt = Date.now()
    }
  }, 1000)

  connect()

  return {
    get state(): string {
      return state
    },
    /** Seconds of audio handed to Deepgram so far (all connections). */
    get audioSeconds(): number {
      return timeBase + bytesSentThisConnection / bytesPerSecond
    },
    send(pcm: Uint8Array): void {
      if (closing) return
      if (ws && ws.readyState === 1) {
        sendNow(pcm)
        return
      }
      queue.push(pcm)
      queuedBytes += pcm.byteLength
      const maxBytes = MAX_QUEUE_SECONDS * bytesPerSecond
      while (queuedBytes > maxBytes && queue.length) {
        const dropped = queue.shift()!
        queuedBytes -= dropped.byteLength
        timeBase += dropped.byteLength / bytesPerSecond // keep times aligned with the WAV
        if (!warnedQueueDrop) {
          warnedQueueDrop = true
          opts.onEvent(`deepgram unreachable: dropping audio older than ${MAX_QUEUE_SECONDS}s from the transcription queue (the WAV still has it)`)
        }
      }
    },
    /** Flush and end the stream. Resolves when Deepgram closes or after a grace period. */
    async close(): Promise<void> {
      closing = true
      if (keepalive) clearInterval(keepalive)
      if (reconnectTimer) clearTimeout(reconnectTimer)
      const socket = ws
      if (socket && socket.readyState === 0) {
        // Still connecting: give it a moment so queued audio can be flushed.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, CLOSE_GRACE_MS)
          const done = (): void => {
            clearTimeout(timer)
            resolve()
          }
          socket.addEventListener("open", done, {once: true})
          socket.addEventListener("close", done, {once: true})
        })
      }
      if (socket && socket.readyState === 1) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            closeResolve = null
            try {
              socket.close()
            } catch {
              /* ignore */
            }
            resolve()
          }, CLOSE_GRACE_MS)
          closeResolve = () => {
            clearTimeout(timer)
            resolve()
          }
          try {
            socket.send(JSON.stringify({type: "CloseStream"}))
          } catch {
            clearTimeout(timer)
            resolve()
          }
        })
      } else {
        if (queuedBytes > 0) opts.onEvent(`deepgram: dropped ${(queuedBytes / bytesPerSecond).toFixed(1)}s of unsent audio (still in the WAV)`)
        try {
          socket?.close()
        } catch {
          /* ignore */
        }
      }
      queue = []
      queuedBytes = 0
      ws = null
      state = "closed"
    },
  }
}
