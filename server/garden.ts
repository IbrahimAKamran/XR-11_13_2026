/**
 * Export the Mind Palace as a Memory Garden file.
 *
 * Memory Garden (https://ibrahimakamran.github.io/Memory-Garden/) is a separate
 * web app that grows a 3D tree per person and shows it beside their head in a
 * webcam "AR mirror". It imports `{v: 1, profiles: [...]}` with its ⬆ Import
 * button. This builds that file from PICoVoice's people, so everyone you met
 * through the glasses appears in the garden with their facts and quotes.
 *
 * Tree shapes: Memory Garden normally derives a tree's 10 genes from the
 * browser mic. PICoVoice has no voice features to give it yet, so the genes
 * come from a stable hash of the person, marked genomeEdited so the garden
 * keeps them. The same person always grows the same tree. Faces are linked in
 * the garden itself ("Link face in view").
 */
import type {PersonDetail} from "./people"

export interface GardenProfile {
  id: string
  name: string
  autoName: false
  notes: string
  demo: false
  createdAt: number
  lastHeard: number
  slot: number
  arSide: "auto"
  arPos: null
  idMean: null
  u: number[]
  genome: number[]
  genomeEdited: true
  seed: number
  traits: null
  faceSig: null
  faceN: 0
  talkSec: number
  laughs: 0
  words: number
  quotes: Array<{t: number; text: string}>
  facts: Record<string, string[]>
  kw: Record<string, 1>
  source: "picovoice"
}

/** Deterministic pseudo-random numbers in [0, 1) from a string (mulberry32 over an FNV-1a seed). */
function stream(key: string): () => number {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619)
  let a = h >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const STOP = new Set(["that", "this", "with", "have", "what", "from", "they", "there", "about", "would", "should", "could", "their", "been", "were", "just", "like", "really", "think", "know"])

export function toGardenProfile(p: PersonDetail): GardenProfile {
  const rnd = stream(`picovoice:${p.id}:${p.display_name}`)
  const u = Array.from({length: 14}, () => Math.round((rnd() * 3 - 1.5) * 1000) / 1000)
  const genome = Array.from({length: 10}, () => Math.round((0.15 + rnd() * 0.7) * 1000) / 1000)
  const seed = Math.floor(rnd() * 2 ** 32)
  const facts: Record<string, string[]> = {}
  if (p.role) facts.role = [p.role]
  if (p.met_at) facts.other = [`met: ${p.met_at}`]
  if (!p.voice_consent) (facts.other ??= []).push("name only, no voice saved")
  const quotes = p.quotes.map((q, i) => ({t: p.created_at + i, text: q.text}))
  const words = quotes.reduce((n, q) => n + q.text.split(/\s+/).filter(Boolean).length, 0)
  const kw: Record<string, 1> = {}
  for (const v of [p.role, p.met_at, ...quotes.map((q) => q.text)]) {
    for (const w of (v ?? "").toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? []) if (!STOP.has(w)) kw[w] = 1
  }
  return {
    id: `picovoice-${p.id}`,
    name: p.display_name,
    autoName: false,
    notes: p.notes ?? "",
    demo: false,
    createdAt: p.created_at,
    lastHeard: p.created_at,
    slot: 0, // the garden assigns a free slot on import
    arSide: "auto",
    arPos: null,
    idMean: null,
    u,
    genome,
    genomeEdited: true,
    seed,
    traits: null,
    faceSig: null,
    faceN: 0,
    // Trees grow with talk time; give everyone a visible sapling at least.
    talkSec: Math.max(60, Math.round(p.speech_seconds)),
    laughs: 0,
    words,
    quotes,
    facts,
    kw,
    source: "picovoice",
  }
}

export function toGardenExport(people: PersonDetail[]): {v: 1; profiles: GardenProfile[]} {
  return {v: 1, profiles: people.map(toGardenProfile)}
}
