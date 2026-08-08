#!/usr/bin/env node
/**
 * collect.mjs — Pull daily request counts for every Worker + Pages project
 * on both Cloudflare accounts and merge into data/history.json.
 *
 * Data source: Cloudflare GraphQL Analytics API
 *   - workersInvocationsAdaptive            → per-script daily requests
 *   - pagesFunctionsInvocationsAdaptiveGroups → per-project daily function requests
 *
 * Env (set by GitHub Actions secrets):
 *   CF_ACCOUNT1, CF_TOKEN_ACCOUNT1   (walusimbileon1@gmail.com)
 *   CF_ACCOUNT2, CF_TOKEN_ACCOUNT2   (walusimbileon2@gmail.com)
 *
 * Behavior: fetches the last 2 days (yesterday + today) on each run and
 * merges into the persistent history file. Safe to run daily.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");
const GQL_URL = "https://api.cloudflare.com/client/v4/graphql";

const LOOKBACK_DAYS = 2; // yesterday + today (today may be partial, merged by max)

// ── Date helpers (UTC) ─────────────────────────────────────────────────────
function isoDay(offsetDays) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - offsetDays);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function lastNDays(n, endOffset = 0) {
  const days = [];
  for (let i = n - 1 + endOffset; i >= endOffset; i--) days.push(isoDay(i));
  return days;
}

// ── GraphQL ─────────────────────────────────────────────────────────────────
async function gql(token, query, variables) {
  const res = await fetch(GQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (!res.ok || data.errors) {
    throw new Error("GraphQL error: " + JSON.stringify(data.errors || data));
  }
  return data;
}

const WORKERS_QUERY = `
query WorkersDaily($accountTag: String!, $since: String!, $until: String!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workersInvocationsAdaptive(
        limit: 5000
        filter: { date_geq: $since, date_leq: $until }
      ) {
        dimensions { date scriptName }
        sum { requests errors }
      }
    }
  }
}`;

const PAGES_QUERY = `
query PagesDaily($accountTag: String!, $since: String!, $until: String!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      pagesFunctionsInvocationsAdaptiveGroups(
        limit: 5000
        filter: { date_geq: $since, date_leq: $until }
      ) {
        dimensions { date scriptName }
        sum { requests errors }
      }
    }
  }
}`;

// ── Cloudflare REST helpers ─────────────────────────────────────────────────
async function cfGet(token, pathname) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${pathname}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!data.success) {
    throw new Error(`CF ${pathname}: ${JSON.stringify(data.errors || data)}`);
  }
  return data.result;
}

// All worker script names on the account (so idle services still appear at 0)
async function fetchWorkerScripts(token, accountId) {
  try {
    const scripts = await cfGet(token, `/accounts/${accountId}/workers/scripts`);
    return (scripts || []).map((s) => s.id);
  } catch {
    return [];
  }
}

// Pages projects → their production script name (pages-worker--<id>-production)
async function fetchPagesProjects(token, accountId) {
  try {
    // NOTE: the list endpoint REJECTS per_page/page params (error 8000024) and
    // the list rows omit production_script_name — so fetch each project by name.
    const projects = await cfGet(token, `/accounts/${accountId}/pages/projects`);
    const map = {};
    for (const p of projects) {
      try {
        const detail = await cfGet(token, `/accounts/${accountId}/pages/projects/${p.name}`);
        if (detail && detail.production_script_name) map[detail.production_script_name] = detail.name;
      } catch {
        /* project may have been deleted — skip */
      }
    }
    return map;
  } catch {
    return {}; // no pages projects / no permission — non-fatal
  }
}

// ── History file ────────────────────────────────────────────────────────────
function loadHistory() {
  if (fs.existsSync(HISTORY_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    } catch {
      /* corrupt — start fresh */
    }
  }
  return { updatedAt: null, accounts: {} };
}

function mergeRow(accounts, accountId, service, platform, kind, date, requests, errors) {
  if (!accounts[accountId]) accounts[accountId] = { label: accountId, services: {} };
  // Key by platform+name: pop-party exists as BOTH a worker and a Pages
  // project — without the prefix they'd collide into one row.
  const key = `${platform}:${service}`;
  const svc = (accounts[accountId].services[key] ||= {
    name: service,
    platform,
    kind,
    daily: {},
    errors: {},
  });
  // Keep the largest seen value for the day (today may be partial, later runs complete it)
  svc.daily[date] = Math.max(svc.daily[date] || 0, requests || 0);
  svc.errors[date] = Math.max(svc.errors[date] || 0, errors || 0);
}

