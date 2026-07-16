/**
 * タスク管理アプリ  Google Apps Script バックエンド
 * -------------------------------------------------
 * Googleスプレッドシートを DB として、フロントエンド(SPA)と中継する Web API。
 *
 * 【セットアップ】
 *  1. タスクを保存したい Google スプレッドシートを開く
 *  2. 拡張機能 → Apps Script を開き、このコードを貼り付ける
 *  3. 下の SHARED_TOKEN を推測されにくい文字列に変更する
 *     （フロント側 config.js の TOKEN と同じ値にする）
 *  4. 「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
 *       - 実行するユーザー: 自分
 *       - アクセスできるユーザー: 全員
 *  5. 発行された /exec の URL をフロントの config.js に設定する
 *
 * シートは初回アクセス時に "Tasks" / "Recurring" シートとヘッダーを自動生成します。
 *
 * 【定期タスク（毎月/毎年 自動追加）を有効にするには】
 *  コードを貼り直したあと、エディタ上部の関数選択で「setupTriggers」を選び
 *  「実行」を1回押してください。毎日1回、期日になった定期タスクを
 *  自動でタスク一覧へ追加するトリガーが設定されます。
 */

// ===== 設定 =====
var SHEET_NAME = 'Tasks';
var RECUR_SHEET = 'Recurring';
var ARCHIVE_SHEET = 'Archive';
var MEMO_SHEET = 'Memo';
var ASSIGNEE_SHEET = 'Assignees';
var TIMEZONE = 'Asia/Tokyo';
var DEFAULT_PRIORITY = 'p1';
// 簡易アクセストークン（フロントの config.js の TOKEN と一致させる）
var SHARED_TOKEN = 'jaoagpagauzify7aouw';

// 列定義（この順序でシートに保存される）
var COLUMNS = ['id', 'title', 'priority', 'status', 'assignees', 'lineMemo', 'createdAt', 'doneAt', 'updatedAt'];
var RECUR_COLUMNS = ['id', 'title', 'priority', 'assignees', 'freq', 'month', 'day', 'nextDue', 'active', 'createdAt'];
var ARCHIVE_COLUMNS = ['id', 'text', 'priority', 'assignees', 'createdAt', 'repeat', 'lastFired'];
var MEMO_COLUMNS = ['id', 'text', 'createdAt', 'updatedAt'];
var ASSIGNEE_COLUMNS = ['name'];

// ===== エントリポイント =====
function doGet(e) {
  return handle_(e, (e && e.parameter) || {});
}

function doPost(e) {
  var params = {};
  try {
    if (e && e.postData && e.postData.contents) {
      params = JSON.parse(e.postData.contents);
    }
  } catch (err) {
    return json_({ ok: false, error: 'invalid JSON body' });
  }
  return handle_(e, params);
}

