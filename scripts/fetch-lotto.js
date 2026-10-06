// Builds data/lotto/latest.txt for the CYD "LOTTERY" page: the latest Thai government
// lottery result (GLO, HTTPS + POST only) plus the first prize / last two digits of the
// previous draws. The board reads this small text file over plain HTTP (raw.githack.com).
//
// One record per line, fields separated by "|":
//   L|date|first|near1 a,b|front3 a,b|back3 a,b|last2
//   R|second|n,n,...      (also third, fourth, fifth: for a ticket checker)
//   H|date|first|last2    (previous draws, newest first)
import { writeFile, mkdir } from "node:fs/promises";

const LATEST = "https://www.glo.or.th/api/lottery/getLatestLottery";
const BY_DATE = "https://www.glo.or.th/api/checking/getLotteryResult";
const HISTORY = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(url, body, attempts = 3) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "cyd-lotto/1.0" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      last = e;
      if (i < attempts) await sleep(2000 * i);
    }
  }
  throw new Error(`${url}: ${last.message}`);
}

const nums = (d, key) => ((d && d[key] && d[key].number) || []).map((n) => n.value).filter(Boolean);
const sorted = (a) => [...a].sort();

// Draws are on the 1st and 16th, moved to the 2nd / 17th / 30th around holidays.
function* candidateDates(before) {
  let y = before.getUTCFullYear(), m = before.getUTCMonth() + 1;
  const beforeKey = before.toISOString().slice(0, 10);
  for (let k = 0; k < 4; k++) {
    for (const d of [30, 17, 16, 2, 1]) {
      const dt = new Date(Date.UTC(y, m - 1, d));
      if (dt.getUTCMonth() !== m - 1) continue; // no 30 Feb
      const key = dt.toISOString().slice(0, 10);
      if (key < beforeKey) yield { key, d, m, y };
    }
    if (--m === 0) {
      m = 12;
      y--;
    }
  }
}

async function main() {
  const j = await post(LATEST, {});
  const r = j && j.response;
  if (!r || !r.data || !r.date) throw new Error("no latest result");
  const d = r.data;
  const out = []; // no timestamp: the file (and the commit) only changes with the results
  out.push(["L", r.date, nums(d, "first")[0] || "", sorted(nums(d, "near1")).join(","), sorted(nums(d, "last3f")).join(","),
    sorted(nums(d, "last3b")).join(","), nums(d, "last2")[0] || ""].join("|"));
  for (const k of ["second", "third", "fourth", "fifth"]) out.push(`R|${k}|${sorted(nums(d, k)).join(",")}`);

  let found = 0;
  for (const c of candidateDates(new Date(r.date + "T00:00:00Z"))) {
    if (found >= HISTORY) break;
    const h = await post(BY_DATE, { date: String(c.d).padStart(2, "0"), month: String(c.m).padStart(2, "0"), year: String(c.y) });
    const res = h && h.response && h.response.result;
    if (!res || !res.data || !res.data.first) continue;
    out.push(["H", c.key, nums(res.data, "first")[0] || "", nums(res.data, "last2")[0] || ""].join("|"));
    found++;
  }
  console.log(`latest ${r.date}, history ${found}`);
  await mkdir("data/lotto", { recursive: true });
  await writeFile("data/lotto/latest.txt", out.join("\n") + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1); // keep the previous file
});
