// 03_test_page.mjs
// ---------------------------------------------------------------------------
// Step 3: drive the page in a headless browser and check what it shows.
//
// Input : index.html, data/cases.js, data/case_*.js, data/tutorial.js,
//         build/test_expected.json (from step 2)
// Output: PASS / FAIL lines on the screen, screenshots (PNG) in build/screenshots/
//
// Run   : ~/.nvm/versions/node/v22.22.2/bin/node build/03_test_page.mjs
//
// Needs the "playwright" package and a headless Chromium. Where they are can
// be set with the environment variables PLAYWRIGHT_DIR and CHROMIUM_PATH.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---- settings --------------------------------------------------------------
const BUILD = path.dirname(fileURLToPath(import.meta.url));
const PAGE_DIR = path.dirname(BUILD);
const SHOTS = process.env.SHOT_DIR || path.join(BUILD, "screenshots");
const PLAYWRIGHT_DIR = process.env.PLAYWRIGHT_DIR || "playwright";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH ||
  path.join(process.env.HOME, ".cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell");
const PAGE_URL = pathToFileURL(path.join(PAGE_DIR, "index.html")).href;
const STORAGE_KEY = "wmh-rater-trainer-v1";

fs.mkdirSync(SHOTS, { recursive: true });
const expected = JSON.parse(fs.readFileSync(path.join(BUILD, "test_expected.json"), "utf8"));
const ALL_IDS = Object.keys(expected.cases);
const { chromium } = createRequire(import.meta.url)(PLAYWRIGHT_DIR);

// ---- small helpers ---------------------------------------------------------
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  [" + detail + "]" : ""}`);
}
const near = (a, b, tol = 1e-9) => (a === null || b === null ? a === b : Math.abs(a - b) <= tol);
const shot = (page, name, options = {}) => page.screenshot({ path: path.join(SHOTS, name + ".png"), ...options });

// Open the page and collect everything that goes wrong in it.
async function openPage(context, query = "?test=1") {
  const page = await context.newPage();
  page.problems = [];      // console errors and script errors
  page.requests = [];      // every address the page asks for
  page.dialogs = 0;        // native alert / confirm boxes (there must be none)
  page.on("console", m => { if (m.type() === "error") page.problems.push("console: " + m.text()); });
  page.on("pageerror", e => page.problems.push("pageerror: " + e.message));
  page.on("request", r => page.requests.push(r.url()));
  page.on("dialog", d => { page.dialogs++; d.dismiss(); });
  await page.goto(PAGE_URL + query);
  await page.waitForFunction(() => document.documentElement.dataset.ready === "1", null, { timeout: 15000 });
  return page;
}
const frames = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
const hook = (page, fn, ...args) => page.evaluate(([fn, args]) => window.__wmhTest[fn](...args), [fn, args]);
const currentId = page => page.evaluate(() => window.__wmhTest.state.id);
const voxelXY = (page, x, y) => hook(page, "voxelToClient", x, y);
const maskCounts = page => page.evaluate(() => {
  const t = window.__wmhTest;
  return t.state.masks.map((m, pos) => t.maskCount(pos));
});
// Colour of the picture at the centre of a voxel, as drawn on the screen canvas.
async function pixelAtVoxel(page, x, y) {
  await page.mouse.move(3, 3);                    // pointer away: no brush ring in the way
  await frames(page);
  return page.evaluate(([x, y]) => {
    const cv = document.getElementById("cv"), rect = cv.getBoundingClientRect();
    const p = window.__wmhTest.voxelToClient(x, y), dpr = window.devicePixelRatio || 1;
    const d = cv.getContext("2d").getImageData(Math.round((p.x - rect.left) * dpr), Math.round((p.y - rect.top) * dpr), 1, 1).data;
    return [d[0], d[1], d[2]];
  }, [x, y]);
}
// Is the picture on the screen really drawn (not a black canvas)?
async function screenNotBlack(page) {
  await page.mouse.move(3, 3);
  await frames(page);
  return page.evaluate(() => {
    const cv = document.getElementById("cv");
    const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
    let bright = 0;
    for (let i = 0; i < d.length; i += 4 * 7) if (d[i] > 60) bright++;
    return bright / (d.length / (4 * 7));           // share of bright pixels
  });
}
async function scoreCase(page) {
  await page.click("#btnScore");
  await page.click("#modalOk");
  await page.waitForSelector("#diceValue");
}
async function nextPatient(page) {
  const before = await currentId(page);
  await page.click("#btnNext");
  await page.waitForFunction(b => window.__wmhTest.state.id !== b && !document.getElementById("btnNext"), before, { timeout: 15000 });
  return currentId(page);
}
async function openById(page, id) {
  const ok = await page.evaluate(id => window.__wmhTest.openPatient(id), id);
  if (!ok) throw new Error("patient " + id + " did not open");
}
const readScore = page => page.evaluate(() => {
  const num = id => { const v = document.getElementById(id).dataset.value; return v === "" ? null : Number(v); };
  const f = document.getElementById("formula").dataset;
  return { dice: num("diceValue"), diceText: document.getElementById("diceValue").textContent,
           algoDice: num("algoDice"), verdict: document.getElementById("verdict").dataset.verdict,
           verdictText: document.querySelector("#verdict .head").textContent,
           sensitivity: num("sensValue"), precision: num("precValue"), own_ml: num("ownMl"), ref_ml: num("refMl"),
           tp: +f.tp, fp: +f.fp, fn: +f.fn,
           perSlice: [...document.querySelectorAll("#sliceTable tbody tr:not(.total)")].map(tr => [tr.children[1].textContent, tr.children[2].textContent]) };
});
function sameScore(got, exp) {
  return got.tp === exp.tp && got.fp === exp.fp && got.fn === exp.fn && near(got.dice, exp.dice, 1e-12) &&
         near(got.sensitivity, exp.sensitivity, 1e-12) && near(got.precision, exp.precision, 1e-12) &&
         near(got.own_ml, exp.own_ml) && near(got.ref_ml, exp.ref_ml);
}
const scoreText = s => `TP ${s.tp} FP ${s.fp} FN ${s.fn} Dice ${s.dice === null ? "n/a" : s.dice.toFixed(4)}`;
const readProgress = page => page.evaluate(() => {
  const num = id => { const v = document.getElementById(id).dataset.value; return v === "" ? null : Number(v); };
  return { done: num("progDone"), mean: num("progMean"), beat: num("progBeat"), best: num("progBest"),
           bars: document.querySelectorAll("#hist .col").length, chip: document.getElementById("doneChip").textContent };
});
const savedState = page => page.evaluate(key => JSON.parse(window.localStorage.getItem(key) || "null"), STORAGE_KEY);
// Things that must hold in every window size.
async function layoutProblems(page) {
  return page.evaluate(() => {
    const out = [];
    if (document.documentElement.scrollWidth > window.innerWidth + 1)
      out.push(`page is wider than the window (${document.documentElement.scrollWidth} > ${window.innerWidth})`);
    for (const el of document.querySelectorAll("button, h1, h2, .badge, label.sl, dl.kv dd")) {
      if (!el.offsetParent) continue;
      if (el.scrollWidth > el.clientWidth + 1) out.push(`text cut off: "${el.textContent.trim().slice(0, 40)}"`);
    }
    return out;
  });
}
const caseFilesAsked = page => page.requests.filter(u => /\/data\/case_[^/]+\.js$/.test(u));

// ---- start the browser ------------------------------------------------------
let browser;
try { browser = await chromium.launch(); }
catch (err) { browser = await chromium.launch({ executablePath: CHROMIUM_PATH }); }
console.log("browser:", browser.version(), "\n");
let context, page;