function handle_(e, params) {
  try {
    // トークン検証
    if (String(params.token || '') !== String(SHARED_TOKEN)) {
      return json_({ ok: false, error: 'unauthorized' });
    }

    var action = params.action || 'list';
    var result;
    switch (action) {
      case 'list':            result = listAll_(); break;
      case 'add':             result = addTask_(params); break;
      case 'update':          result = updateTask_(params); break;
      case 'complete':        result = setStatus_(params.id, 'done'); break;
      case 'uncomplete':      result = setStatus_(params.id, 'open'); break;
      case 'delete':          result = deleteTask_(params.id); break;
      case 'addRecurring':    result = addRecurring_(params); break;
      case 'updateRecurring': result = updateRecurring_(params); break;
      case 'deleteRecurring': result = deleteRecurring_(params.id); break;
      case 'addArchive':      result = addArchive_(params); break;
      case 'updateArchive':   result = updateArchive_(params); break;
      case 'deleteArchive':   result = deleteArchive_(params.id); break;
      case 'addMemo':         result = addMemo_(params); break;
      case 'updateMemo':      result = updateMemo_(params); break;
      case 'deleteMemo':      result = deleteMemo_(params.id); break;
      case 'setAssignees':    result = setAssignees_(params); break;
      default:
        return json_({ ok: false, error: 'unknown action: ' + action });
    }
    return json_({ ok: true, data: result });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

// ===== 各アクション =====
function listAll_() {
  return {
    tasks: readRows_(getSheet_(), COLUMNS),
    recurring: readRows_(getRecurSheet_(), RECUR_COLUMNS),
    archive: readRows_(getArchiveSheet_(), ARCHIVE_COLUMNS),
    memos: readRows_(getMemoSheet_(), MEMO_COLUMNS),
    assignees: readAssignees_()
  };
}

function readRows_(sheet, cols) {
  var values = sheet.getDataRange().getValues();
  var rows = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (!row[0]) continue; // id が無い行はスキップ
    var obj = {};
    for (var c = 0; c < cols.length; c++) {
      var v = row[c];
      if (v instanceof Date) {
        // シートが日付型に自動変換したセルは yyyy/MM/dd HH:mm:ss 文字列へ整形
        obj[cols[c]] = Utilities.formatDate(v, TIMEZONE, 'yyyy/MM/dd HH:mm:ss');
      } else {
        obj[cols[c]] = v != null ? String(v) : '';
      }
    }
    rows.push(obj);
  }
  return rows;
}

function addTask_(params) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sheet = getSheet_();
    var now = now_();
    var task = {
      id: params.id || generateId_(),
      title: String(params.title || '').trim(),
      priority: params.priority || DEFAULT_PRIORITY,
      status: 'open',
      assignees: String(params.assignees || ''),
      lineMemo: String(params.lineMemo || ''),
      createdAt: now,
      doneAt: '',
      updatedAt: now
    };
    if (!task.title) throw new Error('title is required');
    sheet.appendRow(COLUMNS.map(function (c) { return task[c]; }));
    return { task: task };
  } finally {
    lock.releaseLock();
  }
}

function updateTask_(params) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var loc = findRow_(params.id);
    if (!loc) throw new Error('task not found: ' + params.id);
    var sheet = loc.sheet, rowIndex = loc.rowIndex, task = loc.task;

    // 更新可能なフィールドのみ反映
    ['title', 'priority', 'assignees', 'lineMemo', 'status'].forEach(function (key) {
      if (params[key] !== undefined) task[key] = String(params[key]);
    });
    // status を done/open に切り替えた場合は doneAt を整合させる
    if (params.status !== undefined) {
      task.doneAt = params.status === 'done' ? (task.doneAt || now_()) : '';
    }
    task.updatedAt = now_();

    writeRow_(sheet, rowIndex, task);
    return { task: task };
  } finally {
    lock.releaseLock();
  }
}

function setStatus_(id, status) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var loc = findRow_(id);
    if (!loc) throw new Error('task not found: ' + id);
    var sheet = loc.sheet, rowIndex = loc.rowIndex, task = loc.task;
    task.status = status;
    task.doneAt = status === 'done' ? now_() : '';
    task.updatedAt = now_();
    writeRow_(sheet, rowIndex, task);
    return { task: task };
  } finally {
    lock.releaseLock();
  }
}

function deleteTask_(id) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var loc = findRow_(id);
    if (!loc) throw new Error('task not found: ' + id);
    loc.sheet.deleteRow(loc.rowIndex);
    return { id: id };
  } finally {
    lock.releaseLock();
  }
}

// ===== 定期タスク（毎月 / 毎年） =====
function addRecurring_(params) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sheet = getRecurSheet_();
    var freq = params.freq === 'yearly' ? 'yearly' : 'monthly';
    var day = clampInt_(params.day, 1, 31);
    var month = freq === 'yearly' ? clampInt_(params.month, 1, 12) : '';
    var rec = {
      id: generateId_(),
      title: String(params.title || '').trim(),
      priority: params.priority || DEFAULT_PRIORITY,
      assignees: String(params.assignees || ''),
      freq: freq,
      month: month,
      day: day,
      nextDue: computeFirstDue_(freq, month, day),
      active: 'true',
      createdAt: now_()
    };
    if (!rec.title) throw new Error('title is required');
    sheet.appendRow(RECUR_COLUMNS.map(function (c) { return rec[c]; }));

    // 期日が本日以前ならその場でタスクを生成
    runRecurringCore_();
    return {
      recurring: readRows_(getRecurSheet_(), RECUR_COLUMNS),
      tasks: readRows_(getSheet_(), COLUMNS),
      archive: readRows_(getArchiveSheet_(), ARCHIVE_COLUMNS)
    };
  } finally {
    lock.releaseLock();
  }
}

