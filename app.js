"use strict";
const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clone = (o) => JSON.parse(JSON.stringify(o));
const pad = (n) => String(n).padStart(2, "0");
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const epId = (n) => "e" + String(n).padStart(3, "0");

const SHOTS = 6, SHOT_SEC = 10, MEMORY = 10;
const LS_DATA = "autoseries.v1", LS_ENGINE = "autoseries.engine";
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } }

const S = { ready: false, series: null, episodes: [], view: "home", epNo: null, confirmNew: false, confirmImport: false };
let T = null;

// ---------- storage (this browser only) ----------
const DEFAULT_MODEL = "gemini-3-flash-preview";
const LS_SETTINGS = "autoseries.settings";
let memoryOnly = false;
let settings = { key: "", model: "" };
function canStore() { try { localStorage.setItem("__t", "1"); localStorage.removeItem("__t"); return true; } catch { return false; } }
function saveLocal() {
  try { localStorage.setItem(LS_DATA, JSON.stringify({ series: S.series, episodes: S.episodes })); } catch { memoryOnly = true; }
}
async function putSeries() { saveLocal(); }
async function putEpisode() { saveLocal(); }
async function guarded(fn) { try { await fn(); } catch { toast("บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง", true); } }
function boot() {
  memoryOnly = !canStore();
  try { const d = JSON.parse(lsGet(LS_DATA) || "null"); if (d && d.series) { S.series = d.series; S.episodes = d.episodes || []; } } catch { /* start empty */ }
  try { const t = JSON.parse(lsGet(LS_SETTINGS) || "null"); if (t) settings = { key: String(t.key || ""), model: String(t.model || "") }; } catch { /* defaults */ }
  S.ready = true; render();
}

// ---------- Gemini ----------
function geminiError(status, apiMsg) {
  let m;
  if (status === 400) m = /API key/i.test(apiMsg) ? "API key ไม่ถูกต้อง ตรวจที่แท็บตั้งค่า" : "Gemini ปฏิเสธคำขอ (400) " + apiMsg;
  else if (status === 401 || status === 403) m = "API key ใช้ไม่ได้หรือไม่มีสิทธิ์ใช้โมเดลนี้ ตรวจที่แท็บตั้งค่า";
  else if (status === 404) m = "ไม่พบโมเดลชื่อนี้ ตรวจชื่อรุ่นที่แท็บตั้งค่า";
  else if (status === 429) m = "ใช้เกินโควตาฟรีของ Gemini ชั่วคราว รอสักครู่แล้วลองใหม่";
  else m = "Gemini ขัดข้องชั่วคราว (" + status + ") ลองใหม่อีกครั้ง";
  const err = new Error(m); err.status = status; return err;
}
async function geminiJSON(prompt, signal) {
  const model = settings.model || DEFAULT_MODEL;
  let res;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST", signal,
      headers: { "Content-Type": "application/json", "x-goog-api-key": settings.key },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", temperature: 0.9 } }),
    });
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    throw new Error("เชื่อมต่อ Gemini ไม่ได้ ตรวจอินเทอร์เน็ตแล้วลองใหม่");
  }
  if (!res.ok) { let msg = ""; try { msg = (await res.json()).error?.message || ""; } catch { /* no body */ } throw geminiError(res.status, msg); }
  const j = await res.json();
  const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  if (!text.trim()) throw new Error("Gemini ไม่ส่งคำตอบกลับมา (อาจถูกกรองเนื้อหา) ลองใหม่หรือปรับไอเดีย");
  return extractJSON(text);
}

// ---------- domain helpers ----------
const mainShots = (ep) => ep.shots.filter((s) => !s.backup);
const doneCount = (ep) => mainShots(ep).filter((s) => s.doneDate).length;
function quotaLimit() { return Math.min(20, Math.max(1, Number(S.series?.settings?.dailyQuota) || 7)); }
function quotaUsed() {
  const t = today();
  const ticks = S.episodes.reduce((n, ep) => n + ep.shots.filter((s) => s.doneDate === t).length, 0);
  const adj = S.series?.adj && S.series.adj.date === t ? Number(S.series.adj.n) || 0 : 0;
  return Math.max(0, ticks + adj);
}
function flowPrompt(shot) {
  const b = S.series.bible;
  const looks = b.characters.filter((c) => c.name && shot.prompt_en.includes(c.name)).map((c) => `${c.name}: ${c.look_en}`);
  return [b.style_lock_en, looks.length ? "Characters - " + looks.join("; ") : "", shot.prompt_en].filter(Boolean).join(" ");
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  ta.remove();
  return ok;
}
let toastTimer;
function toast(msg, bad = false) {
  const t = $("#toast");
  t.textContent = msg; t.className = "toast show" + (bad ? " bad" : "");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = "toast"), 3800);
}

