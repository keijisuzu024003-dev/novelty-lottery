// 受付歓迎画面 — Service Worker（scope: novelty-lottery/welcome/）
//
// 抽選アプリの SW とは別物。抽選アプリ側のファイル・キャッシュには一切触れない。
// 【更新するときは CACHE_NAME の数字と index.html 内の 'welcome2026-vN' を両方上げる】
const CACHE_NAME = 'welcome2026-v2';
const PRECACHE_URLS = ['./', './index.html', './logo.png', './fonts/ShipporiMinchoB1-Bold.welcome.woff2'];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return Promise.all(PRECACHE_URLS.map(function (url) {
        return cache.add(url).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

// 自分の古い版（welcome2026-*）だけ消す。抽選アプリのキャッシュは消さない
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) {
        return k.indexOf('welcome2026-') === 0 && k !== CACHE_NAME;
      }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

// キャッシュ優先。裏でネットから取り直して次回に備える
self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) { return; }
  event.respondWith(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.match(req, {ignoreSearch: true}).then(function (cached) {
        var net = fetch(req).then(function (res) {
          if (res && res.ok) { cache.put(req, res.clone()).catch(function () {}); }
          return res;
        }).catch(function () { return null; });
        return cached || net.then(function (res) {
          if (res) { return res; }
          return req.mode === 'navigate' ? cache.match('./index.html') : Response.error();
        });
      });
    })
  );
});
