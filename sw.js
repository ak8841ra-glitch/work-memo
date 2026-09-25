/*
 * Service Worker（オフライン対応）
 *
 * やること: アプリ本体のファイル（HTML/CSS/JS/アイコン）を端末にキャッシュし、
 *           電波がなくても開けるようにする。
 * やらないこと: メモやノートの内容を扱うこと・送信すること。
 *           ここで通信が起きるのは「公開元からアプリ本体のファイルを取得するとき」だけ。
 *
 * アプリを更新して公開し直すときは、CACHE_NAME の末尾の数字を1つ上げてください。
 */
var CACHE_NAME = 'work-memo-v1';

var APP_FILES = [
  './',
  './index.html',
  './css/style.css',
  './js/db.js',
  './js/app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) { return cache.addAll(APP_FILES); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k.indexOf('work-memo-') === 0 && k !== CACHE_NAME) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  // 同じ公開元のファイル取得（GET）だけを扱う。それ以外には一切関与しない
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (cached) {
      if (cached) return cached;
      return fetch(req).catch(function () {
        // オフラインで画面を開こうとした場合はアプリ本体を返す
        if (req.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      });
    })
  );
});
