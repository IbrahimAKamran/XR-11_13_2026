import {describe, expect, test} from "bun:test"
import {dashboardRoute} from "./dashboard"
import {Store} from "./store"

const get = (store: Store, path: string): Promise<Response | null> => {
  const req = new Request(`http://localhost${path}`)
  return dashboardRoute(req, new URL(req.url), store)
}

function seeded(): Store {
  const s = new Store(":memory:")
  s.startSession({runId: "r1", startedAt: 1000, provider: "deepgram"})
  s.startSession({runId: "r2", startedAt: 2000, provider: "deepgram"})
  s.insertUtterance({runId: "r1", tStart: 1, tEnd: 2, speakerLabel: "S0", text: "Hello.", confidence: 0.9, speechFinal: true, provider: "deepgram"})
  s.insertUtterance({runId: "r1", tStart: 2.5, tEnd: 3, speakerLabel: "S1", text: "Hi.", confidence: 0.8, speechFinal: true, provider: "deepgram"})
  s.insertUtterance({runId: "r2", tStart: 0, tEnd: 1, speakerLabel: "S0", text: "Other run.", confidence: 0.8, speechFinal: false, provider: "deepgram"})
  return s
}

describe("dashboard routes", () => {
  test("serves the page", async () => {
    const res = await get(seeded(), "/dashboard")
    expect(res?.status).toBe(200)
    expect(res?.headers.get("content-type")).toContain("text/html")
    expect(await res?.text()).toContain("/api/sessions")
  })

  test("lists sessions newest first with counts", async () => {
    const body = (await (await get(seeded(), "/api/sessions"))!.json()) as {sessions: Array<{run_id: string; utterance_count: number}>}
    expect(body.sessions.map((s) => [s.run_id, s.utterance_count])).toEqual([["r2", 1], ["r1", 2]])
  })

  test("returns only utterances after the given id, for that run", async () => {
    const s = seeded()
    const all = (await (await get(s, "/api/sessions/r1/utterances"))!.json()) as {utterances: Array<{id: number; text: string}>; lastId: number}
    expect(all.utterances.map((u) => u.text)).toEqual(["Hello.", "Hi."])
    const rest = (await (await get(s, `/api/sessions/r1/utterances?after=${all.utterances[0].id}`))!.json()) as {utterances: Array<{text: string}>; lastId: number}
    expect(rest.utterances.map((u) => u.text)).toEqual(["Hi."])
    expect(rest.lastId).toBe(all.lastId)
    const none = (await (await get(s, `/api/sessions/r1/utterances?after=${all.lastId}`))!.json()) as {utterances: unknown[]; lastId: number}
    expect(none.utterances).toEqual([])
    expect(none.lastId).toBe(all.lastId)
  })

  test("shows a person's name once a label is assigned", async () => {
    const s = seeded()
    const pid = Number(s.db.run(`INSERT INTO people (display_name, created_at) VALUES ('Maya', 1)`).lastInsertRowid)
    s.db.run(`INSERT INTO speaker_assignments (run_id, speaker_label, person_id, method, created_at) VALUES ('r1', 'S1', ?, 'test', 1)`, [pid])
    const body = (await (await get(s, "/api/sessions/r1/utterances"))!.json()) as {utterances: Array<{speaker_label: string; person_name: string | null}>}
    expect(body.utterances.map((u) => [u.speaker_label, u.person_name])).toEqual([["S0", null], ["S1", "Maya"]])
  })

  test("falls through for other paths and methods", async () => {
    const s = seeded()
    expect(await get(s, "/health")).toBeNull()
    expect((await get(s, "/api/nope"))?.status).toBe(404)
    const post = new Request("http://localhost/api/sessions", {method: "POST"})
    expect(await dashboardRoute(post, new URL(post.url), s)).toBeNull()
  })
})
