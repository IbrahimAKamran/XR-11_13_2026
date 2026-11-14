import {describe, expect, test} from "bun:test"
import {readFileSync, rmSync} from "node:fs"
import {WavFile, wavHeader, WAV_HEADER_BYTES} from "./wav"

describe("wavHeader", () => {
  test("encodes a 16 kHz mono 16-bit header with the right sizes", () => {
    const h = Buffer.from(wavHeader({sampleRate: 16000, channels: 1, bitsPerSample: 16}, 32000))
    expect(h.length).toBe(WAV_HEADER_BYTES)
    expect(h.toString("ascii", 0, 4)).toBe("RIFF")
    expect(h.readUInt32LE(4)).toBe(36 + 32000)
    expect(h.toString("ascii", 8, 12)).toBe("WAVE")
    expect(h.readUInt16LE(20)).toBe(1) // PCM
    expect(h.readUInt16LE(22)).toBe(1) // mono
    expect(h.readUInt32LE(24)).toBe(16000)
    expect(h.readUInt32LE(28)).toBe(32000) // byte rate
    expect(h.readUInt16LE(32)).toBe(2) // block align
    expect(h.readUInt16LE(34)).toBe(16)
    expect(h.toString("ascii", 36, 40)).toBe("data")
    expect(h.readUInt32LE(40)).toBe(32000)
  })
})

describe("WavFile", () => {
  test("appends PCM and keeps the header patched so the file is always valid", () => {
    const path = `/tmp/fieldassist-wav-test-${process.pid}.wav`
    try {
      const wav = new WavFile(path, {sampleRate: 16000, channels: 1, bitsPerSample: 16})
      const chunk = new Uint8Array(3200) // 100 ms of 16 kHz 16-bit mono
      wav.append(chunk)
      wav.append(chunk)
      expect(wav.bytes).toBe(6400)
      expect(wav.seconds).toBeCloseTo(0.2, 5)
      // Crash safety: the header already describes the data before close().
      const beforeClose = readFileSync(path)
      expect(beforeClose.readUInt32LE(40)).toBe(6400)
      expect(beforeClose.readUInt32LE(4)).toBe(36 + 6400)
      wav.close()
      expect(() => wav.append(chunk)).toThrow()
      const file = readFileSync(path)
      expect(file.length).toBe(WAV_HEADER_BYTES + 6400)
      expect(file.readUInt32LE(40)).toBe(6400)
      expect(file.readUInt32LE(4)).toBe(36 + 6400)
    } finally {
      rmSync(path, {force: true})
    }
  })
})
