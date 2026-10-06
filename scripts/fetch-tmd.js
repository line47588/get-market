// Builds small per-station weather files from the Thai Meteorological Department (TMD)
// for the CYD weather page. The ESP32 (no PSRAM) can only afford one HTTPS session per
// page and every TMD API is HTTPS-only, so this Action fetches them and the board reads
// one <1 KB JSON over plain HTTP (raw.githack.com).
//
// Output (committed by .github/workflows/fetch-tmd.yml):
//   data/tmd/st/<wmo>.json  station report + its region's 24 h forecast + CAP warnings
//                           that cover the station's province
//   data/tmd/index.json     wmo, name, province, lat, lon of every station with a report
//
// No secrets needed: TMD's public demo key (uid=api, ukey=api12345) is used for the
// station list.
import { writeFile, mkdir } from "node:fs/promises";

const STATION_LIST = "https://data.tmd.go.th/api/Station/v1/?uid=api&ukey=api12345&format=json";
const REPORT = (wmo) => `https://www.tmd.go.th/api/xml/weather-report?stationnumber=${wmo}`;
const REGION = (id) => `https://www.tmd.go.th/api/xml/region-daily-forecast?regionid=${id}`;
const CAP_LIST = "https://www.tmd.go.th/api/xml/CAP";

// TMD forecast regions (region-daily-forecast?regionid=N)
const REGION_NAMES = {
  1: "ภาคเหนือ",
  2: "ภาคตะวันออกเฉียงเหนือ",
  3: "ภาคกลาง",
  4: "ภาคตะวันออก",
  5: "ภาคใต้ฝั่งตะวันออก",
  6: "ภาคใต้ฝั่งตะวันตก",
  7: "กทม.และปริมณฑล",
};
const PROVINCE_REGION = {
  // 1 North
  "เชียงราย": 1, "เชียงใหม่": 1, "น่าน": 1, "พะเยา": 1, "แพร่": 1, "แม่ฮ่องสอน": 1, "ลำปาง": 1,
  "ลำพูน": 1, "อุตรดิตถ์": 1, "ตาก": 1, "สุโขทัย": 1, "พิษณุโลก": 1, "พิจิตร": 1,
  "กำแพงเพชร": 1, "เพชรบูรณ์": 1,
  // 2 Northeast
  "เลย": 2, "หนองคาย": 2, "บึงกาฬ": 2, "หนองบัวลำภู": 2, "อุดรธานี": 2, "สกลนคร": 2,
  "นครพนม": 2, "มุกดาหาร": 2, "ขอนแก่น": 2, "กาฬสินธุ์": 2, "มหาสารคาม": 2, "ร้อยเอ็ด": 2,
  "ชัยภูมิ": 2, "ยโสธร": 2, "อำนาจเจริญ": 2, "นครราชสีมา": 2, "บุรีรัมย์": 2, "สุรินทร์": 2,
  "ศรีสะเกษ": 2, "อุบลราชธานี": 2,
  // 3 Central
  "นครสวรรค์": 3, "อุทัยธานี": 3, "ชัยนาท": 3, "สิงห์บุรี": 3, "อ่างทอง": 3, "ลพบุรี": 3,
  "สระบุรี": 3, "พระนครศรีอยุธยา": 3, "สุพรรณบุรี": 3, "กาญจนบุรี": 3, "ราชบุรี": 3,
  "สมุทรสงคราม": 3,
  // 4 East
  "นครนายก": 4, "ปราจีนบุรี": 4, "ฉะเชิงเทรา": 4, "สระแก้ว": 4, "ชลบุรี": 4, "ระยอง": 4,
  "จันทบุรี": 4, "ตราด": 4,
  // 5 South, east coast
  "เพชรบุรี": 5, "ประจวบคีรีขันธ์": 5, "ชุมพร": 5, "สุราษฎร์ธานี": 5, "นครศรีธรรมราช": 5,
  "พัทลุง": 5, "สงขลา": 5, "ปัตตานี": 5, "ยะลา": 5, "นราธิวาส": 5,
  // 6 South, west coast
  "ระนอง": 6, "พังงา": 6, "ภูเก็ต": 6, "กระบี่": 6, "ตรัง": 6, "สตูล": 6,
  // 7 Bangkok and vicinity
  "กรุงเทพมหานคร": 7, "นนทบุรี": 7, "ปทุมธานี": 7, "สมุทรปราการ": 7, "สมุทรสาคร": 7,
  "นครปฐม": 7,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getText(url, attempts = 3) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "cyd-weather/1.0" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      last = e;
      if (i < attempts) await sleep(1500 * i);
    }
  }
  throw new Error(`${url}: ${last.message}`);
}

