/*
 * 業務メモ アプリ本体
 *
 * 方針:
 *  - データはすべて IndexedDB（js/db.js）に保存。ネットワーク通信は一切しない。
 *  - ユーザーの入力は textContent / value でのみ画面に出す（innerHTML は使わない）。
 */
(function () {
  'use strict';

  var APP_ID = 'work-memo';
  var BACKUP_VERSION = 1;
  var MAX_BACKUP_BYTES = 50 * 1024 * 1024;

  var state = {
    tab: 'write',
    memos: [],
    notes: [],
    selected: new Set(),
    expanded: new Set(),
    editingMemoId: null,
    viewingNoteId: null,
    editingNoteId: null, // null = 新規
    noteEditSnapshot: null,
    openPanel: null
  };

  // ---------- 小物 ----------

  function $(id) { return document.getElementById(id); }

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  var WEEK = ['日', '月', '火', '水', '木', '金', '土'];
  function pad(n) { return String(n).padStart(2, '0'); }
  function fmtDate(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate()) +
      '(' + WEEK[d.getDay()] + ') ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function fmtTime(ms) { var d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function fileStamp(ms) {
    var d = new Date(ms);
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes());
  }
  function isSameDay(a, b) {
    var x = new Date(a), y = new Date(b);
    return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2200);
  }

  function fail(err) {
    console.error(err);
    alert('エラーが発生しました。\n' + (err && err.message ? err.message : String(err)));
  }

  // テキストをクリップボードへ（端末内の操作。通信はしない）
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () { return legacyCopy(text); });
    }
    return legacyCopy(text);
  }
  function legacyCopy(text) {
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.className = 'offscreen';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error('コピーできませんでした。プレビューを長押しして選択・コピーしてください。'));
    });
  }

  // ファイルとして端末に保存（Blob をその場で作ってダウンロード。通信はしない）
  function downloadFile(filename, text, mime) {
    var blob = new Blob([text], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 60 * 1000);
  }

  // ブラウザにデータを消されにくくするよう依頼（端末内の設定。通信はしない）
  function requestPersist() {
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persisted().then(function (p) {
        if (!p) return navigator.storage.persist();
      }).catch(function () {});
    }
  }

  // ---------- 画面切り替え ----------

  function showTab(tab) {
    state.tab = tab;
    ['write', 'list', 'notes'].forEach(function (t) {
      $('view-' + t).hidden = t !== tab;
    });
    document.querySelectorAll('.tab').forEach(function (b) {
      if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    document.body.dataset.tab = tab;
    if (tab === 'list') renderMemoList();
    if (tab === 'notes') renderNoteList();
    if (tab === 'write') renderWriteInfo();
    window.scrollTo(0, 0);
  }

  function openPanel(id) {
    if (state.openPanel) $(state.openPanel).hidden = true;
    state.openPanel = id;
    $(id).hidden = false;
    $(id).querySelector('.panel-body').scrollTop = 0;
    document.body.classList.add('panel-open');
  }

  function closePanel() {
    if (!state.openPanel) return;
    $(state.openPanel).hidden = true;
    state.openPanel = null;
    document.body.classList.remove('panel-open');
  }

  // ---------- データ読み込み ----------

  function loadAll() {
    return Promise.all([DB.getAll('memos'), DB.getAll('notes')]).then(function (r) {
      state.memos = r[0].sort(function (a, b) { return b.createdAt - a.createdAt; });
      state.notes = r[1].sort(function (a, b) { return b.updatedAt - a.updatedAt; });
      // 消えたメモが選択に残らないように
      var ids = new Set(state.memos.map(function (m) { return m.id; }));
      state.selected.forEach(function (id) { if (!ids.has(id)) state.selected.delete(id); });
    });
  }

  // ---------- ① メモする ----------

  var draftTimer = null;

  function renderWriteInfo() {
    var now = Date.now();
    var today = state.memos.filter(function (m) { return isSameDay(m.createdAt, now); }).length;
    $('write-info').textContent = '今日 ' + today + '件 ／ 全 ' + state.memos.length + '件';
  }

  function saveDraftSoon() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(function () {
      DB.setMeta('draft', $('memo-input').value).catch(function () {});
    }, 400);
  }

  function saveMemo() {
    var input = $('memo-input');
    var text = input.value.replace(/\s+$/, '');
    if (!text.trim()) {
      $('save-status').textContent = '空のメモは保存しません';
      input.focus();
      return;
    }
    var now = Date.now();
    var memo = { id: newId(), text: text, createdAt: now, updatedAt: now };
    // 保存完了を待たずに入力欄を空にする（すぐ次のメモを打ち始めても消えないように）
    clearTimeout(draftTimer);
    input.value = '';
    input.focus();
    DB.put('memos', memo).then(function () {
      state.memos.unshift(memo);
      $('save-status').textContent = '✓ 保存しました（' + fmtTime(now) + '）';
      renderWriteInfo();
      requestPersist();
      // 保存中に次のメモを打ち始めていたら、その下書きを残す
      return DB.setMeta('draft', input.value);
    }).catch(function (err) {
      // 保存に失敗したら、書いた内容を入力欄に戻す
      input.value = text + (input.value ? '\n' + input.value : '');
      fail(err);
    });
  }

  // ---------- ② メモ一覧 ----------

  function renderMemoList() {
    var list = $('memo-list');
    list.textContent = '';
    $('memo-count').textContent = state.memos.length ? '（' + state.memos.length + '件）' : '';
    $('memo-empty').hidden = state.memos.length > 0;

    state.memos.forEach(function (m) {
      var li = el('li', 'memo-item');
      li.dataset.id = m.id;
      if (state.selected.has(m.id)) li.classList.add('selected');

      var label = el('label', 'sel');
      var cb = el('input');
      cb.type = 'checkbox';
      cb.checked = state.selected.has(m.id);
      cb.setAttribute('aria-label', fmtDate(m.createdAt) + ' のメモを選択');
      cb.dataset.action = 'select';
      label.appendChild(cb);

      var body = el('div', 'memo-body');
      var meta = el('div', 'meta', fmtDate(m.createdAt) + (m.updatedAt !== m.createdAt ? '（編集済み）' : ''));
      var text = el('div', 'text', m.text);
      text.dataset.action = 'expand';
      if (!state.expanded.has(m.id)) text.classList.add('clamp');

      var actions = el('div', 'actions');
      var bEdit = el('button', 'btn small', '編集');
      bEdit.type = 'button';
      bEdit.dataset.action = 'edit';
      var bDel = el('button', 'btn small danger', '削除');
      bDel.type = 'button';
      bDel.dataset.action = 'delete';
      actions.appendChild(bEdit);
      actions.appendChild(bDel);

      body.appendChild(meta);
      body.appendChild(text);
      body.appendChild(actions);
      li.appendChild(label);
      li.appendChild(body);
      list.appendChild(li);
    });
    renderSelection();
  }

  function renderSelection() {
    var n = state.selected.size;
    $('sel-count').textContent = n ? n + '件選択中' : '選択なし';
    $('export-bar').hidden = n === 0;
    $('btn-export').textContent = '選択した ' + n + '件 を書き出す';
    $('btn-clear-sel').disabled = n === 0;
    $('btn-select-all').disabled = state.memos.length === 0 || n === state.memos.length;
    document.body.classList.toggle('has-selection', n > 0);
  }

  function onMemoListClick(e) {
    var target = e.target.closest('[data-action]');
    if (!target) return;
    var li = target.closest('.memo-item');
    if (!li) return;
    var id = li.dataset.id;
    var action = target.dataset.action;

    if (action === 'select') {
      if (target.checked) state.selected.add(id); else state.selected.delete(id);
      li.classList.toggle('selected', target.checked);
      renderSelection();
    } else if (action === 'expand') {
      // テキスト選択中はたたまない
      if (window.getSelection && String(window.getSelection())) return;
      if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
      target.classList.toggle('clamp', !state.expanded.has(id));
    } else if (action === 'edit') {
      openMemoEdit(id);
    } else if (action === 'delete') {
      deleteMemo(id);
    }
  }

  function findMemo(id) {
    return state.memos.find(function (m) { return m.id === id; });
  }

  function openMemoEdit(id) {
    var m = findMemo(id);
    if (!m) return;
    state.editingMemoId = id;
    $('memo-edit-meta').textContent = '作成：' + fmtDate(m.createdAt);
    $('memo-edit-input').value = m.text;
    openPanel('panel-memo-edit');
  }

  function saveMemoEdit() {
    var m = findMemo(state.editingMemoId);
    if (!m) { closePanel(); return; }
    var text = $('memo-edit-input').value.replace(/\s+$/, '');
    if (!text.trim()) {
      alert('空のメモにはできません。消したい場合は一覧の「削除」を使ってください。');
      return;
    }
    if (text === m.text) { closePanel(); return; }
    var updated = { id: m.id, text: text, createdAt: m.createdAt, updatedAt: Date.now() };
    DB.put('memos', updated).then(function () {
      Object.assign(m, updated);
      closePanel();
      renderMemoList();
      toast('保存しました');
    }).catch(fail);
  }

  function deleteMemo(id) {
    var m = findMemo(id);
    if (!m) return;
    var preview = m.text.length > 40 ? m.text.slice(0, 40) + '…' : m.text;
    if (!confirm('このメモを削除しますか？\n削除すると元に戻せません。\n\n「' + preview + '」')) return;
    DB.remove('memos', id).then(function () {
      state.memos = state.memos.filter(function (x) { return x.id !== id; });
      state.selected.delete(id);
      state.expanded.delete(id);
      renderMemoList();
      toast('削除しました');
    }).catch(fail);
  }

  // ---------- 書き出し ----------

  function buildExportText() {
    var picked = state.memos
      .filter(function (m) { return state.selected.has(m.id); })
      .sort(function (a, b) { return a.createdAt - b.createdAt; }); // 読みやすいよう古い順
    var lines = [];
    lines.push('業務メモ（' + picked.length + '件）');
    lines.push('書き出し日時：' + fmtDate(Date.now()));
    lines.push('');
    picked.forEach(function (m) {
      lines.push('--------------------');
      lines.push('■ ' + fmtDate(m.createdAt) + (m.updatedAt !== m.createdAt ? '（' + fmtDate(m.updatedAt) + ' 編集）' : ''));
      lines.push(m.text);
      lines.push('');
    });
    return lines.join('\n');
  }

  function openExport() {
    if (state.selected.size === 0) return;
    $('export-preview').value = buildExportText();
    $('export-confirm').checked = false;
    updateExportButtons();
    openPanel('panel-export');
  }

  function updateExportButtons() {
    var ok = $('export-confirm').checked;
    $('btn-copy').disabled = !ok;
    $('btn-save-txt').disabled = !ok;
  }

  // ---------- ③ 整理済みノート ----------

  function findNote(id) {
    return state.notes.find(function (n) { return n.id === id; });
  }

  function renderNoteList() {
    var list = $('note-list');
    list.textContent = '';
    $('note-empty').hidden = state.notes.length > 0;
    state.notes.forEach(function (n) {
      var li = el('li');
      var b = el('button', 'note-item');
      b.type = 'button';
      b.dataset.id = n.id;
      b.appendChild(el('span', 'note-item-title', n.title || '（無題）'));
      b.appendChild(el('span', 'note-item-meta', '更新：' + fmtDate(n.updatedAt)));
      var snippet = n.body.replace(/\s+/g, ' ').trim();
      if (snippet) b.appendChild(el('span', 'note-item-snippet', snippet.slice(0, 80)));
      li.appendChild(b);
      list.appendChild(li);
    });
  }

  function openNoteView(id) {
    var n = findNote(id);
    if (!n) return;
    state.viewingNoteId = id;
    $('note-view-title').textContent = n.title || '（無題）';
    $('note-view-meta').textContent = '作成：' + fmtDate(n.createdAt) +
      (n.updatedAt !== n.createdAt ? '　更新：' + fmtDate(n.updatedAt) : '');
    $('note-view-body').textContent = n.body;
    openPanel('panel-note-view');
  }

  function openNoteEdit(id) {
    var n = id ? findNote(id) : null;
    state.editingNoteId = n ? n.id : null;
    $('note-edit-heading').textContent = n ? 'ノートを編集' : '新しいノート';
    $('note-edit-title').value = n ? n.title : '';
    $('note-edit-body').value = n ? n.body : '';
    state.noteEditSnapshot = $('note-edit-title').value + '\u0000' + $('note-edit-body').value;
    openPanel('panel-note-edit');
    if (!n) $('note-edit-title').focus();
  }

  function noteEditDirty() {
    return ($('note-edit-title').value + '\u0000' + $('note-edit-body').value) !== state.noteEditSnapshot;
  }

  function saveNote() {
    var title = $('note-edit-title').value.trim();
    var body = $('note-edit-body').value.replace(/\s+$/, '');
    if (!title && !body.trim()) {
      alert('タイトルか本文を入力してください。');
      return;
    }
    var now = Date.now();
    var existing = state.editingNoteId ? findNote(state.editingNoteId) : null;
    var note = existing
      ? { id: existing.id, title: title, body: body, createdAt: existing.createdAt, updatedAt: now }
      : { id: newId(), title: title, body: body, createdAt: now, updatedAt: now };
    DB.put('notes', note).then(function () {
      if (existing) Object.assign(existing, note); else state.notes.unshift(note);
      state.notes.sort(function (a, b) { return b.updatedAt - a.updatedAt; });
      requestPersist();
      renderNoteList();
      toast('保存しました');
      openNoteView(note.id);
    }).catch(fail);
  }

  function deleteNote() {
    var n = findNote(state.viewingNoteId);
    if (!n) return;
    if (!confirm('ノート「' + (n.title || '（無題）') + '」を削除しますか？\n削除すると元に戻せません。')) return;
    DB.remove('notes', n.id).then(function () {
      state.notes = state.notes.filter(function (x) { return x.id !== n.id; });
      closePanel();
      renderNoteList();
      toast('削除しました');
    }).catch(fail);
  }

  // ---------- バックアップ・復元 ----------

  function openBackup() {
    DB.getMeta('lastBackupAt').then(function (t) {
      $('last-backup').textContent = t ? '前回のバックアップ：' + fmtDate(t) : 'まだバックアップしていません';
    });
    var info = $('storage-info');
    info.textContent = '';
    if (navigator.storage && navigator.storage.persisted) {
      navigator.storage.persisted().then(function (p) {
        info.textContent = p
          ? 'ブラウザの「データを消されにくくする設定」：有効'
          : 'ブラウザの「データを消されにくくする設定」：未設定（ホーム画面に追加して使うと消えにくくなります）';
      }).catch(function () {});
    }
    openPanel('panel-backup');
  }

  function doBackup() {
    Promise.all([DB.getAll('memos'), DB.getAll('notes')]).then(function (r) {
      var now = Date.now();
      var data = {
        app: APP_ID,
        version: BACKUP_VERSION,
        exportedAt: now,
        exportedAtText: fmtDate(now),
        memos: r[0],
        notes: r[1]
      };
      downloadFile('work-memo-backup-' + fileStamp(now) + '.json', JSON.stringify(data, null, 2), 'application/json');
      return DB.setMeta('lastBackupAt', now).then(function () {
        $('last-backup').textContent = '前回のバックアップ：' + fmtDate(now);
        toast('バックアップを書き出しました（メモ' + r[0].length + '件・ノート' + r[1].length + '件）');
      });
    }).catch(fail);
  }

  function num(v, fallback) {
    return typeof v === 'number' && isFinite(v) ? v : fallback;
  }

  // バックアップの1件を検査し、アプリが扱う項目だけを取り出す
  function cleanMemo(x) {
    if (!x || typeof x !== 'object' || typeof x.text !== 'string') return null;
    var created = num(x.createdAt, Date.now());
    return {
      id: typeof x.id === 'string' && x.id ? x.id : newId(),
      text: x.text,
      createdAt: created,
      updatedAt: num(x.updatedAt, created)
    };
  }
  function cleanNote(x) {
    if (!x || typeof x !== 'object') return null;
    if (typeof x.title !== 'string' && typeof x.body !== 'string') return null;
    var created = num(x.createdAt, Date.now());
    return {
      id: typeof x.id === 'string' && x.id ? x.id : newId(),
      title: typeof x.title === 'string' ? x.title : '',
      body: typeof x.body === 'string' ? x.body : '',
      createdAt: created,
      updatedAt: num(x.updatedAt, created)
    };
  }

  // 既存データは一切変更せず、「追加するもの」だけを決める
  //  - 同じidがない → そのまま追加
  //  - 同じidで同じ内容 → 重複なのでスキップ
  //  - 同じidで内容が違う → 既存は残し、新しいidを付けて別のものとして追加
  function planMerge(incoming, existing, sameContent) {
    var byId = new Map(existing.map(function (x) { return [x.id, x]; }));
    var add = [], skipped = 0, renamed = 0;
    incoming.forEach(function (x) {
      var cur = byId.get(x.id);
      if (!cur) {
        add.push(x);
        byId.set(x.id, x);
      } else if (sameContent(cur, x)) {
        skipped++;
      } else {
        var copy = Object.assign({}, x, { id: newId() });
        add.push(copy);
        byId.set(copy.id, copy);
        renamed++;
      }
    });
    return { add: add, skipped: skipped, renamed: renamed };
  }

  function onRestoreFile(e) {
    var file = e.target.files && e.target.files[0];
    e.target.value = ''; // 同じファイルをもう一度選べるように
    if (!file) return;
    if (file.size > MAX_BACKUP_BYTES) {
      alert('ファイルが大きすぎます（50MBまで）。');
      return;
    }
    file.text().then(function (text) {
      var data;
      try { data = JSON.parse(text); } catch (err) {
        throw new Error('バックアップファイルとして読み込めませんでした（JSON形式ではありません）。');
      }
      if (!data || data.app !== APP_ID || !Array.isArray(data.memos) || !Array.isArray(data.notes)) {
        throw new Error('このアプリのバックアップファイルではないようです。');
      }
      var memos = data.memos.map(cleanMemo).filter(Boolean);
      var notes = data.notes.map(cleanNote).filter(Boolean);
      var invalid = (data.memos.length - memos.length) + (data.notes.length - notes.length);

      return Promise.all([DB.getAll('memos'), DB.getAll('notes')]).then(function (r) {
        var pm = planMerge(memos, r[0], function (a, b) { return a.text === b.text && a.createdAt === b.createdAt; });
        var pn = planMerge(notes, r[1], function (a, b) { return a.title === b.title && a.body === b.body && a.createdAt === b.createdAt; });

        var when = typeof data.exportedAt === 'number' ? fmtDate(data.exportedAt) : '不明';
        var msg = 'バックアップ（作成：' + when + '）から復元します。\n\n' +
          '追加するもの：メモ ' + pm.add.length + '件、ノート ' + pn.add.length + '件\n' +
          '同じ内容がすでにあるので追加しないもの：' + (pm.skipped + pn.skipped) + '件\n';
        if (pm.renamed + pn.renamed) msg += '内容が違うため別のものとして追加：' + (pm.renamed + pn.renamed) + '件\n';
        if (invalid) msg += '読み取れず無視するもの：' + invalid + '件\n';
        msg += '\n今あるデータは消えたり上書きされたりしません。';

        if (pm.add.length + pn.add.length === 0) {
          alert(msg.replace('から復元します。', 'を確認しました。') + '\n\n追加するものはありませんでした。');
          return;
        }
        if (!confirm(msg + '\n\n復元しますか？')) return;

        return DB.addMany({ memos: pm.add, notes: pn.add }).then(function () {
          return loadAll();
        }).then(function () {
          renderMemoList();
          renderNoteList();
          renderWriteInfo();
          requestPersist();
          alert('復元しました。\nメモ ' + pm.add.length + '件、ノート ' + pn.add.length + '件を追加しました。');
        });
      });
    }).catch(fail);
  }

  // ---------- キーボード表示時のレイアウト（iPhone向け） ----------
  // キーボードが出ても「保存」ボタンがキーボードのすぐ上に見えるようにする

  function fitViewport() {
    var vv = window.visualViewport;
    if (!vv) return;
    var kb = window.innerHeight - vv.height > 120;
    document.body.classList.toggle('kb-open', kb);
    var root = document.documentElement.style;
    root.setProperty('--vv-top', vv.offsetTop + 'px');
    root.setProperty('--vv-h', vv.height + 'px');
  }

  // ---------- 起動 ----------

  function bind() {
    document.querySelectorAll('.tab').forEach(function (b) {
      b.addEventListener('click', function () { closePanel(); showTab(b.dataset.tab); });
    });

    // メモする
    $('btn-save').addEventListener('click', saveMemo);
    $('memo-input').addEventListener('input', function () {
      $('save-status').textContent = '';
      saveDraftSoon();
    });
    $('memo-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveMemo(); }
    });

    // 一覧
    $('memo-list').addEventListener('click', onMemoListClick);
    $('btn-select-all').addEventListener('click', function () {
      state.memos.forEach(function (m) { state.selected.add(m.id); });
      renderMemoList();
    });
    $('btn-clear-sel').addEventListener('click', function () {
      state.selected.clear();
      renderMemoList();
    });
    $('btn-export').addEventListener('click', openExport);
    $('btn-memo-edit-save').addEventListener('click', saveMemoEdit);

    // 書き出し
    $('export-confirm').addEventListener('change', updateExportButtons);
    $('btn-copy').addEventListener('click', function () {
      copyText($('export-preview').value).then(function () { toast('コピーしました'); }).catch(fail);
    });
    $('btn-save-txt').addEventListener('click', function () {
      downloadFile('memo-export-' + fileStamp(Date.now()) + '.txt', $('export-preview').value, 'text/plain;charset=utf-8');
    });

    // ノート
    $('btn-new-note').addEventListener('click', function () { openNoteEdit(null); });
    $('note-list').addEventListener('click', function (e) {
      var b = e.target.closest('.note-item');
      if (b) openNoteView(b.dataset.id);
    });
    $('btn-note-edit').addEventListener('click', function () { openNoteEdit(state.viewingNoteId); });
    $('btn-note-save').addEventListener('click', saveNote);
    $('btn-note-delete').addEventListener('click', deleteNote);
    $('btn-note-copy').addEventListener('click', function () {
      var n = findNote(state.viewingNoteId);
      if (n) copyText(n.body).then(function () { toast('コピーしました'); }).catch(fail);
    });

    // バックアップ
    $('btn-open-backup').addEventListener('click', openBackup);
    $('btn-backup').addEventListener('click', doBackup);
    $('btn-restore').addEventListener('click', function () { $('restore-file').click(); });
    $('restore-file').addEventListener('change', onRestoreFile);

    // パネルを閉じる
    document.querySelectorAll('[data-close]').forEach(function (b) {
      b.addEventListener('click', function () {
        var panel = b.closest('.panel').id;
        if (panel === 'panel-note-edit' && noteEditDirty() && !confirm('変更を保存せずに閉じますか？')) return;
        if (panel === 'panel-memo-edit') {
          var m = findMemo(state.editingMemoId);
          if (m && $('memo-edit-input').value.replace(/\s+$/, '') !== m.text && !confirm('変更を保存せずに閉じますか？')) return;
        }
        if (panel === 'panel-note-edit' && state.editingNoteId) { openNoteView(state.editingNoteId); return; }
        closePanel();
      });
    });

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', fitViewport);
      window.visualViewport.addEventListener('scroll', fitViewport);
      fitViewport();
    }
  }

  function start() {
    bind();
    showTab('write');
    DB.open()
      .then(loadAll)
      .then(function () { return DB.getMeta('draft'); })
      .then(function (draft) {
        var input = $('memo-input');
        // 読み込み中に打ち始めていた場合は上書きしない
        if (draft && !input.value) input.value = draft;
        renderWriteInfo();
      })
      .catch(fail);
    $('memo-input').focus();

    // オフライン用のService Worker（アプリ本体のファイルを端末にキャッシュするだけ）
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('sw.js').catch(function (err) { console.warn('Service Worker 登録失敗', err); });
    }
  }

  start();
})();