// ---------- validation of AI output ----------
function str(v, name) { if (typeof v !== "string" || !v.trim()) throw new Error(`ในคำตอบไม่มีข้อมูล "${name}"`); return v.trim(); }
function arr(v, name) { if (!Array.isArray(v)) throw new Error(`"${name}" ต้องเป็นรายการ`); return v; }
function vBible(d) {
  const chars = arr(d?.characters, "characters");
  if (!chars.length) throw new Error("ไม่มีตัวละครในคำตอบ");
  return {
    title: str(d.title, "title"), world: str(d.world, "world"), tone: str(d.tone, "tone"), style_lock_en: str(d.style_lock_en, "style_lock_en"),
    characters: chars.map((c) => ({ name: str(c?.name, "name"), role: String(c?.role ?? "").trim(), personality: String(c?.personality ?? "").trim(), goal: String(c?.goal ?? "").trim(), look_en: str(c?.look_en, "look_en") })),
    open_threads: arr(d.open_threads, "open_threads").map(String),
  };
}
function vShot(s, number, backup) {
  return { number, backup, action_th: str(s?.action_th, "action_th"), dialogue_th: typeof s?.dialogue_th === "string" ? s.dialogue_th.trim() : "", prompt_en: str(s?.prompt_en, "prompt_en"), doneDate: null };
}
function vEpisode(d) {
  const shots = arr(d?.shots, "shots");
  if (shots.length < SHOTS) throw new Error(`คำตอบมีแค่ ${shots.length} ช็อต ต้องมี ${SHOTS} ช็อต`);
  const backup = d.backup_shot ?? shots[SHOTS];
  if (!backup) throw new Error("ไม่มีช็อตสำรอง (backup_shot)");
  return {
    title: str(d.title, "title"), summary_th: str(d.summary_th, "summary_th"),
    shots: [...shots.slice(0, SHOTS).map((s, i) => vShot(s, i + 1, false)), vShot(backup, SHOTS + 1, true)],
    resolved_threads: Array.isArray(d.resolved_threads) ? d.resolved_threads.map(String) : [],
    new_threads: Array.isArray(d.new_threads) ? d.new_threads.map(String) : [],
  };
}
function vRewrite(d) { return { action_th: str(d?.action_th, "action_th"), dialogue_th: typeof d?.dialogue_th === "string" ? d.dialogue_th.trim() : "", prompt_en: str(d?.prompt_en, "prompt_en") }; }
function extractJSON(text) {
  const t = String(text || "").trim();
  if (!t) throw new Error("ยังไม่ได้วางคำตอบ");
  const tries = [t];
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) tries.push(fence[1]);
  const a = t.indexOf("{"), z = t.lastIndexOf("}");
  if (a >= 0 && z > a) tries.push(t.slice(a, z + 1));
  for (const s of tries) { try { return JSON.parse(s); } catch { /* next */ } }
  throw new Error("อ่านคำตอบไม่ได้ ให้ก๊อปคำตอบของ Gemini มาทั้งหมด หรือกดให้ Gemini ตอบใหม่เป็น JSON อย่างเดียว");
}

