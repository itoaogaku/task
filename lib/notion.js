/**
 * Notion API 中継ロジック（Vercel サーバー関数から利用）
 * --------------------------------------------------------
 * フロントとの JSON プロトコルは Google スプレッドシート版と同一。
 * バックエンドの保存先だけ Notion データベースに置き換えている。
 *
 * 必要な環境変数（Vercel の Settings → Environment Variables で設定）:
 *   NOTION_TOKEN               … Notion インテグレーションのトークン
 *   NOTION_DATABASE_ID         … タスク用データベースの ID
 *   NOTION_RECUR_DATABASE_ID   … 定期タスク用データベースの ID（定期機能を使う場合）
 */

'use strict';

var NOTION_BASE = 'https://api.notion.com/v1';
var NOTION_VERSION = '2022-06-28';
var TZ = 'Asia/Tokyo';
var DEFAULT_PRIORITY = 'p1';

// --- Notion データベースのプロパティ名（DB 側の列名と一致させる）---
var PROP = { title: '名前', priority: '優先度', status: '状態', assignees: '確認対象者', lineMemo: 'LINEメモ', doneAt: '完了日時' };
var RPROP = { title: '名前', priority: '優先度', assignees: '確認対象者', freq: '頻度', month: '月', day: '日', nextDue: '次回期日', active: '有効' };

// --- 値のマッピング ---
var KEY_TO_LABEL = { s: 'S', p1: '1', p2: '2', p3: '3' };
var LABEL_TO_KEY = { 'S': 's', '1': 'p1', '2': 'p2', '3': 'p3' };
var ST_OPEN = '未完了', ST_DONE = '完了';
var FREQ_MONTHLY = '毎月', FREQ_YEARLY = '毎年';

function DB() { return process.env.NOTION_DATABASE_ID; }
function REC_DB() { return process.env.NOTION_RECUR_DATABASE_ID; }

