import {useEffect, useState, type ReactElement} from "react"
import type {Diag} from "../shared/channels"

/**
 * Phone-side status and diagnostics page. Mentra Live has no display, so this
 * is the only visual surface on the phone; when the terminal shows nothing,
 * this tells you which bundle is running, whether the Mentra App treats it as
 * a dev install, and what the uplink to the Mac is doing.
 */

interface HostInfo {
  platform?: string
  miniappDeveloperMode?: boolean
  packageName?: string
}

function readHost(): HostInfo {
  const g = (window as unknown as {MentraOS?: HostInfo}).MentraOS
  return g ?? {}
}

export function App(): ReactElement {
  const [status, setStatus] = useState("waiting for background…")
  const [transcript, setTranscript] = useState<{text: string; isFinal: boolean} | null>(null)
  const [diag, setDiag] = useState<Diag | null>(null)
  const host = readHost()

  useEffect(() => {
    const offStatus = mentra.on("status", ({state, detail}) => setStatus(`${state} (${detail})`))
    const offTranscript = mentra.on("transcript", ({text, isFinal}) => setTranscript({text, isFinal}))
    const offDiag = mentra.on("diag", (d) => setDiag(d))
    return () => {
      offStatus()
      offTranscript()
      offDiag()
    }
  }, [])

  const rows: Array<[string, string]> = [
    ["Mentra App platform", host.platform ?? "unknown"],
    ["Dev install (console bridge active)", host.miniappDeveloperMode == null ? "unknown" : host.miniappDeveloperMode ? "yes" : "NO"],
    ["Bundle built", diag?.buildId ?? "…"],
    ["Run id / uptime", diag ? `${diag.runId} / ${diag.uptimeS}s` : "…"],
    ["Cloud", diag?.cloud ?? "…"],
    ["Ingest URL", diag?.ingestUrl ?? "…"],
    ["Uplink (HTTP POST)", diag ? `${diag.uplinkState} (posts ok ${diag.uplinkSent}, failed ${diag.uplinkFailed}, dropped ${diag.uplinkDropped})` : "…"],
    ["Uplink last error", diag?.uplinkLastError || "none"],
    ["Audio chunks", diag ? `${diag.audioChunks} (format ${diag.audioFormat}, rate ${diag.audioSampleRate})` : "…"],
    ["Transcripts", diag ? String(diag.transcripts) : "…"],
  ]

  return (
    <div className="app">
      <h1>FieldAssist</h1>
      <p>Background: {status}</p>
      <p>{transcript ? `${transcript.isFinal ? "" : "… "}${transcript.text}` : "Say something to see the latest transcript here."}</p>
      <table className="diag">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td>{k}</td>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">Terminal silent? Report the rows above. "Dev install: NO" means the Mentra App did not treat the scan as a dev install, so no console lines reach the Mac.</p>
    </div>
  )
}
