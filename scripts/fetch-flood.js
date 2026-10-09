// Builds data/quotes.json for the CYD crypto and US markets pages: the top coins
// (CoinGecko) and stock quotes (Yahoo chart API, no key). Binance and Finnhub are
// HTTPS-only and the ESP32 (no PSRAM) has heap for at most one TLS session, less
// while the radio plays, so the board reads this small file over plain HTTP
// (raw.githack.com) and asks Finnhub only for symbols that are not in it.
//
// {"t":"2026-10-09T05:00","top":[["ETH",2510.5,1.2],...],
//  "q":{"QQQ":[512.3,0.45],"BINANCE:BTCUSDT":[82420,0.37],...}}   [price, % change]
import { writeFile, mkdir, readFile } from "node:fs/promises";

// coin symbol shown on the board -> CoinGecko id (the board's fixed list)
const COINS = [
  ["ETH", "ethereum"],
  ["BNB", "binancecoin"],
  ["SOL", "solana"],
  ["XRP", "ripple"],
  ["DOGE", "dogecoin"],
  ["ADA", "cardano"],
];

// stock symbol as typed in the board's settings (upper case) -> Yahoo symbol.
// The board's default list plus its tech-score symbols; add your own here.
const STOCKS = {
  QQQ: "QQQ",
  NVDA: "NVDA",
  TSLA: "TSLA",
  AMD: "AMD",
  AAPL: "AAPL",
  MSFT: "MSFT",
  GOOGL: "GOOGL",
  AMZN: "AMZN",
  META: "META",
  AVGO: "AVGO",
  PLTR: "PLTR",
  SLV: "SLV",
  GLD: "GLD",
  SPY: "SPY",
  "BINANCE:BTCUSDT": "BTC-USD",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, attempts = 3) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      last = e;
      if (i < attempts) await sleep(2000 * i);
    }
  }
  throw new Error(`${url}: ${last.message}`);
}

const r2 = (x) => Math.round(x * 100) / 100;
const price = (x) => (x >= 1 ? r2(x) : Math.round(x * 10000) / 10000);

async function main() {
  // start from the previous file so a failed source keeps its last value
  let out = {};
  try {
    out = JSON.parse(await readFile("data/quotes.json", "utf8"));
  } catch {}
  out.q = out.q || {};
  let ok = 0;

  try {
    const ids = COINS.map((c) => c[1]).join(",");
    const j = await get(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`);
    const top = COINS.filter(([, id]) => j[id] && j[id].usd).map(([sym, id]) => [sym, price(j[id].usd), r2(j[id].usd_24h_change || 0)]);
    if (top.length) {
      out.top = top;
      ok++;
    }
  } catch (e) {
    console.error("coins", e.message);
  }

  for (const [key, sym] of Object.entries(STOCKS)) {
    try {
      const j = await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`, 2);
      const m = j.chart.result[0].meta;
      const prev = m.chartPreviousClose ?? m.previousClose;
      if (!m.regularMarketPrice || !prev) throw new Error("no price");
      out.q[key] = [price(m.regularMarketPrice), r2((m.regularMarketPrice / prev - 1) * 100)];
      ok++;
    } catch (e) {
      console.warn(key, e.message);
    }
  }

  if (ok === 0) process.exit(1); // keep the previous file
  out.t = new Date().toISOString().slice(0, 16);
  const { t, top, q } = out;
  await mkdir("data", { recursive: true });
  await writeFile("data/quotes.json", JSON.stringify({ t, top, q }) + "\n");
  console.log(`quotes ok (${ok})`, JSON.stringify(out));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
