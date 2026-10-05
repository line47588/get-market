// Fetches the macro and news Google Apps Scripts and saves them as small JSON files
// that the CYD reads from raw.githubusercontent.com. The ESP32 (no PSRAM) cannot
// fetch Google Script directly while mining: the redirect + large certificate
// needs more heap than it has, so GitHub Actions does it instead.
//
// Secrets (repo Settings > Secrets and variables > Actions):
//   MACRO_URL  = https://script.google.com/macros/s/.../exec  (macro prices)
//   NEWS_URL   = https://script.google.com/macros/s/.../exec  (news prices)
import { writeFile, mkdir } from "node:fs/promises";

const MACRO_URL = process.env.MACRO_URL;
const NEWS_URL = process.env.NEWS_URL;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Google Script randomly answers 404 / an HTML "page not found" for the same URL
// (seen about half the time in testing), so retry a few times.
async function getJson(url, name, attempts = 4) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "ESP32" },
        redirect: "follow",
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`${name}: not JSON: ${text.slice(0, 120)}`);
      }
    } catch (e) {
      lastErr = e;
      console.warn(`${e.message} (attempt ${i}/${attempts})`);
      if (i < attempts) await sleep(3000 * i);
    }
  }
  throw lastErr;
}

async function main() {
  if (!MACRO_URL || !NEWS_URL) throw new Error("MACRO_URL / NEWS_URL secrets are not set");
  await mkdir("data", { recursive: true });
  let failed = 0;

  // Macro: { ok, updatedAt, data: { vix, vix_pct, dxy, ... } } saved as-is (~250 B)
  try {
    const macro = await getJson(MACRO_URL, "macro");
    if (macro.ok !== true) throw new Error("macro: ok != true");
    await writeFile("data/macro.json", JSON.stringify(macro) + "\n");
    console.log("macro ok");
  } catch (e) {
    failed++;
    console.error(e.message); // keep the previous data/macro.json
  }

  // News: keep only type=NEWS entries with the field the CYD shows (~5 KB -> <2 KB)
  try {
    const news = await getJson(NEWS_URL, "news");
    const slim = {};
    for (const [key, v] of Object.entries(news)) {
      if (v && v.type === "NEWS") slim[key] = { type: "NEWS", change_text: v.change_text ?? "N/A" };
    }
    if (Object.keys(slim).length === 0) throw new Error("news: no NEWS entries");
    await writeFile("data/news.json", JSON.stringify(slim) + "\n");
    console.log(`news ok (${Object.keys(slim).length} entries)`);
  } catch (e) {
    failed++;
    console.error(e.message); // keep the previous data/news.json
  }

  if (failed === 2) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