// ============================================================================
// (a) the page loads from file:// without errors, straight into a random patient
// ============================================================================
context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
page = await openPage(context);
{
  check("a1 page loads from file:// with no console or script errors", page.problems.length === 0, page.problems.join(" | "));
  const outside = page.requests.filter(u => !u.startsWith("file:") && !u.startsWith("data:") && !u.startsWith("blob:"));
  check("a2 the page asks for nothing from the internet", outside.length === 0, outside.slice(0, 3).join(" "));
  const id = await currentId(page);
  const files = caseFilesAsked(page);
  check("a3 a patient is on the screen right after loading", ALL_IDS.includes(id) && await page.isVisible("#btnScore"), id);
  check("a4 only ONE patient file is loaded at the start (lazy loading)",
    files.length === 1 && files[0].endsWith("case_" + id + ".js") && page.requests.some(u => u.endsWith("/data/cases.js")),
    `${files.length} patient file(s), ${page.requests.length} requests in all`);
  const index = await page.evaluate(() => ({ n: window.__wmhTest.index.cases.length, per: window.__wmhTest.index.slicesPerCase }));
  check("a5 the index lists 110 patients", index.n === 110 && ALL_IDS.length === 110, `${index.n} patients, ${index.per} slices each`);
  check("a6 the picture is drawn (not black)", (await screenNotBlack(page)) > 0.05, `bright share ${(await screenNotBlack(page)).toFixed(3)}`);
  check("a7 the How-to panel is closed and no tutorial covers the page in test mode",
    !(await page.evaluate(() => document.getElementById("intro").open)) && await page.isHidden("#tut"));
  const footer = await page.textContent("footer");
  check("a8 the footer carries the data credit, the licence and the teaching-only note",
    footer.includes("Kuijf") && footer.includes("CC BY-NC 4.0") && footer.includes("10.34894/AECRSD") &&
    footer.includes("wmh.isi.uu.nl") && footer.includes("Not a medical device"));
  const lp = await layoutProblems(page);
  check("a9 laptop 1366x768: no horizontal scroll, no cut-off text", lp.length === 0, lp.join(" | "));
  const box = await page.evaluate(() => {
    const r = id => document.getElementById(id).getBoundingClientRect();
    return { view: r("view").bottom, strip: r("strip").bottom, score: r("btnScore").bottom, h: window.innerHeight };
  });
  check("a10 laptop 1366x768: picture, slice strip and Score button fit without scrolling",
    box.view <= box.h && box.strip <= box.h && box.score <= box.h, JSON.stringify(box));
  await shot(page, "01_start_laptop");
}
await context.close();

// a first visit (no test mode): the short tutorial opens once, then never again by itself
context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
page = await openPage(context, "");
{
  await page.waitForSelector("#tut:not([hidden])");
  await page.waitForFunction(() => !document.getElementById("tutCv").hidden);
  await shot(page, "02_tutorial_step1");
  const steps = [await page.textContent("#tutTitle")];
  await page.click("#tutNext"); steps.push(await page.textContent("#tutTitle"));
  await frames(page);
  const yellow = await page.evaluate(() => {
    const cv = document.getElementById("tutCv"), d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 150 && d[i + 1] > 120 && d[i + 2] < 140 && d[i] - d[i + 2] > 60) n++;
    return n;
  });
  await shot(page, "03_tutorial_step2_answer");
  await page.click("#tutNext"); steps.push(await page.textContent("#tutTitle"));
  const lastLabel = await page.textContent("#tutNext");
  await page.click("#tutNext");
  check("b1 first visit: the tutorial opens, has 3 steps, shows the expert's answer in step 2 and closes",
    steps.length === 3 && new Set(steps).size === 3 && yellow > 50 && lastLabel === "Start painting" && await page.isHidden("#tut"),
    `${steps.join(" / ")}; ${yellow} yellow voxels`);
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.ready === "1");
  await page.waitForTimeout(300);
  check("b2 after a reload the tutorial stays closed, the Tutorial button opens it again",
    await page.isHidden("#tut") && (await page.click("#tutBtn"), await page.isVisible("#tut")));
  await page.keyboard.press("Escape");
  check("b3 Escape closes the tutorial; no errors, no native dialogs", await page.isHidden("#tut") && page.problems.length === 0 && page.dialogs === 0,
    page.problems.join(" | "));
}
await context.close();