function updateRecurring_(params) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sheet = getRecurSheet_();
    var last = sheet.getLastRow();
    var ids = sheet.getRange(1, 1, last, 1).getValues();
    for (var r = 1; r < ids.length; r++) {
      if (String(ids[r][0]) !== String(params.id)) continue;
      var rowIndex = r + 1;
      var vals = sheet.getRange(rowIndex, 1, 1, RECUR_COLUMNS.length).getValues()[0];
      var cur = {};
      for (var c = 0; c < RECUR_COLUMNS.length; c++) cur[RECUR_COLUMNS[c]] = vals[c] != null ? String(vals[c]) : '';

      var freq = (params.freq !== undefined ? params.freq : cur.freq) === 'yearly' ? 'yearly' : 'monthly';
      var day = clampInt_(params.day !== undefined ? params.day : cur.day, 1, 31);
      var month = freq === 'yearly' ? clampInt_(params.month !== undefined ? params.month : cur.month, 1, 12) : '';

      var rec = {
        id: cur.id,
        title: params.title !== undefined ? String(params.title).trim() : cur.title,
        priority: params.priority || cur.priority || DEFAULT_PRIORITY,
        assignees: params.assignees !== undefined ? String(params.assignees) : cur.assignees,
        freq: freq,
        month: month,
        day: day,
        nextDue: computeFirstDue_(freq, month, day),
        active: params.active !== undefined ? String(params.active) : (cur.active || 'true'),
        createdAt: cur.createdAt || now_()
      };
      if (!rec.title) throw new Error('title is required');

      sheet.getRange(rowIndex, 1, 1, RECUR_COLUMNS.length)
           .setValues([RECUR_COLUMNS.map(function (col) { return rec[col]; })]);
      runRecurringCore_();
      return {
        recurring: readRows_(getRecurSheet_(), RECUR_COLUMNS),
        tasks: readRows_(getSheet_(), COLUMNS),
        archive: readRows_(getArchiveSheet_(), ARCHIVE_COLUMNS)
      };
    }
    throw new Error('recurring not found: ' + params.id);
  } finally {
    lock.releaseLock();
  }
}

function deleteRecurring_(id) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sheet = getRecurSheet_();
    var ids = sheet.getRange(1, 1, sheet.getLastRow(), 1).getValues();
    for (var r = 1; r < ids.length; r++) {
      if (String(ids[r][0]) === String(id)) { sheet.deleteRow(r + 1); return { id: id }; }
    }
    throw new Error('recurring not found: ' + id);
  } finally {
    lock.releaseLock();
  }
}

// ===== 保管（アーカイブ / 記録） =====
function addArchive_(params) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sheet = getArchiveSheet_();
    var repeat = (params.repeat === 'monthly' || params.repeat === 'yearly') ? params.repeat : 'none';
    var entry = {
      id: generateId_(),
      text: String(params.text || '').trim(),
      priority: params.priority || DEFAULT_PRIORITY,
      assignees: String(params.assignees || ''),
      createdAt: params.createdAt ? String(params.createdAt) : now_(),
      repeat: repeat,
      lastFired: ''
    };
    if (!entry.text) throw new Error('text is required');
    sheet.appendRow(ARCHIVE_COLUMNS.map(function (c) { return entry[c]; }));
    runArchiveReminders_(); // 記載日が本日(月日)なら即タスク化
    return {
      archive: readRows_(getArchiveSheet_(), ARCHIVE_COLUMNS),
      tasks: readRows_(getSheet_(), COLUMNS)
    };
  } finally {
    lock.releaseLock();
  }
}