const cdata = (xml) => (xml.match(/<!\[CDATA\[([\s\S]*?)\]\]>/) || [])[1] || "";
const tag = (xml, t) => ((xml.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)) || [])[1] || "").trim();
const num = (s) => {
  const m = String(s).match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};
const clean = (s) => s.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

// "<b> อุณหภูมิ : </b>28.6 องศาเซลเซียส <br/>..." -> { "อุณหภูมิ": "28.6 องศาเซลเซียส", ... }
function reportFields(desc) {
  const out = {};
  for (const line of desc.split(/<br\s*\/?>/i)) {
    const txt = clean(line);
    const i = txt.indexOf(":");
    if (i > 0) out[txt.slice(0, i).trim()] = txt.slice(i + 1).trim();
  }
  return out;
}

async function stationReport(wmo) {
  const xml = await getText(REPORT(wmo), 2);
  const item = tag(xml, "item");
  if (!item) return null;
  const f = reportFields(cdata(item));
  const title = tag(item, "title"); // "รายงานสภาวะอากาศ - เกาะสมุย : ... วันที่ : 06/10/2026 เวลา 07:00 นาฬิกา"
  const name = (title.match(/-\s*([^:]+?)\s*:/) || [])[1] || "";
  const when = title.match(/(\d{2}\/\d{2}\/\d{4})\s*เวลา\s*(\d{2}:\d{2})/) || [];
  const key = (k) => Object.keys(f).find((x) => x.includes(k));
  const val = (k) => (key(k) ? f[key(k)] : "");
  if (num(val("อุณหภูมิ")) === null) return null; // station without a live report
  return {
    name,
    date: when[1] || "",
    time: when[2] || "",
    t: num(val("อุณหภูมิ")),
    rh: num(val("ความชื้น")),
    p: num(val("ความกด")),
    wind: val("ทิศทางลม").replace(/\s+/g, " "),
    vis: num(val("ทัศนวิสัย")),
    wx: val("ลักษณะอากาศ"),
    rain: num(val("ฝนสะสม")),
    sunrise: (val("ขึ้น").match(/\d{2}:\d{2}/) || [""])[0],
    sunset: (val("ตก").match(/\d{2}:\d{2}/) || [""])[0],
  };
}

// TMD's English region forecast uses a small fixed vocabulary; turn it into a short Thai
// line. Anything not recognised keeps a trimmed English sentence instead.
function regionSummaryTh(en) {
  const s = en.toLowerCase();
  const parts = [];
  const cover = s.includes("fairly widespread") ? "เกือบทั่วไป"
    : s.includes("widespread") ? "ทั่วไป"
    : s.includes("scattered") ? "กระจาย"
    : s.includes("isolated") ? "บางแห่ง" : "";
  if (s.includes("thundershower")) parts.push("ฝนฟ้าคะนอง" + cover);
  else if (/\brain\b/.test(s) && !s.includes("heavy rain")) parts.push("มีฝน" + cover);
  if (s.includes("very heavy rain")) parts.push("ฝนหนักมากบางแห่ง");
  else if (s.includes("heavy rain")) parts.push("ฝนหนักบางแห่ง");
  if (s.includes("gust")) parts.push("ลมกระโชก");
  if (s.includes("hail")) parts.push("ลูกเห็บ");
  if (s.includes("very hot")) parts.push("อากาศร้อนจัด");
  else if (/\bhot\b/.test(s)) parts.push("อากาศร้อน");
  if (s.includes("very cold")) parts.push("อากาศหนาวจัด");
  else if (/\bcold\b/.test(s)) parts.push("อากาศหนาว");
  else if (/\bcool\b/.test(s)) parts.push("อากาศเย็น");
  if (s.includes("fog")) parts.push("มีหมอก");
  if (!parts.length) {
    if (s.includes("partly cloudy")) parts.push("มีเมฆบางส่วน");
    else if (s.includes("mostly cloudy") || s.includes("cloudy")) parts.push("มีเมฆมาก");
    else if (s.includes("clear")) parts.push("ท้องฟ้าโปร่ง");
  }
  return parts.join(" ");
}