// ============================================================================
// (c) all 110 patients, reached with the "Next patient" button
//     For every patient: the file loads, the numbers of the page agree with
//     the independent numbers of step 2, painting the exact expert mask gives
//     Dice 1.000, and "Next patient" never repeats a patient.
// ============================================================================
context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
page = await openPage(context);
{
  const seen = [];
  const bad = { geometry: [], reference: [], algo: [], algoIndex: [], perfect: [], shown: [], perSlice: [], black: [], memory: [], verdict: [] };
  let beatExpected = 0;
  for (let n = 0; n < ALL_IDS.length; n++) {
    const id = await currentId(page);
    seen.push(id);
    const exp = expected.cases[id];
    if (!exp) { bad.geometry.push(id + " (unknown)"); break; }
    const got = await page.evaluate(() => {
      const t = window.__wmhTest;
      return { c: t.getCase(), ref: t.refCounts(), ignore: t.ignoreCounts(), algo: t.algoScoreNow(), pic: t.pictureStats(),
               loaded: t.loadedCaseIds(), tags: t.caseScriptCount(),
               row: t.index.cases.find(r => r.id === t.state.id) };
    });
    if (!(got.c.width === exp.width && got.c.height === exp.height && near(got.c.voxelMl, exp.voxel_ml, 1e-9) &&
          JSON.stringify(got.c.z) === JSON.stringify(exp.slices_z))) bad.geometry.push(id);
    if (JSON.stringify(got.ref) !== JSON.stringify(exp.ref_voxels) || JSON.stringify(got.ignore) !== JSON.stringify(exp.ignore_voxels)) bad.reference.push(id);
    if (!(got.algo.tp === exp.bianca.tp && got.algo.fp === exp.bianca.fp && got.algo.fn === exp.bianca.fn && near(got.algo.dice, exp.bianca.dice, 1e-12))) bad.algo.push(id);
    if (!near(got.row.biancaDice, exp.bianca.dice, 5.1e-5)) bad.algoIndex.push(id);
    if (!(got.pic.mean > 8 && got.pic.max > 150) || (await screenNotBlack(page)) < 0.03) bad.black.push(id);
    if (got.loaded.length !== 1 || got.loaded[0] !== id || got.tags !== 0) bad.memory.push(id);

    await hook(page, "paintReference");
    await scoreCase(page);
    const s = await readScore(page);
    if (!(sameScore(s, exp.reference) && s.diceText === "1.000")) bad.perfect.push(`${id} ${scoreText(s)}`);
    if (!near(s.algoDice, exp.bianca.dice, 1e-12)) bad.shown.push(id);
    const wantSlices = exp.bianca_per_slice.map(d => ["1.000", d === null ? "n/a" : d.toFixed(3)]);
    if (JSON.stringify(s.perSlice) !== JSON.stringify(wantSlices)) bad.perSlice.push(id);
    const beats = Math.round(exp.bianca.dice * 1000) < 1000;
    if (beats) beatExpected++;
    if (s.verdict !== (beats ? "win" : "tie") || (beats && s.verdictText !== "You beat the algorithm")) bad.verdict.push(id);
    if (n < ALL_IDS.length - 1) await nextPatient(page);
  }
  const distinct = new Set(seen).size;
  check("c1 Next patient: 110 patients in a row, all different, no repeats", seen.length === 110 && distinct === 110, `${distinct} different of ${seen.length}`);
  check("c2 all 110: picture size, voxel size and slice numbers as in step 2", bad.geometry.length === 0, bad.geometry.join(" "));
  check("c3 all 110: expert and other-pathology voxels per slice equal the original label files", bad.reference.length === 0, bad.reference.join(" "));
  check("c4 all 110: the algorithm's TP / FP / FN / Dice on the page equal the independent numbers", bad.algo.length === 0, bad.algo.join(" "));
  check("c5 all 110: the algorithm's Dice in the patient list equals the independent number (4 decimals)", bad.algoIndex.length === 0, bad.algoIndex.join(" "));
  check("c6 all 110: painting the exact expert mask gives Dice 1.000", bad.perfect.length === 0, bad.perfect.slice(0, 4).join(" | "));
  check("c7 all 110: the algorithm's Dice shown after scoring and per slice is right", bad.shown.length === 0 && bad.perSlice.length === 0,
    [...bad.shown, ...bad.perSlice].slice(0, 6).join(" "));
  check("c8 all 110: the picture is not black", bad.black.length === 0, bad.black.join(" "));
  check("c9 all 110: only the open patient is kept in memory", bad.memory.length === 0, bad.memory.slice(0, 6).join(" "));
  check("c10 all 110: verdict line fits (a perfect mask beats the algorithm)", bad.verdict.length === 0, bad.verdict.join(" "));

  const pr = await readProgress(page);
  check("c11 progress after 110 patients: 110 done, mean 1.000, best 1.000, beat count right, 20 bars",
    pr.done === 110 && near(pr.mean, 1) && near(pr.best, 1) && pr.beat === beatExpected && pr.bars === 20 && pr.chip.startsWith("110 of 110"),
    JSON.stringify(pr) + ` expected beat ${beatExpected}`);
  const saved = await savedState(page);
  check("c12 saved state: 110 patients, 30 history entries, round of 110", Object.keys(saved.progress.patients).length === 110 &&
    saved.progress.history.length === 30 && saved.progress.round.length === 110,
    `${Object.keys(saved.progress.patients).length} / ${saved.progress.history.length} / ${saved.progress.round.length}`);
  // all done: "Next patient" starts a new round with a different patient and says so
  const last = seen[seen.length - 1];
  const again = await nextPatient(page);
  const toast = await page.textContent("#toast");
  check("c13 after all 110: Next patient starts a new round with another patient", again !== last && ALL_IDS.includes(again) && /new round/.test(toast), `${again}; "${toast}"`);
  const asked = new Set(caseFilesAsked(page));
  check("c14 one data file per patient was loaded, each only when its patient was opened", asked.size === 110, `${asked.size} different files, ${caseFilesAsked(page).length} requests`);
  check("c15 110 patients in one session: no console or script errors, no native dialogs", page.problems.length === 0 && page.dialogs === 0, page.problems.slice(0, 3).join(" | "));
  const mean = ALL_IDS.reduce((a, id) => a + expected.cases[id].bianca.dice, 0) / ALL_IDS.length;
  const shownMean = await page.evaluate(() => window.__wmhTest.index.bianca.meanDiceSlices);
  check("c16 mean Dice of the algorithm on the chosen slices, index = independent", near(shownMean, mean, 5.1e-5), `${shownMean} vs ${mean.toFixed(4)}`);
}
await context.close();