function updateArchive_(params) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sheet = getArchiveSheet_();
    var last = sheet.getLastRow();
    var ids = sheet.getRange(1, 1, last, 1).getValues();
    for (var r = 1; r < ids.length; r++) {
      if (String(ids[r][0]) === String(params.id)) {
        var rowIndex = r + 1;
        var vals = sheet.getRange(rowIndex, 1, 1, ARCHIVE_COLUMNS.length).getValues()[0];
        var entry = {};
        for (var c = 0; c < ARCHIVE_COLUMNS.length; c++) {
          entry[ARCHIVE_COLUMNS[c]] = vals[c] != null ? String(vals[c]) : '';
        }
        ['text', 'priority', 'assignees', 'createdAt'].forEach(function (k) {
          if (params[k] !== undefined) entry[k] = String(params[k]);
        });
        if (params.repeat !== undefined) {
          entry.repeat = (params.repeat === 'monthly' || params.repeat === 'yearly') ? params.repeat : 'none';
        }
        // 日付や繰り返し設定を変えたら、発火状態をリセット
        if (params.createdAt !== undefined || params.repeat !== undefined) entry.lastFired = '';
        sheet.getRange(rowIndex, 1, 1, ARCHIVE_COLUMNS.length)
             .setValues([ARCHIVE_COLUMNS.map(function (col) { return entry[col]; })]);
        runArchiveReminders_();
        return {
          archive: readRows_(getArchiveSheet_(), ARCHIVE_COLUMNS),
          tasks: readRows_(getSheet_(), COLUMNS)
        };
      }
    }
    throw new Error('archive not found: ' + params.id);
  } finally {
    lock.releaseLock();
  }
}

function deleteArchive_(id) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sheet = getArchiveSheet_();
    var ids = sheet.getRange(1, 1, sheet.getLastRow(), 1).getValues();
    for (var r = 1; r < ids.length; r++) {
      if (String(ids[r][0]) === String(id)) { sheet.deleteRow(r + 1); return { id: id }; }
    }
    throw new Error('archive not found: ' + id);
  } finally {
    lock.releaseLock();
  }
}

// ===== メモ（自由記入のメモ帳） =====
function addMemo_(params) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sheet = getMemoSheet_();
    var now = now_();
    var memo = {
      id: generateId_(),
      text: String(params.text || '').trim(),
      createdAt: now,
      updatedAt: now
    };
    if (!memo.text) throw new Error('text is required');
    sheet.appendRow(MEMO_COLUMNS.map(function (c) { return memo[c]; }));
    return { memo: memo, memos: readRows_(getMemoSheet_(), MEMO_COLUMNS) };
  } finally {
    lock.releaseLock();
  }
}

function updateMemo_(params) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sheet = getMemoSheet_();
    var ids = sheet.getRange(1, 1, sheet.getLastRow(), 1).getValues();
    for (var r = 1; r < ids.length; r++) {
      if (String(ids[r][0]) !== String(params.id)) continue;
      var rowIndex = r + 1;
      var vals = sheet.getRange(rowIndex, 1, 1, MEMO_COLUMNS.length).getValues()[0];
      var memo = {};
      for (var c = 0; c < MEMO_COLUMNS.length; c++) memo[MEMO_COLUMNS[c]] = vals[c] != null ? String(vals[c]) : '';
      if (params.text !== undefined) memo.text = String(params.text);
      memo.updatedAt = now_();
      sheet.getRange(rowIndex, 1, 1, MEMO_COLUMNS.length)
           .setValues([MEMO_COLUMNS.map(function (col) { return memo[col]; })]);
      return { memo: memo, memos: readRows_(getMemoSheet_(), MEMO_COLUMNS) };
    }
    throw new Error('memo not found: ' + params.id);
  } finally {
    lock.releaseLock();
  }
}

function deleteMemo_(id) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sheet = getMemoSheet_();
    var ids = sheet.getRange(1, 1, sheet.getLastRow(), 1).getValues();
    for (var r = 1; r < ids.length; r++) {
      if (String(ids[r][0]) === String(id)) { sheet.deleteRow(r + 1); return { id: id }; }
    }
    throw new Error('memo not found: ' + id);
  } finally {
    lock.releaseLock();
  }
}

// ===== 確認先（確認対象者リスト・端末をまたいで共有） =====
function readAssignees_() {
  var sheet = getAssigneeSheet_();
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var vals = sheet.getRange(2, 1, last - 1, 1).getValues();
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    var n = vals[i][0];
    if (n != null && String(n).trim() !== '') out.push(String(n));
  }
  return out;
}

// 確認先リストをまるごと上書き保存（順序を保持・重複と空を除去）
function setAssignees_(params) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var names = params.names;
    if (!Array.isArray(names)) {
      try { names = JSON.parse(names); } catch (e) { names = []; }
    }
    if (!Array.isArray(names)) names = [];
    var clean = [];
    for (var i = 0; i < names.length; i++) {
      var n = String(names[i] == null ? '' : names[i]).trim();
      if (n && clean.indexOf(n) < 0) clean.push(n);
    }
    var sheet = getAssigneeSheet_();
    sheet.clearContents();
    sheet.getRange(1, 1).setValue('name');
    if (clean.length) {
      sheet.getRange(2, 1, clean.length, 1).setValues(clean.map(function (n) { return [n]; }));
    }
    sheet.setFrozenRows(1);
    return { assignees: clean };
  } finally {
    lock.releaseLock();
  }
}

