/* ===== タスク管理 SPA ロジック ===== */
(function () {
  'use strict';

  var CFG = window.APP_CONFIG || {};
  var PRIORITIES = CFG.PRIORITIES || [
    { key: 'high', label: '急ぎ' }, { key: 'mid', label: '通常' }, { key: 'low', label: '低' }
  ];
  var PRESETS = CFG.ASSIGNEE_PRESETS || [];

  // ---- 状態 ----
  var state = {
    tasks: [],
    view: 'open',          // 'open' | 'done'
    composerPriority: 'high',
    composerAssignees: []  // 追加フォームで選択中の @タグ
  };

  // ---- DOM 参照 ----
  var $list = document.getElementById('taskList');
  var $empty = document.getElementById('emptyState');
  var $composer = document.getElementById('composer');
  var $titleInput = document.getElementById('titleInput');
  var $prioBtn = document.getElementById('prioBtn');
  var $composerTags = document.getElementById('composerTags');
  var $toast = document.getElementById('toast');
  var $countOpen = document.getElementById('countOpen');
  var $countDone = document.getElementById('countDone');

  // ================= API =================
  function api(action, payload) {
    payload = payload || {};
    payload.action = action;
    payload.token = CFG.TOKEN;

    if (action === 'list') {
      var url = CFG.API_URL + '?action=list&token=' + encodeURIComponent(CFG.TOKEN);
      return fetch(url, { method: 'GET' }).then(parseRes);
    }
    // 変更系は text/plain の "単純リクエスト" にして CORS プリフライトを回避
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

  // ================= ローディング表示 =================
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

  // ================= ユーティリティ =================
  function prioLabel(key) {
    var p = PRIORITIES.filter(function (x) { return x.key === key; })[0];
    return p ? p.label : key;
  }
  function prioClass(key) {
    return key === 'high' ? 'high' : (key === 'low' ? 'low' : 'mid');
  }
  function nextPriority(key) {
    var order = ['high', 'mid', 'low'];
    return order[(order.indexOf(key) + 1) % order.length];
  }
  function parseAssignees(str) {
    if (!str) return [];
    return str.split(/\s+/).filter(Boolean);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ================= レンダリング =================
  function render() {
    var open = state.tasks.filter(function (t) { return t.status !== 'done'; });
    var done = state.tasks.filter(function (t) { return t.status === 'done'; });
    $countOpen.textContent = open.length;
    $countDone.textContent = done.length;

    // 完了済みは完了日時の新しい順
    done.sort(function (a, b) { return (b.doneAt || '').localeCompare(a.doneAt || ''); });

    var rows = state.view === 'open' ? open : done;
    $empty.hidden = rows.length !== 0;

    $list.innerHTML = '';
    rows.forEach(function (t) { $list.appendChild(taskEl(t)); });
  }

  function taskEl(t) {
    var assignees = parseAssignees(t.assignees);
    var el = document.createElement('div');
    el.className = 'task' + (t.status === 'done' ? ' done' : '');
    el.dataset.id = t.id;

    // --- メイン行 ---
    var main = document.createElement('div');
    main.className = 'task-main';

    var badge = document.createElement('span');
    badge.className = 'badge ' + prioClass(t.priority);
    badge.textContent = prioLabel(t.priority);
    badge.title = '優先度を変更';
    badge.addEventListener('click', function (e) {
      e.stopPropagation();
      cyclePriority(t);
    });

    var title = document.createElement('div');
    title.className = 'task-title';
    title.textContent = t.title;

    var doneBtn = document.createElement('button');
    doneBtn.className = 'done-btn';
    doneBtn.textContent = t.status === 'done' ? '↩' : '✓';
    doneBtn.title = t.status === 'done' ? '未完了に戻す' : '完了';
    doneBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleComplete(t);
    });

    main.appendChild(badge);
    main.appendChild(title);
    main.appendChild(doneBtn);
    main.addEventListener('click', function () { el.classList.toggle('expanded'); });
    el.appendChild(main);

    // --- メタ行（要約） ---
    if (assignees.length || t.lineMemo || t.status === 'done') {
      var meta = document.createElement('div');
      meta.className = 'task-meta';
      assignees.forEach(function (a) {
        var c = document.createElement('span');
        c.className = 'chip';
        c.textContent = a;
        meta.appendChild(c);
      });
      if (t.lineMemo) {
        var lc = document.createElement('span');
        lc.className = 'chip line';
        lc.textContent = 'LINE: ' + t.lineMemo;
        meta.appendChild(lc);
      }
      if (t.status === 'done' && t.doneAt) {
        var dc = document.createElement('span');
        dc.className = 'done-time';
        dc.textContent = '完了 ' + t.doneAt;
        meta.appendChild(dc);
      }
      el.appendChild(meta);
    }

    // --- 展開編集エリア ---
    el.appendChild(editEl(t));
    return el;
  }

  function editEl(t) {
    var wrap = document.createElement('div');
    wrap.className = 'task-edit';

    // 確認対象者（@タグ）
    var selected = parseAssignees(t.assignees);
    var aLabel = document.createElement('div');
    aLabel.className = 'field-label';
    aLabel.textContent = '確認対象者（マークダウン @タグ）';
    var tagRow = document.createElement('div');
    tagRow.className = 'tag-row';
    var presetUnion = PRESETS.concat(selected.filter(function (s) { return PRESETS.indexOf(s) < 0; }));
    presetUnion.forEach(function (name) {
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

    // LINE 確認済みメモ
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

    // アクション（タイトル編集 / 削除）
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

  // ================= 操作（楽観的更新） =================
  function load() {
    loading(true);
    api('list').then(function (d) {
      state.tasks = (d && d.tasks) || [];
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
      createdAt: '', doneAt: '', updatedAt: ''
    };
    state.tasks.unshift(task);   // 即座に画面へ
    render();

    loading(true);
    api('add', {
      title: title, priority: task.priority, assignees: task.assignees
    }).then(function (d) {
      // 仮 ID を本物に置き換え
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
      // ロールバック
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
    var cls = prioClass(state.composerPriority);
    var colors = { high: '#ef4444', mid: '#f59e0b', low: '#64748b' };
    $prioBtn.textContent = prioLabel(state.composerPriority);
    $prioBtn.style.background = colors[cls];
  }

  function buildComposerTags() {
    $composerTags.innerHTML = '';
    PRESETS.forEach(function (name) {
      var tag = document.createElement('button');
      tag.type = 'button';
      tag.className = 'tag';
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
      $titleInput.focus(); // 連続入力しやすく
    });

    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        document.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('is-active'); });
        tab.classList.add('is-active');
        state.view = tab.dataset.view;
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
