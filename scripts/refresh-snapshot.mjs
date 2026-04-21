#!/usr/bin/env node
// Refresh the STATIC fallback snapshot in index.html + international_finance_atlas.html.
// Mirrors the in-browser fetchers: open.er-api.com, World Bank, and The Economist Big Mac data.
// Idempotent: re-running with no changes leaves files untouched.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const FILES = ["index.html", "international_finance_atlas.html"].map(f => path.join(ROOT, f));

const WB = "https://api.worldbank.org/v2";
const WB_INDICATORS = {
  wbFX:   "PA.NUS.FCRF",        // annual avg LCU per USD (fallback for countries FX API doesn't cover)
  wbPPP:  "PA.NUS.PPP",         // PPP conversion factor (LCU per intl $)
  wbCA:   "BN.CAB.XOKA.GD.ZS",  // current account balance (% GDP)
  wbFisc: "GC.BAL.CASH.GD.ZS",  // fiscal cash balance (% GDP)
};
const FX_URL = "https://open.er-api.com/v6/latest/USD";
const BIGMAC_URL = "https://raw.githubusercontent.com/TheEconomistDataTeam/big-mac-data/master/output-data/big-mac-full-index.csv";

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}

async function fetchWBIndicator(indicator) {
  const url = `${WB}/country/all/indicator/${indicator}?format=json&per_page=20000&mrnev=1`;
  const j = await fetchJSON(url);
  const rows = j[1] || [];
  const out = {};
  for (const row of rows) {
    if (row.value == null) continue;
    const iso3 = row.countryiso3code || row.country?.id;
    if (!iso3 || iso3.length !== 3) continue;
    out[iso3] = +row.value;
  }
  return out;
}

async function fetchFX() {
  const j = await fetchJSON(FX_URL);
  if (j.result !== "success") throw new Error("FX result not success");
  return j.rates;
}

async function fetchBigMac() {
  const r = await fetch(BIGMAC_URL);
  if (!r.ok) throw new Error(`BigMac HTTP ${r.status}`);
  const text = await r.text();
  const lines = text.trim().split(/\r?\n/);
  const headers = lines.shift().split(",").map(h => h.trim());
  const iISO = headers.indexOf("iso_a3");
  const iDate = headers.indexOf("date");
  const iRaw = headers.indexOf("USD_raw");
  const byIso = {};
  for (const line of lines) {
    const cells = line.split(",");
    const iso = cells[iISO];
    const date = cells[iDate];
    const raw = parseFloat(cells[iRaw]);
    if (!iso || !date || !isFinite(raw)) continue;
    if (!byIso[iso] || date > byIso[iso].date) byIso[iso] = { date, over: raw };
  }
  const out = {};
  for (const [iso, v] of Object.entries(byIso)) out[iso] = v.over;
  return out;
}

// Parse CURRENCY map from the source file.
function parseCurrency(src) {
  const m = src.match(/const CURRENCY = \{([\s\S]*?)\};/);
  if (!m) throw new Error("CURRENCY block not found");
  const out = {};
  const re = /([A-Z]{3})\s*:\s*"([A-Z]{3})"/g;
  let mm;
  while ((mm = re.exec(m[1])) !== null) out[mm[1]] = mm[2];
  return out;
}

// Parse STATIC map from the source file. Returns { ISO: {er, ppp, ca, fisc, bm} }.
function parseStatic(src) {
  const m = src.match(/const STATIC = \{([\s\S]*?)\n\};/);
  if (!m) throw new Error("STATIC block not found");
  const body = m[1];
  const out = {};
  const entryRe = /([A-Z]{3})\s*:\s*\{([^}]*)\}/g;
  let mm;
  while ((mm = entryRe.exec(body)) !== null) {
    const iso = mm[1];
    const fields = {};
    const fieldRe = /(er|ppp|ca|fisc|bm)\s*:\s*(-?\d+(?:\.\d+)?)/g;
    let fm;
    while ((fm = fieldRe.exec(mm[2])) !== null) fields[fm[1]] = parseFloat(fm[2]);
    out[iso] = fields;
  }
  return out;
}

// Format a numeric value for the snapshot, matching the existing style.
function fmtER(v) {
  if (v == null || !isFinite(v)) return null;
  const abs = Math.abs(v);
  if (abs >= 100) return v.toFixed(0);
  if (abs >= 10)  return v.toFixed(1);
  return v.toFixed(2);
}
const fmtPPP = fmtER;
function fmt1(v) { return v == null || !isFinite(v) ? null : v.toFixed(1); }
function fmt2(v) { return v == null || !isFinite(v) ? null : v.toFixed(2); }