// 毎日1回のトリガーから呼ばれるエントリポイント
function runRecurring() {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    runRecurringCore_();
    runArchiveReminders_();
  } finally {
    lock.releaseLock();
  }
}

// 保管の各記録を繰り返し設定に応じてタスク化する（保管データは消さない・同日に二重発火しない）
//   repeat = 'yearly'  … 毎年その月日にタスク化
//   repeat = 'monthly' … 毎月その日にタスク化
//   repeat = 'none'    … タスク化しない（保管のみ）
function runArchiveReminders_() {
  var sheet = getArchiveSheet_();
  var last = sheet.getLastRow();
  if (last < 2) return;
  var today = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy/MM/dd');
  var todayMMDD = today.slice(5);   // MM/dd
  var todayDD = today.slice(8);     // dd
  var values = sheet.getRange(2, 1, last - 1, ARCHIVE_COLUMNS.length).getValues();
  var idx = {};
  ARCHIVE_COLUMNS.forEach(function (c, i) { idx[c] = i; });

  for (var r = 0; r < values.length; r++) {
    var row = values[r];
    if (!row[idx.id]) continue;
    var repeat = String(row[idx.repeat] || 'none');
    if (repeat !== 'monthly' && repeat !== 'yearly') continue; // 保管のみ
    var created = String(row[idx.createdAt] || '');
    if (repeat === 'yearly') {
      if (created.slice(5, 10) !== todayMMDD) continue;  // 月日が今日でない
    } else { // monthly
      if (created.slice(8, 10) !== todayDD) continue;    // 日が今日でない
    }
    if (String(row[idx.lastFired] || '') === today) continue; // 本日は発火済み

    var now = now_();
    var task = {
      id: generateId_(), title: String(row[idx.text] || ''),
      priority: String(row[idx.priority] || '') || DEFAULT_PRIORITY,
      status: 'open', assignees: String(row[idx.assignees] || ''), lineMemo: '',
      createdAt: now, doneAt: '', updatedAt: now
    };
    if (!task.title) continue;
    getSheet_().appendRow(COLUMNS.map(function (c) { return task[c]; }));
    sheet.getRange(r + 2, idx.lastFired + 1).setValue(today); // 本日発火済みに
  }
}

// 期日を過ぎた定期タスクをタスク一覧へ追加し、次回期日を更新する（ロックは呼び出し側）
function runRecurringCore_() {
  var sheet = getRecurSheet_();
  var last = sheet.getLastRow();
  if (last < 2) return;
  var today = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy/MM/dd');
  var values = sheet.getRange(2, 1, last - 1, RECUR_COLUMNS.length).getValues();
  var idx = {};
  RECUR_COLUMNS.forEach(function (c, i) { idx[c] = i; });

  for (var r = 0; r < values.length; r++) {
    var row = values[r];
    if (!row[idx.id]) continue;
    if (String(row[idx.active]).toLowerCase() === 'false') continue;
    var nextDue = String(row[idx.nextDue]);
    if (!nextDue || nextDue > today) continue; // まだ期日前

    // タスクを1件生成
    createTaskFromRecur_({
      title: String(row[idx.title]),
      priority: String(row[idx.priority]) || DEFAULT_PRIORITY,
      assignees: String(row[idx.assignees])
    });

    // 次回期日を「今日より後」まで進める
    var freq = String(row[idx.freq]);
    var month = row[idx.month];
    var day = row[idx.day];
    var nd = nextDue;
    do { nd = advanceDue_(nd, freq, month, day); } while (nd <= today);
    sheet.getRange(r + 2, idx.nextDue + 1).setValue(nd);
  }
}

