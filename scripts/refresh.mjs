// Pulls eBlast sends from Wrike and writes data.json for the calendar page.
// Runs in GitHub Actions every 15 minutes. Needs the WRIKE_TOKEN secret (a Wrike permanent access token).
//
// Tagging order for each send (later wins):
//   1. auto      - guessed from the Wrike title (marked auto:true so the page can show it as unconfirmed)
//   2. overrides - data/overrides.json, hand-checked tags keyed by the Wrike numeric id in the permalink
//   3. Wrike     - custom fields "Broad send" and "Series step" on the task, when someone has filled them in

import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const TOKEN = process.env.WRIKE_TOKEN;
const SPACE_ID = process.env.WRIKE_SPACE_ID || "MQAAAAENKDdT"; // Marketing & Communications Operations — New
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 130);
const OUT = process.env.OUT || "data.json";
const OVERRIDES = process.env.OVERRIDES || "data/overrides.json";
const DRY = process.argv.includes("--dry");

if (!TOKEN && !process.env.MOCK) {
  console.error("WRIKE_TOKEN is not set. Add it under Settings → Secrets and variables → Actions.");
  process.exit(1);
}

/* ---------------- Wrike API ---------------- */
let BASE = null;
async function api(path, params = {}) {
  if (process.env.MOCK) return (await import(process.env.MOCK)).default(path, params);
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, typeof v === "string" ? v : JSON.stringify(v));
  const url = `${BASE}${path}${qs.toString() ? "?" + qs : ""}`;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `bearer ${TOKEN}` } });
    if (res.status === 429 && attempt < 5) { await new Promise(r => setTimeout(r, 2000 * attempt)); continue; }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Wrike ${res.status} on ${path}: ${body.errorDescription || body.error || res.statusText}`);
    return body;
  }
}
async function pickHost() {
  if (process.env.MOCK) return;
  const hosts = [process.env.WRIKE_HOST, "www.wrike.com", "app-us2.wrike.com", "app-eu.wrike.com"].filter(Boolean);
  for (const h of hosts) {
    BASE = `https://${h}/api/v4`;
    try { await api("/contacts", { me: "true" }); console.log(`Using ${h}`); return; }
    catch (e) { console.log(`${h}: ${e.message}`); }
  }
  throw new Error("Could not reach Wrike with this token on any data center host.");
}
async function paged(path, params) {
  const out = [];
  let nextPageToken;
  do {
    const r = await api(path, { ...params, pageSize: 1000, nextPageToken });
    out.push(...(r.data || []));
    nextPageToken = r.nextPageToken;
  } while (nextPageToken);
  return out;
}
async function inBatches(prefix, ids, size = 100, params) {
  const out = [];
  const list = [...new Set(ids)];
  for (let i = 0; i < list.length; i += size) {
    const r = await api(`${prefix}/${list.slice(i, i + size).join(",")}`, params);
    out.push(...(r.data || []));
  }
  return out;
}

/* ---------------- helpers ---------------- */
const isoDay = d => d.toISOString().slice(0, 10);
const numericId = permalink => (String(permalink || "").match(/id=(\d+)/) || [])[1] || null;
const norm = s => String(s || "").toLowerCase();
const BLAST = /e-?\s?blast/i;
const PRODUCTION = /\b(write|copy|translat\w*|design|layout|review|proof\w*|draft|approv\w*|brief)\b/i;
const CONTAINER = /one-off content|all email marketing projects/i;
const MONTHS = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\b/gi;