// ---------- prompts ----------
const BIBLE_SHAPE = `{"title":"ชื่อเรื่อง","world":"โลกและกติกาของเรื่อง","tone":"โทนเรื่อง","style_lock_en":"fixed visual style in English","characters":[{"name":"ชื่อ","role":"บทบาท","personality":"บุคลิก","goal":"เป้าหมาย","look_en":"fixed appearance in English"}],"open_threads":["ปมที่ค้าง"]}`;
const SHOT_SHAPE = `{"number":1,"action_th":"สิ่งที่เกิดขึ้นในช็อต","dialogue_th":"บทพูดสั้นๆ หรือว่าง","prompt_en":"camera, action, light, audio in English"}`;
const EP_SHAPE = `{"title":"ชื่อตอน","summary_th":"สรุปตอน 2-3 ประโยค","shots":[${SHOT_SHAPE}, ... รวม ${SHOTS} ช็อต],"backup_shot":{"number":${SHOTS + 1},"action_th":"...","dialogue_th":"","prompt_en":"..."},"resolved_threads":["ข้อความปมเดิมที่คลายแล้ว"],"new_threads":["ปมใหม่"]}`;
function promptBible(idea) {
  return `คุณคือผู้เขียนบทซีรีส์สั้นแนวตั้ง ตอนละ 1 นาที สร้าง Series Bible จากไอเดีย: ${idea}

กติกา:
- title, world, tone, personality, goal เป็นภาษาไทย
- ตัวละคร 2-4 ตัว แต่ละตัวมีเป้าหมายและจุดอ่อนชัดเจน
- look_en และ style_lock_en เป็นภาษาอังกฤษ บอกหน้าตา เสื้อผ้า สี และสไตล์ภาพให้คงที่ทุกตอน
- open_threads: ปมใหญ่ 3-4 ข้อที่จะค่อยๆ คลายตลอดซีรีส์

ตอบเป็น JSON อย่างเดียว ไม่ต้องมีคำอธิบายอื่น ตามรูปแบบนี้:
${BIBLE_SHAPE}`;
}
function promptEpisode() {
  const b = S.series.bible, n = S.episodes.length + 1;
  const recap = S.episodes.slice(-MEMORY).map((e) => `ตอน ${e.number}: ${e.summary_th}`).join("\n") || "(ยังไม่มีตอนก่อนหน้า)";
  return `คุณคือผู้เขียนบทซีรีส์สั้นแนวตั้ง เขียนบทตอนที่ ${n}

Series Bible:
${JSON.stringify(b)}

สรุปตอนก่อนหน้า:
${recap}

ปมที่ยังค้าง: ${JSON.stringify(b.open_threads)}

กติกา:
- แบ่งเป็น ${SHOTS} ช็อต ช็อตละ ${SHOT_SEC} วินาที (number 1-${SHOTS}) และ backup_shot 1 ช็อต (number ${SHOTS + 1}) เป็นมุมสำรองของช็อตที่ภาพซับซ้อนที่สุด
- 1 ช็อตมี 1 การกระทำหลัก บทพูดไม่เกิน 1 ประโยคสั้น
- ต่อจากตอนก่อนหน้าโดยตรง ห้ามขัดกับเหตุการณ์เดิม คลายปมเก่าอย่างน้อย 1 ข้อ และเปิดปมใหม่ 1 ข้อ
- ช็อตสุดท้ายต้องเป็น cliffhanger
- prompt_en เป็นภาษาอังกฤษ ระบุมุมกล้อง การกระทำ แสง เสียงประกอบ ใช้ชื่อตัวละครเท่านั้น ห้ามบรรยายหน้าตา (ระบบจะเติมให้เอง) ห้ามมีตัวหนังสือบนภาพ
- resolved_threads ต้องตรงกับข้อความใน open_threads เดิมทุกตัวอักษร

ตอบเป็น JSON อย่างเดียว ไม่ต้องมีคำอธิบายอื่น ตามรูปแบบนี้:
${EP_SHAPE}`;
}
function promptRewrite(ep, shot, note) {
  return `ปรับ prompt วิดีโอของช็อตนี้ตามหมายเหตุ โดยคงเนื้อเรื่องเดิมไว้

Series Bible: ${JSON.stringify(S.series.bible)}
ช็อตเดิม: ${JSON.stringify({ number: shot.number, action_th: shot.action_th, dialogue_th: shot.dialogue_th, prompt_en: shot.prompt_en })}
หมายเหตุจากผู้ใช้ (เช่น ภาพเพี้ยน ตัวละครผิด): ${note || "ทำให้ภาพเรียบง่ายขึ้น"}

กติกา: prompt_en ภาษาอังกฤษ ใช้ชื่อตัวละครเท่านั้น ห้ามบรรยายหน้าตา ห้ามมีตัวหนังสือบนภาพ ช็อตยาว ${SHOT_SEC} วินาที ทำให้ภาพเรียบง่ายขึ้นเพื่อให้โมเดลวิดีโอสร้างได้แม่น

ตอบเป็น JSON อย่างเดียว ไม่ต้องมีคำอธิบายอื่น ตามรูปแบบนี้:
${SHOT_SHAPE}`;
}