function createTaskFromRecur_(rec) {
  var now = now_();
  var task = {
    id: generateId_(), title: rec.title, priority: rec.priority || DEFAULT_PRIORITY,
    status: 'open', assignees: rec.assignees || '', lineMemo: '',
    createdAt: now, doneAt: '', updatedAt: now
  };
  getSheet_().appendRow(COLUMNS.map(function (c) { return task[c]; }));

  // 定期タスクの自動生成を保管（記録）にも反映
  var entry = {
    id: generateId_(), text: '【定期】' + rec.title, priority: rec.priority || DEFAULT_PRIORITY,
    assignees: rec.assignees || '', createdAt: now, repeat: 'none', lastFired: ''
  };
  getArchiveSheet_().appendRow(ARCHIVE_COLUMNS.map(function (c) { return entry[c]; }));
}

// 頻度・月・日から、本日以降の最初の期日（yyyy/MM/dd）を求める
function computeFirstDue_(freq, month, day) {
  var today = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy/MM/dd');
  var p = today.split('/');
  var ty = +p[0], tm = +p[1];
  day = clampInt_(day, 1, 31);
  if (freq === 'yearly') {
    month = clampInt_(month, 1, 12);
    var due = mkDate_(ty, month, day);
    if (due < today) due = mkDate_(ty + 1, month, day);
    return due;
  }
  var m = mkDate_(ty, tm, day);
  if (m < today) {
    var nm = tm + 1, ny = ty;
    if (nm > 12) { nm = 1; ny++; }
    m = mkDate_(ny, nm, day);
  }
  return m;
}

// 期日を1周期進める
function advanceDue_(dateStr, freq, month, day) {
  var p = dateStr.split('/');
  var y = +p[0], m = +p[1];
  if (freq === 'yearly') return mkDate_(y + 1, clampInt_(month, 1, 12), day);
  var nm = m + 1, ny = y;
  if (nm > 12) { nm = 1; ny++; }
  return mkDate_(ny, nm, day);
}

// y/m/d を実在日に丸めて yyyy/MM/dd 文字列に（月末超えはその月の末日へ）
function mkDate_(y, m, d) {
  var dim = new Date(y, m, 0).getDate(); // m は1始まり
  d = clampInt_(d, 1, dim);
  return y + '/' + pad2_(m) + '/' + pad2_(d);
}

function clampInt_(v, min, max) {
  v = parseInt(v, 10);
  if (isNaN(v)) v = min;
  return Math.max(min, Math.min(max, v));
}

function pad2_(n) { return ('0' + n).slice(-2); }

// 毎日1回のトリガーを設定（GASエディタから1回だけ手動実行する）
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runRecurring') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runRecurring').timeBased().everyDays(1).atHour(6).create();
}

// ===== ヘルパー =====
function getSheet_() {
  return ensureSheet_(SHEET_NAME, COLUMNS);
}

function getRecurSheet_() {
  return ensureSheet_(RECUR_SHEET, RECUR_COLUMNS);
}

function getArchiveSheet_() {
  return ensureSheet_(ARCHIVE_SHEET, ARCHIVE_COLUMNS);
}

function getMemoSheet_() {
  return ensureSheet_(MEMO_SHEET, MEMO_COLUMNS);
}

function getAssigneeSheet_() {
  return ensureSheet_(ASSIGNEE_SHEET, ASSIGNEE_COLUMNS);
}

function ensureSheet_(name, cols) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(cols);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function findRow_(id) {
  if (!id) return null;
  var sheet = getSheet_();
  var ids = sheet.getRange(1, 1, sheet.getLastRow(), 1).getValues();
  for (var r = 1; r < ids.length; r++) {
    if (String(ids[r][0]) === String(id)) {
      var rowIndex = r + 1; // 1-based
      var rowValues = sheet.getRange(rowIndex, 1, 1, COLUMNS.length).getValues()[0];
      var task = {};
      for (var c = 0; c < COLUMNS.length; c++) {
        task[COLUMNS[c]] = rowValues[c] != null ? String(rowValues[c]) : '';
      }
      return { sheet: sheet, rowIndex: rowIndex, task: task };
    }
  }
  return null;
}

function writeRow_(sheet, rowIndex, task) {
  sheet.getRange(rowIndex, 1, 1, COLUMNS.length)
       .setValues([COLUMNS.map(function (c) { return task[c]; })]);
}

function now_() {
  return Utilities.formatDate(new Date(), TIMEZONE, 'yyyy/MM/dd HH:mm:ss');
}

function generateId_() {
  return 't' + new Date().getTime().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
