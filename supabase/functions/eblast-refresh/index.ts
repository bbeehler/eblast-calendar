// eblast-refresh: lets the public calendar page start the "Refresh from Wrike" GitHub workflow.
//
//   GET  -> latest workflow run (status, conclusion, times) so the page can show progress
//   POST -> starts the workflow, unless one is already running or one started in the last 2 minutes
//
// Needs one Supabase secret: GH_DISPATCH_TOKEN, a fine-grained GitHub token limited to
// bbeehler/eblast-calendar with "Actions: Read and write" permission.
// The page has no login, so the function checks the calling site and rate-limits instead of using a JWT.

const REPO = "bbeehler/eblast-calendar";
const WORKFLOW = "refresh.yml";
const MIN_GAP_SECONDS = 120;
const ALLOWED_ORIGINS = ["https://bbeehler.github.io"];

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") ?? "";
  const cors = {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Vary": "Origin",
  };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const token = Deno.env.get("GH_DISPATCH_TOKEN");
  if (!token) return json({ error: "not_configured", message: "GH_DISPATCH_TOKEN secret is not set in Supabase." }, 500, cors);

  const gh = (path: string, init: RequestInit = {}) =>
    fetch(`https://api.github.com/repos/${REPO}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "eblast-calendar-refresh",
        ...(init.headers ?? {}),
      },
    });

  const latestRun = async () => {
    const r = await gh(`/actions/workflows/${WORKFLOW}/runs?per_page=1`);
    if (!r.ok) throw new Error(`GitHub ${r.status}`);
    const run = (await r.json()).workflow_runs?.[0];
    return run
      ? { status: run.status, conclusion: run.conclusion, event: run.event, created: run.created_at, updated: run.updated_at }
      : null;
  };

  try {
    if (req.method === "GET") return json({ run: await latestRun() }, 200, cors);
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, cors);
    if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: "forbidden" }, 403, cors);

    const run = await latestRun();
    if (run && run.status !== "completed") return json({ started: false, reason: "running", run }, 200, cors);
    const age = run ? (Date.now() - new Date(run.created).getTime()) / 1000 : Infinity;
    if (age < MIN_GAP_SECONDS) {
      return json({ started: false, reason: "recent", run, retryAfter: Math.ceil(MIN_GAP_SECONDS - age) }, 200, cors);
    }

    const r = await gh(`/actions/workflows/${WORKFLOW}/dispatches`, { method: "POST", body: JSON.stringify({ ref: "main" }) });
    if (r.status !== 204) return json({ error: "dispatch_failed", status: r.status, message: await r.text() }, 502, cors);
    return json({ started: true, at: new Date().toISOString() }, 200, cors);
  } catch (e) {
    return json({ error: "github_unreachable", message: String((e as Error).message ?? e) }, 502, cors);
  }
});