// ============================================================================
// (d) empty mask = Dice 0; partly right masks; other pathology; the overlay;
//     try again; progress numbers; everything survives a reload
// ============================================================================
context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
const FIXED_ID = ALL_IDS.find(id => !expected.partial[id] && id.startsWith("Utrecht"));     // a fixed patient, given in the address
page = await openPage(context, "?test=1&patient=" + FIXED_ID);
{
  const partialIds = Object.keys(expected.partial);
  // d1: nothing painted
  const emptyId = await currentId(page);
  check("d0 a patient can be opened by the address (?patient=...)", emptyId === FIXED_ID, emptyId);
  await scoreCase(page);
  let s = await readScore(page);
  const expNothing = expected.cases[emptyId].nothing;
  check("d1 an empty mask gives Dice 0 and the line 'The algorithm was better this time'",
    s.dice === 0 && s.diceText === "0.000" && sameScore(s, expNothing) && s.verdict === "lose" && s.verdictText === "The algorithm was better this time",
    `${emptyId}: ${scoreText(s)}, "${s.verdictText}"`);
  let firsts = { [emptyId]: 0 }, beat = 0;

  // d2: partly right masks on 5 patients (2 of them with other pathology on their slices)
  const wrong = [];
  for (const id of partialIds) {
    const exp = expected.partial[id];
    await openById(page, id);
    await hook(page, "setMasksRle", exp.partial_rle);
    await scoreCase(page);
    s = await readScore(page);
    const wantSlices = exp.per_slice.map((d, i) => [d === null ? "n/a" : d.toFixed(3),
      expected.cases[id].bianca_per_slice[i] === null ? "n/a" : expected.cases[id].bianca_per_slice[i].toFixed(3)]);
    const wantVerdict = exp.beats_bianca ? "win" : "lose";
    if (!(sameScore(s, exp.score) && JSON.stringify(s.perSlice) === JSON.stringify(wantSlices) && s.verdict === wantVerdict))
      wrong.push(`${id}: ${scoreText(s)} (expected ${scoreText(exp.score)})`);
    if (id !== emptyId) { firsts[id] = exp.score.dice; if (exp.beats_bianca) beat++; }
    console.log(`      partial mask ${id}: ${scoreText(s)} | algorithm ${s.algoDice.toFixed(4)} | ${s.verdictText}`);
  }
  check("d2 partly right masks on 5 patients: TP, FP, FN, Dice, sensitivity, precision, ml and per-slice Dice as computed in Python",
    wrong.length === 0, wrong.join(" | "));

  // d3: colours of the overlay on the last partial patient (one with other pathology)
  const lastId = partialIds[partialIds.length - 1];
  await page.evaluate(() => { const el = document.getElementById("opacity"); el.value = 100; el.dispatchEvent(new Event("input", { bubbles: true })); });
  const cls = await page.evaluate(() => {
    const t = window.__wmhTest, w = t.getCase().width;
    for (let pos = 0; pos < t.state.masks.length; pos++) {
      const c = t.classIndices(pos);
      if (c.hit.length && c.extra.length && c.missed.length && c.ignored.length) {
        const xy = i => [i % w, Math.floor(i / w)];
        return { pos, hit: xy(c.hit[0]), extra: xy(c.extra[0]), missed: xy(c.missed[0]), ignored: xy(c.ignored[0]) };
      }
    }
    return null;
  });
  if (cls) {
    await page.click(`#strip button[data-slice="${cls.pos}"]`);
    const colour = {};
    for (const k of ["hit", "extra", "missed", "ignored"]) colour[k] = await pixelAtVoxel(page, ...cls[k]);
    const isGreen = c => c[1] > 150 && c[0] < 90, isRed = c => c[0] > 200 && c[2] < 110 && c[1] < 150;
    const isBlue = c => c[2] > 200 && c[0] < 130, isGrey = c => Math.abs(c[0] - c[1]) < 12 && Math.abs(c[1] - c[2]) < 25 && c[0] > 120;
    check("d3 overlay colours: hit green, extra red, missed blue, other pathology grey",
      isGreen(colour.hit) && isRed(colour.extra) && isBlue(colour.missed) && isGrey(colour.ignored), JSON.stringify(colour));
  } else check("d3 overlay colours: a slice with all four classes exists", false);
  await page.evaluate(() => { const el = document.getElementById("opacity"); el.value = 55; el.dispatchEvent(new Event("input", { bubbles: true })); });
  await shot(page, "06_score_screen");
  await shot(page, "06b_score_screen_full_page", { fullPage: true });

  // d4: "Show the algorithm's mask": overlay and numbers of the algorithm
  await page.click("#btnAlgo");
  let f = await page.evaluate(() => ({ ...document.getElementById("formula").dataset, label: document.getElementById("sliceLabel").textContent,
                                       button: document.getElementById("btnAlgo").textContent }));
  const eb = expected.cases[lastId].bianca;
  check("d4 the algorithm's mask can be shown: its TP / FP / FN are in the panel", +f.tp === eb.tp && +f.fp === eb.fp && +f.fn === eb.fn &&
    f.label.includes("BIANCA vs expert") && f.button === "Show my mask again", `TP ${f.tp} FP ${f.fp} FN ${f.fn}; "${f.label}"`);
  await shot(page, "07_algorithm_overlay");
  await page.click("#btnAlgo");
  f = await page.evaluate(() => ({ ...document.getElementById("formula").dataset }));
  check("d5 back to my mask: my numbers again", +f.tp === expected.partial[lastId].score.tp && +f.fp === expected.partial[lastId].score.fp);

  // d6: progress numbers = first tries
  const ids = Object.keys(firsts);
  const mean = ids.reduce((a, id) => a + firsts[id], 0) / ids.length, best = Math.max(...ids.map(id => firsts[id]));
  let pr = await readProgress(page);
  check("d6 progress: patients done, mean Dice, beat-the-algorithm count, best score, one bar per score",
    pr.done === ids.length && near(pr.mean, mean, 1e-12) && pr.beat === beat && near(pr.best, best, 1e-12) && pr.bars === partialIds.length + 1,
    `${JSON.stringify(pr)}; expected ${ids.length} done, mean ${mean.toFixed(4)}, beat ${beat}, best ${best.toFixed(4)}`);
  // a bar of the history can be tapped for its numbers
  await page.click('#hist .col[data-hist="0"]');
  const info = await page.textContent("#histInfo");
  check("d7 tapping a history bar shows its patient and both Dice values", info.includes(emptyId.replace(/_/g, " ")) && info.includes("you 0.000") && info.includes("BIANCA"), info);

  // d8: reload: the scored patient is still locked with the same score, progress is the same
  const before = await readScore(page);
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.ready === "1");
  const after = await readScore(page), pr2 = await readProgress(page);
  check("d8 progress and the scored patient survive a reload",
    (await currentId(page)) === lastId && sameScore(after, expected.partial[lastId].score) && after.verdict === before.verdict &&
    JSON.stringify(pr2) === JSON.stringify(pr) && await page.isVisible("#lockBadge"), JSON.stringify(pr2));
  check("d9 after the reload the picture is not black", (await screenNotBlack(page)) > 0.03);

  // d10: try again: perfect mask (plus paint on the other pathology) -> 1.000, but mean stays on the first try
  await page.click("#btnRetry"); await page.click("#modalOk"); await page.waitForSelector("#btnScore");
  const emptied = (await maskCounts(page)).every(n => n === 0);
  await hook(page, "paintReferencePlusIgnore");
  await scoreCase(page);
  s = await readScore(page);
  pr = await readProgress(page);
  const saved = await savedState(page);
  const rec = saved.progress.patients[lastId];
  check("d10 try again: empty slices, the perfect mask scores 1.000 even with paint on the other pathology",
    emptied && sameScore(s, expected.partial[lastId].reference_plus_ignore) && s.diceText === "1.000", scoreText(s));
  check("d11 a second try raises the best score but not the mean of the first tries",
    near(pr.mean, mean, 1e-12) && near(pr.best, 1) && pr.done === ids.length && rec.tries === 2 && near(rec.first, firsts[lastId], 1e-12) && rec.best === 1 &&
    saved.progress.history[saved.progress.history.length - 1].retry === true, JSON.stringify(rec));

  // d12: a painting that is not scored yet also survives a reload
  const nextId = await nextPatient(page);
  await hook(page, "paintReference");
  await page.click('#strip button[data-slice="3"]');
  const counts = await maskCounts(page);
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.ready === "1");
  const st = await page.evaluate(() => ({ id: window.__wmhTest.state.id, slice: window.__wmhTest.state.slice, scored: window.__wmhTest.state.scored }));
  check("d12 a painting in progress survives a reload (same patient, same slice, same mask)",
    st.id === nextId && st.slice === 3 && !st.scored && JSON.stringify(await maskCounts(page)) === JSON.stringify(counts) && counts[0] > 0, JSON.stringify(st));
  check("d13 this session: no console or script errors, no native dialogs", page.problems.length === 0 && page.dialogs === 0, page.problems.slice(0, 3).join(" | "));
}
await context.close();

