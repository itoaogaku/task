/**
 * /api/cron  — 定期タスクの自動追加（Vercel Cron から毎日呼ばれる）
 * vercel.json の "crons" で 1 日 1 回スケジュールされる。
 * 手動で開いて実行することもできる（例: /api/cron）。
 */
'use strict';

var N = require('../lib/notion');

module.exports = async function (req, res) {
  // CRON_SECRET を設定している場合は Vercel Cron からの呼び出しのみ許可
  if (process.env.CRON_SECRET) {
    var auth = req.headers['authorization'] || '';
    if (auth !== 'Bearer ' + process.env.CRON_SECRET) {
      res.statusCode = 401; res.end('unauthorized'); return;
    }
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    if (!process.env.NOTION_TOKEN || !process.env.NOTION_DATABASE_ID) {
      res.statusCode = 200; res.end(JSON.stringify({ ok: false, error: 'env not set' })); return;
    }
    var created = await N.runRecurringCore();
    res.statusCode = 200; res.end(JSON.stringify({ ok: true, created: created }));
  } catch (e) {
    res.statusCode = 200; res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
  }
};