// ---------- AI task sheet ----------
function openTask(cfg) {
  const pref = lsGet(LS_ENGINE);
  T = { ...cfg, mode: settings.key && pref !== "paste" ? "auto" : "paste", busy: false, err: "", note: cfg.noteDefault || "", reply: "", ctl: null };
  $("#scrim").hidden = false;
  renderSheet();
  $("#sheet").focus();
}
function closeSheet() { if (T && T.ctl) T.ctl.abort(); T = null; $("#scrim").hidden = true; }
function renderSheet() {
  if (!T) return;
  const auto = T.mode === "auto";
  const noteBox = T.noteLabel ? `<label class="field" for="t-note">${esc(T.noteLabel)}<textarea id="t-note" style="min-height:64px">${esc(T.note)}</textarea></label>` : "";
  const seg = `<div class="seg" role="group" aria-label="เลือกวิธีเขียนบท">
    <button class="btn ${auto ? "on" : ""}" data-act="mode" data-mode="auto">Gemini อัตโนมัติ</button>
    <button class="btn ${auto ? "" : "on"}" data-act="mode" data-mode="paste">ก๊อปไปวางเอง</button></div>`;
  let body;
  if (auto) {
    body = !settings.key
      ? `<div class="banner">ยังไม่ได้ใส่ API key ไปที่แท็บตั้งค่าเพื่อใส่คีย์ฟรีจาก Google AI Studio</div><button class="btn full" data-act="goto-settings">ไปตั้งค่า</button>`
      : T.busy
        ? `<div class="soft">Gemini กำลังเขียน… ปกติใช้เวลา 5-30 วินาที</div><button class="btn full" data-act="stop">หยุด</button>`
        : `<button class="btn primary full" data-act="run-auto">ให้ Gemini เขียนเลย</button>`;
  } else {
    body = `<div class="muted small">ก๊อปคำสั่งไปวางในแอปหรือเว็บ Gemini (เลือกรุ่น Flash) แล้วนำคำตอบทั้งหมดกลับมาวางตรงนี้</div>
      <button class="btn full" data-act="copy-task">1. คัดลอกคำสั่ง</button>
      <label class="field" for="t-reply">2. วางคำตอบจาก Gemini<textarea id="t-reply" placeholder="วางที่นี่">${esc(T.reply)}</textarea></label>
      <button class="btn primary full" data-act="use-reply">3. ใช้คำตอบนี้</button>`;
  }
  $("#sheet").innerHTML = `<div class="row between"><h2 id="sheet-title">${esc(T.title)}</h2><button class="btn ghost" data-act="close-sheet">ปิด</button></div>
    ${T.desc ? `<div class="muted small">${esc(T.desc)}</div>` : ""}${noteBox}${seg}${body}${T.err ? `<div class="err" role="alert">${esc(T.err)}</div>` : ""}`;
}
function errCopy(e) {
  if (e && e.name === "AbortError") return "";
  if (e instanceof Error) return e.message;
  return "เกิดข้อผิดพลาด ลองใหม่อีกครั้ง";
}
async function finishTask(data) {
  const val = T.validate(data);
  await T.onDone(val);
  const msg = T.doneMsg;
  closeSheet();
  if (msg) toast(msg);
}
async function runAuto() {
  const cfg = T;
  cfg.busy = true; cfg.err = ""; cfg.ctl = new AbortController();
  renderSheet();
  try {
    const data = await geminiJSON(cfg.buildPrompt(cfg.note), cfg.ctl.signal);
    if (T === cfg) await finishTask(data);
  } catch (e) {
    if (T === cfg) cfg.err = errCopy(e);
  } finally {
    if (T === cfg) { cfg.busy = false; cfg.ctl = null; renderSheet(); }
  }
}
async function useReply() {
  try { T.err = ""; await finishTask(extractJSON(T.reply)); } catch (e) { if (T) { T.err = errCopy(e); renderSheet(); } }
}

// ---------- views ----------
function segs(used, limit) { return `<div class="segs" aria-hidden="true">${Array.from({ length: limit }, (_, i) => `<i class="${i < used ? "on" : ""}"></i>`).join("")}</div>`; }
function epChip(ep) {
  const c = doneCount(ep);
  if (c === SHOTS) return `<span class="chip ok">สร้างครบแล้ว</span>`;
  if (c === 0) return `<span class="chip">ยังไม่เริ่ม</span>`;
  return `<span class="chip wait">สร้างแล้ว ${c}/${SHOTS}</span>`;
}
function banner() { return memoryOnly ? `<div class="banner">เบราว์เซอร์นี้ไม่ยอมให้เก็บข้อมูล (อาจเป็นโหมดส่วนตัว) ข้อมูลจะหายเมื่อปิดหน้านี้</div>` : ""; }