// ============================================================================
// (e) old, foreign or damaged saved state: the page must start, show a real
//     patient and a picture, and every reset / start-over path must work.
//     (An earlier bug of the class page: a reset path used the name of a case
//     that no longer existed and the picture went black.)
// ============================================================================
const someId = ALL_IDS[7], someCase = expected.cases[someId];
const OLD_STATES = {
  "class-exercise shape (cur: 'easy')": JSON.stringify({ cur: "easy", mode: "practice", work: { practice: { easy: { masks: [[1, 2]], scored: true } } } }),
  "v1 with a patient name that does not exist": JSON.stringify({ v: 1, settings: { tool: "lasso", brushMm: 999, opacity: -3, smooth: "yes" },
    current: { id: "easy", w: 100, h: 100, slice: 2, scored: true, masks: [[0, 5]] },
    progress: { patients: { easy: { first: 0.5, best: 0.6, tries: 2 }, hard: { first: 2 }, [someId]: { first: 0.4, best: 0.1, tries: -3 } },
                history: [{ id: "easy", dice: 0.5, algo: 0.7 }, { id: someId, dice: 0.4, algo: 0.7 }, null, 5], round: ["easy", someId, someId, 7] } }),
  "v1 with the wrong picture size and slice count": JSON.stringify({ v: 1, settings: {},
    current: { id: someId, w: someCase.width + 9, h: 5, slice: 99, scored: true, masks: [[0, 5], [1, 1]] }, progress: { patients: [], history: {}, round: "x" } }),
  "v1 with runs outside the picture": JSON.stringify({ v: 1, settings: null,
    current: { id: someId, w: someCase.width, h: someCase.height, slice: -4, scored: true, masks: [[0, 5], [99999999, 4], "x", null, [3, -1], [1.5, 2]] }, progress: null }),
  "v1 scored patient without masks": JSON.stringify({ v: 1, current: { id: someId, w: someCase.width, h: someCase.height, slice: 1, scored: true, masks: [null, null, null, null, null, null] } }),
  "not JSON at all": "{{{ not json",
  "a number": "42",
  "v2 from a future version": JSON.stringify({ v: 2, current: { id: someId }, progress: { patients: { [someId]: { first: 0.9 } } } }),
};
// A browser that already holds "text" as the saved state when the page is opened the first time.
// (Writing it into an open page would not work: the page saves its own state when it is left.)
async function contextWithSavedState(text) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  await ctx.addInitScript(([key, text]) => {
    if (window.sessionStorage.getItem("test-injected")) return;        // only before the first load, not at a reload
    window.sessionStorage.setItem("test-injected", "1");
    window.localStorage.setItem(key, text);
  }, [STORAGE_KEY, text]);
  return ctx;
}
let dialogsOld = 0;
for (const [label, text] of Object.entries(OLD_STATES)) {
  context = await contextWithSavedState(text);
  page = await openPage(context);
  const problemsBefore = 0;
  const notes = [];
  const sane = async step => {
    const id = await currentId(page), share = await screenNotBlack(page);
    const c = await hook(page, "getCase");
    if (!ALL_IDS.includes(id) || !c || c.id !== id) notes.push(`${step}: no valid patient (${id})`);
    if (share < 0.03) notes.push(`${step}: picture is black (${share.toFixed(3)})`);
    if (await page.isVisible("#fatal")) notes.push(`${step}: error box shown`);
  };
  await sane("start");
  // scored without a reason? A damaged save must not show a locked patient with a wrong mask.
  const st = await page.evaluate(() => ({ scored: window.__wmhTest.state.scored, n: window.__wmhTest.state.masks.filter(Boolean).length }));
  if (label.includes("wrong picture size") || label.includes("outside the picture") || label.includes("does not exist")) {
    if (st.scored || st.n) notes.push("damaged masks were taken over");
  }
  // path 1: start this patient over (paint with the mouse first)
  if (st.scored) { await page.click("#btnRetry"); await page.click("#modalOk"); await page.waitForSelector("#btnScore"); await sane("try again"); }
  const mid = await page.evaluate(() => { const c = window.__wmhTest.getCase(); return [Math.floor(c.width / 2), Math.floor(c.height / 2)]; });
  const p = await voxelXY(page, ...mid);
  await page.mouse.click(p.x, p.y);
  if ((await maskCounts(page))[await page.evaluate(() => window.__wmhTest.state.slice)] === 0) notes.push("mouse click painted nothing");
  await page.click("#btnClearAll"); await page.click("#modalOk");
  if ((await maskCounts(page)).some(n => n > 0)) notes.push("start over left a mask");
  await sane("start over");
  // path 2: score, try again
  await page.mouse.click(p.x, p.y);
  await scoreCase(page); await sane("score");
  await page.click("#btnRetry"); await page.click("#modalOk"); await page.waitForSelector("#btnScore"); await sane("try again after score");
  // path 3: skip to another patient, then next patient
  const idA = await currentId(page);
  await page.click("#btnSkip");
  await page.waitForFunction(a => window.__wmhTest.state.id !== a, idA);
  await sane("skip");
  await scoreCase(page);
  await nextPatient(page); await sane("next");
  // path 4: reset my progress
  await page.click("#resetBtn"); await page.click("#resetYes");
  await page.waitForFunction(() => document.getElementById("progDone").dataset.value === "0" && !document.getElementById("loadBadge").offsetParent);
  await sane("reset");
  const saved = await savedState(page);
  if (!(saved && saved.v === 1 && Object.keys(saved.progress.patients).length === 0 && saved.progress.history.length === 0 && saved.progress.round.length === 0))
    notes.push("saved state after reset is not empty");
  if (page.problems.length > problemsBefore) notes.push(page.problems.slice(problemsBefore).join(" | "));
  check(`e  old saved state "${label}": page starts, start over / try again / skip / next / reset all keep a real patient and a picture`,
    notes.length === 0, notes.join(" ; "));
  dialogsOld += page.dialogs;
  await context.close();
}
{
  // what is kept from a half-valid save: the valid patient, with its numbers checked
  context = await contextWithSavedState(OLD_STATES["v1 with a patient name that does not exist"]);
  page = await openPage(context);
  const pr = await readProgress(page);
  const st = await page.evaluate(() => ({ ...window.__wmhTest.state, masks: null, progress: window.__wmhTest.state.progress }));
  check("e9 from a half-valid save only the patient that exists is kept, wrong settings fall back to the defaults",
    pr.done === 1 && near(pr.mean, 0.4) && near(pr.best, 0.4) && pr.bars === 1 && st.tool === "brush" && st.brushMm === 4 && st.opacity === 55 &&
    JSON.stringify(st.progress.round) === JSON.stringify([someId]) && st.progress.patients[someId].tries === 1,
    JSON.stringify(pr) + " " + JSON.stringify(st.progress.patients));
  check("e10 old saved states: no native dialogs", page.dialogs + dialogsOld === 0);
  // the valid part of a save with a scored patient but no masks: shown as scored with Dice 0, picture there
  await context.close();
  context = await contextWithSavedState(OLD_STATES["v1 scored patient without masks"]);
  page = await openPage(context);
  const s = await readScore(page).catch(() => null);
  check("e11 a saved scored patient comes back locked, on the saved slice, with a picture",
    (await currentId(page)) === someId && s && s.dice === 0 && (await page.evaluate(() => window.__wmhTest.state.slice)) === 1 && (await screenNotBlack(page)) > 0.03,
    s ? scoreText(s) : "no score panel");
}
await context.close();

