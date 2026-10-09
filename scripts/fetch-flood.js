// Builds data/alerts/flood.txt for the CYD "FLOOD & QUAKE" page: river water levels
// and dam storage from ThaiWater (api-v3.thaiwater.net, several MB of JSON) and the
// latest earthquakes from TMD (HTTPS only). The board streams this file over plain
// HTTP (raw.githack.com) one line at a time and keeps only what is near it, so the
// whole country fits without using its heap.
//
// One record per line, fields separated by "|":
//   T|<generated, ISO time>
//   S|<stations at level 5 (overflow)>|<level 4 (high)>|<stations reporting>
//   W|lat|lon|name|province|level_msl|previous_msl|percent_of_bank|situation 1-5|time
//   D|lat|lon|name|province|storage_percent|inflow_mcm|released_mcm|date
//   Q|magnitude|lat|lon|depth_km|time_utc|title|where
import { writeFile, mkdir } from "node:fs/promises";

const WATERLEVEL = "https://api-v3.thaiwater.net/api/v1/thaiwater30/public/waterlevel_load";
const MAIN = "https://api-v3.thaiwater.net/api/v1/thaiwater30/public/thailand_main";
const QUAKES = "https://earthquake.tmd.go.th/feed/rss_tmd.xml";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getText(url, attempts = 3) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "cyd-flood/1.0" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      last = e;
      if (i < attempts) await sleep(2000 * i);
    }
  }
  throw new Error(`${url}: ${last.message}`);
}

// no "|" or line breaks inside a field
const f = (v) => (v === null || v === undefined ? "" : String(v).replace(/[|\r\n]+/g, " ").trim());
const n2 = (v) => (v === null || v === undefined || v === "" || isNaN(Number(v)) ? "" : String(Math.round(Number(v) * 100) / 100));
const ll = (v) => (v === null || v === undefined || isNaN(Number(v)) ? "" : Number(v).toFixed(4));

async function waterLines() {
  const d = JSON.parse(await getText(WATERLEVEL));
  const rows = (d.waterlevel_data && d.waterlevel_data.data) || [];
  const lines = [];
  let l5 = 0, l4 = 0;
  for (const r of rows) {
    const st = r.station || {};
    const lat = st.tele_station_lat, lon = st.tele_station_long;
    if (!lat || !lon || r.storage_percent === null || r.storage_percent === undefined) continue;
    const sit = Number(r.situation_level) || 0;
    if (sit === 5) l5++;
    if (sit === 4) l4++;
    lines.push(["W", ll(lat), ll(lon), f(st.tele_station_name && st.tele_station_name.th),
      f(r.geocode && r.geocode.province_name && r.geocode.province_name.th),
      n2(r.waterlevel_msl), n2(r.waterlevel_msl_previous), n2(r.storage_percent), sit,
      f((r.waterlevel_datetime || "").slice(11, 16))].join("|"));
  }
  return { lines, summary: `S|${l5}|${l4}|${lines.length}` };
}

async function damLines() {
  const d = JSON.parse(await getText(MAIN));
  const dams = (d.dam && d.dam.data && (d.dam.data.data || d.dam.data)) || [];
  return dams.filter((r) => r.dam && r.dam.dam_lat).map((r) => ["D", ll(r.dam.dam_lat), ll(r.dam.dam_long),
    f(r.dam.dam_name && r.dam.dam_name.th), f(r.geocode && r.geocode.province_name && r.geocode.province_name.th),
    n2(r.dam_storage_percent), n2(r.dam_inflow), n2(r.dam_released), f(r.dam_date)].join("|"));
}

async function quakeLines() {
  const xml = await getText(QUAKES);
  const tag = (s, t) => ((s.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)) || [])[1] || "").trim();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
    const it = m[1];
    const title = tag(it, "title").replace(/\s*\([^)]*\)\s*$/, ""); // "ประเทศเมียนมา (Myanmar)" -> Thai only
    return ["Q", n2(tag(it, "tmd:magnitude")), ll(tag(it, "geo:lat")), ll(tag(it, "geo:long")), n2(tag(it, "tmd:depth")),
      f(tag(it, "tmd:time").replace(" UTC", "")), f(title), f(tag(it, "comments"))].join("|");
  });
}

async function main() {
  await mkdir("data/alerts", { recursive: true });
  const out = [`T|${new Date().toISOString().slice(0, 16)}`];
  let ok = 0;
  try {
    const w = await waterLines();
    out.push(w.summary, ...w.lines);
    ok++;
    console.log(`water stations ${w.lines.length}`);
  } catch (e) {
    console.error("water", e.message);
  }
  try {
    const d = await damLines();
    out.push(...d);
    ok++;
    console.log(`dams ${d.length}`);
  } catch (e) {
    console.error("dams", e.message);
  }
  try {
    const q = await quakeLines();
    out.push(...q);
    ok++;
    console.log(`quakes ${q.length}`);
  } catch (e) {
    console.error("quakes", e.message);
  }
  if (ok === 0) process.exit(1); // keep the previous file
  await writeFile("data/alerts/flood.txt", out.join("\n") + "\n");
  await writeAreas(out);
}

// ---- small files per 1-degree area: data/alerts/area/<lat>_<lon>.txt (floor of the board's
// lat / lon). The board needs only the 3 nearest gauges within 120 km, the nearest dam within
// 400 km and the quakes; reading the ~95 KB country file took longer than the radio leaves it.
// Each area keeps what any point in it would pick (sampled every 0.1 degree), the country
// summary (S) and N|<gauge lines in this file> for the board's
// completeness check. ~4 KB each.
const GAUGES_NEAR = 3, GAUGE_KM = 120, DAM_KM = 400;
function km(la1, lo1, la2, lo2) {
  const r = Math.PI / 180, a = Math.sin(((la2 - la1) * r) / 2) ** 2 +
    Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(((lo2 - lo1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}
async function writeAreas(out) {
  const head = out.filter((l) => l[0] === "T" || l[0] === "S");
  const quakes = out.filter((l) => l[0] === "Q");
  const pos = (l) => { const p = l.split("|"); return [Number(p[1]), Number(p[2])]; };
  const gauges = out.filter((l) => l[0] === "W").map((l) => [l, ...pos(l)]);
  const dams = out.filter((l) => l[0] === "D").map((l) => [l, ...pos(l)]);
  await mkdir("data/alerts/area", { recursive: true });
  let files = 0;
  for (let lat = 5; lat <= 20; lat++)
    for (let lon = 97; lon <= 105; lon++) {
      const pick = new Set(), dam = new Set();
      for (let iy = 0; iy <= 10; iy++)
        for (let ix = 0; ix <= 10; ix++) {
          const y = lat + iy / 10, x = lon + ix / 10;
          gauges.map((g) => [g[0], km(y, x, g[1], g[2])]).filter((g) => g[1] < GAUGE_KM)
            .sort((a, b) => a[1] - b[1]).slice(0, GAUGES_NEAR).forEach((g) => pick.add(g[0]));
          const d = dams.map((g) => [g[0], km(y, x, g[1], g[2])]).filter((g) => g[1] < DAM_KM).sort((a, b) => a[1] - b[1])[0];
          if (d) dam.add(d[0]);
        }
      const w = gauges.map((g) => g[0]).filter((l) => pick.has(l)); // the country file's order
      const lines = [...head, `N|${w.length}`, ...w, ...dams.map((g) => g[0]).filter((l) => dam.has(l)), ...quakes];
      await writeFile(`data/alerts/area/${lat}_${lon}.txt`, lines.join("\n") + "\n");
      files++;
    }
  console.log(`area files ${files}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
