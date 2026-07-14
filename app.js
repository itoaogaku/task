/* ===== タスク管理 SPA ロジック ===== */
(function () {
  'use strict';

  var CFG = window.APP_CONFIG || {};
  var PRIORITIES = CFG.PRIORITIES || [
    { key: 's', label: 'S', color: '#ff3b30' },
    { key: 'p1', label: '1', color: '#ff9500' },
    { key: 'p2', label: '2', color: '#007aff' },
    { key: 'kan', label: '監', color: '#af52de' },
    { key: 'cho', label: '長', color: '#34c759' },
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
    view: 'open',                 // 'open' | 'done' | 'recurring' | 'settings'
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
  var $recurPanel = document.getElementById('recurPanel');
  var $recurToggle = document.getElementById('recurToggle');
  var $toast = document.getElementById('toast');
  var $countOpen = document.getElementById('countOpen');
  var $countDone = document.getElementById('countDone');
  var $countRecurring = document.getElementById('countRecurring');

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

  // ================= レンダリング =================
  function render() {
    var open = state.tasks.filter(function (t) { return t.status !== 'done'; });
    var done = state.tasks.filter(function (t) { return t.status === 'done'; });
    $countOpen.textContent = open.length;
    $countDone.textContent = done.length;
    if ($countRecurring) $countRecurring.textContent = state.recurring.length;

    open.sort(function (a, b) {
      var d = prioMeta(a.priority).index - prioMeta(b.priority).index;
      if (d !== 0) return d;
      return (b.createdAt || '').localeCompare(a.createdAt || '');
    });
    done.sort(function (a, b) { return (b.doneAt || '').localeCompare(a.doneAt || ''); });

    // 入力ドックはタスク一覧（未完了/完了）でのみ表示
    var showDock = state.view === 'open' || state.view === 'done';
    $dock.style.display = showDock ? '' : 'none';

    $list.innerHTML = '';

    if (state.view === 'recurring') { $empty.hidden = true; renderRecurring($list); return; }
    if (state.view === 'settings') { $empty.hidden = true; renderSettings(); return; }

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
    badge.addEventListener('click', function (e) { e.stopPropagation(); cyclePriority(t); });

    var title = document.createElement('div');
    title.className = 'task-title';
    title.textContent = t.title;

    var doneBtn = document.createElement('button');
    doneBtn.className = 'done-btn';
    doneBtn.textContent = t.status === 'done' ? '↩' : '✓';
    doneBtn.title = t.status === 'done' ? '未完了に戻す' : '完了';
    doneBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleComplete(t); });

    main.appendChild(badge);
    main.appendChild(title);
    main.appendChild(doneBtn);
    main.addEventListener('click', function () { el.classList.toggle('expanded'); });
    el.appendChild(main);

    if (assignees.length || t.lineMemo || t.status === 'done') {
      var metaRow = document.createElement('div');
      metaRow.className = 'task-meta';
      assignees.forEach(function (a) {
        var c = document.createElement('span');
        c.className = 'chip';
        c.textContent = a;
        metaRow.appendChild(c);
      });
      if (t.lineMemo) {
        var lc = document.createElement('span');
        lc.className = 'chip line';
        lc.textContent = 'LINE: ' + t.lineMemo;
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
        saveField(t, { assignees: selected.join(' ') });
      });
      tagRow.appendChild(tag);
    });

    var lLabel = document.createElement('div');
    lLabel.className = 'field-label';
    lLabel.textContent = 'LINE：ここまで確認/返信済みメモ';
    var memo = document.createElement('textarea');
    memo.className = 'memo';
    memo.placeholder = '例: 〇〇さんの17:30のメッセージまで返信済み';
    memo.value = t.lineMemo || '';
    memo.addEventListener('blur', function () {
      if (memo.value !== (t.lineMemo || '')) saveField(t, { lineMemo: memo.value });
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

    // サンプルデータ投入（お試し用）
    var tools = document.createElement('div');
    tools.style.marginTop = '24px';
    var seedBtn = document.createElement('button');
    seedBtn.type = 'button';
    seedBtn.className = 'seed-btn';
    seedBtn.textContent = '🧪 サンプルデータを投入';
    seedBtn.addEventListener('click', seedSampleData);
    tools.appendChild(seedBtn);
    var seedNote = document.createElement('div');
    seedNote.className = 'field-label';
    seedNote.style.marginTop = '6px';
    seedNote.textContent = 'お試し用のタスク・定期タスクを追加します（後で削除できます）。';
    tools.appendChild(seedNote);
    $list.appendChild(tools);
  }

  function seedSampleData() {
    if (!confirm('サンプルのタスク・定期タスクを投入します。よろしいですか？（後で削除できます）')) return;
    loading(true);
    var samples = [
      { title: '請求書を月末までに送付する', priority: 's', assignees: '上司 経理' },
      { title: '新規提案資料のドラフト作成', priority: 'p1', assignees: 'チームA' },
      { title: 'A社との打ち合わせ日程を調整', priority: 'p1', assignees: '顧客' },
      { title: '今月の経費精算を提出', priority: 'p2', assignees: '経理' },
      { title: '監査対応の資料をそろえる', priority: 'kan', assignees: '上司' },
      { title: '部長へ週次報告を送る', priority: 'cho', assignees: '部長' },
      { title: '自宅の電球を買い替える', priority: 'ie', assignees: '' },
      { title: 'キックオフMTGの議事録を共有', priority: 'p2', assignees: 'チームA チームB' }
    ];
    var ids = [];
    var chain = Promise.resolve();
    samples.forEach(function (s) {
      chain = chain.then(function () { return api('add', s); })
        .then(function (d) { if (d && d.task) ids.push(d.task.id); });
    });
    chain = chain
      .then(function () { if (ids[2]) return api('update', { id: ids[2], lineMemo: '田中さんの15:00のメッセージまで返信済み' }); })
      .then(function () { if (ids[3]) return api('complete', { id: ids[3] }); })
      .then(function () { if (ids[7]) return api('complete', { id: ids[7] }); })
      .then(function () { return api('addRecurring', { title: '家賃の振込', priority: 'p1', freq: 'monthly', month: '', day: 25 }); })
      .then(function () { return api('addRecurring', { title: '健康診断の予約', priority: 'p2', freq: 'yearly', month: 6, day: 1 }); })
      .then(function () { toast('サンプルデータを投入しました'); load(); })
      .catch(function (e) { toast('投入失敗: ' + e.message); })
      .finally(function () { loading(false); });
  }

  // ================= 定期タスク（毎月 / 毎年） =================
  function scheduleText(r) {
    if (r.freq === 'yearly') return '毎年 ' + (+r.month) + '月' + (+r.day) + '日';
    return '毎月 ' + (+r.day) + '日';
  }

  // 定期タスク入力フォームを生成（メイン画面のパネルと定期タブで共用）
  function buildRecurForm(onDone) {
    var form = document.createElement('div');
    form.className = 'recur-form';

    var hint = document.createElement('div');
    hint.className = 'field-label';
    hint.textContent = '設定した日付になると、未完了タスクへ自動で追加されます';
    form.appendChild(hint);

    var titleInput = document.createElement('input');
    titleInput.className = 'composer-input';
    titleInput.placeholder = '定期タスク名（例: 家賃の振込）';
    form.appendChild(titleInput);

    var opts = { priority: DEFAULT_PRIORITY, freq: 'monthly' };
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
    prioBtn.addEventListener('click', function () { opts.priority = nextPriority(opts.priority); refreshPrio(); });

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
    monthInput.type = 'number'; monthInput.min = '1'; monthInput.max = '12'; monthInput.value = '1';
    monthWrap.appendChild(monthInput);
    monthWrap.appendChild(document.createTextNode('月'));

    var dayWrap = document.createElement('label');
    dayWrap.className = 'num-field';
    var dayInput = document.createElement('input');
    dayInput.type = 'number'; dayInput.min = '1'; dayInput.max = '31'; dayInput.value = '1';
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

    var addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'recur-add';
    addBtn.textContent = '＋ 定期タスクを登録';
    addBtn.addEventListener('click', function () {
      var title = titleInput.value.trim();
      if (!title) { toast('定期タスク名を入力してください'); return; }
      addRecurring({
        title: title,
        priority: opts.priority,
        freq: opts.freq,
        month: opts.freq === 'yearly' ? (+monthInput.value || 1) : '',
        day: +dayInput.value || 1
      });
      titleInput.value = '';
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
      del.addEventListener('click', function () {
        if (confirm('この定期タスクを削除しますか？')) removeRecurring(r);
      });

      main.appendChild(badge);
      main.appendChild(body);
      main.appendChild(del);
      el.appendChild(main);
      group.appendChild(el);
    });
  }

  // メイン画面下部の定期パネル開閉
  function toggleRecurPanel() {
    if ($recurPanel.hidden) {
      $recurPanel.innerHTML = '';
      $recurPanel.appendChild(buildRecurForm(function () { closeRecurPanel(); }));
      $recurPanel.hidden = false;
      $recurToggle.classList.add('on');
    } else {
      closeRecurPanel();
    }
  }
  function closeRecurPanel() {
    $recurPanel.hidden = true;
    $recurPanel.innerHTML = '';
    $recurToggle.classList.remove('on');
  }

  // ================= 操作（楽観的更新） =================
  function load() {
    loading(true);
    api('list').then(function (d) {
      state.tasks = (d && d.tasks) || [];
      state.recurring = (d && d.recurring) || [];
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

  function toggleComplete(t) {
    var toDone = t.status !== 'done';
    t.status = toDone ? 'done' : 'open';
    t.doneAt = toDone ? nowLocal() : '';
    render();
    loading(true);
    api(toDone ? 'complete' : 'uncomplete', { id: t.id }).then(function (d) {
      mergeTask(d.task);
    }).catch(function (e) {
      t.status = toDone ? 'open' : 'done';
      t.doneAt = toDone ? '' : t.doneAt;
      render();
      toast('更新失敗: ' + e.message);
    }).finally(function () { loading(false); });
  }

  function cyclePriority(t) {
    var prev = t.priority;
    t.priority = nextPriority(t.priority);
    render();
    saveField(t, { priority: t.priority }, function () { t.priority = prev; render(); });
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
      state.composerPriority = nextPriority(state.composerPriority);
      updatePrioBtn();
    });

    $composer.addEventListener('submit', function (e) {
      e.preventDefault();
      var title = $titleInput.value.trim();
      if (!title) return;
      addTask(title);
      $titleInput.value = '';
      $titleInput.focus();
    });

    $recurToggle.addEventListener('click', toggleRecurPanel);

    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        document.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('is-active'); });
        tab.classList.add('is-active');
        state.view = tab.dataset.view;
        closeRecurPanel();
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
