/**
 * Typed channel registry shared by the background JSContext and the UI WebView.
 * Everything flows background -> UI: a status line, the latest transcript, and a
 * diagnostics snapshot so the phone tile can show what the terminal cannot.
 */

export interface Diag {
  buildId: string
  runId: string
  userId: string
  cloud: string
  ingestUrl: string
  uplinkState: "disabled" | "connecting" | "connected" | "stalled"
  uplinkPosts: number
  uplinkSent: number
  uplinkFailed: number
  uplinkDropped: number
  uplinkLastError: string
  audioChunks: number
  audioFormat: string
  audioSampleRate: string
  transcripts: number
  uptimeS: number
}

export interface Channels {
  // background → WebView
  status: {state: "ready" | "disconnected"; detail: string}
  transcript: {text: string; isFinal: boolean; at: number}
  diag: Diag
}

declare global {
  // eslint-disable-next-line no-var
  var mentra: import("@mentra/miniapp/ui").MentraTyped<Channels>
}
