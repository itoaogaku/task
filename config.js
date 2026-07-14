// ===== アプリ設定 =====
// GAS ウェブアプリのデプロイ URL（末尾が /exec のもの）に置き換えてください。
window.APP_CONFIG = {
  // 例: 'https://script.google.com/macros/s/AKfy...../exec'
  API_URL: 'https://script.google.com/macros/s/AKfycbxRtRA58uTIcqO8XKZZ6cF674kPoz57DePS5XPIEgqA1wBEJG5gacZFW-l1T8lGaUsb0g/exec',

  // GAS の Code.gs の SHARED_TOKEN と同じ値にしてください。
  TOKEN: 'jaoagpagauzify7aouw',

  // 確認対象者の初期プリセット（アプリの「確認先」タブで自由に追加・削除できます）。
  ASSIGNEE_PRESETS: ['上司', '先輩', 'チームA', 'チームB', '顧客', '自分'],

  // 優先度の定義（配列の上から順に優先度が高い＝並び順もこの順）。
  // key: 内部値 / label: 表示 / color: バッジ色
  PRIORITIES: [
    { key: 's',  label: 'S', color: '#ff3b30' },
    { key: 'p1', label: '1', color: '#ff9500' },
    { key: 'p2', label: '2', color: '#007aff' },
    { key: 'kan', label: '監', color: '#af52de' },
    { key: 'cho', label: '長', color: '#34c759' },
    { key: 'ie',  label: '家', color: '#5856d6' }
  ],

  // 新規タスクの初期優先度（key）。
  DEFAULT_PRIORITY: 'p1'
};