function viewInit() {
  return `${banner()}<div class="col"><div class="muted small">เริ่มต้น</div><h1>สร้างซีรีส์ใหม่</h1></div>
  <div class="card"><label class="field" for="idea">ไอเดียของเรื่อง (แนว ตัวละคร โลกของเรื่อง)<textarea id="idea" placeholder="เช่น ร้านกาแฟที่ประตูหลังเปิดไปสู่มิติอื่นทุกคืนฝนตก"></textarea></label>
  <button class="btn primary full" data-act="init">สร้าง Series Bible</button></div>`;
}
function viewHome() {
  const b = S.series.bible, eps = S.episodes, cur = eps[eps.length - 1], used = quotaUsed(), limit = quotaLimit();
  const curCard = cur ? `<div class="card"><div class="muted small">ตอนล่าสุด</div><div style="font-size:19px;font-weight:600;line-height:1.35">ตอนที่ ${cur.number} · ${esc(cur.title)}</div>
    <div class="col"><div class="row between soft small"><span>ช็อตที่สร้างใน Flow แล้ว</span><span class="mono">${doneCount(cur)} / ${SHOTS}</span></div><div class="bar"><span style="width:${(doneCount(cur) / SHOTS) * 100}%"></span></div></div>
    <button class="btn full" data-act="open-ep" data-n="${cur.number}">เปิดบอร์ดช็อต</button></div>` : "";
  const list = eps.length ? `<div class="list"><h2>ตอนทั้งหมด</h2>${[...eps].reverse().map((e) => `<button class="item" data-act="open-ep" data-n="${e.number}"><span class="no mono">${pad(e.number)}</span><span class="nm">${esc(e.title)}</span>${epChip(e)}</button>`).join("")}</div>` : "";
  return `${banner()}<div class="col"><div class="muted small">ภาพรวมวันนี้</div><h1>${esc(b.title)}</h1></div>
  <button class="btn primary full" data-act="next">สร้างบทตอนใหม่</button>
  <div class="card"><div class="muted small">คลิป Flow ที่สร้างวันนี้</div>
    <div class="row" style="gap:8px;align-items:baseline"><span class="big mono">${used} / ${limit}</span><span class="soft">คลิป (${SHOT_SEC} วินาที)</span></div>${segs(used, limit)}
    <div class="row"><button class="btn ghost" data-act="adj" data-d="1">นับเพิ่ม 1 (สร้างซ้ำ)</button><button class="btn ghost" data-act="adj" data-d="-1">ลด 1</button></div>
    <div class="muted small">นับจากช็อตที่คุณกดว่าสร้างแล้ว รีเซ็ตทุกวัน</div></div>
  ${curCard}
  <div class="card"><div class="muted small">ปมที่ยังค้างอยู่</div><div class="row" style="gap:8px;align-items:baseline"><span class="big mono">${b.open_threads.length}</span><span class="soft">ข้อ</span></div>
    <div class="muted small">ตอนถัดไปจะอ้างปมเหล่านี้โดยอัตโนมัติ</div></div>
  ${list}`;
}
function shotCard(ep, s) {
  const label = s.backup ? "ช็อตสำรอง" : `ช็อต ${s.number}`;
  const chip = s.doneDate ? `<span class="chip ok">สร้างแล้ว</span>` : s.backup ? `<span class="chip">สำรอง</span>` : `<span class="chip">ยังไม่สร้าง</span>`;
  return `<div class="card ${s.backup ? "dashed" : ""}">
    <div class="row between"><div style="font-weight:600;font-size:16px">${label} <span class="mono small muted">${SHOT_SEC} วินาที</span></div>${chip}</div>
    <div class="shot-act">${esc(s.action_th)}${s.dialogue_th ? `<br><span class="muted">บทพูด:</span> ${esc(s.dialogue_th)}` : ""}</div>
    <div class="promptbox">${esc(flowPrompt(s))}</div>
    ${s.backup ? `<div class="muted small">เก็บไว้สร้างเมื่อมีช็อตไหนเพี้ยน</div>` : ""}
    <button class="btn primary full" data-act="copy" data-n="${ep.number}" data-s="${s.number}">คัดลอก prompt</button>
    <div class="row"><button class="btn" style="flex:1" data-act="done" data-n="${ep.number}" data-s="${s.number}">${s.doneDate ? "ยกเลิกสร้างแล้ว" : "สร้างใน Flow แล้ว"}</button>
    <button class="btn ghost" style="flex:1" data-act="rewrite" data-n="${ep.number}" data-s="${s.number}">ปรับ prompt</button></div></div>`;
}
function viewEpisode() {
  if (!S.episodes.length) return `${banner()}<div class="empty">ยังไม่มีตอน ไปที่ภาพรวมแล้วกด "สร้างบทตอนใหม่"</div>`;
  const ep = S.episodes.find((e) => e.number === S.epNo) || S.episodes[S.episodes.length - 1];
  S.epNo = ep.number;
  return `${banner()}<div class="pills" role="tablist" aria-label="เลือกตอน">${S.episodes.map((e) => `<button class="pill ${e.number === ep.number ? "on" : ""}" data-act="open-ep" data-n="${e.number}">ตอน ${e.number}</button>`).join("")}</div>
  <div class="col"><div class="muted small">ตอนที่ ${ep.number}</div><h1>${esc(ep.title)}</h1></div>
  <div class="card"><div class="muted small">สรุปบทตอนนี้</div><div class="soft">${esc(ep.summary_th)}</div></div>
  <div class="card"><div class="muted small">สไตล์ที่ล็อกไว้ (ใส่หน้าทุก prompt อัตโนมัติ)</div><div class="promptbox">${esc(S.series.bible.style_lock_en)}</div></div>
  <div class="row between"><span class="soft">โควตาวันนี้ ${quotaUsed()} จาก ${quotaLimit()}</span></div>${segs(quotaUsed(), quotaLimit())}
  ${ep.shots.map((s) => shotCard(ep, s)).join("")}`;
}
function viewBible() {
  const b = S.series.bible;
  const chars = b.characters.map((c, i) => `<div class="char" data-char="${i}">
    <label class="field">ชื่อ<input type="text" data-f="name" value="${esc(c.name)}"></label>
    <label class="field">บทบาท<input type="text" data-f="role" value="${esc(c.role)}"></label>
    <label class="field">บุคลิก<textarea data-f="personality" style="min-height:60px">${esc(c.personality)}</textarea></label>
    <label class="field">เป้าหมาย<textarea data-f="goal" style="min-height:60px">${esc(c.goal)}</textarea></label>
    <label class="field">หน้าตา (ภาษาอังกฤษ ใช้ล็อกทุก prompt)<textarea data-f="look_en" style="min-height:60px">${esc(c.look_en)}</textarea></label></div>`).join("");
  const confirm = S.confirmNew ? `<div class="card live"><div>ลบซีรีส์นี้และทุกตอนถาวร ควรดาวน์โหลดไฟล์สำรองที่แท็บตั้งค่าก่อน</div>
    <div class="row"><button class="btn danger" data-act="wipe">ยืนยัน ลบทั้งหมด</button><button class="btn ghost" data-act="cancel-new">ยกเลิก</button></div></div>`
    : `<button class="btn ghost full" data-act="new-series">เริ่มซีรีส์ใหม่</button>`;
  return `${banner()}<div class="col"><div class="muted small">ความจำของเรื่อง</div><h1>Series Bible</h1></div>
  <button class="btn primary full" data-act="save-bible">บันทึกการแก้ไข</button>
  <div class="card"><label class="field">ชื่อเรื่อง<input type="text" id="b-title" value="${esc(b.title)}"></label>
    <label class="field">โลกของเรื่อง<textarea id="b-world">${esc(b.world)}</textarea></label>
    <label class="field">โทนเรื่อง<input type="text" id="b-tone" value="${esc(b.tone)}"></label>
    <label class="field">สไตล์ภาพที่ล็อกไว้ (ภาษาอังกฤษ)<textarea id="b-style">${esc(b.style_lock_en)}</textarea></label>
    <label class="field">โควตา Flow ต่อวัน (คลิป)<input type="number" id="b-quota" min="1" max="20" value="${quotaLimit()}"></label></div>
  <h2>ตัวละคร</h2>${chars}
  <div class="card"><label class="field">ปมที่ยังค้าง (หนึ่งข้อต่อหนึ่งบรรทัด)<textarea id="b-threads" style="min-height:120px">${esc(b.open_threads.join("\n"))}</textarea></label></div>
  ${confirm}`;
}