// A task is a send if it reads like one ("Eblast: …", "eBlast to all members", "Send eBlast"),
// not a production step ("Design and layout eBlast", "Provide the attendee list … for e-blast #1").
const SEND_PREFIX = /^\s*(\d+\s*[.)-]\s*)?(aiac\s+)?e-?\s?blast\b\s*[:\-–]?/i;
const NOT_SEND = /\b(submit|provide|request|update|add|linktree|attendee list|webpage|plan)\b|copy to/i;
function isSendTask(title) {
  if (CONTAINER.test(title) || NOT_SEND.test(title)) return false;
  const sendWord = /\bsend\b|\bschedule\b/i.test(title);
  if (PRODUCTION.test(title) && !sendWord) return false;
  return SEND_PREFIX.test(title) || sendWord || /e-?\s?blast\s+(to|of)\b/i.test(title);
}

function isGeneric(title) {
  const rest = norm(title)
    .replace(BLAST, " ").replace(MONTHS, " ")
    .replace(/\b(send|schedule|and|the|to|a\.?m\.?|p\.?m\.?)\b/g, " ")
    .replace(/[^a-z]+/g, " ").trim();
  return rest.split(/\s+/).filter(w => w.length > 1).length < 2;
}
function cleanTitle(t) {
  return String(t).replace(/^\s*\d+\s*[.)-]\s*/, "").replace(/^\s*(aiac\s+)?e-?\s?blast\s*[:\-–]\s*/i, "").replace(/\s{2,}/g, " ").trim();
}

