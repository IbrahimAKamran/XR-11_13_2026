/**
 * Fills the database with a fake conversation so the dashboard can be built
 * and tested without the glasses.
 *
 *   bun run seed            one finished conversation, written at once
 *   bun run seed --live     a "live" conversation: one new line every 2 s
 *   bun run seed --names    also save S1 as "Maya Chen" in the Mind Palace (Picavoice app)
 *
 * Uses the same database as the ingest server (FIELDASSIST_DB, default
 * data/fieldassist.sqlite). Runs alongside `bun run ingest`; SQLite handles both.
 */
import {join} from "node:path"
import {People} from "../server/people"
import {Store} from "../server/store"

const DB_PATH = process.env.FIELDASSIST_DB ?? join(import.meta.dir, "..", "data", "fieldassist.sqlite")
const live = process.argv.includes("--live")
const names = process.argv.includes("--names")

const SCRIPT: Array<[string, string]> = [
  ["S0", "Echo, start."],
  ["S0", "Thanks for doing this. Do you agree to this being recorded?"],
  ["S1", "Yes, that's fine."],
  ["S0", "Great. What's the hardest part of onboarding new users today?"],
  ["S1", "Honestly, people skip the setup screens. They want to try the thing first."],
  ["S1", "I think onboarding should start with a short voice tutorial instead of forms."],
  ["S0", "Echo, remember that onboarding should start with a voice tutorial."],
  ["S0", "And what would make you come back the next day?"],
  ["S1", "Seeing what I said yesterday, summarized. Like a running notebook."],
  ["S0", "Got it. Thanks, that's really useful."],
]

const store = new Store(DB_PATH)
const runId = `demo-${Date.now().toString(36)}`
store.startSession({runId, startedAt: Date.now(), provider: "seed"})

if (names) {
  const people = new People(store.db)
  people.create({name: "Maya Chen", role: "Product designer", metAt: "Demo booth, day 1", voiceConsent: true, runId, speakerLabel: "S1"})
}

let t = 0.5
const write = ([label, text]: [string, string]): void => {
  const dur = Math.max(1.2, text.split(" ").length * 0.35)
  store.insertUtterance({runId, tStart: t, tEnd: t + dur, speakerLabel: label, text, confidence: 0.95, speechFinal: true, provider: "seed"})
  t += dur + 0.6
}

console.log(`seeding run ${runId} into ${DB_PATH}${live ? " (live: one line every 2 s, Ctrl+C to stop)" : ""}`)
if (!live) {
  SCRIPT.forEach(write)
  store.endSession(runId, "seed")
  console.log(`wrote ${SCRIPT.length} lines; open /dashboard`)
  store.close()
} else {
  let i = 0
  const timer = setInterval(() => {
    write(SCRIPT[i])
    console.log(`  ${SCRIPT[i][0]}: ${SCRIPT[i][1]}`)
    i++
    if (i === SCRIPT.length) {
      clearInterval(timer)
      store.endSession(runId, "seed")
      store.close()
      console.log("done; the conversation is now marked ended")
    }
  }, 2000)
  process.on("SIGINT", () => {
    clearInterval(timer)
    store.endSession(runId, "seed stopped")
    store.close()
    process.exit(0)
  })
}
