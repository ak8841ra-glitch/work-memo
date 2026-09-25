/*
 * IndexedDB の薄いラッパー。
 * データはこの端末のブラウザ内だけに保存され、どこにも送信されない。
 *
 * ストア:
 *   memos : { id, text, createdAt, updatedAt }        業務メモ
 *   notes : { id, title, body, createdAt, updatedAt } 整理済みノート
 *   meta  : { key, value }                             下書き・最終バックアップ日時など
 */
(function () {
  'use strict';

  var DB_NAME = 'work-memo';
  var DB_VERSION = 1;
  var dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!('indexedDB' in window)) {
        reject(new Error('このブラウザはIndexedDBに対応していません'));
        return;
      }
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('memos')) db.createObjectStore('memos', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = function () {
        var db = req.result;
        // 別タブで新しいバージョンが開かれたら接続を閉じる
        db.onversionchange = function () { db.close(); dbPromise = null; };
        // ブラウザ側で接続が切られた場合も、次回の操作で開き直す
        db.onclose = function () { dbPromise = null; };
        resolve(db);
      };
      req.onerror = function () { dbPromise = null; reject(req.error); };
      req.onblocked = function () { reject(new Error('他のタブでこのアプリが開かれているため、データベースを開けません')); };
    });
    return dbPromise;
  }

  // トランザクションを実行し、完了（コミット）した時点で resolve する
  function run(storeNames, mode, work, retried) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx;
        try {
          tx = db.transaction(storeNames, mode);
        } catch (err) {
          // 接続が切れていたら1回だけ開き直してやり直す
          if (!retried && err && err.name === 'InvalidStateError') {
            dbPromise = null;
            resolve(run(storeNames, mode, work, true));
            return;
          }
          reject(err);
          return;
        }
        var result;
        tx.oncomplete = function () { resolve(result); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('保存が中断されました')); };
        work(tx, function (value) { result = value; });
      });
    });
  }

  function getAll(store) {
    return run([store], 'readonly', function (tx, set) {
      var req = tx.objectStore(store).getAll();
      req.onsuccess = function () { set(req.result || []); };
    });
  }

  function get(store, key) {
    return run([store], 'readonly', function (tx, set) {
      var req = tx.objectStore(store).get(key);
      req.onsuccess = function () { set(req.result); };
    });
  }

  function put(store, value) {
    return run([store], 'readwrite', function (tx) {
      tx.objectStore(store).put(value);
    });
  }

  function remove(store, key) {
    return run([store], 'readwrite', function (tx) {
      tx.objectStore(store).delete(key);
    });
  }

  // 復元用: 複数ストアへの追加を1つのトランザクションで行う（途中で失敗したら全部取り消し）
  // items: { memos: [...], notes: [...] }
  function addMany(items) {
    var stores = Object.keys(items).filter(function (s) { return items[s].length > 0; });
    if (stores.length === 0) return Promise.resolve();
    return run(stores, 'readwrite', function (tx) {
      stores.forEach(function (s) {
        var os = tx.objectStore(s);
        // add() は同じidが既にあると失敗する＝既存データを上書きしない
        items[s].forEach(function (v) { os.add(v); });
      });
    });
  }

  function getMeta(key) {
    return get('meta', key).then(function (row) { return row ? row.value : undefined; });
  }

  function setMeta(key, value) {
    return put('meta', { key: key, value: value });
  }

  window.DB = {
    open: open,
    getAll: getAll,
    get: get,
    put: put,
    remove: remove,
    addMany: addMany,
    getMeta: getMeta,
    setMeta: setMeta
  };
})();
