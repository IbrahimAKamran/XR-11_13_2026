/**
 * Minimal WAV (RIFF) writer for 16-bit little-endian PCM. The header is written
 * first with zero sizes and patched on every flush and on close, so a crash or
 * Ctrl+C still leaves a playable file.
 */
import {closeSync, mkdirSync, openSync, writeSync} from "node:fs"
import {dirname} from "node:path"

export interface WavFormat {
  sampleRate: number
  channels: number
  bitsPerSample: number
}

export const WAV_HEADER_BYTES = 44

/** Build the 44-byte RIFF/WAVE header for `dataBytes` bytes of PCM. */
export function wavHeader(fmt: WavFormat, dataBytes: number): Uint8Array {
  const blockAlign = (fmt.channels * fmt.bitsPerSample) / 8
  const byteRate = fmt.sampleRate * blockAlign
  const buf = Buffer.alloc(WAV_HEADER_BYTES)
  buf.write("RIFF", 0, "ascii")
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write("WAVE", 8, "ascii")
  buf.write("fmt ", 12, "ascii")
  buf.writeUInt32LE(16, 16) // fmt chunk size (PCM)
  buf.writeUInt16LE(1, 20) // audio format 1 = PCM
  buf.writeUInt16LE(fmt.channels, 22)
  buf.writeUInt32LE(fmt.sampleRate, 24)
  buf.writeUInt32LE(byteRate, 28)
  buf.writeUInt16LE(blockAlign, 32)
  buf.writeUInt16LE(fmt.bitsPerSample, 34)
  buf.write("data", 36, "ascii")
  buf.writeUInt32LE(dataBytes, 40)
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

export class WavFile {
  readonly path: string
  readonly format: WavFormat
  private fd: number
  private dataBytes = 0
  private closed = false

  constructor(path: string, format: WavFormat) {
    this.path = path
    this.format = format
    mkdirSync(dirname(path), {recursive: true})
    this.fd = openSync(path, "w")
    writeSync(this.fd, wavHeader(format, 0), 0, WAV_HEADER_BYTES, 0)
  }

  /** Append raw PCM bytes and keep the header sizes current. */
  append(pcm: Uint8Array): void {
    if (this.closed) throw new Error("WavFile is closed")
    writeSync(this.fd, pcm, 0, pcm.byteLength, WAV_HEADER_BYTES + this.dataBytes)
    this.dataBytes += pcm.byteLength
    writeSync(this.fd, wavHeader(this.format, this.dataBytes), 0, WAV_HEADER_BYTES, 0)
  }

  /** Seconds of audio written so far. */
  get seconds(): number {
    const bytesPerSecond = (this.format.sampleRate * this.format.channels * this.format.bitsPerSample) / 8
    return bytesPerSecond > 0 ? this.dataBytes / bytesPerSecond : 0
  }

  get bytes(): number {
    return this.dataBytes
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    closeSync(this.fd)
  }
}
