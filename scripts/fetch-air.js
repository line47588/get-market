// Builds data/air/latest.txt for the CYD "AIR QUALITY" page from Air4Thai (Pollution
// Control Department, the Thai AQI): every station, so a board picks its nearest one,
// plus the worst three in the country. The board reads it over plain HTTP (raw.githack).
//
// One record per line, fields separated by "|":
//   U|date time|stations        the newest reading (Thai time) and how many stations
//   C|n                         stations at AQI 101 or more (orange and worse)
//   T|aqi|pm25|province|name    the worst three, worst first
//   S|lat|lon|aqi|pm25|pm10|o3|time|province|name   every station with a reading
// pm10 / o3 are -1 where the station does not measure them.
import { writeFile, mkdir } from "node:fs/promises";
import https from "node:https";
import http from "node:http";
import tls from "node:tls";
import { X509Certificate } from "node:crypto";

const URL = "https://air4thai.pcd.go.th/services/getNewAQI_JSON.php";
const STALE_H = 3; // readings older than this behind the newest one are left out
const NAME_MAX = 30; // characters (Thai combining marks included) the screen has room for

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function download(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https:") ? https : http;
    const req = mod.get(url, { headers: { "User-Agent": "cyd-air/1.0" }, timeout: 30000, ...opts }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(new globalThis.URL(res.headers.location, url).toString(), opts));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const parts = [];
      res.on("data", (d) => parts.push(d));
      res.on("end", () => resolve(Buffer.concat(parts)));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

// Air4Thai's server sends the wrong intermediate certificate, so a normal HTTPS client
// cannot verify it. Fetch the right one from the address in the server's own
// certificate (Authority Information Access) and verify against the usual roots plus it.
async function missingIntermediate(host) {
  const leaf = await new Promise((resolve, reject) => {
    const s = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false }, () => {
      const c = s.getPeerCertificate();
      s.end();
      resolve(c);
    });
    s.on("error", reject);
  });
  const issuerUrl = (info) => {
    const m = /CA Issuers - URI:(\S+)/.exec(info || "");
    return m ? m[1] : null;
  };
  let url = issuerUrl(leaf.infoAccess && Object.entries(leaf.infoAccess).map(([k, v]) => `${k}:${v}`).join("\n"));
  if (!url) throw new Error("no issuer address in the certificate");
  // follow the issuers up (a new intermediate can hang off a root Node does not ship yet,
  // itself cross-signed by an old one) until one is signed by a root Node knows
  const roots = tls.rootCertificates.map((p) => new X509Certificate(p));
  const chain = [];
  for (let depth = 0; url && depth < 4; depth++) {
    const cert = new X509Certificate(await download(url));
    chain.push(cert.toString());
    if (roots.some((r) => cert.checkIssued(r) && cert.verify(r.publicKey))) break;
    url = issuerUrl(cert.infoAccess);
  }
  return chain; // PEMs
}

async function get(url, attempts = 3) {
  let last, ca;
  for (let i = 1; i <= attempts; i++) {
    try {
      const body = await download(url, ca ? { ca: [...tls.rootCertificates, ...ca] } : {});
      return JSON.parse(body.toString("utf8").replace(/^﻿/, ""));
    } catch (e) {
      last = e;
      if (!ca && /UNABLE_TO_VERIFY|unable to verify|issuer/i.test(`${e.code} ${e.message}`)) {
        ca = await missingIntermediate(new globalThis.URL(url).hostname);
        console.log(`added ${ca.length} certificate(s) the server leaves out`);
        i--; // this retry does not count
        continue;
      }
      if (i < attempts) await sleep(3000 * i);
    }
  }
  throw new Error(`${url}: ${last.message}`);
}

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) && n >= 0 ? n : -1;
};
const clean = (s) => String(s || "").replace(/[|\r\n]+/g, " ").replace(/\s+/g, " ").trim();
// cut at a whole character: never leave a Thai vowel or tone mark without its consonant
function cut(s, max) {
  const chars = [...s];
  if (chars.length <= max) return s;
  let n = max;
  while (n > 0 && /[ัิ-ฺ็-๎]/.test(chars[n])) n--;
  return chars.slice(0, n).join("").trim() + ".."; // the board's Thai font has no "…"
}
function province(st) {
  if (st.stationType === "BKK") return "กรุงเทพฯ";
  const parts = clean(st.areaTH).split(",");
  return clean(parts[parts.length - 1]).replace(/^จ\.\s*/, "").replace(/^จังหวัด/, "") || "-";
}

