/* 十点半 Service Worker
 *
 * 策略（照抄六选五踩过的结论）：
 *   · 导航请求：network-first，断网回退缓存的 index.html —— 保证更新能拿到
 *   · 静态资源：cache-first，且 URL **精确匹配**（带 ?v= 与不带是两条）
 *   · version.json 不预缓存：它是「有没有新版」的探针，缓存住就永远探不出
 *   · 不做无条件 reload：SW 更新后强刷会把正在玩的一局清掉
 */
const CACHE = 'sd10-v2';
const PRECACHE = [
  './',
  './index.html',
  './css/style.css?v=202611232c',
  './css/records.css?v=202611232c',
  './css/ten.css?v=202611232c',
  './js/store.js?v=202611232c',
  './js/params.js?v=202611232c',
  './js/rules.js?v=202611232c',
  './js/match.js?v=202611232c',
  './js/card.js?v=202611232c',
  './js/sfx.js?v=202611232c',
  './js/achievements.js?v=202611232c',
  './js/game.js?v=202611232c',
  './manifest.webmanifest',
  './assets/table_bg.webp',
  './assets/home_bg.webp',
  './assets/card_back.webp',
  './assets/audio/sfx_deal.mp3',
  './assets/audio/sfx_select.mp3',
  './assets/audio/sfx_submit.mp3',
  './assets/audio/sfx_win.mp3',
  './assets/audio/sfx_settle.mp3',
  './assets/audio/bgm_room_loop.mp3',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  /* 版本探针永不缓存 */
  if (url.pathname.endsWith('/version.json')) return;

  /* 导航：先网后缓存，断网时回 index.html */
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  /* 静态资源：缓存优先，URL 精确相等（不忽略 query） */
  e.respondWith(
    caches.match(req, { ignoreSearch: false }).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => hit);
    })
  );
});
