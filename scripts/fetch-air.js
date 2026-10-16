// Builds data/air/latest.txt for the CYD "AIR QUALITY" page from Air4Thai (Pollution
// Control Department, the Thai AQI): every station, so a board picks its nearest one,
// plus the worst three in the country. The board reads it over plain HTTP (raw.githack).
//
// One record per line, fields separated by "|":
//   U|date time|stations        the newest reading (Thai time) and how many stations
//   C|n                         stations at AQI 101 or more (orange and worse)
//   T|aqi|pm25|province|name    the worst three, worst first
//   S|lat|lon|aqi|pm25|pm10|o3|time|province|name|id   every station with a reading
//   W|aqi|place, country        the worst three in the world (WAQI, US AQI)
//   H|count|from|to             hotspots in Thailand in the last 24 h (NASA FIRMS, S-NPP)
//   P|count|province            the six provinces with the most of them
// pm10 / o3 are -1 where the station does not measure them.
// Also data/air/h/<id>.txt for each station: "id|first hour|pm25,pm25,..." (the last 24
// hourly PM2.5 values, -1 for a missing hour) for the page's 24 h chart.
import { writeFile, mkdir } from "node:fs/promises";
import https from "node:https";
import http from "node:http";
import tls from "node:tls";
import { X509Certificate } from "node:crypto";