// ---- the worst places in the world (WAQI, US AQI), written as "W|aqi|place, country".
// WAQI's map API returns a sample of the stations in a box, so the world is asked in
// boxes (~3000 official stations). The token is the WAQI_TOKEN secret; without it the
// world lines are left out. Readings over 3 h old or at the 500 cap (a stuck sensor) are
// skipped, and one place per ~1 degree cell is kept so one smoky city does not fill all.
const WAQI = "https://api.waqi.info/map/bounds/";
const UA = { "User-Agent": "cyd-air/1.0 (+https://github.com/line47588/get-market)" };
const ascii = (s) => String(s || "").replace(/\([^)]*\)/g, " ").replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim();
async function worldWorst(n = 3) {
  const token = process.env.WAQI_TOKEN;
  if (!token) return [];
  const all = new Map();
  for (let la = -60; la < 75; la += 45)
    for (let lo = -180; lo < 180; lo += 60) {
      const j = JSON.parse((await download(`${WAQI}?latlng=${la},${lo},${la + 45},${lo + 60}&networks=official&token=${token}`)).toString());
      if (j.status !== "ok") throw new Error(`WAQI ${j.status}: ${j.data}`);
      for (const x of j.data || []) all.set(x.uid, x);
    }
  const now = Date.now();
  const ok = [...all.values()].filter((x) => {
    const a = parseInt(x.aqi, 10), t = Date.parse(x.station && x.station.time);
    return a > 0 && a < 500 && Number.isFinite(t) && now - t < STALE_H * 3600e3;
  });
  ok.sort((a, b) => parseInt(b.aqi, 10) - parseInt(a.aqi, 10));
  const cells = new Set(), top = [];
  for (const x of ok) {
    const cell = `${Math.round(x.lat)},${Math.round(x.lon)}`;
    if (cells.has(cell)) continue;
    cells.add(cell);
    top.push(x);
    if (top.length >= n) break;
  }
  const out = [];
  for (const x of top) {
    // "Station, City, Country" usually; Chinese and some other names have no country:
    // OpenStreetMap's reverse geocoder (one request a second, as its policy asks)
    let place = ascii(x.station.name);
    const parts = place.split(",").map((s) => s.trim()).filter(Boolean);
    try {
      await sleep(1100);
      const r = JSON.parse((await download(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=10&accept-language=en&lat=${x.lat}&lon=${x.lon}`, { headers: UA })).toString());
      const a = r.address || {};
      const city = ascii(a.city || a.town || a.county || a.state || parts[parts.length - 2] || parts[0]);
      if (a.country) place = `${city}, ${ascii(a.country)}`;
    } catch (e) {
      place = parts.slice(-2).join(", ");
    }
    out.push({ aqi: parseInt(x.aqi, 10), place: cut(place, 34) });
  }
  console.log(`world: ${all.size} stations, ${ok.length} fresh, worst ${out.map((w) => w.aqi + " " + w.place).join(" / ")}`);
  return out;
}

async function main() {
  const j = await get(URL);
  const stations = (j && j.stations) || [];
  if (stations.length < 50) throw new Error(`only ${stations.length} stations`);

  const rows = [];
  for (const st of stations) {
    const a = st.AQILast || {};
    const aqi = num(a.AQI && a.AQI.aqi);
    const lat = parseFloat(st.lat), lon = parseFloat(st.long);
    if (aqi < 0 || !Number.isFinite(lat) || !Number.isFinite(lon) || !a.date || !a.time) continue;
    rows.push({
      when: `${a.date} ${a.time}`,
      lat, lon, aqi,
      pm25: num(a.PM25 && a.PM25.value),
      pm10: num(a.PM10 && a.PM10.value),
      o3: num(a.O3 && a.O3.value),
      prov: province(st),
      name: cut(clean(st.nameTH), NAME_MAX),
      type: st.stationType,
    });
  }
  if (!rows.length) throw new Error("no readings");
  const newest = rows.map((r) => r.when).sort().pop();
  const cutoff = new Date(new Date(newest.replace(" ", "T") + ":00+07:00").getTime() - STALE_H * 3600e3);
  const fresh = rows.filter((r) => new Date(r.when.replace(" ", "T") + ":00+07:00") >= cutoff);

  const ranked = fresh.filter((r) => r.type !== "MOBILE").sort((a, b) => b.aqi - a.aqi);
  const out = [];
  out.push(["U", newest, fresh.length].join("|"));
  out.push(["C", fresh.filter((r) => r.aqi >= 101).length].join("|"));
  for (const r of ranked.slice(0, 3)) out.push(["T", r.aqi, r.pm25, r.prov, r.name].join("|"));
  for (const r of fresh)
    out.push(["S", r.lat.toFixed(4), r.lon.toFixed(4), r.aqi, r.pm25, r.pm10, r.o3, r.when.slice(11, 16), r.prov, r.name].join("|"));

  try {
    for (const w of await worldWorst()) out.push(["W", w.aqi, w.place].join("|"));
  } catch (e) {
    console.error("world:", e.message); // the Thai part still goes out
  }

  await mkdir("data/air", { recursive: true });
  await writeFile("data/air/latest.txt", out.join("\n") + "\n", "utf8");
  console.log(`newest ${newest}, ${fresh.length}/${rows.length} fresh stations, worst ${ranked[0] && ranked[0].aqi}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