function buildEntry(iso, merged) {
  const parts = [];
  const er   = fmtER(merged.er);
  const ppp  = fmtPPP(merged.ppp);
  const ca   = fmt1(merged.ca);
  const fisc = fmt1(merged.fisc);
  const bm   = fmt2(merged.bm);
  if (er   != null) parts.push(`er:${er}`);
  if (ppp  != null) parts.push(`ppp:${ppp}`);
  if (ca   != null) parts.push(`ca:${ca}`);
  if (fisc != null) parts.push(`fisc:${fisc}`);
  if (bm   != null) parts.push(`bm:${bm}`);
  return `  ${iso}:{${parts.join(", ")}}`;
}

function buildStaticBlock(currentStatic, currency, fx, wbFX, wbPPP, wbCA, wbFisc, bigmac, dateISO) {
  const lines = [];
  lines.push("/* ============================================================================");
  lines.push(`   Static snapshot (auto-refreshed ${dateISO}) — fallback if live fetch fails.`);
  lines.push("   ER = local currency per USD, PPP = LCU per international $,");
  lines.push("   CA & FISC = % GDP, BM = Big Mac under/over-valuation vs USD (decimal).");
  lines.push("   ============================================================================ */");
  lines.push("const STATIC = {");
  for (const iso of Object.keys(currentStatic)) {
    const prev = currentStatic[iso] || {};
    const ccy = currency[iso];
    let er = prev.er;
    if (ccy === "USD") er = 1;
    else if (ccy && typeof fx[ccy] === "number" && fx[ccy] > 0) er = fx[ccy];
    else if (wbFX[iso] != null) er = wbFX[iso];

    const merged = {
      er,
      ppp:  wbPPP[iso]  ?? prev.ppp,
      ca:   wbCA[iso]   ?? prev.ca,
      fisc: wbFisc[iso] ?? prev.fisc,
      bm:   bigmac[iso] ?? prev.bm,
    };
    lines.push(buildEntry(iso, merged) + ",");
  }
  lines.push("};");
  return lines.join("\n");
}

function replaceStaticBlock(src, newBlock) {
  const re = /\/\* =+\s*\n\s*Static snapshot[\s\S]*?\n\};/;
  if (!re.test(src)) throw new Error("Could not locate snapshot block to replace");
  return src.replace(re, newBlock);
}

async function main() {
  const primary = await fs.readFile(FILES[0], "utf8");
  const currency = parseCurrency(primary);
  const currentStatic = parseStatic(primary);
  console.log(`Parsed ${Object.keys(currentStatic).length} countries from existing snapshot.`);

  const [fxRes, wbFXRes, wbPPPRes, wbCARes, wbFiscRes, bmRes] = await Promise.allSettled([
    fetchFX(),
    fetchWBIndicator(WB_INDICATORS.wbFX),
    fetchWBIndicator(WB_INDICATORS.wbPPP),
    fetchWBIndicator(WB_INDICATORS.wbCA),
    fetchWBIndicator(WB_INDICATORS.wbFisc),
    fetchBigMac(),
  ]);
  const ok = (r, label) => {
    if (r.status === "fulfilled") { console.log(`✓ ${label}: ${Object.keys(r.value).length} entries`); return r.value; }
    console.warn(`✗ ${label} failed: ${r.reason?.message || r.reason}`);
    return {};
  };
  const fx     = ok(fxRes,     "FX (open.er-api.com)");
  const wbFX   = ok(wbFXRes,   "WB annual FX");
  const wbPPP  = ok(wbPPPRes,  "WB PPP");
  const wbCA   = ok(wbCARes,   "WB current account");
  const wbFisc = ok(wbFiscRes, "WB fiscal balance");
  const bigmac = ok(bmRes,     "Big Mac");

  const dateISO = new Date().toISOString().slice(0, 10);
  const newBlock = buildStaticBlock(currentStatic, currency, fx, wbFX, wbPPP, wbCA, wbFisc, bigmac, dateISO);

  let changed = 0;
  for (const file of FILES) {
    const src = await fs.readFile(file, "utf8");
    const next = replaceStaticBlock(src, newBlock);
    if (next !== src) {
      await fs.writeFile(file, next);
      console.log(`Updated ${path.basename(file)}`);
      changed++;
    } else {
      console.log(`No change in ${path.basename(file)}`);
    }
  }
  console.log(`Done. Files changed: ${changed}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
