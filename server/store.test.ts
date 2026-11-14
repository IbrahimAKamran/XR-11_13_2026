import {describe, expect, test} from "bun:test"
import {Store} from "./store"

describe("Store", () => {
  test("records a session, utterances and events", () => {
    const s = new Store(":memory:")
    s.startSession({runId: "r1", startedAt: 1000, userId: "u", packageName: "p", provider: "deepgram"})
    s.startSession({runId: "r1", startedAt: 1000, provider: "deepgram"}) // idempotent
    s.setSessionAudio("r1", "/tmp/r1.wav", 16000)
    s.insertUtterance({runId: "r1", tStart: 1, tEnd: 2, speakerLabel: "S0", text: "Hello.", confidence: 0.9, speechFinal: true, provider: "deepgram"})
    s.insertUtterance({runId: "r1", tStart: 2.5, tEnd: 3, speakerLabel: "S1", text: "Hi.", confidence: 0.8, speechFinal: false, provider: "deepgram"})
    s.insertEvent("r1", "vad", {speaking: true})
    s.endSession("r1", "test")
    expect(s.countUtterances("r1")).toBe(2)
    expect(s.utterancesForRun("r1").map((u) => `${u.speaker_label}:${u.text}`)).toEqual(["S0:Hello.", "S1:Hi."])
    const session = s.db.query("SELECT wav_path, sample_rate, end_reason FROM sessions WHERE run_id = 'r1'").get() as Record<string, unknown>
    expect(session).toMatchObject({wav_path: "/tmp/r1.wav", sample_rate: 16000, end_reason: "test"})
    for (const t of ["people", "voiceprints", "speaker_assignments"]) {
      expect(s.db.query(`SELECT COUNT(*) AS c FROM ${t}`).get()).toEqual({c: 0})
    }
    s.close()
  })
})
