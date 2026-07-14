// ===== アプリ設定 =====
// GAS ウェブアプリのデプロイ URL（末尾が /exec のもの）に置き換えてください。
window.APP_CONFIG = {
  // 例: 'https://script.google.com/macros/s/AKfy...../exec'
  API_URL: 'https://script.google.com/macros/s/AKfycbxRtRA58uTIcqO8XKZZ6cF674kPoz57DePS5XPIEgqA1wBEJG5gacZFW-l1T8lGaUsb0g/exec',

  // GAS の Code.gs の SHARED_TOKEN と同じ値にしてください。
  TOKEN: 'jaoagpagauzify7aouw',

  // 確認対象者のプリセット（@タグ）。自由に増減できます。
  ASSIGNEE_PRESETS: ['@上司', '@先輩', '@チームA', '@チームB', '@顧客', '@自分'],

  // 優先度の定義（key と表示ラベル・色）。
  PRIORITIES: [
    { key: 'high', label: '急ぎ' },
    { key: 'mid',  label: '通常' },
    { key: 'low',  label: '低' }
  ]
};