function guessProgram(text) {
  const t = norm(text);
  if (/caic|industry week|leadership roundtable/.test(t)) return "caic";
  if (/canada night/.test(t)) return "cn";
  if (/golf/.test(t)) return "golf";
  if (/saic|student automotive|student aftermarket/.test(t)) return "saic";
  if (/i-?car/.test(t)) return "icar";
  if (/ccif/.test(t)) return "ccif";
  if (/\bypa\b|young professional/.test(t)) return "ypa";
  return "mem";
}
function guessKind(text) {
  const t = norm(text);
  if (/kbyg|know before|survey/.test(t)) return "log";
  if (/tariff|advisory|urgent|recall/.test(t)) return "adv";
  if (/sponsor|supporter|vendor|exhibitor|prospectus|claim tickets|partner/.test(t)) return "spons";
  if (/\breg\b|registration|register|launch|rmd|reminder|last call|last chance|left to|tickets|application|closes|early bird/.test(t)) return "reg";
  return "content";
}
function guessBroad(text, program, kind) {
  const t = norm(text);
  if (kind === "log") return false;
  if (program === "golf" || program === "ccif") return false;
  if (/registered|attendees\)|past ccif|vendors|(gold|platinum|diamond|maple leaf)[^)]*sponsors|division|qc member/.test(t)) return false;
  return true;
}
function stepFromTitle(text) {
  const t = norm(text);
  const m = t.match(/(?:rmd|reminder)\s*#?\s*(\d+)/);
  if (m) return Number(m[1]) + 1;
  if (/\blaunch\b/.test(t)) return 1;
  return null;
}
function readCustom(task, fieldIds) {
  const out = {};
  for (const cf of task.customFields || []) {
    const v = String(cf.value ?? "").trim();
    if (!v) continue;
    if (cf.id === fieldIds.broad) out.b = /^(yes|true|1|broad)/i.test(v);
    if (cf.id === fieldIds.step) {
      const s = norm(v);
      if (/single|one-off|^one$/.test(s)) out.single = true;
      else if (/launch/.test(s)) out.st = 1;
      else if (/last/.test(s)) out.last = true;
      else { const n = s.match(/(\d+)/); if (/remind|rmd/.test(s)) out.st = n ? Number(n[1]) + 1 : 2; else if (n) out.st = Number(n[1]); }
    }
  }
  return out;
}

/* ---------------- main ---------------- */
async function main() {
  await pickHost();
  const today = new Date();
  const from = new Date(today); from.setDate(from.getDate() - LOOKBACK_DAYS);
  const FROM = isoDay(from);

  // Custom fields "Broad send" and "Series step", if they exist
  const fields = (await api("/customfields")).data || [];
  const fieldIds = {
    broad: fields.find(f => /broad\s*send/i.test(f.title))?.id,
    step: fields.find(f => /series\s*step/i.test(f.title))?.id,
  };
  console.log("Custom fields:", JSON.stringify(fieldIds));

  // Tasks with "blast" in the title anywhere in the space
  // Wrike's title filter is case-sensitive, so ask for both "blast" (Eblast, e-blast) and "Blast" (eBlast, e-Blast)
  const byId = new Map();
  for (const title of ["blast", "Blast", "BLAST"]) {
    const found = await paged(`/spaces/${SPACE_ID}/tasks`, {
      descendants: "true", subTasks: "true", title,
      fields: ["responsibleIds", "parentIds", "customFields"],
    });
    console.log(`Tasks matching "${title}": ${found.length}`);
    for (const t of found) byId.set(t.id, t);
  }
  const tasks = [...byId.values()];

  // Projects/folders in the space, to find eBlast projects with no separate send task
  const tree = await api(`/spaces/${SPACE_ID}/folders`).then(r => r.data || []).catch(e => { console.log(`Folder tree failed: ${e.message}`); return []; });
  console.log(`Folders and projects in space: ${tree.length}`);
  const blastProjects = tree.filter(f => f.project && BLAST.test(f.title) && !CONTAINER.test(f.title));

  // Parent details for titles and project dates
  const parentIds = tasks.flatMap(t => t.parentIds || []);
  const folderIds = [...new Set([...parentIds, ...blastProjects.map(f => f.id)])];
  const folders = folderIds.length ? await inBatches("/folders", folderIds) : [];
  const folderById = Object.fromEntries(folders.map(f => [f.id, f]));

  // Owner names
  const contactIds = [...tasks.flatMap(t => t.responsibleIds || []), ...folders.flatMap(f => f.project?.ownerIds || [])];
  const contacts = contactIds.length ? await inBatches("/contacts", contactIds) : [];
  const nameOf = Object.fromEntries(contacts.map(c => [c.id, `${c.firstName || ""} ${c.lastName || ""}`.trim()]));

  const statusCode = s => (s === "Completed" ? "C" : s === "Cancelled" ? "X" : "A");
  const raw = [];
  const usedProjects = new Set();

  for (const t of tasks) {
    if (!isSendTask(t.title)) continue;
    const due = t.dates?.due || t.dates?.start;
    if (!due) continue;
    const d = due.slice(0, 10);
    const parents = (t.parentIds || []).map(id => folderById[id]).filter(Boolean);
    const blastParent = parents.find(p => BLAST.test(p.title) && !CONTAINER.test(p.title));
    const parent = blastParent || parents.find(p => p.project) || parents[0];
    if (blastParent) usedProjects.add(blastParent.id);
    const generic = isGeneric(t.title) && parent;
    const title = generic ? parent.title : t.title;
    raw.push({ d, title, context: generic ? `${t.title} ${parent.title}` : t.title, programContext: `${t.title} ${parent?.title || ""}`, status: statusCode(t.status), permalink: t.permalink, owner: (t.responsibleIds || []).map(id => nameOf[id]).filter(Boolean).join(", "), task: t });
  }
  for (const f of blastProjects) {
    if (usedProjects.has(f.id)) continue;
    const full = folderById[f.id] || f;
    const end = full.project?.endDate;
    if (!end) continue;
    // Skip projects that already have a send task under them
    if (raw.some(r => (r.task.parentIds || []).includes(f.id))) continue;
    const st = full.project?.status;
    raw.push({ d: end.slice(0, 10), title: full.title, context: full.title, status: full.project?.completedDate ? "C" : st === "Cancelled" ? "X" : "A", permalink: full.permalink, owner: (full.project?.ownerIds || []).map(id => nameOf[id]).filter(Boolean).join(", "), task: { customFields: full.customFields } });
  }

  const overrides = JSON.parse(await readFile(OVERRIDES, "utf8").catch(() => "{}"));

  let sends = raw
    .filter(r => r.d >= FROM)
    .map(r => {
      const id = numericId(r.permalink);
      const p = guessProgram(r.programContext || r.context);
      const k = guessKind(r.context);
      const s = {
        d: r.d, t: cleanTitle(r.title), p, s: r.status, id, url: r.permalink,
        o: r.owner, b: guessBroad(r.context, p, k), k, se: null, st: null, auto: true,
        _stepHint: stepFromTitle(r.context), _cf: readCustom(r.task, fieldIds),
      };
      const ov = id && overrides[id];
      if (ov) Object.assign(s, ov, { auto: false });
      if (s._cf.b !== undefined) { s.b = s._cf.b; if (!(k === "reg" || k === "spons") || s._cf.st || s._cf.single || s._cf.last) s.auto = false; }
      return s;
    });

  // De-duplicate by Wrike id (a task can sit in two folders)
  const seen = new Set();
  sends = sends.filter(s => { const key = s.id || s.url + s.d; if (seen.has(key)) return false; seen.add(key); return true; });
  sends.sort((a, b) => a.d.localeCompare(b.d) || a.t.localeCompare(b.t));

  // Series and step for anything not hand-tagged: group by program + ask type, new series after a 120-day gap
  const lastInSeries = {};
  for (const s of sends) {
    const cf = s._cf;
    if (!(s.k === "reg" || s.k === "spons")) { delete s._stepHint; delete s._cf; continue; }
    const base = `${s.p}-${s.k}`;
    if (s.se && !s.auto) { // hand-tagged: let later auto-tagged sends continue its numbering
      lastInSeries[base] = { d: s.d, n: s.st || 1, key: s.se };
      if (cf.st) { s.st = cf.st; } if (cf.last) { s.st = Math.max(s.st || 3, 3); }
      delete s._stepHint; delete s._cf; continue;
    }
    if (cf.single) { s.se = null; s.st = null; }
    else if (!s.se) {
      const prev = lastInSeries[base];
      const gap = prev ? (new Date(s.d) - new Date(prev.d)) / 864e5 : Infinity;
      const n = gap > 120 ? 1 : (prev?.n || 0) + (s.s === "X" ? 0 : 1);
      const key = gap > 120 ? `${base}-${s.d.slice(0, 7)}` : prev.key;
      lastInSeries[base] = { d: s.d, n: gap > 120 ? (s.s === "X" ? 0 : 1) : n, key };
      s.se = key;
      s.st = Math.max(n || 1, s._stepHint || 0);
    }
    if (cf.st) { s.st = cf.st; s.auto = false; }
    if (cf.last) { s.st = Math.max(s.st || 3, 3); s.auto = false; }
    delete s._stepHint; delete s._cf;
  }

  const prevCount = (prev0 => (prev0.sends || []).filter(x => x.d >= FROM).length)(JSON.parse(await readFile(OUT, "utf8").catch(() => "{}")));
  if (prevCount >= 10 && sends.length < prevCount * 0.6 && !process.env.FORCE) {
    console.error(`Found ${sends.length} sends, down from ${prevCount}. That looks like a bad pull, so the calendar keeps its last data. Run with FORCE=1 to accept it.`);
    process.exit(1);
  }
  const hash = createHash("sha256").update(JSON.stringify(sends)).digest("hex").slice(0, 16);
  const prev = JSON.parse(await readFile(OUT, "utf8").catch(() => "{}"));
  const changed = prev.hash !== hash;
  const out = { generated: changed ? new Date().toISOString() : prev.generated, hash, source: "wrike", space: SPACE_ID, sends };
  console.log(`${sends.length} sends from ${FROM} on · ${sends.filter(s => s.auto).length} auto-tagged · ${changed ? "changed" : "no change"}`);
  if (!DRY) await writeFile(OUT, JSON.stringify(out, null, 1) + "\n");
}

main().catch(e => { console.error(e.message); process.exit(1); });
