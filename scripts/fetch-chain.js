// Builds data/chain.json for the CYD mining / home pages: Bitcoin block height,
// network hashrate and difficulty, recommended fees (mempool.space) and the BTC
// price with its 24 h change (CoinGecko, blockchain.com as a fallback). All of these
// are HTTPS-only, and the ESP32 cannot open several TLS sessions while mining, so the
// board reads this ~250 byte file over plain HTTP (raw.githack.com) instead.
//
// {"t":"2026-10-06T08:00","height":917000,"hash_eh":950,"diff_t":"129.43",
//  "fees":{"fastest":3,"halfHour":2,"hour":2,"economy":1,"minimum":1},
//  "btc":85583.12,"btc_chg":-0.71}
import { writeFile, mkdir, readFile } from "node:fs/promises";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, asJson = true, attempts = 3) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "cyd-chain/1.0" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return asJson ? await res.json() : (await res.text()).trim();
    } catch (e) {
      last = e;
      if (i < attempts) await sleep(2000 * i);
    }
  }
  throw new Error(`${url}: ${last.message}`);
}

async function btcPrice() {
  try {
    const j = await get("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true");
    return { btc: Math.round(j.bitcoin.usd * 100) / 100, btc_chg: Math.round(j.bitcoin.usd_24h_change * 100) / 100 };
  } catch (e) {
    console.warn("coingecko", e.message);
  }
  // fallback: price_24h is the price 24 h ago
  const t = await get("https://api.blockchain.com/v3/exchange/tickers/BTC-USD");
  return {
    btc: Math.round(t.last_trade_price * 100) / 100,
    btc_chg: Math.round((t.last_trade_price / t.price_24h - 1) * 10000) / 100,
  };
}

async function main() {
  // start from the previous file so one failed source keeps its last value
  let out = {};
  try {
    out = JSON.parse(await readFile("data/chain.json", "utf8"));
  } catch {}
  let ok = 0;
  try {
    out.height = Number(await get("https://mempool.space/api/blocks/tip/height", false));
    ok++;
  } catch (e) {
    console.error("height", e.message);
  }
  try {
    const h = await get("https://mempool.space/api/v1/mining/hashrate/3d");
    out.hash_eh = Math.round(h.currentHashrate / 1e18);
    out.diff_t = (h.currentDifficulty / 1e12).toFixed(2);
    ok++;
  } catch (e) {
    console.error("hashrate", e.message);
  }
  try {
    const f = await get("https://mempool.space/api/v1/fees/recommended");
    out.fees = { fastest: f.fastestFee, halfHour: f.halfHourFee, hour: f.hourFee, economy: f.economyFee, minimum: f.minimumFee };
    ok++;
  } catch (e) {
    console.error("fees", e.message);
  }
  try {
    Object.assign(out, await btcPrice());
    ok++;
  } catch (e) {
    console.error("btc", e.message);
  }
  if (ok === 0) process.exit(1); // keep the previous file
  out.t = new Date().toISOString().slice(0, 16);
  // fixed key order keeps the file small and diffs readable
  const { t, height, hash_eh, diff_t, fees, btc, btc_chg } = out;
  await mkdir("data", { recursive: true });
  await writeFile("data/chain.json", JSON.stringify({ t, height, hash_eh, diff_t, fees, btc, btc_chg }) + "\n");
  console.log(`chain ok (${ok}/4)`, JSON.stringify(out));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