// ============================================================================
// (f) painting with a real mouse, the confirmations, the patient list
// ============================================================================
context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
page = await openPage(context, "?test=1&patient=" + FIXED_ID);
{
  const W = expected.cases[FIXED_ID].width;
  // paint along the expert's mask of the slice with the most WMH, with the real mouse
  const pos = expected.cases[FIXED_ID].ref_voxels.indexOf(Math.max(...expected.cases[FIXED_ID].ref_voxels));
  await page.click(`#strip button[data-slice="${pos}"]`);
  const ref = await hook(page, "refIndices", pos);
  await page.evaluate(() => { const el = document.getElementById("brushSize"); el.value = 3; el.dispatchEvent(new Event("input", { bubbles: true })); });
  let p = await voxelXY(page, ref[0] % W, Math.floor(ref[0] / W));
  await page.mouse.click(p.x, p.y);
  const one = (await maskCounts(page))[pos];
  const hasVoxel = await page.evaluate(([pos, i]) => window.__wmhTest.state.masks[pos][i] === 1, [pos, ref[0]]);
  check("f1 a mouse click paints at the clicked voxel", hasVoxel && one >= 1 && one < 40, `${one} voxels`);
  for (let k = 0; k < ref.length; k += 9) {
    p = await voxelXY(page, ref[k] % W, Math.floor(ref[k] / W));
    await page.mouse.click(p.x, p.y);
  }
  // one dragged stroke
  const a = await voxelXY(page, 30, 30), b = await voxelXY(page, 60, 34);
  const beforeDrag = (await maskCounts(page))[pos];
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move((a.x + b.x) / 2, a.y, { steps: 4 }); await page.mouse.move(b.x, b.y, { steps: 4 }); await page.mouse.up();
  const afterDrag = (await maskCounts(page))[pos];
  await page.keyboard.press("z");
  const afterUndo = (await maskCounts(page))[pos];
  check("f2 a dragged stroke paints a line, Z takes exactly this stroke back", afterDrag > beforeDrag + 20 && afterUndo === beforeDrag, `${beforeDrag} -> ${afterDrag} -> ${afterUndo}`);
  // eraser
  await page.click('#toolRow button[data-tool="eraser"]');
  p = await voxelXY(page, ref[0] % W, Math.floor(ref[0] / W));
  await page.mouse.click(p.x, p.y);
  const erased = await page.evaluate(([pos, i]) => window.__wmhTest.state.masks[pos][i] === 0, [pos, ref[0]]);
  await page.keyboard.press("b");
  check("f3 the eraser removes paint, key B goes back to the brush", erased && await page.evaluate(() => window.__wmhTest.state.tool === "brush"));
  // wheel zoom and Fit
  p = await voxelXY(page, 50, 60);
  await page.mouse.move(p.x, p.y); await page.mouse.wheel(0, -600); await frames(page);
  const zoomed = await page.evaluate(() => window.__wmhTest.view.zoom);
  await shot(page, "05_painting_zoomed");
  await page.click("#zoomFit");
  check("f4 the mouse wheel zooms in, Fit shows the whole slice again", zoomed > 1.5 && await page.evaluate(() => window.__wmhTest.view.zoom === 1), `zoom ${zoomed.toFixed(2)}`);
  await page.mouse.move(p.x + 40, p.y + 30); await frames(page);
  await shot(page, "04_painting");
  const count = await page.textContent("#paintedCount");
  check("f5 the panel counts the slices with a mask", count === "1 of 6", count);

  // leaving a painted, unscored patient asks first (in the page, not with a native box)
  await page.click("#btnSkip");
  const asked = await page.isVisible("#modal");
  await page.click("#modalCancel");
  const stayed = (await currentId(page)) === FIXED_ID && (await maskCounts(page))[pos] > 0;
  await page.click("#btnSkip"); await page.click("#modalOk");
  await page.waitForFunction(id => window.__wmhTest.state.id !== id, FIXED_ID);
  check("f6 Skip with an unscored mask asks first: 'Keep painting' stays, 'Leave' opens another patient", asked && stayed && page.dialogs === 0, await currentId(page));

  // reset my progress: confirmation inside the page
  await hook(page, "paintReference"); await scoreCase(page);
  await page.click("#resetBtn");
  const boxShown = await page.isVisible("#resetBox");
  await page.click("#resetNo");
  const kept = (await readProgress(page)).done === 1 && await page.isVisible("#resetBtn");
  await page.click("#resetBtn");
  await shot(page, "09_reset_confirmation", { fullPage: true });
  const idBefore = await currentId(page);
  await page.click("#resetYes");
  await page.waitForFunction(() => document.getElementById("progDone").dataset.value === "0" && !document.getElementById("loadBadge").offsetParent);
  const pr = await readProgress(page);
  check("f7 Reset my progress asks inside the page; 'Keep' keeps, 'Yes, reset' empties the progress and opens a fresh patient",
    boxShown && kept && pr.done === 0 && pr.bars === 0 && (await maskCounts(page)).every(n => n === 0) && await page.isVisible("#btnScore") &&
    (await screenNotBlack(page)) > 0.03 && page.dialogs === 0, `${idBefore} -> ${await currentId(page)}`);

  // ---- patient list ----
  await hook(page, "paintReference"); await scoreCase(page);               // one scored patient for the list
  const scoredId = await currentId(page);
  await page.click("#pickBtn");
  const rowsOf = () => page.evaluate(() => [...document.querySelectorAll("#pickTable tbody tr")].map(tr => ({
    id: tr.dataset.id, ml: +tr.children[2].textContent, load: tr.children[3].textContent, algo: +tr.children[4].textContent,
    first: tr.children[5].textContent, cur: tr.classList.contains("cur") })));
  let rows = await rowsOf();
  const sortedBy = (list, key, dir) => list.every((r, i) => i === 0 || (r[key] - list[i - 1][key]) * dir >= 0);
  check("g1 the patient list shows all 110 patients, the open one is marked, scored ones show the score",
    rows.length === 110 && rows.filter(r => r.cur).length === 1 && rows.find(r => r.cur).id === scoredId && rows.find(r => r.id === scoredId).first === "1.00");
  await page.waitForFunction(() => document.getElementById("toast").hidden, null, { timeout: 8000 }).catch(() => {});   // an old message would cover the list
  await shot(page, "08_patient_list");
  await page.click('#pickTable th[data-sort="ml"]');
  rows = await rowsOf(); const up = sortedBy(rows, "ml", 1), down = sortedBy(rows, "ml", -1);
  await page.click('#pickTable th[data-sort="ml"]');
  rows = await rowsOf();
  check("g2 the list sorts by lesion load (WMH ml) up and down", (up && sortedBy(rows, "ml", -1)) || (down && sortedBy(rows, "ml", 1)), `first row now ${rows[0].id} ${rows[0].ml} ml`);
  await page.click('#pickTable th[data-sort="load"]');
  rows = await rowsOf();
  const order = rows.map(r => r.load).filter((load, i, all) => i === 0 || load !== all[i - 1]).join(" > ");     // runs collapsed
  check("g3 sorting by the Load column groups small / medium / large", order === "large > medium > small" || order === "small > medium > large", order);
  await page.click('#pickTable th[data-sort="algo"]');
  rows = await rowsOf();
  check("g4 the list sorts by the algorithm's Dice", sortedBy(rows, "algo", 1) || sortedBy(rows, "algo", -1));
  const counts = {};
  for (const load of ["small", "medium", "large"]) {
    await page.click(`#pickLoad button[data-load="${load}"]`);
    rows = await rowsOf();
    counts[load] = rows.length;
    if (!rows.every(r => r.load === load)) counts[load] = -1;
  }
  check("g5 the Small / Medium / Large filter shows only that class; together 110", counts.small > 0 && counts.medium > 0 && counts.large > 0 &&
    counts.small + counts.medium + counts.large === 110, JSON.stringify(counts));
  await page.click('#pickLoad button[data-load="all"]');
  await page.check("#pickHideDone");
  rows = await rowsOf();
  check("g6 'Hide done' leaves out the scored patient", rows.length === 109 && !rows.some(r => r.id === scoredId));
  const target = rows[5].id;
  await page.click(`#pickTable tbody tr[data-id="${target}"]`);
  await page.waitForFunction(id => window.__wmhTest.state.id === id, target);
  check("g7 a click on a row opens that patient and closes the list", await page.isHidden("#picker") && (await screenNotBlack(page)) > 0.03 && await page.isVisible("#btnScore"), target);
  await page.click("#pickBtn"); await page.keyboard.press("Escape");
  const closedByKey = await page.isHidden("#picker");
  await page.click("#pickBtn"); await page.click("#pickRandom");
  await page.waitForFunction(id => window.__wmhTest.state.id !== id, target);
  check("g8 Escape closes the list; 'Random patient' opens another patient", closedByKey && await page.isHidden("#picker") && (await currentId(page)) !== scoredId);
  check("g9 this session: no console or script errors, no native dialogs", page.problems.length === 0 && page.dialogs === 0, page.problems.slice(0, 3).join(" | "));
}
await context.close();

// ============================================================================
// (h) the page must also work when the browser blocks local storage
// ============================================================================
context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
await context.addInitScript(() => {
  Object.defineProperty(window, "localStorage", { get() { throw new Error("storage blocked (test)"); } });
  Object.defineProperty(window, "sessionStorage", { get() { throw new Error("storage blocked (test)"); } });
});
page = await openPage(context);
{
  const blocked = await page.evaluate(() => { try { window.localStorage.getItem("x"); return false; } catch (err) { return true; } });
  const first = await currentId(page);
  await hook(page, "paintReference");
  await scoreCase(page);
  const s = await readScore(page);
  const second = await nextPatient(page);
  const pr = await readProgress(page);
  const note = await page.textContent("#footStorage");
  check("h1 with blocked storage the page still loads, scores, goes to the next patient and counts the progress of this visit",
    blocked && s.diceText === "1.000" && second !== first && pr.done === 1 && (await screenNotBlack(page)) > 0.03, `${first} -> ${second}`);
  check("h2 with blocked storage the footer says that the progress is not kept", /blocks local storage/.test(note), note);
  await page.click("#resetBtn"); await page.click("#resetYes");
  await page.waitForFunction(() => document.getElementById("progDone").dataset.value === "0" && !document.getElementById("loadBadge").offsetParent);
  check("h3 with blocked storage: reset works, no console or script errors", (await screenNotBlack(page)) > 0.03 && page.problems.length === 0 && page.dialogs === 0,
    page.problems.slice(0, 3).join(" | "));
}
await context.close();