async function regionForecast(id) {
  const xml = await getText(REGION(id));
  const item = tag(xml, "item");
  const body = cdata(item);
  const en = clean(body.split(/คาดหมายอุณหภูมิ/)[0].replace(/^.*?วันพรุ่งนี้/, ""));
  const range = (word) => {
    const m = en.match(new RegExp(`${word} temperature\\s*(\\d+)\\s*[–-]?\\s*(\\d+)?`, "i"));
    return m ? [Number(m[1]), Number(m[2] || m[1])] : [null, null];
  };
  const [minLo] = range("Minimum");
  const [, maxHi] = range("Maximum");
  return { id, name: REGION_NAMES[id], th: regionSummaryTh(en), tmin: minLo, tmax: maxHi, en: en.slice(0, 240) };
}

// Active CAP warnings (Thai feed) with the provinces they cover
async function capWarnings() {
  const xml = await getText(CAP_LIST);
  const links = [...xml.matchAll(/<item>[\s\S]*?<link>([^<]+)<\/link>[\s\S]*?<\/item>/g)].map((m) => m[1].trim());
  const now = Date.now();
  const out = [];
  for (const link of links.slice(0, 8)) {
    try {
      const cap = await getText(link, 2);
      const expires = Date.parse(tag(cap, "expires"));
      if (!expires || expires < now) continue;
      out.push({
        event: tag(cap, "event"),
        headline: tag(cap, "headline"),
        severity: tag(cap, "severity"),
        effective: tag(cap, "effective"),
        expires: tag(cap, "expires"),
        areas: tag(cap, "areaDesc").split(/\s+/).filter(Boolean),
      });
    } catch (e) {
      console.warn("CAP", link, e.message);
    }
  }
  return out;
}

const hhmm = (iso) => (iso.match(/T(\d{2}:\d{2})/) || [])[1] || "";
const EVENT_TH = { "Heavy Rain": "ฝนตกหนัก", "Very Heavy Rain": "ฝนตกหนักมาก", "Storm": "พายุ", "Strong Wind": "ลมแรง", "High Waves": "คลื่นลมแรง" };

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]);
    }
  }));
  return out;
}

async function main() {
  await mkdir("data/tmd/st", { recursive: true });

  const stations = JSON.parse(await getText(STATION_LIST)).Station.filter((s) => /^\d{5}$/.test(s.WmoCode));
  const regions = {};
  for (const id of Object.keys(REGION_NAMES)) {
    try {
      regions[id] = await regionForecast(Number(id));
    } catch (e) {
      console.warn("region", id, e.message);
    }
  }
  let caps = [];
  try {
    caps = await capWarnings();
  } catch (e) {
    console.warn("CAP list", e.message);
  }
  console.log(`stations ${stations.length}, regions ${Object.keys(regions).length}, active CAP ${caps.length}`);

  const index = [];
  const reports = await pool(stations, 8, async (s) => {
    try {
      return await stationReport(s.WmoCode);
    } catch (e) {
      return null;
    }
  });

  for (let k = 0; k < stations.length; k++) {
    const s = stations[k], rep = reports[k];
    if (!rep) continue;
    const prov = String(s.Province || "").trim();
    const reg = regions[PROVINCE_REGION[prov]] || null;
    const cap = caps
      .filter((c) => c.areas.includes(prov))
      .map((c) => ({ event: EVENT_TH[c.event] || c.headline || c.event, severity: c.severity, from: hhmm(c.effective), to: hhmm(c.expires) }));
    const name = rep.name || String(s.StationNameThai).trim();
    await writeFile(`data/tmd/st/${s.WmoCode}.json`, JSON.stringify({
      id: s.WmoCode, name, prov,
      date: rep.date, time: rep.time,
      t: rep.t, rh: rep.rh, p: rep.p, wind: rep.wind, vis: rep.vis, wx: rep.wx, rain: rep.rain,
      sunrise: rep.sunrise, sunset: rep.sunset,
      region: reg && { id: reg.id, name: reg.name, th: reg.th, tmin: reg.tmin, tmax: reg.tmax },
      cap,
    }) + "\n");
    index.push({ id: s.WmoCode, name, prov, lat: Number(s.Latitude), lon: Number(s.Longitude) });
  }
  await writeFile("data/tmd/index.json", JSON.stringify(index) + "\n");
  console.log(`wrote ${index.length} station files`);
  if (index.length === 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
