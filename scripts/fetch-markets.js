// Node 18+: มี fetch ให้ใช้ในตัว
// รวม: XAUUSD/XAGUSD, Fear & Greed, USDTHB -> เขียนเป็น data/latest.json

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";

const OUT_DIR = "data";
const OUT_FILE = `${OUT_DIR}/latest.json`;

function log(...args){ console.log("[fetch]", ...args); }

async function safeJson(url, opts = {}, pick = (j)=>j) {
  try {
    const res = await fetch(url, {
      // บาง API ชอบให้มี UA
      headers: { "user-agent": "github-actions-fetch/1.0", ...(opts.headers||{}) },
      ...opts
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const j = await res.json();
    return pick(j);
  } catch (e) {
    log("WARN:", url, String(e));
    return null; // ให้ไป fallback ที่ค่าก่อนหน้า
  }
}

async function main() {
  // --- 1) Gold prices: XAUUSD/XAGUSD ---
  // ปลายทางของคุณ: https://api.gold-api.com/price/XAU (และ XAG)
  // ถ้าต้องใช้ API key ให้เพิ่ม header ด้านล่าง (ปล่อยว่างถ้าไม่ใช้)
  const goldHeaders = {}; // เช่น { "x-api-key": process.env.GOLD_API_KEY }
  const xau = await safeJson(
    "https://api.gold-api.com/price/XAU",
    { headers: goldHeaders },
    j => Number(j?.price ?? j)
  );
  const xag = await safeJson(
    "https://api.gold-api.com/price/XAG",
    { headers: goldHeaders },
    j => Number(j?.price ?? j)
  );

  // --- 2) Fear & Greed ---
  // https://api.alternative.me/fng/
  const fng = await safeJson(
    "https://api.alternative.me/fng/",
    {},
    j => {
      const d = j?.data?.[0];
      return d ? { value: Number(d.value), classification: String(d.value_classification || "") } : null;
    }
  );

  // --- 3) USD -> THB (CoinGecko) ---
  // https://api.coingecko.com/api/v3/simple/price?ids=usd&vs_currencies=thb
  const usdthb = await safeJson(
    "https://api.coingecko.com/api/v3/simple/price?ids=usd&vs_currencies=thb",
    {},
    j => Number(j?.usd?.thb)
  );

  // เตรียมผลลัพธ์ใหม่
  const now = new Date().toISOString();
  let next = {
    ts: now,
    xauusd: xau,     // ตัวเลข (เช่น 2401.23)
    xagusd: xag,     // ตัวเลข
    fng,             // { value, classification }
    usd_thb: usdthb  // ตัวเลข (เช่น 32.24)
  };

  // ถ้าบางค่าเจ๊ง ให้ fallback ค่าเดิม (ถ้ามี)
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  if (existsSync(OUT_FILE)) {
    try {
      const prev = JSON.parse(readFileSync(OUT_FILE, "utf-8"));
      // ใช้ค่าก่อนหน้าเฉพาะ field ที่ดึงไม่สำเร็จ
      if (next.xauusd == null) next.xauusd = prev.xauusd ?? null;
      if (next.xagusd == null) next.xagusd = prev.xagusd ?? null;
      if (next.fng == null)    next.fng    = prev.fng ?? null;
      if (next.usd_thb == null)next.usd_thb= prev.usd_thb ?? null;
    } catch { /* noop */ }
  }

  writeFileSync(OUT_FILE, JSON.stringify(next, null, 2));
  log("Wrote", OUT_FILE, "=>", next);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
