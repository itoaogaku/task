/* ===== タスク管理 SPA ロジック ===== */
(function () {
  'use strict';

  var CFG = window.APP_CONFIG || {};
  var PRIORITIES = CFG.PRIORITIES || [
    { key: 'l', label: 'L', color: '#34c759' },
    { key: 's', label: 'S', color: '#ff3b30' },
    { key: 'kan', label: '監', color: '#af52de' },
    { key: 'p1', label: '1', color: '#ff9500' },
    { key: 'p2', label: '2', color: '#007aff' },
    { key: 'cho', label: '長', color: '#30b0c7' },
    { key: 'ie', label: '家', color: '#5856d6' }
  ];
  var DEFAULT_PRIORITY = CFG.DEFAULT_PRIORITY || (PRIORITIES[0] && PRIORITIES[0].key) || 's';
  // 旧優先度キー → 新キーの読み替え（過去データ対応）
  var LEGACY_PRIORITY = { high: 's', mid: 'p2', low: 'ie', p3: 'ie' };
  var ASSIGNEE_STORE = 'assignee_options_v1';

  // ---- 状態 ----
  var state = {
    tasks: [],
    recurring: [],
    archive: [],
    view: 'open',                 // 'open' | 'done' | 'recurring' | 'settings' | 'archive'
    composerOpen: false,          // 入力ドックを開いているか（false=丸ボタンのみ）
    composerPriority: DEFAULT_PRIORITY,
    composerAssignees: [],        // 追加フォームで選択中の確認対象者
    assigneeOptions: loadAssignees()
  };

  // ---- DOM 参照 ----
  var $list = document.getElementById('taskList');
  var $empty = document.getElementById('emptyState');
  var $dock = document.getElementById('dock');
  var $composer = document.getElementById('composer');
  var $titleInput = document.getElementById('titleInput');
  var $prioBtn = document.getElementById('prioBtn');
  var $composerTags = document.getElementById('composerTags');
  var $archiveBtn = document.getElementById('archiveBtn');
  var $fab = document.getElementById('fab');
  var $composerBackdrop = document.getElementById('composerBackdrop');
  var $toast = document.getElementById('toast');

  // ================= 確認対象者リスト（端末に保存） =================
  function loadAssignees() {
    try {
      var s = localStorage.getItem(ASSIGNEE_STORE);
      if (s) { var a = JSON.parse(s); if (Array.isArray(a)) return a; }
    } catch (e) { /* noop */ }
    return (CFG.ASSIGNEE_PRESETS || []).slice();
  }
  function saveAssignees() {
    try { localStorage.setItem(ASSIGNEE_STORE, JSON.stringify(state.assigneeOptions)); } catch (e) { /* noop */ }
  }

  // ================= API =================
  function api(action, payload) {
    payload = payload || {};
    payload.action = action;
    payload.token = CFG.TOKEN;

    if (action === 'list') {
      var url = CFG.API_URL + '?action=list&token=' + encodeURIComponent(CFG.TOKEN);
      return fetch(url, { method: 'GET' }).then(parseRes);
    }
    return fetch(CFG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    }).then(parseRes);
  }

  function parseRes(res) {
    return res.text().then(function (t) {
      var data;
      try { data = JSON.parse(t); } catch (e) { throw new Error('サーバー応答が不正です'); }
      if (!data.ok) throw new Error(data.error || '不明なエラー');
      return data.data;
    });
  }

  // ================= ローディング / トースト =================
  var loadingCount = 0, $bar = null;
  function loading(on) {
    loadingCount += on ? 1 : -1;
    if (loadingCount < 0) loadingCount = 0;
    if (!$bar) {
      $bar = document.createElement('div');
      $bar.className = 'loading-bar';
      document.body.appendChild($bar);
    }
    $bar.style.width = loadingCount > 0 ? '80%' : '0';
    $bar.style.opacity = loadingCount > 0 ? '1' : '0';
  }

  var toastTimer;
  function toast(msg) {
    $toast.textContent = msg;
    $toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { $toast.hidden = true; }, 2200);
  }

  // 「取り消す」スナックバー
  var $undo = null, undoCurrentId = null;
  function showUndoBar(id, message, onUndo) {
    if (!$undo) {
      $undo = document.createElement('div');
      $undo.className = 'undo-bar';
      document.body.appendChild($undo);
    }
    undoCurrentId = id;
    $undo.innerHTML = '';
    var span = document.createElement('span');
    span.textContent = message;
    var btn = document.createElement('button');
    btn.className = 'undo-btn';
    btn.textContent = '取り消す';
    btn.addEventListener('click', function () { undoCurrentId = null; $undo.classList.remove('show'); onUndo(); });
    $undo.appendChild(span);
    $undo.appendChild(btn);
    $undo.classList.add('show');
  }
  function hideUndoBar(id) {
    if ($undo && (id === undefined || undoCurrentId === id)) {
      $undo.classList.remove('show');
      undoCurrentId = null;
    }
  }

  // ================= 優先度ユーティリティ =================
  function prioIndexOf(key) {
    for (var i = 0; i < PRIORITIES.length; i++) if (PRIORITIES[i].key === key) return i;
    return -1;
  }
  function prioMeta(key) {
    var idx = prioIndexOf(key);
    if (idx < 0 && LEGACY_PRIORITY[key]) idx = prioIndexOf(LEGACY_PRIORITY[key]);
    if (idx < 0) return { label: key || '?', color: '#8e8e93', index: PRIORITIES.length };
    var p = PRIORITIES[idx];
    return { label: p.label, color: p.color || '#8e8e93', index: idx };
  }
  function nextPriority(key) {
    var m = prioMeta(key);
    var next = m.index >= PRIORITIES.length ? 0 : (m.index + 1) % PRIORITIES.length;
    return PRIORITIES[next].key;
  }
  function parseAssignees(str) {
    if (!str) return [];
    return str.split(/\s+/).filter(Boolean);
  }

  // 確認先の並び順（確認先タブの順）。複数なら最上位、未設定は末尾。
  function assigneeRank(t) {
    var names = parseAssignees(t.assignees);
    if (!names.length) return 100000;
    var min = 100000;
    names.forEach(function (n) {
      var i = state.assigneeOptions.indexOf(n);
      if (i < 0) i = 10000; // リスト外の確認先は既知の後・未設定の前
      if (i < min) min = i;
    });
    return min;
  }

  // ================= 優先度メニュー（上に開く選択リスト） =================
  var $menuBackdrop = null, $prioMenu = null;
  function closePrioMenu() {
    if ($prioMenu) { $prioMenu.remove(); $prioMenu = null; }
    if ($menuBackdrop) { $menuBackdrop.remove(); $menuBackdrop = null; }
  }
  function openPrioMenu(anchor, currentKey, onSelect) {
    closePrioMenu();
    $menuBackdrop = document.createElement('div');
    $menuBackdrop.className = 'menu-backdrop';
    $menuBackdrop.addEventListener('click', closePrioMenu);
    $prioMenu = document.createElement('div');
    $prioMenu.className = 'prio-menu';
    PRIORITIES.forEach(function (p) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'prio-item' + (p.key === currentKey ? ' sel' : '');
      var dot = document.createElement('span');
      dot.className = 'prio-dot';
      dot.style.background = p.color;
      var lbl = document.createElement('span');
      lbl.className = 'prio-item-label';
      lbl.textContent = p.label;
      item.appendChild(dot);
      item.appendChild(lbl);
      if (p.key === currentKey) {
        var ck = document.createElement('span');
        ck.className = 'prio-check';
        ck.textContent = '✓';
        item.appendChild(ck);
      }
      item.addEventListener('click', function () { closePrioMenu(); onSelect(p.key); });
      $prioMenu.appendChild(item);
    });
    document.body.appendChild($menuBackdrop);
    document.body.appendChild($prioMenu);
    positionMenu($prioMenu, anchor);
  }
  function positionMenu(menu, anchor) {
    // どのバッジから開いても、入力バー（ドック）のすぐ上・左寄せの固定位置に表示
    var mh = menu.offsetHeight, mw = menu.offsetWidth;
    var vw = window.innerWidth, vh = window.innerHeight;
    var dock = document.getElementById('dock');
    var bottomLimit = vh - 8;
    if (dock && dock.style.display !== 'none') {
      var dr = dock.getBoundingClientRect();
      if (dr.height) bottomLimit = dr.top - 8;
    }
    var app = document.querySelector('.app');
    var ar = app ? app.getBoundingClientRect() : { left: 0 };
    var left = Math.min(Math.max(6, ar.left + 10), vw - mw - 6);
    var top = bottomLimit - mh;
    if (top < 6) top = 6;
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
  }

  // ================= レンダリング =================
  function render() {
    var open = state.tasks.filter(function (t) { return t.status !== 'done'; });
    var done = state.tasks.filter(function (t) { return t.status === 'done'; });

    open.sort(function (a, b) {
      var d = prioMeta(a.priority).index - prioMeta(b.priority).index;
      if (d !== 0) return d;                     // まず優先度順
      var ra = assigneeRank(a), rb = assigneeRank(b);
      if (ra !== rb) return ra - rb;             // 次に確認先順（確認先タブの並び）
      return (b.createdAt || '').localeCompare(a.createdAt || '');
    });
    done.sort(function (a, b) { return (b.doneAt || '').localeCompare(a.doneAt || ''); });

    updateComposerVisibility();

    $list.innerHTML = '';

    if (state.view === 'recurring') { $empty.hidden = true; renderRecurring($list); return; }
    if (state.view === 'settings') { $empty.hidden = true; renderSettings(); return; }
    if (state.view === 'archive') { $empty.hidden = true; renderArchive(); return; }

    var rows = state.view === 'open' ? open : done;
    $empty.hidden = rows.length !== 0;
    if (rows.length) {
      var group = document.createElement('div');
      group.className = 'group';
      rows.forEach(function (t) { group.appendChild(taskEl(t)); });
      $list.appendChild(group);
    }
  }

  function taskEl(t) {
    var assignees = parseAssignees(t.assignees);
    var meta = prioMeta(t.priority);
    var el = document.createElement('div');
    el.className = 'task' + (t.status === 'done' ? ' done' : '');
    el.dataset.id = t.id;

    var main = document.createElement('div');
    main.className = 'task-main';

    var badge = document.createElement('span');
    badge.className = 'badge';
    badge.style.setProperty('--c', meta.color);
    badge.textContent = meta.label;
    badge.title = '優先度を変更';
    badge.addEventListener('click', function (e) {
      e.stopPropagation();
      openPrioMenu(badge, t.priority, function (key) { setTaskPriority(t, key); });
    });

    var title = document.createElement('div');
    title.className = 'task-title';
    title.textContent = t.title;

    var doneBtn = document.createElement('button');
    doneBtn.className = 'done-btn';
    doneBtn.textContent = t.status === 'done' ? '↺' : '✓';
    doneBtn.title = t.status === 'done' ? '未完了に戻す' : '完了';
    doneBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleComplete(t); });

    main.appendChild(badge);
    main.appendChild(title);
    // 確認先（確認対象者）は完了ボタンのすぐ左に inline 表示
    if (assignees.length) {
      var ia = document.createElement('div');
      ia.className = 'task-assignees';
      assignees.forEach(function (a) {
        var c = document.createElement('span');
        c.className = 'chip';
        c.textContent = a;
        ia.appendChild(c);
      });
      main.appendChild(ia);
    }
    main.appendChild(doneBtn);
    main.addEventListener('click', function () { el.classList.toggle('expanded'); });
    el.appendChild(main);

    if (t.lineMemo || (t.status === 'done' && t.doneAt)) {
      var metaRow = document.createElement('div');
      metaRow.className = 'task-meta';
      if (t.lineMemo) {
        var lc = document.createElement('span');
        lc.className = 'chip line';
        lc.textContent = t.lineMemo;
        metaRow.appendChild(lc);
      }
      if (t.status === 'done' && t.doneAt) {
        var dc = document.createElement('span');
        dc.className = 'done-time';
        dc.textContent = '完了 ' + t.doneAt;
        metaRow.appendChild(dc);
      }
      el.appendChild(metaRow);
    }

    el.appendChild(editEl(t));
    return el;
  }

  function editEl(t) {
    var wrap = document.createElement('div');
    wrap.className = 'task-edit';

    var selected = parseAssignees(t.assignees);
    var aLabel = document.createElement('div');
    aLabel.className = 'field-label';
    aLabel.textContent = '確認対象者';
    var tagRow = document.createElement('div');
    tagRow.className = 'tag-row';
    var union = state.assigneeOptions.concat(selected.filter(function (s) { return state.assigneeOptions.indexOf(s) < 0; }));
    union.forEach(function (name) {
      var tag = document.createElement('button');
      tag.type = 'button';
      tag.className = 'tag' + (selected.indexOf(name) >= 0 ? ' on' : '');
      tag.textContent = name;
      tag.addEventListener('click', function () {
        var i = selected.indexOf(name);
        if (i >= 0) { selected.splice(i, 1); tag.classList.remove('on'); }
        else { selected.push(name); tag.classList.add('on'); }
        // 「保存」ボタンでまとめて確定するため、ここでは保存しない
      });
      tagRow.appendChild(tag);
    });

    var lLabel = document.createElement('div');
    lLabel.className = 'field-label';
    lLabel.textContent = '詳細';
    var memo = document.createElement('textarea');
    memo.className = 'memo';
    memo.placeholder = '詳細メモ（自由記入）';
    memo.value = t.lineMemo || '';

    // 保存ボタン（確認先・詳細をまとめて確定）
    var saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'save-btn';
    saveBtn.textContent = '保存';
    saveBtn.addEventListener('click', function () {
      var changed = {};
      var newAssignees = selected.join(' ');
      if (newAssignees !== (t.assignees || '')) changed.assignees = newAssignees;
      if (memo.value !== (t.lineMemo || '')) changed.lineMemo = memo.value;
      if (Object.keys(changed).length) {
        saveField(t, changed); // 保存後は再描画でパネルが閉じる
      } else {
        var host = wrap.closest ? wrap.closest('.task') : null;
        if (host) host.classList.remove('expanded');
      }
      toast('保存しました');
    });

    var actions = document.createElement('div');
    actions.className = 'edit-actions';
    var editTitleBtn = document.createElement('button');
    editTitleBtn.type = 'button';
    editTitleBtn.className = 'text-btn';
    editTitleBtn.textContent = 'タイトル編集';
    editTitleBtn.addEventListener('click', function () {
      var nv = prompt('タスク名を編集', t.title);
      if (nv != null && nv.trim() && nv.trim() !== t.title) saveField(t, { title: nv.trim() });
    });
    var delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'text-btn danger';
    delBtn.textContent = '削除';
    delBtn.addEventListener('click', function () {
      if (confirm('このタスクを削除しますか？')) removeTask(t);
    });
    actions.appendChild(editTitleBtn);
    actions.appendChild(delBtn);

    wrap.appendChild(aLabel);
    wrap.appendChild(tagRow);
    wrap.appendChild(lLabel);
    wrap.appendChild(memo);
    wrap.appendChild(saveBtn);
    wrap.appendChild(actions);
    return wrap;
  }

  // ================= 確認先タブ（確認対象者の管理） =================
  function renderSettings() {
    var card = document.createElement('div');
    card.className = 'recur-form';

    var hint = document.createElement('div');
    hint.className = 'field-label';
    hint.textContent = '確認対象者を追加・削除できます。ここの相手はタスク編集や入力時に選べます。';
    card.appendChild(hint);

    var row = document.createElement('div');
    row.className = 'recur-row';
    var input = document.createElement('input');
    input.className = 'composer-input';
    input.placeholder = '名前を入力（例: 山田課長）';
    var add = document.createElement('button');
    add.type = 'button';
    add.className = 'seg on';
    add.textContent = '追加';
    function doAdd() {
      var v = input.value.trim();
      if (!v) return;
      if (state.assigneeOptions.indexOf(v) < 0) { state.assigneeOptions.push(v); saveAssignees(); buildComposerTags(); }
      input.value = '';
      render();
    }
    add.addEventListener('click', doAdd);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doAdd(); } });
    row.appendChild(input);
    row.appendChild(add);
    card.appendChild(row);
    $list.appendChild(card);

    if (!state.assigneeOptions.length) return;
    var group = document.createElement('div');
    group.className = 'group';
    $list.appendChild(group);
    state.assigneeOptions.forEach(function (name) {
      var el = document.createElement('div');
      el.className = 'task';
      var main = document.createElement('div');
      main.className = 'task-main';
      var title = document.createElement('div');
      title.className = 'task-title';
      title.textContent = name;
      var del = document.createElement('button');
      del.className = 'done-btn';
      del.style.background = 'var(--muted)';
      del.textContent = '×';
      del.title = '削除';
      del.addEventListener('click', function () {
        state.assigneeOptions = state.assigneeOptions.filter(function (x) { return x !== name; });
        saveAssignees(); buildComposerTags(); render();
      });
      main.appendChild(title);
      main.appendChild(del);
      el.appendChild(main);
      group.appendChild(el);
    });
  }

  // ================= 定期タスク（毎月 / 毎年） =================
  function scheduleText(r) {
    if (r.freq === 'yearly') return '毎年 ' + (+r.month) + '月' + (+r.day) + '日';
    return '毎月 ' + (+r.day) + '日';
  }

  // 定期タスク入力フォームを生成（新規登録と編集で共用。rec を渡すと編集モード）
  function buildRecurForm(onDone, rec) {
    var form = document.createElement('div');
    form.className = 'recur-form';

    var hint = document.createElement('div');
    hint.className = 'field-label';
    hint.textContent = '設定した日付になると、未完了タスクへ自動で追加されます';
    form.appendChild(hint);

    var titleInput = document.createElement('input');
    titleInput.className = 'composer-input';
    titleInput.placeholder = '定期タスク名（例: 家賃の振込）';
    if (rec) titleInput.value = rec.title || '';
    form.appendChild(titleInput);

    var opts = {
      priority: rec ? (rec.priority || DEFAULT_PRIORITY) : DEFAULT_PRIORITY,
      freq: rec && rec.freq === 'yearly' ? 'yearly' : 'monthly'
    };
    var row = document.createElement('div');
    row.className = 'recur-row';

    var prioBtn = document.createElement('button');
    prioBtn.type = 'button';
    prioBtn.className = 'prio-btn';
    function refreshPrio() {
      var m = prioMeta(opts.priority);
      prioBtn.textContent = m.label;
      prioBtn.style.setProperty('--c', m.color);
    }
    refreshPrio();
    prioBtn.addEventListener('click', function () {
      openPrioMenu(prioBtn, opts.priority, function (key) { opts.priority = key; refreshPrio(); });
    });

    var freqMonthly = document.createElement('button');
    var freqYearly = document.createElement('button');
    freqMonthly.type = freqYearly.type = 'button';
    freqMonthly.className = 'seg on'; freqMonthly.textContent = '毎月';
    freqYearly.className = 'seg'; freqYearly.textContent = '毎年';

    row.appendChild(prioBtn);
    row.appendChild(freqMonthly);
    row.appendChild(freqYearly);
    form.appendChild(row);

    var dateRow = document.createElement('div');
    dateRow.className = 'recur-row';
    var monthWrap = document.createElement('label');
    monthWrap.className = 'num-field';
    monthWrap.style.display = 'none';
    var monthInput = document.createElement('input');
    monthInput.type = 'number'; monthInput.min = '1'; monthInput.max = '12';
    monthInput.value = rec && rec.month ? String(+rec.month) : '1';
    monthWrap.appendChild(monthInput);
    monthWrap.appendChild(document.createTextNode('月'));

    var dayWrap = document.createElement('label');
    dayWrap.className = 'num-field';
    var dayInput = document.createElement('input');
    dayInput.type = 'number'; dayInput.min = '1'; dayInput.max = '31';
    dayInput.value = rec && rec.day ? String(+rec.day) : '1';
    dayWrap.appendChild(dayInput);
    dayWrap.appendChild(document.createTextNode('日'));

    dateRow.appendChild(monthWrap);
    dateRow.appendChild(dayWrap);
    form.appendChild(dateRow);

    function setFreq(f) {
      opts.freq = f;
      freqMonthly.className = 'seg' + (f === 'monthly' ? ' on' : '');
      freqYearly.className = 'seg' + (f === 'yearly' ? ' on' : '');
      monthWrap.style.display = f === 'yearly' ? '' : 'none';
    }
    freqMonthly.addEventListener('click', function () { setFreq('monthly'); });
    freqYearly.addEventListener('click', function () { setFreq('yearly'); });
    setFreq(opts.freq); // 初期状態（編集時は既存の頻度に合わせる）

    var addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'recur-add';
    addBtn.textContent = rec ? '保存' : '＋ 定期タスクを登録';
    addBtn.addEventListener('click', function () {
      var title = titleInput.value.trim();
      if (!title) { toast('定期タスク名を入力してください'); return; }
      var payload = {
        title: title,
        priority: opts.priority,
        freq: opts.freq,
        month: opts.freq === 'yearly' ? (+monthInput.value || 1) : '',
        day: +dayInput.value || 1
      };
      if (rec) {
        updateRecurring(rec.id, payload);
      } else {
        addRecurring(payload);
        titleInput.value = '';
      }
      if (onDone) onDone();
    });
    form.appendChild(addBtn);
    return form;
  }

  function renderRecurring(container) {
    container.appendChild(buildRecurForm(null));

    if (!state.recurring.length) {
      var none = document.createElement('div');
      none.className = 'empty';
      none.style.padding = '24px 8px';
      none.textContent = '登録された定期タスクはありません';
      container.appendChild(none);
      return;
    }
    var group = document.createElement('div');
    group.className = 'group';
    container.appendChild(group);
    state.recurring.forEach(function (r) {
      var m = prioMeta(r.priority);
      var el = document.createElement('div');
      el.className = 'task';
      var main = document.createElement('div');
      main.className = 'task-main';

      var badge = document.createElement('span');
      badge.className = 'badge';
      badge.style.setProperty('--c', m.color);
      badge.textContent = m.label;

      var body = document.createElement('div');
      body.className = 'task-title';
      var t1 = document.createElement('div');
      t1.textContent = r.title;
      var t2 = document.createElement('div');
      t2.className = 'recur-sub';
      t2.textContent = scheduleText(r) + '　/　次回 ' + (r.nextDue || '-');
      body.appendChild(t1);
      body.appendChild(t2);

      var del = document.createElement('button');
      del.className = 'done-btn';
      del.style.background = 'var(--muted)';
      del.textContent = '×';
      del.title = '定期タスクを削除';
      del.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (confirm('この定期タスクを削除しますか？')) removeRecurring(r);
      });

      main.appendChild(badge);
      main.appendChild(body);
      main.appendChild(del);
      main.addEventListener('click', function () { el.classList.toggle('expanded'); });
      el.appendChild(main);

      var editForm = buildRecurForm(function () { el.classList.remove('expanded'); }, r);
      editForm.classList.add('recur-edit');
      el.appendChild(editForm);

      group.appendChild(el);
    });
  }

  // ================= 保管（スクロールカレンダー 1/1〜12/31・年をまたいで統合） =================
  function mmddKey(createdAt) { return (createdAt || '').slice(5, 10); } // 'MM/dd'
  function fmtMMDD(createdAt) { // 'yyyy/MM/dd HH:mm' -> 'M月D日'
    var mm = mmddKey(createdAt).split('/');
    return (+mm[0]) + '月' + (+mm[1]) + '日';
  }
  function toDateInputValue(createdAt) { // -> 'yyyy-MM-dd'
    return (createdAt || '').slice(0, 10).replace(/\//g, '-');
  }

  function renderArchive() {
    if (!state.archive.length) {
      var none = document.createElement('div');
      none.className = 'empty';
      none.textContent = '保管された記録はありません。タスク入力欄で「保管」を押すとここに残ります。';
      $list.appendChild(none);
      return;
    }
    // 月日（MM/dd）で並べ替え：1/1 → 12/31。同じ日付内は新しい順。
    var entries = state.archive.slice().sort(function (a, b) {
      var ka = mmddKey(a.createdAt), kb = mmddKey(b.createdAt);
      if (ka !== kb) return ka < kb ? -1 : 1;
      return (b.createdAt || '').localeCompare(a.createdAt || '');
    });

    var lastKey = null, group = null;
    entries.forEach(function (e) {
      var key = mmddKey(e.createdAt);
      if (key !== lastKey) {
        var dh = document.createElement('div');
        dh.className = 'arch-day';
        dh.textContent = fmtMMDD(e.createdAt);
        $list.appendChild(dh);
        group = document.createElement('div');
        group.className = 'group';
        $list.appendChild(group);
        lastKey = key;
      }
      group.appendChild(archiveEntryEl(e));
    });
  }

  function archiveEntryEl(e) {
    var meta = prioMeta(e.priority);
    var assignees = parseAssignees(e.assignees);
    var el = document.createElement('div');
    el.className = 'task';

    var main = document.createElement('div');
    main.className = 'task-main';

    var badge = document.createElement('span');
    badge.className = 'badge';
    badge.style.setProperty('--c', meta.color);
    badge.textContent = meta.label;
    badge.title = '優先度を変更';
    badge.addEventListener('click', function (ev) {
      ev.stopPropagation();
      openPrioMenu(badge, e.priority, function (key) { saveArchiveFields(e, { priority: key }); });
    });

    var text = document.createElement('div');
    text.className = 'task-title';
    text.textContent = e.text;

    // 日付変更（タップで日付ピッカー）
    var dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.className = 'arch-date';
    dateInput.value = toDateInputValue(e.createdAt);
    dateInput.title = '日付を変更';
    dateInput.addEventListener('click', function (ev) { ev.stopPropagation(); });
    dateInput.addEventListener('change', function () {
      if (!dateInput.value) return;
      var time = (e.createdAt || '').slice(11, 16) || '00:00';
      saveArchiveFields(e, { createdAt: dateInput.value.replace(/-/g, '/') + ' ' + time });
    });

    var del = document.createElement('button');
    del.className = 'done-btn';
    del.style.background = 'var(--muted)';
    del.textContent = '×';
    del.title = '記録を削除';
    del.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (confirm('この記録を削除しますか？')) removeArchive(e);
    });

    main.appendChild(badge);
    main.appendChild(text);
    main.appendChild(dateInput);
    main.appendChild(del);
    main.addEventListener('click', function () { el.classList.toggle('expanded'); });
    el.appendChild(main);

    if (assignees.length) {
      var metaRow = document.createElement('div');
      metaRow.className = 'task-meta';
      assignees.forEach(function (a) {
        var c = document.createElement('span');
        c.className = 'chip';
        c.textContent = a;
        metaRow.appendChild(c);
      });
      el.appendChild(metaRow);
    }

    el.appendChild(archiveEditEl(e));
    return el;
  }

  function archiveEditEl(e) {
    var wrap = document.createElement('div');
    wrap.className = 'task-edit';

    var tLabel = document.createElement('div');
    tLabel.className = 'field-label';
    tLabel.textContent = '内容';
    var textInput = document.createElement('input');
    textInput.className = 'composer-input';
    textInput.value = e.text || '';

    var aLabel = document.createElement('div');
    aLabel.className = 'field-label';
    aLabel.textContent = '確認対象者';
    var selected = parseAssignees(e.assignees);
    var tagRow = document.createElement('div');
    tagRow.className = 'tag-row';
    var union = state.assigneeOptions.concat(selected.filter(function (s) { return state.assigneeOptions.indexOf(s) < 0; }));
    union.forEach(function (name) {
      var tag = document.createElement('button');
      tag.type = 'button';
      tag.className = 'tag' + (selected.indexOf(name) >= 0 ? ' on' : '');
      tag.textContent = name;
      tag.addEventListener('click', function () {
        var i = selected.indexOf(name);
        if (i >= 0) { selected.splice(i, 1); tag.classList.remove('on'); }
        else { selected.push(name); tag.classList.add('on'); }
      });
      tagRow.appendChild(tag);
    });

    var saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'save-btn';
    saveBtn.textContent = '保存';
    saveBtn.addEventListener('click', function () {
      var changed = {};
      var nt = textInput.value.trim();
      if (nt && nt !== (e.text || '')) changed.text = nt;
      var na = selected.join(' ');
      if (na !== (e.assignees || '')) changed.assignees = na;
      if (Object.keys(changed).length) saveArchiveFields(e, changed);
      else { var host = wrap.closest ? wrap.closest('.task') : null; if (host) host.classList.remove('expanded'); }
      toast('保存しました');
    });

    wrap.appendChild(tLabel);
    wrap.appendChild(textInput);
    wrap.appendChild(aLabel);
    wrap.appendChild(tagRow);
    wrap.appendChild(saveBtn);
    return wrap;
  }

  function saveArchiveFields(e, fields) {
    var prev = {};
    Object.keys(fields).forEach(function (k) { prev[k] = e[k]; e[k] = fields[k]; });
    render();
    var payload = { id: e.id };
    Object.keys(fields).forEach(function (k) { payload[k] = fields[k]; });
    loading(true);
    api('updateArchive', payload).then(function (d) {
      if (d && d.archive) {
        var idx = state.archive.map(function (x) { return x.id; }).indexOf(e.id);
        if (idx >= 0) state.archive[idx] = d.archive;
      }
    }).catch(function (err) {
      Object.keys(prev).forEach(function (k) { e[k] = prev[k]; });
      render();
      toast('保存に失敗: ' + err.message);
    }).finally(function () { loading(false); });
  }

  function addArchive(text) {
    var tempId = 'tmp-' + Date.now();
    var entry = {
      id: tempId, text: text, priority: state.composerPriority,
      assignees: state.composerAssignees.join(' '), createdAt: nowLocal()
    };
    state.archive.unshift(entry);
    if (state.view === 'archive') render();
    toast('保管しました');

    loading(true);
    api('addArchive', { text: text, priority: entry.priority, assignees: entry.assignees, createdAt: entry.createdAt })
      .then(function (d) {
        if (d && d.archive) {
          var idx = state.archive.map(function (x) { return x.id; }).indexOf(tempId);
          if (idx >= 0) state.archive[idx] = d.archive;
        }
        if (state.view === 'archive') render();
      })
      .catch(function (e) {
        state.archive = state.archive.filter(function (x) { return x.id !== tempId; });
        if (state.view === 'archive') render();
        toast('保管失敗: ' + e.message);
      })
      .finally(function () { loading(false); });
  }

  function removeArchive(e) {
    var backup = state.archive.slice();
    state.archive = state.archive.filter(function (x) { return x.id !== e.id; });
    render();
    loading(true);
    api('deleteArchive', { id: e.id }).catch(function (err) {
      state.archive = backup;
      render();
      toast('削除失敗: ' + err.message);
    }).finally(function () { loading(false); });
  }

  // ================= 操作（楽観的更新） =================
  function load() {
    loading(true);
    api('list').then(function (d) {
      state.tasks = (d && d.tasks) || [];
      state.recurring = (d && d.recurring) || [];
      state.archive = (d && d.archive) || [];
      render();
    }).catch(function (e) {
      toast('読み込み失敗: ' + e.message);
    }).finally(function () { loading(false); });
  }

  function addTask(title) {
    var tempId = 'tmp-' + Date.now();
    var task = {
      id: tempId, title: title, priority: state.composerPriority, status: 'open',
      assignees: state.composerAssignees.join(' '), lineMemo: '',
      createdAt: nowLocal(), doneAt: '', updatedAt: ''
    };
    state.tasks.unshift(task);
    render();

    loading(true);
    api('add', {
      title: title, priority: task.priority, assignees: task.assignees
    }).then(function (d) {
      var real = d.task;
      var idx = state.tasks.map(function (x) { return x.id; }).indexOf(tempId);
      if (idx >= 0) state.tasks[idx] = real;
      render();
    }).catch(function (e) {
      state.tasks = state.tasks.filter(function (x) { return x.id !== tempId; });
      render();
      toast('追加失敗: ' + e.message);
    }).finally(function () { loading(false); });
  }

  var completeTimers = {}; // id -> timer（確定待ちの完了）

  function toggleComplete(t) {
    if (t.status !== 'done') { completeTask(t); return; }

    // 完了 → 未完了に戻す
    if (completeTimers[t.id]) {
      // まだ確定前ならサーバーへ送らずに取り消し
      clearTimeout(completeTimers[t.id]);
      delete completeTimers[t.id];
      hideUndoBar(t.id);
      t.status = 'open'; t.doneAt = ''; render();
      return;
    }
    t.status = 'open'; t.doneAt = ''; render();
    loading(true);
    api('uncomplete', { id: t.id }).then(function (d) {
      mergeTask(d.task);
    }).catch(function (e) {
      t.status = 'done'; t.doneAt = nowLocal(); render();
      toast('更新失敗: ' + e.message);
    }).finally(function () { loading(false); });
  }

  // 完了：画面上は即完了にし、約2秒「取り消す」を表示。その間に取り消せば保存しない。
  function completeTask(t) {
    t.status = 'done';
    t.doneAt = nowLocal();
    render();

    if (completeTimers[t.id]) clearTimeout(completeTimers[t.id]);

    showUndoBar(t.id, '完了にしました', function () {
      clearTimeout(completeTimers[t.id]);
      delete completeTimers[t.id];
      t.status = 'open'; t.doneAt = ''; render();
    });

    completeTimers[t.id] = setTimeout(function () {
      delete completeTimers[t.id];
      hideUndoBar(t.id);
      loading(true);
      api('complete', { id: t.id }).then(function (d) {
        mergeTask(d.task);
      }).catch(function (e) {
        t.status = 'open'; t.doneAt = ''; render();
        toast('更新失敗: ' + e.message);
      }).finally(function () { loading(false); });
    }, 2500);
  }

  function setTaskPriority(t, key) {
    if (key === t.priority) return;
    var prev = t.priority;
    saveField(t, { priority: key }, function () { t.priority = prev; render(); });
  }

  function saveField(t, fields, onError) {
    Object.keys(fields).forEach(function (k) { t[k] = fields[k]; });
    render();
    var payload = { id: t.id };
    Object.keys(fields).forEach(function (k) { payload[k] = fields[k]; });
    loading(true);
    api('update', payload).then(function (d) {
      mergeTask(d.task);
    }).catch(function (e) {
      toast('保存失敗: ' + e.message);
      if (onError) onError();
    }).finally(function () { loading(false); });
  }

  function removeTask(t) {
    var backup = state.tasks.slice();
    state.tasks = state.tasks.filter(function (x) { return x.id !== t.id; });
    render();
    loading(true);
    api('delete', { id: t.id }).catch(function (e) {
      state.tasks = backup;
      render();
      toast('削除失敗: ' + e.message);
    }).finally(function () { loading(false); });
  }

  function addRecurring(rec) {
    loading(true);
    api('addRecurring', rec).then(function (d) {
      state.recurring = (d && d.recurring) || state.recurring;
      if (d && d.tasks) state.tasks = d.tasks;
      if (d && d.archive) state.archive = d.archive;
      render();
      toast('定期タスクを登録しました');
    }).catch(function (e) {
      toast('登録失敗: ' + e.message);
    }).finally(function () { loading(false); });
  }

  function removeRecurring(r) {
    var backup = state.recurring.slice();
    state.recurring = state.recurring.filter(function (x) { return x.id !== r.id; });
    render();
    loading(true);
    api('deleteRecurring', { id: r.id }).catch(function (e) {
      state.recurring = backup;
      render();
      toast('削除失敗: ' + e.message);
    }).finally(function () { loading(false); });
  }

  function updateRecurring(id, fields) {
    var payload = { id: id };
    Object.keys(fields).forEach(function (k) { payload[k] = fields[k]; });
    loading(true);
    api('updateRecurring', payload).then(function (d) {
      if (d && d.recurring) state.recurring = d.recurring;
      if (d && d.tasks) state.tasks = d.tasks;
      if (d && d.archive) state.archive = d.archive;
      render();
      toast('定期タスクを更新しました');
    }).catch(function (e) {
      toast('更新失敗: ' + e.message);
    }).finally(function () { loading(false); });
  }

  function mergeTask(task) {
    if (!task) return;
    var idx = state.tasks.map(function (x) { return x.id; }).indexOf(task.id);
    if (idx >= 0) state.tasks[idx] = task; else state.tasks.unshift(task);
    render();
  }

  function nowLocal() {
    var d = new Date(), p = function (n) { return ('0' + n).slice(-2); };
    return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  // ================= 入力バー / タブ =================
  function updatePrioBtn() {
    var m = prioMeta(state.composerPriority);
    $prioBtn.textContent = m.label;
    $prioBtn.style.setProperty('--c', m.color);
  }

  // 入力ドックの開閉（未完了/完了タブでのみ丸ボタン⇄入力欄）
  function updateComposerVisibility() {
    var canCompose = state.view === 'open' || state.view === 'done';
    $dock.style.display = (canCompose && state.composerOpen) ? '' : 'none';
    $fab.style.display = (canCompose && !state.composerOpen) ? '' : 'none';
    $composerBackdrop.classList.toggle('show', canCompose && state.composerOpen);
  }
  function openComposer() {
    state.composerOpen = true;
    updateComposerVisibility();
    $titleInput.focus();
  }
  function closeComposer() {
    state.composerOpen = false;
    if (document.activeElement) document.activeElement.blur();
    updateComposerVisibility();
  }

  function buildComposerTags() {
    $composerTags.innerHTML = '';
    state.assigneeOptions.forEach(function (name) {
      var tag = document.createElement('button');
      tag.type = 'button';
      tag.className = 'tag' + (state.composerAssignees.indexOf(name) >= 0 ? ' on' : '');
      tag.textContent = name;
      tag.addEventListener('click', function () {
        var i = state.composerAssignees.indexOf(name);
        if (i >= 0) { state.composerAssignees.splice(i, 1); tag.classList.remove('on'); }
        else { state.composerAssignees.push(name); tag.classList.add('on'); }
      });
      $composerTags.appendChild(tag);
    });
  }

  function bindEvents() {
    $prioBtn.addEventListener('click', function () {
      openPrioMenu($prioBtn, state.composerPriority, function (key) {
        state.composerPriority = key;
        updatePrioBtn();
      });
    });

    $composer.addEventListener('submit', function (e) {
      e.preventDefault();
      var title = $titleInput.value.trim();
      if (!title) return;
      addTask(title);
      $titleInput.value = '';
      $titleInput.focus();
    });

    $archiveBtn.addEventListener('click', function () {
      var text = $titleInput.value.trim();
      if (!text) { toast('保管する内容を入力してください'); return; }
      addTask(text);      // タスクとして追加
      addArchive(text);   // 同じ内容を保管にも格納
      $titleInput.value = '';
      $titleInput.focus();
    });

    $fab.addEventListener('click', openComposer);
    $composerBackdrop.addEventListener('click', closeComposer);

    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        document.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('is-active'); });
        tab.classList.add('is-active');
        state.view = tab.dataset.view;
        state.composerOpen = false;
        render();
      });
    });

    document.getElementById('reloadBtn').addEventListener('click', load);
  }

  // ================= 起動 =================
  function init() {
    if (!CFG.API_URL || CFG.API_URL.indexOf('PASTE_YOUR') === 0) {
      toast('config.js に GAS の URL を設定してください');
    }
    buildComposerTags();
    updatePrioBtn();
    bindEvents();
    load();
  }

  init();
})();