// ============================================================================
// (i) a patient file that is missing: the page says so and offers another patient
//     (tested on a copy of the page with only ONE patient file, in a temporary folder)
// ============================================================================
{
  const os = await import("node:os");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wmh-rater-trainer-test-"));
  fs.mkdirSync(path.join(tmp, "data"));
  fs.copyFileSync(path.join(PAGE_DIR, "index.html"), path.join(tmp, "index.html"));
  fs.copyFileSync(path.join(PAGE_DIR, "data", "cases.js"), path.join(tmp, "data", "cases.js"));
  const onlyId = ALL_IDS[3], missingId = ALL_IDS[4];
  fs.copyFileSync(path.join(PAGE_DIR, "data", `case_${onlyId}.js`), path.join(tmp, "data", `case_${onlyId}.js`));
  const tmpUrl = pathToFileURL(path.join(tmp, "index.html")).href;
  context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  // 1. the first patient cannot be loaded: an error box with a button, no black picture pretending to be a patient
  await page.goto(tmpUrl + "?test=1&patient=" + missingId);
  await page.waitForFunction(() => document.documentElement.dataset.ready === "1", null, { timeout: 20000 });
  const st = await page.evaluate(() => ({ id: window.__wmhTest.state.id, fatal: document.getElementById("fatal").hidden ? "" : document.getElementById("fatal").textContent,
                                           button: !!document.getElementById("fatalRetry") }));
  // the page tried the wanted patient and then a random one; with 1 file of 110 this fails nearly always
  const startOk = st.id === onlyId ? true : (st.id === null && st.fatal.includes("could not be loaded") && st.button);
  check("i1 missing patient file at the start: a clear message with a 'Try another patient' button", startOk, st.fatal.slice(0, 90) || st.id);
  // 2. a patient is open, the next file is missing: the open patient stays, a short message appears
  await page.goto(tmpUrl + "?test=1&patient=" + onlyId);
  await page.waitForFunction(() => document.documentElement.dataset.ready === "1", null, { timeout: 20000 });
  await page.evaluate(() => window.__wmhTest.paintReference());
  const ok = await page.evaluate(id => window.__wmhTest.openPatient(id), missingId);
  const after = await page.evaluate(() => ({ id: window.__wmhTest.state.id, toast: document.getElementById("toast").textContent,
                                              painted: window.__wmhTest.maskCount(0), busy: !!document.getElementById("loadBadge").offsetParent }));
  check("i2 missing patient file later: the open patient and its mask stay, a message says what happened",
    ok === false && after.id === onlyId && after.painted > 0 && !after.busy && after.toast.includes("could not be loaded") && (await screenNotBlack(page)) > 0.03 &&
    errors.length === 0, after.toast);
  await context.close();
  fs.rmSync(tmp, { recursive: true, force: true });        // only the temporary copy made above
}

