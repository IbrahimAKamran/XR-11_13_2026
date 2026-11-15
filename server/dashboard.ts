/**
 * Read-only dashboard routes, served by the ingest server on the same port.
 *
 *   GET /dashboard                              the page (server/dashboard.html)
 *   GET /api/sessions                           newest sessions first
 *   GET /api/sessions/:runId/utterances?after=N utterances with id > N, oldest first
 *
 * The page polls over plain HTTP because WebSockets from the iPhone to the Mac
 * fail (see README, Troubleshooting).
 */
import {join} from "node:path"
import type {Store} from "./store"

const PAGE_PATH = join(import.meta.dir, "dashboard.html")

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {status, headers: {"content-type": "application/json", "cache-control": "no-store"}})

/** Returns a Response for dashboard routes, or null so the caller can fall through. */
export async function dashboardRoute(req: Request, url: URL, store: Store): Promise<Response | null> {
  if (req.method !== "GET") return null
  const path = url.pathname.replace(/\/+$/, "") || "/"

  if (path === "/dashboard") {
    return new Response(Bun.file(PAGE_PATH), {headers: {"content-type": "text/html; charset=utf-8", "cache-control": "no-store"}})
  }
  if (path === "/api/sessions") {
    const limit = clampInt(url.searchParams.get("limit"), 1, 200, 50)
    return json({sessions: store.listSessions(limit)})
  }
  const m = path.match(/^\/api\/sessions\/([^/]+)\/utterances$/)
  if (m) {
    const runId = decodeURIComponent(m[1])
    const after = clampInt(url.searchParams.get("after"), 0, Number.MAX_SAFE_INTEGER, 0)
    const utterances = store.utterancesSince(runId, after)
    return json({runId, utterances, lastId: utterances.length ? utterances[utterances.length - 1].id : after})
  }
  if (path.startsWith("/api/")) return json({error: "not found"}, 404)
  return null
}

function clampInt(raw: string | null, min: number, max: number, fallback: number): number {
  const n = raw == null ? NaN : Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}
