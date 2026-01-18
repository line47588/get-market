// Node 18+: มี fetch ให้ใช้ในตัว
// รวม: XAUUSD/XAGUSD, Fear & Greed, USDTHB (Yahoo Finance) -> เขียนเป็น data/latest.json

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";

const OUT_DIR = "data";
const OUT_FILE = `${OUT_DIR}/latest.json`;

function log(...args){ console.log("[fetch]", ...args); }

async function safeJson(url, opts = {}, pick = (j)=>j) {
  try {
    const res = await fetch(url, {
      // Yahoo Finance และ API อื่นๆ มักต้องการ User-Agent
      headers: { 
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36", 
        ...(opts.headers||{}) 
      },
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
  const goldHeaders = {}; 
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
  const fng = await safeJson(
    "https://api.alternative.me/fng/",
    {},
    j => {
      const d = j?.data?.[0];
      return d ? { value: Number(d.value), classification: String(d.value_classification || "") } : null;
    }
  );

  // --- 3) USD -> THB (Yahoo Finance - Real-time Spot Rate) ---
  // ดึงจาก Yahoo Finance จะได้เรทที่ตรงกับตลาด Forex ปัจจุบันที่สุด (เช่น 31.282)
  const usdthb = await safeJson(
    "https://query1.finance.yahoo.com/v8/finance/chart/USDTHB=X?interval=1m&range=1d",
    {},
    j => {
      // ดึงค่า regularMarketPrice จากโครงสร้าง JSON ของ Yahoo
      const price = j?.chart?.result?.[0]?.meta?.regularMarketPrice;
      return price ? Number(price) : null;
    }
  );

  // เตรียมผลลัพธ์ใหม่
  const now = new Date().toISOString();
  let next = {
    ts: now,
    xauusd: xau,      // ตัวเลข
    xagusd: xag,      // ตัวเลข
    fng,              // { value, classification }
    usd_thb: usdthb   // ตัวเลข (เรทจาก Yahoo Finance)
  };

  // ถ้าบางค่าเจ๊ง ให้ fallback ค่าเดิม (ถ้ามี)
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  if (existsSync(OUT_FILE)) {
    try {
      const prev = JSON.parse(readFileSync(OUT_FILE, "utf-8"));
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