// ================= Notion HTTP =================
async function notionFetch(path, method, body) {
  var r = await fetch(NOTION_BASE + path, {
    method: method || 'GET',
    headers: {
      'Authorization': 'Bearer ' + process.env.NOTION_TOKEN,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  var text = await r.text();
  var json = {};
  try { json = JSON.parse(text); } catch (e) { /* noop */ }
  if (!r.ok) throw new Error('Notion API ' + r.status + ': ' + (json.message || text.slice(0, 200)));
  return json;
}

async function queryAll(dbId) {
  var results = [], cursor;
  do {
    var body = cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 };
    var j = await notionFetch('/databases/' + dbId + '/query', 'POST', body);
    results = results.concat(j.results || []);
    cursor = j.has_more ? j.next_cursor : undefined;
  } while (cursor);
  return results;
}

function createPage(dbId, props) {
  return notionFetch('/pages', 'POST', { parent: { database_id: dbId }, properties: props });
}
function updatePage(id, props) {
  return notionFetch('/pages/' + id, 'PATCH', { properties: props });
}
function archivePage(id) {
  return notionFetch('/pages/' + id, 'PATCH', { archived: true });
}

// ================= プロパティ読み取り =================
function getTitle(pr, n) { var p = pr[n]; return p && p.title && p.title[0] ? p.title.map(function (t) { return t.plain_text; }).join('') : ''; }
function getSelect(pr, n) { var p = pr[n]; return p && p.select ? p.select.name : ''; }
function getMulti(pr, n) { var p = pr[n]; return p && p.multi_select ? p.multi_select.map(function (x) { return x.name; }) : []; }
function getRich(pr, n) { var p = pr[n]; return p && p.rich_text && p.rich_text[0] ? p.rich_text.map(function (t) { return t.plain_text; }).join('') : ''; }
function getNumber(pr, n) { var p = pr[n]; return p && p.number != null ? p.number : ''; }
function getDate(pr, n) { var p = pr[n]; return p && p.date && p.date.start ? p.date.start : ''; }
function getCheckbox(pr, n) { var p = pr[n]; return !!(p && p.checkbox); }

function pageToTask(page) {
  var pr = page.properties;
  return {
    id: page.id,
    title: getTitle(pr, PROP.title),
    priority: LABEL_TO_KEY[getSelect(pr, PROP.priority)] || DEFAULT_PRIORITY,
    status: getSelect(pr, PROP.status) === ST_DONE ? 'done' : 'open',
    assignees: getMulti(pr, PROP.assignees).join(' '),
    lineMemo: getRich(pr, PROP.lineMemo),
    createdAt: fmtJST(page.created_time),
    doneAt: fmtJST(getDate(pr, PROP.doneAt)),
    updatedAt: fmtJST(page.last_edited_time)
  };
}

function pageToRecur(page) {
  var pr = page.properties;
  return {
    id: page.id,
    title: getTitle(pr, RPROP.title),
    priority: LABEL_TO_KEY[getSelect(pr, RPROP.priority)] || DEFAULT_PRIORITY,
    assignees: getMulti(pr, RPROP.assignees).join(' '),
    freq: getSelect(pr, RPROP.freq) === FREQ_YEARLY ? 'yearly' : 'monthly',
    month: String(getNumber(pr, RPROP.month) || ''),
    day: String(getNumber(pr, RPROP.day) || ''),
    nextDue: fromNotionDate(getDate(pr, RPROP.nextDue)),
    active: getCheckbox(pr, RPROP.active) ? 'true' : 'false'
  };
}

// ================= プロパティ書き込み =================
function parseAssignees(str) { return str ? String(str).split(/\s+/).filter(Boolean) : []; }

function taskProps(fields) {
  var p = {};
  if (fields.title !== undefined) p[PROP.title] = { title: [{ text: { content: String(fields.title) } }] };
  if (fields.priority !== undefined) p[PROP.priority] = { select: fields.priority ? { name: KEY_TO_LABEL[fields.priority] || fields.priority } : null };
  if (fields.status !== undefined) p[PROP.status] = { select: { name: fields.status === 'done' ? ST_DONE : ST_OPEN } };
  if (fields.assignees !== undefined) p[PROP.assignees] = { multi_select: parseAssignees(fields.assignees).map(function (n) { return { name: n }; }) };
  if (fields.lineMemo !== undefined) p[PROP.lineMemo] = { rich_text: fields.lineMemo ? [{ text: { content: String(fields.lineMemo) } }] : [] };
  if (fields.doneAt !== undefined) p[PROP.doneAt] = { date: fields.doneAt ? { start: fields.doneAt } : null };
  return p;
}

// ================= 日付ユーティリティ（JST）=================
function fmtJST(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  var o = partsJST(d, true);
  return o.year + '/' + o.month + '/' + o.day + ' ' + o.hour + ':' + o.minute;
}
function todayJST() {
  var o = partsJST(new Date(), false);
  return o.year + '/' + o.month + '/' + o.day;
}
function partsJST(d, withTime) {
  var opt = { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' };
  if (withTime) { opt.hour = '2-digit'; opt.minute = '2-digit'; opt.hour12 = false; }
  var parts = new Intl.DateTimeFormat('en-GB', opt).formatToParts(d);
  var o = {};
  parts.forEach(function (p) { o[p.type] = p.value; });
  if (o.hour === '24') o.hour = '00';
  return o;
}
function pad2(n) { return ('0' + n).slice(-2); }
function clampInt(v, min, max) { v = parseInt(v, 10); if (isNaN(v)) v = min; return Math.max(min, Math.min(max, v)); }
function mkDate(y, m, d) { var dim = new Date(y, m, 0).getDate(); d = clampInt(d, 1, dim); return y + '/' + pad2(m) + '/' + pad2(d); }
function toNotionDate(s) { return s ? s.replace(/\//g, '-') : ''; }
function fromNotionDate(iso) { return iso ? iso.slice(0, 10).replace(/-/g, '/') : ''; }

function computeFirstDue(freq, month, day) {
  var today = todayJST();
  var p = today.split('/');
  var ty = +p[0], tm = +p[1];
  day = clampInt(day, 1, 31);
  if (freq === 'yearly') {
    month = clampInt(month, 1, 12);
    var due = mkDate(ty, month, day);
    if (due < today) due = mkDate(ty + 1, month, day);
    return due;
  }
  var m = mkDate(ty, tm, day);
  if (m < today) { var nm = tm + 1, ny = ty; if (nm > 12) { nm = 1; ny++; } m = mkDate(ny, nm, day); }
  return m;
}
function advanceDue(dateStr, freq, month, day) {
  var p = dateStr.split('/');
  var y = +p[0], m = +p[1];
  if (freq === 'yearly') return mkDate(y + 1, clampInt(month, 1, 12), day);
  var nm = m + 1, ny = y;
  if (nm > 12) { nm = 1; ny++; }
  return mkDate(ny, nm, day);
}

// ================= アクション =================
async function handleAction(action, p) {
  switch (action) {
    case 'list': return await listAll();
    case 'add': return await addTask(p);
    case 'update': return await updateTask(p);
    case 'complete': return await setStatus(p.id, 'done');
    case 'uncomplete': return await setStatus(p.id, 'open');
    case 'delete': return await delTask(p.id);
    case 'addRecurring': return await addRecurring(p);
    case 'deleteRecurring': return await delRecurring(p.id);
    default: throw new Error('unknown action: ' + action);
  }
}

async function listAll() {
  var tasks = (await queryAll(DB())).map(pageToTask);
  var recurring = REC_DB() ? (await queryAll(REC_DB())).map(pageToRecur) : [];
  return { tasks: tasks, recurring: recurring };
}

async function addTask(p) {
  var title = String(p.title || '').trim();
  if (!title) throw new Error('title is required');
  var page = await createPage(DB(), taskProps({
    title: title, priority: p.priority || DEFAULT_PRIORITY, status: 'open', assignees: p.assignees || ''
  }));
  return { task: pageToTask(page) };
}

async function updateTask(p) {
  var fields = {};
  ['title', 'priority', 'assignees', 'lineMemo', 'status'].forEach(function (k) {
    if (p[k] !== undefined) fields[k] = p[k];
  });
  if (p.status !== undefined) fields.doneAt = p.status === 'done' ? new Date().toISOString() : '';
  var page = await updatePage(p.id, taskProps(fields));
  return { task: pageToTask(page) };
}

async function setStatus(id, status) {
  var page = await updatePage(id, taskProps({
    status: status, doneAt: status === 'done' ? new Date().toISOString() : ''
  }));
  return { task: pageToTask(page) };
}

async function delTask(id) {
  await archivePage(id);
  return { id: id };
}

async function addRecurring(p) {
  if (!REC_DB()) throw new Error('定期タスク用のNotion DB(NOTION_RECUR_DATABASE_ID)が未設定です');
  var title = String(p.title || '').trim();
  if (!title) throw new Error('title is required');
  var freq = p.freq === 'yearly' ? 'yearly' : 'monthly';
  var day = clampInt(p.day, 1, 31);
  var month = freq === 'yearly' ? clampInt(p.month, 1, 12) : '';
  var nextDue = computeFirstDue(freq, month, day);

  var props = {};
  props[RPROP.title] = { title: [{ text: { content: title } }] };
  props[RPROP.priority] = { select: { name: KEY_TO_LABEL[p.priority || DEFAULT_PRIORITY] || '1' } };
  props[RPROP.assignees] = { multi_select: parseAssignees(p.assignees || '').map(function (n) { return { name: n }; }) };
  props[RPROP.freq] = { select: { name: freq === 'yearly' ? FREQ_YEARLY : FREQ_MONTHLY } };
  if (month !== '') props[RPROP.month] = { number: month };
  props[RPROP.day] = { number: day };
  props[RPROP.nextDue] = { date: { start: toNotionDate(nextDue) } };
  props[RPROP.active] = { checkbox: true };

  await createPage(REC_DB(), props);
  await runRecurringCore(); // 期日が本日以前なら即タスク生成

  var recurring = (await queryAll(REC_DB())).map(pageToRecur);
  var tasks = (await queryAll(DB())).map(pageToTask);
  return { recurring: recurring, tasks: tasks };
}

async function delRecurring(id) {
  await archivePage(id);
  return { id: id };
}

// 期日を過ぎた定期タスクをタスク一覧へ生成し、次回期日を更新（cron / 追加時に呼ばれる）
async function runRecurringCore() {
  if (!REC_DB()) return 0;
  var today = todayJST();
  var pages = await queryAll(REC_DB());
  var created = 0;
  for (var i = 0; i < pages.length; i++) {
    var page = pages[i];
    var r = pageToRecur(page);
    if (r.active === 'false') continue;
    if (!r.nextDue || r.nextDue > today) continue;

    await createPage(DB(), taskProps({
      title: r.title, priority: r.priority, status: 'open', assignees: r.assignees
    }));
    created++;

    var nd = r.nextDue;
    do { nd = advanceDue(nd, r.freq, r.month, r.day); } while (nd <= today);
    var upd = {};
    upd[RPROP.nextDue] = { date: { start: toNotionDate(nd) } };
    await updatePage(page.id, upd);
  }
  return created;
}

module.exports = { handleAction: handleAction, runRecurringCore: runRecurringCore };
