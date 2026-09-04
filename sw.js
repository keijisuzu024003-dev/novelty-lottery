// ノベルティ抽選ルーレット — Service Worker
//
// 会場ではネット回線が不安定な前提。初回アクセス時にプリキャッシュしておき、
// 2回目以降は完全オフラインで起動できることを最優先にする（Cache First）。
//
// 【更新するときは必ずこの CACHE_NAME の数字を1つ上げること】
// 上げないと、古いキャッシュがそのまま使われ続けて画面が更新されない。
const CACHE_NAME = 'novelty-lottery-v6';

// プリキャッシュ対象。相対パス（"./" 起点）で統一する。
// GitHub Pages のサブディレクトリ配下でも動くよう、絶対パスは使わない。
const PRECACHE_URLS = [
  './',
  './index.html',
  './app.css',
  './js/defaults.js',
  './js/storage.js',
  './js/lottery.js',
  './js/wheel.js',
  './js/sound.js',
  './js/confetti.js',
  './js/settings.js',
  './js/app.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './logo.png',
  './fonts/ShipporiMinchoB1-Bold.subset.woff2'
];

// cache.addAll は1つでも失敗すると install ごと失敗する。
// 開発中はファイルが揃っていないこともあるため、1件ずつ cache.add して
// 失敗はログに残すだけで握りつぶす（install 自体は必ず成功させる）。
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return Promise.all(
        PRECACHE_URLS.map(function (url) {
          return cache.add(url).catch(function (err) {
            console.warn('[sw] precache failed（無視して続行）:', url, err);
          });
        })
      );
    })
  );
  // ここでは skipWaiting しない。抽選の途中で急にリロードされると
  // 演出やアニメーションが壊れるため、切り替えはアプリ側からの
  // 明示的な合図（SKIP_WAITING メッセージ）を待つ。
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys
          .filter(function (key) {
            return key !== CACHE_NAME;
          })
          .map(function (key) {
            return caches.delete(key);
          })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

// 抽選中の予期しないリロードを避けるため、更新の適用はアプリ側の合図待ちにする。
self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Cache First + stale-while-revalidate。
// 会場のネットが不安定でも、キャッシュがあれば即座に返す。
// 同時に裏でネットワークから取り直し、次回表示のためにキャッシュを更新する。
self.addEventListener('fetch', function (event) {
  var request = event.request;

  // GET 以外（POST 等）はキャッシュ対象外なのでそのまま素通し。
  if (request.method !== 'GET') {
    return;
  }

  // 同一オリジン以外（CDNやAPIなど）もそのまま素通し。
  // このアプリは外部リソースを読み込まない設計だが、念のため防御しておく。
  var url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.match(request).then(function (cached) {
        var networkFetch = fetch(request)
          .then(function (response) {
            // 正常なレスポンスだけキャッシュを更新する。
            if (response && response.ok) {
              cache.put(request, response.clone()).catch(function (err) {
                console.warn('[sw] cache put failed（無視）:', request.url, err);
              });
            }
            return response;
          })
          .catch(function (err) {
            // オフラインでネットワークが取れない場合は無視（キャッシュ優先のため）。
            console.warn('[sw] network fetch failed（オフラインの可能性）:', request.url, err);
            return null;
          });

        // キャッシュがあれば即返し、無ければネットワークの結果を待つ。
        return cached || networkFetch;
      });
    })
  );
});
