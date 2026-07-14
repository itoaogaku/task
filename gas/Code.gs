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
 * シートは初回アクセス時に "Tasks" シートとヘッダーを自動生成します。
 */

// ===== 設定 =====
var SHEET_NAME = 'Tasks';
var TIMEZONE = 'Asia/Tokyo';
// 簡易アクセストークン（フロントの config.js と一致させる）
var SHARED_TOKEN = 'change-me-to-a-random-string';

// 列定義（この順序でシートに保存される）
var COLUMNS = ['id', 'title', 'priority', 'status', 'assignees', 'lineMemo', 'createdAt', 'doneAt', 'updatedAt'];

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
      case 'list':       result = listTasks_(); break;
      case 'add':        result = addTask_(params); break;
      case 'update':     result = updateTask_(params); break;
      case 'complete':   result = setStatus_(params.id, 'done'); break;
      case 'uncomplete': result = setStatus_(params.id, 'open'); break;
      case 'delete':     result = deleteTask_(params.id); break;
      default:
        return json_({ ok: false, error: 'unknown action: ' + action });
    }
    return json_({ ok: true, data: result });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

// ===== 各アクション =====
function listTasks_() {
  var sheet = getSheet_();
  var values = sheet.getDataRange().getValues();
  var tasks = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (!row[0]) continue; // id が無い行はスキップ
    var task = {};
    for (var c = 0; c < COLUMNS.length; c++) {
      task[COLUMNS[c]] = row[c] != null ? String(row[c]) : '';
    }
    tasks.push(task);
  }
  return { tasks: tasks };
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
      priority: params.priority || 'mid',
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

// ===== ヘルパー =====
function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  // ヘッダーが無ければ作成
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(COLUMNS);
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
  return Utilities.formatDate(new Date(), TIMEZONE, 'yyyy/MM/dd HH:mm');
}

function generateId_() {
  return 't' + new Date().getTime().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
