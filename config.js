// ===== アプリ設定 =====
window.APP_CONFIG = {
  // バックエンドは同一サイト上の Vercel サーバー関数（/api/tasks）。
  // Notion トークンはサーバー側の環境変数に保管され、ここには載りません。
  API_URL: '/api/tasks',

  // 任意の簡易トークン。Vercel の環境変数 APP_TOKEN を設定した場合のみ、
  // 同じ値をここに入れてください（未設定なら空のままで OK）。
  TOKEN: '',

  // 確認対象者のプリセット（@タグ）。自由に増減できます。
  ASSIGNEE_PRESETS: ['@上司', '@先輩', '@チームA', '@チームB', '@顧客', '@自分'],

  // 優先度の定義（配列の上から順に優先度が高い＝並び順もこの順）。
  // key: 内部値 / label: 表示 / color: バッジ色
  PRIORITIES: [
    { key: 's',  label: 'S', color: '#dc2626' },
    { key: 'p1', label: '1', color: '#f59e0b' },
    { key: 'p2', label: '2', color: '#3b82f6' },
    { key: 'p3', label: '3', color: '#64748b' }
  ],

  // 新規タスクの初期優先度（key）。
  DEFAULT_PRIORITY: 'p1'
};