// ============================================================================
// (j) phone 390 x 844 with touch
// ============================================================================
context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, deviceScaleFactor: 3 });
page = await openPage(context, "?test=1&patient=" + FIXED_ID);
{
  const W = expected.cases[FIXED_ID].width;
  let lp = await layoutProblems(page);
  check("j1 phone 390x844: no horizontal scroll, no cut-off text at the start", lp.length === 0, lp.join(" | "));
  const box = await page.evaluate(() => {
    const r = document.getElementById("view").getBoundingClientRect(), q = document.getElementById("quickBar").getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, width: r.width, quickLeft: q.left, quickRight: q.right, quickShown: !!document.getElementById("quickBar").offsetParent, h: window.innerHeight, w: window.innerWidth };
  });
  check("j2 phone: the whole picture is on the first screen, with the quick tools and a scroll margin right of it",
    box.top >= 0 && box.bottom <= box.h && box.quickShown && box.quickLeft >= box.width && box.quickRight <= box.w, JSON.stringify(box));
  await shot(page, "10_phone_start");

  // a tap paints at the tapped voxel
  const pos = expected.cases[FIXED_ID].ref_voxels.indexOf(Math.max(...expected.cases[FIXED_ID].ref_voxels));
  await page.tap(`#strip button[data-slice="${pos}"]`);
  await page.evaluate(() => document.getElementById("view").scrollIntoView({ block: "center" }));
  const ref = await hook(page, "refIndices", pos);
  const target = ref[Math.floor(ref.length / 2)];
  let p = await voxelXY(page, target % W, Math.floor(target / W));
  await page.touchscreen.tap(p.x, p.y);
  const tapped = await page.evaluate(([pos, i]) => { const m = window.__wmhTest.state.masks[pos]; return !!m && m[i] === 1; }, [pos, target]);
  const afterTap = (await maskCounts(page))[pos];
  check("j3 phone: a finger tap paints at the tapped voxel", tapped && afterTap > 0 && afterTap < 60, `${afterTap} voxels`);

  // one finger drags = paint; two fingers = zoom and nothing painted; Fit shows the whole slice again
  const cdp = await context.newCDPSession(page);
  const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map((q, i) => ({ x: q.x, y: q.y, id: i + 1 })) });
  const a = await voxelXY(page, 40, 60), b = await voxelXY(page, 90, 66);
  await touch("touchStart", [a]); await touch("touchMove", [{ x: (a.x + b.x) / 2, y: a.y }]); await touch("touchMove", [b]); await touch("touchEnd", []);
  const afterDrag = (await maskCounts(page))[pos];
  const c1 = await voxelXY(page, 70, 90);
  await touch("touchStart", [{ x: c1.x - 30, y: c1.y }, { x: c1.x + 30, y: c1.y }]);
  await touch("touchMove", [{ x: c1.x - 60, y: c1.y }, { x: c1.x + 60, y: c1.y }]);
  await touch("touchMove", [{ x: c1.x - 100, y: c1.y }, { x: c1.x + 100, y: c1.y }]);
  await touch("touchEnd", []);
  const afterPinch = (await maskCounts(page))[pos];
  const zoomNow = await page.evaluate(() => window.__wmhTest.view.zoom);
  await frames(page);
  await shot(page, "11_phone_painting_zoomed");
  check("j4 phone: one-finger drag paints, two-finger pinch zooms and paints nothing",
    afterDrag > afterTap + 20 && afterPinch === afterDrag && zoomNow > 1.8, `voxels ${afterTap} -> ${afterDrag} -> ${afterPinch}, zoom ${zoomNow.toFixed(2)}`);
  // painting while zoomed in: the tap still lands on the voxel under the finger
  const center = await page.evaluate(() => { const g = window.__wmhTest.geometry(); const r = document.getElementById("cv").getBoundingClientRect();
    return { x: r.left + g.viewW / 2, y: r.top + g.viewH / 2, vx: Math.floor((g.viewW / 2 - g.ox) / g.px), vy: Math.floor((g.viewH / 2 - g.oy) / g.py) }; });
  await page.tap("#quickBar button[data-tool='eraser']");
  const toolNow = await page.evaluate(() => window.__wmhTest.state.tool);
  await page.tap("#quickBar button[data-tool='brush']");
  await page.touchscreen.tap(center.x, center.y);
  const zoomTap = await page.evaluate(([pos, i]) => window.__wmhTest.state.masks[pos][i] === 1, [pos, center.vy * W + center.vx]);
  await page.tap("#quickFit");
  const fitted = await page.evaluate(() => window.__wmhTest.view.zoom === 1 && window.__wmhTest.view.panX === 0);
  check("j5 phone: quick tools switch the tool, a tap paints under the finger when zoomed in, Fit shows the whole slice",
    toolNow === "eraser" && zoomTap && fitted);
  await page.tap("#quickUndo");
  check("j6 phone: the quick Undo button takes the last tap back", (await maskCounts(page))[pos] === afterDrag);
  const styles = await page.evaluate(() => ({ view: getComputedStyle(document.getElementById("view")).touchAction, cv: getComputedStyle(document.getElementById("cv")).touchAction,
                                               grip: getComputedStyle(document.querySelector("#quickBar .scrollgrip")).touchAction, quick: getComputedStyle(document.getElementById("quickBar")).touchAction }));
  // a finger that starts in the margin right of the picture scrolls the page
  const grip = await page.evaluate(() => { const r = document.querySelector("#quickBar .scrollgrip").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const y0 = await page.evaluate(() => window.scrollY);
  await touch("touchStart", [grip]);
  for (let k = 1; k <= 6; k++) await touch("touchMove", [{ x: grip.x, y: grip.y - 30 * k }]);
  await touch("touchEnd", []);
  await page.waitForTimeout(250);
  const y1 = await page.evaluate(() => window.scrollY);
  check("j7 phone: a swipe that starts in the margin right of the picture scrolls the page and paints nothing",
    y1 > y0 + 40 && (await maskCounts(page))[pos] === afterDrag, `scrollY ${y0} -> ${y1}; touch-action picture "${styles.cv || styles.view}", margin "${styles.grip || styles.quick}"`);

  // score on the phone
  await page.evaluate(() => window.__wmhTest.clearCase());
  await hook(page, "setMasksRle", expected.partial[Object.keys(expected.partial)[0]] && FIXED_ID in expected.partial ? expected.partial[FIXED_ID].partial_rle : await page.evaluate(() => {
    // the expert's mask moved 3 voxels to the right: partly right, partly wrong
    const t = window.__wmhTest, c = t.getCase(), out = [];
    for (let pos = 0; pos < c.nSlices; pos++) {
      const runs = [], idx = t.refIndices(pos).filter(i => i % c.width < c.width - 3).map(i => i + 3);
      for (const i of idx) { if (runs.length && runs[runs.length - 2] + runs[runs.length - 1] === i) runs[runs.length - 1]++; else runs.push(i, 1); }
      out.push(runs);
    }
    return out;
  }));
  await page.evaluate(() => document.getElementById("btnScore").scrollIntoView({ block: "center" }));
  await page.tap("#btnScore"); await page.tap("#modalOk");
  await page.waitForSelector("#diceValue");
  await page.waitForTimeout(200);
  const inView = await page.evaluate(() => {
    const d = document.getElementById("diceValue").getBoundingClientRect(), n = document.getElementById("btnNext").getBoundingClientRect();
    return { dice: d.top >= 0 && d.bottom <= window.innerHeight, next: n.top >= 0 && n.bottom <= window.innerHeight, nextH: n.height, nextW: n.width };
  });
  lp = await layoutProblems(page);
  const s = await readScore(page);
  check("j8 phone: after Score the Dice, the verdict line and the big Next patient button are on the screen, nothing is cut off",
    inView.dice && inView.next && inView.nextH >= 48 && inView.nextW >= 250 && lp.length === 0 && s.dice > 0 && s.dice < 1, `${JSON.stringify(inView)} ${lp.join(" | ")} Dice ${s.diceText}`);
  await shot(page, "12_phone_score");
  await shot(page, "12b_phone_score_full_page", { fullPage: true });
  const idBefore = await currentId(page);
  await page.tap("#btnNext");
  await page.waitForFunction(b => window.__wmhTest.state.id !== b && !document.getElementById("btnNext"), idBefore);
  const top = await page.evaluate(() => ({ y: window.scrollY, view: document.getElementById("view").getBoundingClientRect().top }));
  check("j9 phone: Next patient opens another patient and goes back to the picture", top.y === 0 && top.view < 844 && (await screenNotBlack(page)) > 0.03, JSON.stringify(top));
  await page.tap("#pickBtn");
  lp = await layoutProblems(page);
  const listBox = await page.evaluate(() => { const r = document.querySelector(".pickerbox").getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom,
    rows: document.querySelectorAll("#pickTable tbody tr").length, tableWider: document.querySelector(".tablewrap").scrollWidth > document.querySelector(".tablewrap").clientWidth + 1 }; });
  check("j10 phone: the patient list fits the screen (no sideways scroll, also not inside the table)",
    lp.length === 0 && listBox.l >= 0 && listBox.r <= 390 && listBox.b <= 844 && listBox.rows === 110 && !listBox.tableWider, JSON.stringify(listBox) + lp.join(" | "));
  await shot(page, "13_phone_patient_list");
  await page.tap("#pickClose");
  await page.tap("#tutBtn");
  await page.waitForFunction(() => !document.getElementById("tutCv").hidden);
  const tutBox = await page.evaluate(() => { const n = document.getElementById("tutNext").getBoundingClientRect(); return { nextBottom: n.bottom, wide: document.documentElement.scrollWidth }; });
  check("j11 phone: the tutorial fits, its Next button is on the screen", tutBox.nextBottom <= 844 && tutBox.wide <= 391, JSON.stringify(tutBox));
  await shot(page, "14_phone_tutorial");
  check("j12 phone session: no console or script errors, no native dialogs", page.problems.length === 0 && page.dialogs === 0, page.problems.slice(0, 3).join(" | "));
}
await context.close();

// ============================================================================
// (k) other window sizes: nothing is cut off, the whole picture is on the first screen
// ============================================================================
{
  const sizes = [
    ["small laptop window", 1366, 657, false],
    ["laptop 1280x720", 1280, 720, false],
    ["big screen 1920x1080", 1920, 1080, false],
    ["tablet upright 768x1024", 768, 1024, true],
    ["phone on its side 844x390", 844, 390, true],
    ["small phone 360x640", 360, 640, true],
  ];
  let n = 0;
  for (const [name, width, height, touch] of sizes) {
    n++;
    context = await browser.newContext({ viewport: { width, height }, hasTouch: touch });
    page = await openPage(context, "?test=1&patient=" + FIXED_ID);
    const before = await layoutProblems(page);
    const box = await page.evaluate(() => {
      const r = document.getElementById("view").getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height), win: window.innerHeight };
    });
    const bright = await screenNotBlack(page);
    if (n === 5) await shot(page, "17_phone_sideways_start");
    await hook(page, "paintReference");
    await page.evaluate(() => document.getElementById("btnScore").scrollIntoView({ block: "center" }));
    await scoreCase(page);
    await page.waitForTimeout(150);
    const after = await layoutProblems(page);
    const s = await readScore(page);
    // on a phone held sideways the picture starts on the first screen and is not taller than the window
    const fits = height >= 600 ? (box.top >= 0 && box.bottom <= box.win) : (box.top < box.win / 2 && box.h <= box.win);
    check(`k${n} ${name}: no horizontal scroll, nothing cut off before and after Score, picture on the screen`,
      before.length === 0 && after.length === 0 && fits && box.w >= 250 && box.h >= 200 && bright > 0.03 && s.dice === 1 && page.problems.length === 0,
      `${JSON.stringify(box)} ${before.concat(after).join(" | ")} ${page.problems.slice(0, 2).join(" | ")}`);
    if (n === 1) await shot(page, "15_small_laptop_window_score");
    if (n === 4) await shot(page, "16_tablet_score", { fullPage: true });
    if (n === 5) await shot(page, "17_phone_sideways_score");
    await context.close();
  }
}

// ---- summary ---------------------------------------------------------------
await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed`);
if (failed.length) { console.log("FAILED:"); for (const f of failed) console.log("  " + f.name); process.exit(1); }
