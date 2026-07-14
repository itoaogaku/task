/**
 * /api/tasks  — タスク管理 API（Vercel サーバー関数）
 * フロントからのリクエストを受け、Notion データベースと中継する。
 */
'use strict';

var N = require('../lib/notion');

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }

  try {
    var params = req.method === 'GET' ? (req.query || {}) : await readBody(req);

    // 任意の簡易トークン（Vercel に APP_TOKEN を設定した場合のみ検証）
    if (process.env.APP_TOKEN && String(params.token || '') !== process.env.APP_TOKEN) {
      return send(res, { ok: false, error: 'unauthorized' });
    }
    if (!process.env.NOTION_TOKEN || !process.env.NOTION_DATABASE_ID) {
      return send(res, { ok: false, error: 'Notionの環境変数(NOTION_TOKEN / NOTION_DATABASE_ID)が未設定です。Vercelの設定を確認してください。' });
    }

    var action = params.action || 'list';
    var data = await N.handleAction(action, params);
    return send(res, { ok: true, data: data });
  } catch (e) {
    return send(res, { ok: false, error: String((e && e.message) || e) });
  }
};

function send(res, obj) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise(function (resolve) {
    if (req.body !== undefined && req.body !== null) {
      if (typeof req.body === 'string') {
        try { return resolve(JSON.parse(req.body || '{}')); } catch (e) { return resolve({}); }
      }
      return resolve(req.body);
    }
    var data = '';
    req.on('data', function (c) { data += c; });
    req.on('end', function () {
      try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); }
    });
    req.on('error', function () { resolve({}); });
  });
}