// ── Main ────────────────────────────────────────────────────────────────────
const ACCOUNTS = [
  {
    id: process.env.CF_ACCOUNT1,
    token: process.env.CF_TOKEN_ACCOUNT1,
    label: "Account 1 — walusimbileon1",
  },
  {
    id: process.env.CF_ACCOUNT2,
    token: process.env.CF_TOKEN_ACCOUNT2,
    label: "Account 2 — walusimbileon2",
  },
].filter((a) => a.id && a.token);

if (!ACCOUNTS.length) {
  console.error("No Cloudflare credentials in env (CF_ACCOUNT1/2, CF_TOKEN_ACCOUNT1/2)");
  process.exit(1);
}

const since = isoDay(LOOKBACK_DAYS); // inclusive
const until = isoDay(0);             // today
const days = lastNDays(LOOKBACK_DAYS + 1);
console.log(`Fetching ${since} → ${until} (${days.length} days)`);

const history = loadHistory();
if (!history.accounts || typeof history.accounts !== "object") history.accounts = {};

for (const acc of ACCOUNTS) {
  console.log(`\n== ${acc.label} (${acc.id}) ==`);
  try {
    // Pages script-name → project-name mapping + full worker/pages service list
    const pagesMap = await fetchPagesProjects(acc.token, acc.id);
    const workerScripts = await fetchWorkerScripts(acc.token, acc.id);

    // Seed every known service with zeros for the window (idle services show up)
    for (const script of workerScripts) {
      for (const d of days) mergeRow(history.accounts, acc.id, script, "worker", "worker", d, 0, 0);
    }
    for (const pretty of Object.values(pagesMap)) {
      for (const d of days) mergeRow(history.accounts, acc.id, pretty, "pages", "pages", d, 0, 0);
    }

    // Workers
    const w = await gql(acc.token, WORKERS_QUERY, { accountTag: acc.id, since, until });
    const wRows = (w?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive || []).filter(
      (r) => r.dimensions?.scriptName && r.dimensions.scriptName !== "__unknown__"
    );
    console.log(`  workers rows: ${wRows.length}`);
    for (const row of wRows) {
      const { date, scriptName } = row.dimensions;
      mergeRow(history.accounts, acc.id, scriptName, "worker", "worker", date, row.sum.requests, row.sum.errors);
    }

    // Pages functions
    const p = await gql(acc.token, PAGES_QUERY, { accountTag: acc.id, since, until });
    const pRows = p?.data?.viewer?.accounts?.[0]?.pagesFunctionsInvocationsAdaptiveGroups || [];
    console.log(`  pages rows: ${pRows.length}`);
    for (const row of pRows) {
      const { date, scriptName } = row.dimensions;
      const pretty = pagesMap[scriptName] || scriptName;
      mergeRow(history.accounts, acc.id, pretty, "pages", "pages", date, row.sum.requests, row.sum.errors);
    }

    // Cleanup stale entries from earlier runs:
    //  - __unknown__ rows (Cloudflare placeholder) — never useful
    //  - raw pages-worker--<id> names when we now have the pretty project name
    const svcs = history.accounts[acc.id]?.services;
    if (svcs) {
      for (const [key, svc] of Object.entries(svcs)) {
        if (svc.name === "__unknown__") delete svcs[key];
        if (svc.name.startsWith("pages-worker--") && pagesMap[svc.name]) delete svcs[key];
      }
    }
  } catch (err) {
    console.error(`  ERROR for ${acc.id}:`, err.message);
  }
}

// Ensure every known service has an entry for every day in range (fill 0)
for (const accId of Object.keys(history.accounts)) {
  for (const svc of Object.values(history.accounts[accId].services)) {
    for (const d of days) {
      if (!(d in svc.daily)) svc.daily[d] = 0;
      if (!(d in svc.errors)) svc.errors[d] = 0;
    }
  }
}

history.updatedAt = new Date().toISOString();
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
console.log(`\n✅ history.json written (${Object.values(history.accounts).reduce((n, a) => n + Object.keys(a.services).length, 0)} services)`);