const URL = "https://air4thai.pcd.go.th/services/getNewAQI_JSON.php";
const STALE_H = 3; // readings older than this behind the newest one are left out
let caPem = null; // the server's missing intermediates, once found by get()
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
  let last, ca = caPem;
  for (let i = 1; i <= attempts; i++) {
    try {
      const body = await download(url, ca ? { ca: [...tls.rootCertificates, ...ca] } : {});
      return JSON.parse(body.toString("utf8").replace(/^﻿/, ""));
    } catch (e) {
      last = e;
      if (!ca && /UNABLE_TO_VERIFY|unable to verify|issuer/i.test(`${e.code} ${e.message}`)) {
        ca = caPem = await missingIntermediate(new globalThis.URL(url).hostname);
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

// ---- 24 h of hourly PM2.5 for every station, one small file each (the board reads only
// its own station's). Air4Thai takes many stations in one request.
const HIST = "https://air4thai.pcd.go.th/forweb/getHistoryData.php";
async function histories(ids) {
  const ymd = (d) => d.toISOString().slice(0, 10);
  const now = new Date(Date.now() + 7 * 3600e3); // Thai time as a "UTC" date
  const from = new Date(now.getTime() - 26 * 3600e3);
  let written = 0;
  for (let i = 0; i < ids.length; i += 40) {
    const chunk = ids.slice(i, i + 40);
    const url = `${HIST}?stationID=${chunk.join(",")}&param=PM25&type=hr&sdate=${ymd(from)}&edate=${ymd(now)}&stime=00&etime=23`;
    const j = await get(url);
    for (const st of (j && j.stations) || []) {
      const byHour = new Map();
      for (const d of st.data || []) byHour.set(String(d.DATETIMEDATA).slice(0, 13), num(d.PM25));
      // the last 24 hours that have passed, oldest first
      const hours = [];
      const last = new Date(Math.floor(now.getTime() / 3600e3) * 3600e3 - 3600e3);
      for (let k = 23; k >= 0; k--) {
        const t = new Date(last.getTime() - k * 3600e3).toISOString().slice(0, 13).replace("T", " ");
        hours.push(byHour.has(t) ? byHour.get(t) : -1);
      }
      if (hours.every((v) => v < 0)) continue;
      const first = new Date(last.getTime() - 23 * 3600e3).toISOString().slice(0, 13).replace("T", " ") + ":00";
      await writeFile(`data/air/h/${clean(st.stationID)}.txt`, `${clean(st.stationID)}|${first}|${hours.map((v) => (v < 0 ? -1 : Math.round(v * 10) / 10)).join(",")}\n`, "utf8");
      written++;
    }
  }
  console.log(`history: ${written} station files`);
}

// ---- hotspots (fires) in Thailand in the last 24 h: NASA FIRMS' public S-NPP VIIRS file
// for Southeast Asia (no key), each point placed in a province by the province shapes.
const FIRMS = "https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_SouthEast_Asia_24h.csv";
const PROVINCES = "https://raw.githubusercontent.com/apisit/thailand.json/master/thailand.json";
const PROV_TH = {
  "Amnat Charoen": "อำนาจเจริญ", "Ang Thong": "อ่างทอง", "Bangkok Metropolis": "กรุงเทพฯ", "Bueng Kan": "บึงกาฬ",
  "Buri Ram": "บุรีรัมย์", "Chachoengsao": "ฉะเชิงเทรา", "Chai Nat": "ชัยนาท", "Chaiyaphum": "ชัยภูมิ",
  "Chanthaburi": "จันทบุรี", "Chiang Mai": "เชียงใหม่", "Chiang Rai": "เชียงราย", "Chon Buri": "ชลบุรี",
  "Chumphon": "ชุมพร", "Kalasin": "กาฬสินธุ์", "Kamphaeng Phet": "กำแพงเพชร", "Kanchanaburi": "กาญจนบุรี",
  "Khon Kaen": "ขอนแก่น", "Krabi": "กระบี่", "Lampang": "ลำปาง", "Lamphun": "ลำพูน", "Loei": "เลย",
  "Lop Buri": "ลพบุรี", "Mae Hong Son": "แม่ฮ่องสอน", "Maha Sarakham": "มหาสารคาม", "Mukdahan": "มุกดาหาร",
  "Nakhon Nayok": "นครนายก", "Nakhon Pathom": "นครปฐม", "Nakhon Phanom": "นครพนม",
  "Nakhon Ratchasima": "นครราชสีมา", "Nakhon Sawan": "นครสวรรค์", "Nakhon Si Thammarat": "นครศรีธรรมราช",
  "Nan": "น่าน", "Narathiwat": "นราธิวาส", "Nong Bua Lam Phu": "หนองบัวลำภู", "Nong Khai": "หนองคาย",
  "Nonthaburi": "นนทบุรี", "Pathum Thani": "ปทุมธานี", "Pattani": "ปัตตานี", "Phangnga": "พังงา",
  "Phatthalung": "พัทลุง", "Phayao": "พะเยา", "Phetchabun": "เพชรบูรณ์", "Phetchaburi": "เพชรบุรี",
  "Phichit": "พิจิตร", "Phitsanulok": "พิษณุโลก", "Phra Nakhon Si Ayutthaya": "พระนครศรีอยุธยา", "Phrae": "แพร่",
  "Phuket": "ภูเก็ต", "Prachin Buri": "ปราจีนบุรี", "Prachuap Khiri Khan": "ประจวบคีรีขันธ์", "Ranong": "ระนอง",
  "Ratchaburi": "ราชบุรี", "Rayong": "ระยอง", "Roi Et": "ร้อยเอ็ด", "Sa Kaeo": "สระแก้ว", "Sakon Nakhon": "สกลนคร",
  "Samut Prakan": "สมุทรปราการ", "Samut Sakhon": "สมุทรสาคร", "Samut Songkhram": "สมุทรสงคราม",
  "Saraburi": "สระบุรี", "Satun": "สตูล", "Si Sa Ket": "ศรีสะเกษ", "Sing Buri": "สิงห์บุรี", "Songkhla": "สงขลา",
  "Sukhothai": "สุโขทัย", "Suphan Buri": "สุพรรณบุรี", "Surat Thani": "สุราษฎร์ธานี", "Surin": "สุรินทร์",
  "Tak": "ตาก", "Trang": "ตรัง", "Trat": "ตราด", "Ubon Ratchathani": "อุบลราชธานี", "Udon Thani": "อุดรธานี",
  "Uthai Thani": "อุทัยธานี", "Uttaradit": "อุตรดิตถ์", "Yala": "ยะลา", "Yasothon": "ยโสธร",
};
function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
async function hotspots() {
  const geo = JSON.parse((await download(PROVINCES, { headers: UA })).toString());
  const provs = geo.features.map((f) => {
    const polys = f.geometry.type === "MultiPolygon" ? f.geometry.coordinates : [f.geometry.coordinates];
    let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
    for (const p of polys) for (const [x, y] of p[0]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    return { name: PROV_TH[f.properties.name] || f.properties.name, polys, box: [x0, y0, x1, y1] };
  });
  const csv = (await download(FIRMS, { headers: UA })).toString().trim().split("\n");
  const head = csv.shift().split(",");
  const iLat = head.indexOf("latitude"), iLon = head.indexOf("longitude"), iDate = head.indexOf("acq_date"), iTime = head.indexOf("acq_time");
  const counts = new Map();
  let total = 0, from = "9", to = "0";
  for (const line of csv) {
    const c = line.split(",");
    const y = parseFloat(c[iLat]), x = parseFloat(c[iLon]);
    if (!(y > 5 && y < 21 && x > 97 && x < 106)) continue;
    const prov = provs.find((p) => x >= p.box[0] && x <= p.box[2] && y >= p.box[1] && y <= p.box[3] &&
      p.polys.some((poly) => inRing(x, y, poly[0]) && !poly.slice(1).some((hole) => inRing(x, y, hole))));
    if (!prov) continue; // a neighbour country or the sea
    total++;
    counts.set(prov.name, (counts.get(prov.name) || 0) + 1);
    const when = `${c[iDate]} ${String(c[iTime]).padStart(4, "0")}`;
    if (when < from) from = when;
    if (when > to) to = when;
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  console.log(`hotspots: ${total} in Thailand, top ${top.map(([p, n]) => p + " " + n).join(", ")}`);
  return { total, from: total ? from : "-", to: total ? to : "-", top };
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
      id: clean(st.stationID),
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
    out.push(["S", r.lat.toFixed(4), r.lon.toFixed(4), r.aqi, r.pm25, r.pm10, r.o3, r.when.slice(11, 16), r.prov, r.name, r.id].join("|"));

  try {
    for (const w of await worldWorst()) out.push(["W", w.aqi, w.place].join("|"));
  } catch (e) {
    console.error("world:", e.message); // the Thai part still goes out
  }

  try {
    const h = await hotspots();
    out.push(["H", h.total, h.from, h.to].join("|"));
    for (const [prov, n] of h.top) out.push(["P", n, prov].join("|"));
  } catch (e) {
    console.error("hotspots:", e.message);
  }

  await mkdir("data/air/h", { recursive: true });
  await writeFile("data/air/latest.txt", out.join("\n") + "\n", "utf8");
  try {
    await histories(fresh.map((r) => r.id).filter(Boolean));
  } catch (e) {
    console.error("history:", e.message);
  }
  console.log(`newest ${newest}, ${fresh.length}/${rows.length} fresh stations, worst ${ranked[0] && ranked[0].aqi}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