function viewSettings() {
  const imp = S.confirmImport
    ? `<div class="card live"><div>นำเข้าจะแทนที่ซีรีส์และทุกตอนในเครื่องนี้ ยืนยันหรือไม่</div><div class="row"><button class="btn danger" data-act="import-go">ยืนยัน นำเข้า</button><button class="btn ghost" data-act="import-cancel">ยกเลิก</button></div></div>`
    : `<button class="btn full" data-act="import-ask">นำเข้าข้อมูลสำรอง</button>`;
  return `${banner()}<div class="col"><div class="muted small">ตั้งค่า</div><h1>ตั้งค่า</h1></div>
  <div class="card"><h2>Gemini API</h2>
    <div class="muted small">ขอคีย์ฟรีที่ aistudio.google.com คีย์เก็บในเบราว์เซอร์เครื่องนี้ และส่งไปที่ Google เท่านั้น อย่าแชร์คีย์ให้ใคร ระดับฟรีของ Google อาจนำข้อความไปพัฒนาโมเดล จึงไม่ควรใส่ข้อมูลส่วนตัว</div>
    <label class="field" for="s-key">API key<input type="password" id="s-key" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(settings.key)}"></label>
    <label class="field" for="s-model">ชื่อรุ่น (Flash)<input type="text" id="s-model" autocapitalize="off" spellcheck="false" value="${esc(settings.model || DEFAULT_MODEL)}"></label>
    <div class="row"><button class="btn primary" data-act="save-settings">บันทึก</button><button class="btn" data-act="test-key">ทดสอบการเชื่อมต่อ</button></div>
    <div class="small" id="s-msg" role="status"></div></div>
  <div class="card"><h2>สำรองและย้ายข้อมูล</h2>
    <div class="muted small">ข้อมูลอยู่ในเบราว์เซอร์เครื่องนี้เท่านั้น ถ้าจะใช้อีกเครื่องหรือกันข้อมูลหาย ให้ดาวน์โหลดไฟล์สำรองแล้วนำเข้าที่อีกเครื่อง</div>
    <button class="btn full" data-act="export-download" ${S.series ? "" : "disabled"}>ดาวน์โหลดไฟล์สำรอง</button>
    <button class="btn full" data-act="export-copy" ${S.series ? "" : "disabled"}>คัดลอกข้อมูลสำรอง (JSON)</button>
    <label class="field" for="i-file">เลือกไฟล์สำรอง<input type="file" id="i-file" accept=".json,application/json"></label>
    <label class="field" for="i-text">หรือวางข้อมูลสำรอง<textarea id="i-text" placeholder="วาง JSON ที่นี่"></textarea></label>
    ${imp}</div>`;
}

function render() {
  if (!S.ready) return;
  const ae = document.activeElement;
  if ((S.view === "bible" || S.view === "settings") && ae && /^(INPUT|TEXTAREA)$/.test(ae.tagName) && $("#view").contains(ae)) return; // do not wipe a form being edited
  $("#sname").textContent = S.series ? S.series.bible.title : "";
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.dataset.view === S.view));
  const v = $("#view"), y = window.scrollY;
  v.innerHTML = S.view === "settings" ? viewSettings() : !S.series ? viewInit() : S.view === "episode" ? viewEpisode() : S.view === "bible" ? viewBible() : viewHome();
  window.scrollTo(0, y);
}
function go(view, n) { S.view = view; if (n) S.epNo = n; S.confirmNew = false; S.confirmImport = false; render(); window.scrollTo(0, 0); }

