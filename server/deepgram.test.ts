import {describe, expect, test} from "bun:test"
import {segmentsFromResults, type DgResults} from "./deepgram"

const results = (over: Partial<DgResults> & {words?: DgResults["channel"]["alternatives"][0]["words"]; transcript?: string}): DgResults => ({
  type: "Results",
  start: over.start ?? 10,
  duration: over.duration ?? 2,
  is_final: over.is_final ?? true,
  speech_final: over.speech_final ?? false,
  channel: {alternatives: [{transcript: over.transcript ?? "", confidence: 0.9, words: over.words ?? []}]},
})

describe("segmentsFromResults", () => {
  test("splits consecutive words by speaker and uses punctuated words", () => {
    const segs = segmentsFromResults(
      results({
        transcript: "hi there how are you",
        words: [
          {word: "hi", punctuated_word: "Hi", start: 10.0, end: 10.2, confidence: 0.9, speaker: 0},
          {word: "there", punctuated_word: "there.", start: 10.2, end: 10.5, confidence: 0.8, speaker: 0},
          {word: "how", punctuated_word: "How", start: 10.8, end: 11.0, confidence: 1.0, speaker: 1},
          {word: "are", punctuated_word: "are", start: 11.0, end: 11.1, confidence: 1.0, speaker: 1},
          {word: "you", punctuated_word: "you?", start: 11.1, end: 11.4, confidence: 0.6, speaker: 1},
        ],
      }),
    )
    expect(segs).toHaveLength(2)
    expect(segs[0]).toMatchObject({speaker: 0, text: "Hi there.", tStart: 10.0, tEnd: 10.5})
    expect(segs[0].confidence).toBeCloseTo(0.85, 5)
    expect(segs[1]).toMatchObject({speaker: 1, text: "How are you?", tStart: 10.8, tEnd: 11.4})
  })

  test("applies the time base from earlier connections", () => {
    const segs = segmentsFromResults(results({words: [{word: "ok", start: 1, end: 1.5, confidence: 1, speaker: 2}], transcript: "ok"}), 100)
    expect(segs[0]).toMatchObject({speaker: 2, tStart: 101, tEnd: 101.5})
  })

  test("returns nothing for an empty transcript and a null speaker when words lack one", () => {
    expect(segmentsFromResults(results({transcript: ""}))).toEqual([])
    const segs = segmentsFromResults(results({transcript: "hello", words: [{word: "hello", start: 3, end: 3.4, confidence: 0.7}]}))
    expect(segs).toEqual([{speaker: null, text: "hello", tStart: 3, tEnd: 3.4, confidence: 0.7}])
  })

  test("falls back to the transcript when no words are present", () => {
    const segs = segmentsFromResults(results({transcript: "just text", start: 5, duration: 1.5}))
    expect(segs).toEqual([{speaker: null, text: "just text", tStart: 5, tEnd: 6.5, confidence: 0.9}])
  })
})

import {buildDeepgramUrl} from "./deepgram"

describe("buildDeepgramUrl", () => {
  test("uses diarize_model=latest and the phone's sample rate by default", () => {
    const u = new URL(buildDeepgramUrl("wss://api.deepgram.com/v1/listen", {sampleRate: 16000}))
    expect(u.searchParams.get("diarize_model")).toBe("latest")
    expect(u.searchParams.get("diarize")).toBeNull()
    expect(u.searchParams.get("sample_rate")).toBe("16000")
    expect(u.searchParams.get("encoding")).toBe("linear16")
    expect(u.searchParams.get("interim_results")).toBe("true")
    expect(u.searchParams.get("model")).toBe("nova-3")
  })
  test("extra params override defaults, and diarize replaces diarize_model", () => {
    const u = new URL(buildDeepgramUrl("ws://127.0.0.1:1/v1/listen", {sampleRate: 24000, model: "nova-2", extraParams: "diarize=true&keyterm=Mentra&language=multi"}))
    expect(u.searchParams.get("diarize")).toBe("true")
    expect(u.searchParams.get("diarize_model")).toBeNull()
    expect(u.searchParams.get("keyterm")).toBe("Mentra")
    expect(u.searchParams.get("language")).toBe("multi")
    expect(u.searchParams.get("model")).toBe("nova-2")
    expect(u.searchParams.get("sample_rate")).toBe("24000")
  })
})