// ---------- actions ----------
let importBuffer = "";
function parseBackup(text) {
  let d;
  try { d = JSON.parse(text); } catch { throw new Error("ข้อมูลสำรองอ่านไม่ได้ (ไม่ใช่ JSON)"); }
  if (!d || !d.series || !d.series.bible || !Array.isArray(d.series.bible.characters) || !Array.isArray(d.episodes)) throw new Error("ไฟล์นี้ไม่ใช่ข้อมูลสำรองของ AutoSeries");
  for (const ep of d.episodes) if (!ep || !Array.isArray(ep.shots) || typeof ep.number !== "number") throw new Error("ข้อมูลตอนในไฟล์ไม่ครบ");
  return { series: d.series, episodes: d.episodes };
}
document.addEventListener("change", (e) => {
  if (e.target.id !== "i-file" || !e.target.files.length) return;
  const r = new FileReader();
  r.onload = () => { importBuffer = String(r.result || ""); toast("อ่านไฟล์แล้ว กด นำเข้าข้อมูลสำรอง"); };
  r.onerror = () => toast("อ่านไฟล์ไม่สำเร็จ", true);
  r.readAsText(e.target.files[0]);
});
document.addEventListener("input", (e) => {
  if (!T) return;
  if (e.target.id === "t-note") T.note = e.target.value;
  if (e.target.id === "t-reply") T.reply = e.target.value;
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && T) closeSheet(); });

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const act = el.dataset.act, n = Number(el.dataset.n), sn = Number(el.dataset.s);
  const epOf = (num) => S.episodes.find((x) => x.number === num);

  if (act === "tab") { if (!S.series && el.dataset.view !== "home" && el.dataset.view !== "settings") return toast("สร้างซีรีส์ก่อน"); go(el.dataset.view); }
  else if (act === "open-ep") go("episode", n);
  else if (act === "init") {
    const idea = $("#idea").value.trim();
    if (!idea) return toast("กรุณาใส่ไอเดียของเรื่อง", true);
    openTask({ title: "สร้าง Series Bible", desc: "ได้ชื่อเรื่อง โลก ตัวละคร และปมใหญ่ของซีรีส์ แก้ไขต่อได้ที่หน้า Series Bible", buildPrompt: () => promptBible(idea), validate: vBible, doneMsg: "สร้าง Series Bible แล้ว",
      onDone: async (bible) => { S.series = { bible, settings: { dailyQuota: 7 }, adj: { date: "", n: 0 }, createdAt: new Date().toISOString() }; S.episodes = []; S.view = "bible"; render(); await guarded(putSeries); } });
  }
  else if (act === "next") {
    openTask({ title: `เขียนบทตอนที่ ${S.episodes.length + 1}`, desc: `ได้บท ${SHOTS} ช็อต (ช็อตละ ${SHOT_SEC} วินาที) พร้อม prompt สำหรับ Flow และช็อตสำรอง 1 ช็อต`, buildPrompt: promptEpisode, validate: vEpisode, doneMsg: "เขียนบทตอนใหม่แล้ว",
      onDone: async (v) => {
        const b = S.series.bible, number = S.episodes.length + 1;
        b.open_threads = b.open_threads.filter((t) => !v.resolved_threads.includes(t)).concat(v.new_threads);
        const ep = { number, title: v.title, summary_th: v.summary_th, createdAt: new Date().toISOString(), shots: v.shots };
        S.episodes.push(ep); S.epNo = number; S.view = "episode"; render(); window.scrollTo(0, 0);
        await guarded(async () => { await putSeries(); await putEpisode(ep); });
      } });
  }
  else if (act === "copy") {
    const s = epOf(n)?.shots.find((x) => x.number === sn);
    if (s) toast((await copyText(flowPrompt(s))) ? "คัดลอก prompt แล้ว นำไปวางใน Flow ได้เลย" : "คัดลอกอัตโนมัติไม่ได้ กดค้างที่ข้อความแล้วเลือกคัดลอก", false);
  }
  else if (act === "done") {
    const ep = epOf(n), s = ep?.shots.find((x) => x.number === sn);
    if (!s) return;
    s.doneDate = s.doneDate ? null : today(); render();
    await guarded(() => putEpisode(ep));
  }
  else if (act === "rewrite") {
    const ep = epOf(n), s = ep?.shots.find((x) => x.number === sn);
    if (!s) return;
    openTask({ title: `ปรับ prompt ช็อต ${s.backup ? "สำรอง" : s.number}`, desc: "บอกว่าช็อตนี้มีปัญหาอะไร แล้วให้ AI เขียน prompt ใหม่ที่สร้างได้แม่นขึ้น", noteLabel: "ปัญหาที่เจอ", noteDefault: "ทำให้ภาพเรียบง่ายขึ้น",
      buildPrompt: (note) => promptRewrite(ep, s, note), validate: vRewrite, doneMsg: "ปรับ prompt แล้ว",
      onDone: async (v) => {
        const t = today(), spentToday = s.doneDate === t;   // a regenerated clip spends quota again
        Object.assign(s, v, { doneDate: null });
        if (spentToday) { const cur = S.series.adj && S.series.adj.date === t ? Number(S.series.adj.n) || 0 : 0; S.series.adj = { date: t, n: cur + 1 }; }
        render();
        await guarded(async () => { await putEpisode(ep); if (spentToday) await putSeries(); });
      } });
  }
  else if (act === "adj") {
    const t = today(), cur = S.series.adj && S.series.adj.date === t ? Number(S.series.adj.n) || 0 : 0;
    S.series.adj = { date: t, n: cur + Number(el.dataset.d) }; render();
    await guarded(putSeries);
  }
  else if (act === "save-bible") {
    const b = S.series.bible;
    const chars = [...document.querySelectorAll(".char")].map((c) => { const o = {}; c.querySelectorAll("[data-f]").forEach((f) => (o[f.dataset.f] = f.value.trim())); return o; }).filter((c) => c.name);
    if (!chars.length) return toast("ต้องมีตัวละครอย่างน้อย 1 ตัว", true);
    Object.assign(b, { title: $("#b-title").value.trim() || b.title, world: $("#b-world").value.trim(), tone: $("#b-tone").value.trim(), style_lock_en: $("#b-style").value.trim(), characters: chars,
      open_threads: $("#b-threads").value.split("\n").map((t) => t.trim()).filter(Boolean) });
    S.series.settings = { ...(S.series.settings || {}), dailyQuota: Math.min(20, Math.max(1, Number($("#b-quota").value) || 7)) };
    document.activeElement.blur(); render();
    await guarded(async () => { await putSeries(); toast("บันทึกแล้ว"); });
  }
  else if (act === "new-series") { S.confirmNew = true; render(); }
  else if (act === "cancel-new") { S.confirmNew = false; render(); }
  else if (act === "wipe") {
    S.series = null; S.episodes = []; S.confirmNew = false; S.view = "home"; render();
    await guarded(async () => saveLocal());
  }

  else if (act === "save-settings") {
    settings = { key: $("#s-key").value.trim(), model: $("#s-model").value.trim() };
    lsSet(LS_SETTINGS, JSON.stringify(settings));
    toast("บันทึกการตั้งค่าแล้ว");
  }
  else if (act === "test-key") {
    const msg = $("#s-msg");
    settings = { key: $("#s-key").value.trim(), model: $("#s-model").value.trim() };
    lsSet(LS_SETTINGS, JSON.stringify(settings));
    if (!settings.key) { msg.textContent = "ใส่ API key ก่อน"; msg.style.color = "var(--bad)"; return; }
    msg.textContent = "กำลังทดสอบ…"; msg.style.color = "var(--muted)";
    try { await geminiJSON('ตอบ JSON เท่านั้น: {"ok": true}', undefined); msg.textContent = "เชื่อมต่อสำเร็จ ใช้เขียนบทได้แล้ว"; msg.style.color = "var(--ok)"; }
    catch (e) { msg.textContent = errCopy(e); msg.style.color = "var(--bad)"; }
  }
  else if (act === "export-download") {
    const blob = new Blob([JSON.stringify({ series: S.series, episodes: S.episodes }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `autoseries-backup-${today()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  else if (act === "export-copy") toast((await copyText(JSON.stringify({ series: S.series, episodes: S.episodes }, null, 2))) ? "คัดลอกข้อมูลสำรองแล้ว" : "คัดลอกไม่สำเร็จ", false);
  else if (act === "import-ask") {
    const text = $("#i-text").value.trim();
    if (!text && !importBuffer) return toast("เลือกไฟล์หรือวางข้อมูลสำรองก่อน", true);
    if (text) importBuffer = text;
    try { parseBackup(importBuffer); } catch (err) { importBuffer = ""; return toast(err.message, true); }
    S.confirmImport = true; render();
  }
  else if (act === "import-cancel") { S.confirmImport = false; importBuffer = ""; render(); }
  else if (act === "import-go") {
    try { const d = parseBackup(importBuffer); S.series = d.series; S.episodes = d.episodes; S.confirmImport = false; importBuffer = ""; S.view = "home"; saveLocal(); render(); toast("นำเข้าข้อมูลแล้ว"); }
    catch (err) { toast(err.message, true); }
  }
  // sheet controls
  else if (act === "close-sheet") closeSheet();
  else if (act === "mode") { if (T) { T.mode = el.dataset.mode; lsSet(LS_ENGINE, T.mode); T.err = ""; renderSheet(); } }
  else if (act === "run-auto") runAuto();
  else if (act === "goto-settings") { closeSheet(); go("settings"); }
  else if (act === "stop") { if (T && T.ctl) T.ctl.abort(); }
  else if (act === "copy-task") { if (T) toast((await copyText(T.buildPrompt(T.note))) ? "คัดลอกคำสั่งแล้ว ไปวางในแอป Gemini ได้เลย" : "คัดลอกไม่สำเร็จ", false); }
  else if (act === "use-reply") useReply();
});

boot();
