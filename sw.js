/* 网页预缓存 Service Worker
   版本号要和 index.html 里的 <meta name="app-version"> 一起改：
   改了才会重建缓存、把上一版的旧缓存清掉。
   策略：
     · 页面文档：先走网络（永远拿最新的 HTML），断网时才用缓存
     · js / css / json / xml：先用缓存，同时在后台悄悄换成新的
     · 图片、字体等：缓存优先，用到就存
     · A/ B/ 里的大背景图、跨域请求（别家 favicon）不碰，交给浏览器自己缓存
*/
const VERSION = '20261026-1745';
const CORE_CACHE = `mylinks-core-${VERSION}`;
const RUNTIME_CACHE = `mylinks-runtime-${VERSION}`;
const MANIFEST_URL = 'precache-manifest.json';
// 背景大图单独放一个缓存：不带版本号，换版本时也能留着，不用重新下载
const BG_CACHE = 'mylinks-bg';
const BG_MAX_ENTRIES = 6;                       // 最多留 6 张
const BG_MAX_TOTAL_BYTES = 40 * 1024 * 1024;    // 合计不超过 40MB，手机上不占太多
const BG_MAX_FILE_BYTES = 12 * 1024 * 1024;     // 单张超过 12MB 就不存，省空间

// 首屏必需、体积很小的文件，安装时直接装进来
const CORE_FILES = [
  './',
  'index.html',
  'version.json',
  'C/favicon.ico',
  'C/favicon.svg',
  'C/apple-touch-icon.png',
  'mascot/index.js',
  'mascot/chunks/MascotEngine-BegMTn5U.js'
];

const abs = (path) => new URL(path, self.registration.scope).href;

function isHtmlRequest(request) {
  if (request.mode === 'navigate') return true;
  const accept = request.headers.get('accept') || '';
  return accept.indexOf('text/html') >= 0;
}

function keepFresh(pathname) {
  return /\.(?:js|css|json|xml)$/i.test(pathname) || pathname === '/' || pathname.endsWith('/');
}

function isBigMedia(pathname) {
  return /^\/(?:A|B)\//i.test(pathname);
}

/* ---------------- 安装 / 激活 ---------------- */

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CORE_CACHE);
    await Promise.all(CORE_FILES.map(async (file) => {
      const url = abs(file);
      try {
        const response = await fetch(new Request(url, { cache: 'reload' }));
        if (response && (response.ok || response.type === 'opaque')) await cache.put(url, response);
      } catch (error) {
        // 单个文件拿不到不影响整体安装（比如引擎文件名变了）
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name !== CORE_CACHE && name !== RUNTIME_CACHE && name !== BG_CACHE)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

/* ---------------- 背景图缓存 ---------------- */

async function trimBackgroundCache(cache) {
  const keys = await cache.keys();
  let total = 0;
  const sizes = [];
  for (const key of keys) {
    const response = await cache.match(key);
    const length = Number(response && response.headers.get('content-length') || 0);
    sizes.push({ key, length });
    total += length;
  }
  // 先进先出：从最老的开始删，直到张数和总字节都合格
  let index = 0;
  while (index < sizes.length && (sizes.length - index > BG_MAX_ENTRIES || total > BG_MAX_TOTAL_BYTES)) {
    await cache.delete(sizes[index].key);
    total -= sizes[index].length;
    index += 1;
  }
}

async function storeBackground(url, response) {
  const length = Number(response.headers.get('content-length') || 0);
  if (length > BG_MAX_FILE_BYTES) return 0;      // 太大，不存
  const cache = await caches.open(BG_CACHE);
  await cache.put(url, response);
  await trimBackgroundCache(cache);
  return length;
}

async function serveBackground(request) {
  const cache = await caches.open(BG_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response && response.ok) storeBackground(request.url, response.clone()).catch(() => {});
  return response;
}

async function warmBackground(client, urls) {
  if (!Array.isArray(urls) || !urls.length) return;
  const cache = await caches.open(BG_CACHE);
  const total = urls.length;
  let done = 0;
  let added = 0;
  let skipped = 0;
  let bytes = 0;

  for (const path of urls) {
    done += 1;
    const url = abs(path);
    try {
      const hit = await cache.match(url);
      if (hit) {
        bytes += Number(hit.headers.get('content-length') || 0);
      } else {
        const response = await fetch(new Request(url));
        if (response && response.ok) {
          const length = Number(response.headers.get('content-length') || 0);
          if (length > BG_MAX_FILE_BYTES) {
            skipped += 1;
          } else {
            await cache.put(url, response.clone());
            added += 1;
            bytes += length;
          }
        }
      }
    } catch (error) {
      // 单张失败就跳过
    }
    if (client) client.postMessage({ type: 'BG_PROGRESS', done, total, bytes });
  }
  await trimBackgroundCache(cache);
  const left = await cache.keys();
  if (client) client.postMessage({ type: 'BG_DONE', added, skipped, total, bytes, cached: left.length });
}

/* ---------------- 请求拦截 ---------------- */

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (request.headers.has('range')) return;

  let url;
  try { url = new URL(request.url); } catch (error) { return; }
  if (url.origin !== self.location.origin) return;

  if (isBigMedia(url.pathname)) {
    event.respondWith(serveBackground(request));
    return;
  }

  // 页面明确要最新的（cache: 'no-store'，比如 version.json 的更新检测）就一律放行，
  // 否则版本检查会读到缓存里的旧版本号，永远发现不了更新。
  if (request.cache === 'no-store') return;
  // 页面自己的"击穿缓存"地址（一串斜杠）也放行，保证强制更新真能拿到新文档
  if (/\/{2,}/.test(url.pathname)) return;

  if (isHtmlRequest(request)) {
    event.respondWith((async () => {
      try {
        const response = await fetch(new Request(request.url, { cache: 'no-store', credentials: 'same-origin' }));
        if (response && response.ok) {
          const cache = await caches.open(RUNTIME_CACHE);
          cache.put(abs('index.html'), response.clone()).catch(() => {});
        }
        return response;
      } catch (error) {
        return (await caches.match(abs('index.html')))
          || (await caches.match(abs('./')))
          || new Response('现在没有网络，本机也还没有预缓存这一页。', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request);
    const refresh = fetch(request).then(async (response) => {
      if (response && response.ok && response.type === 'basic') {
        const cache = await caches.open(RUNTIME_CACHE);
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    }).catch(() => null);

    if (keepFresh(url.pathname)) {
      if (cached) return cached;
      return (await refresh) || cached || Response.error();
    }
    if (cached) return cached;
    return (await refresh) || cached || Response.error();
  })());
});

/* ---------------- 和页面通信 ---------------- */

async function cacheStatus() {
  const names = await caches.keys();
  let count = 0;
  let bytes = 0;
  for (const name of names) {
    if (name === BG_CACHE) continue;            // 背景图单独统计，不混进文件数
    const cache = await caches.open(name);
    const keys = await cache.keys();
    for (const key of keys) {
      const response = await cache.match(key);
      if (!response) continue;
      count += 1;
      bytes += Number(response.headers.get('content-length') || 0);
    }
  }
  let bgCount = 0;
  let bgBytes = 0;
  if (names.indexOf(BG_CACHE) >= 0) {
    const bg = await caches.open(BG_CACHE);
    for (const key of await bg.keys()) {
      const response = await bg.match(key);
      if (!response) continue;
      bgCount += 1;
      bgBytes += Number(response.headers.get('content-length') || 0);
    }
  }
  return { version: VERSION, caches: names.length, count, bytes, bgCount, bgBytes };
}

async function readManifest() {
  try {
    const response = await fetch(new Request(abs(MANIFEST_URL), { cache: 'reload' }));
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    return null;
  }
}

let warming = false;

async function warm(client, urls) {
  if (warming) {
    if (client) client.postMessage({ type: 'ERROR', message: '已经在预缓存了' });
    return;
  }
  warming = true;
  try {
    let targets = Array.isArray(urls) && urls.length ? urls : null;
    if (!targets) {
      const manifest = await readManifest();
      if (!manifest) {
        if (client) client.postMessage({ type: 'ERROR', message: '没读到预缓存清单' });
        return;
      }
      targets = [...(manifest.core || []), ...(manifest.assets || [])];
    }

    const cache = await caches.open(CORE_CACHE);
    const total = targets.length;
    let done = 0;
    let added = 0;
    let bytes = 0;

    for (const path of targets) {
      done += 1;
      const url = abs(path);
      try {
        const hit = (await cache.match(url)) || (await caches.match(url));
        if (hit) {
          bytes += Number(hit.headers.get('content-length') || 0);
        } else {
          const response = await fetch(new Request(url, { cache: 'reload' }));
          if (response && response.ok) {
            await cache.put(url, response.clone());
            added += 1;
            bytes += Number(response.headers.get('content-length') || 0);
          }
        }
      } catch (error) {
        // 单个文件失败就跳过
      }
      if (client && (done % 10 === 0 || done === total)) {
        client.postMessage({ type: 'PROGRESS', done, total, bytes });
      }
    }
    if (client) client.postMessage({ type: 'DONE', added, total, bytes });
  } finally {
    warming = false;
  }
}

self.addEventListener('message', (event) => {
  const data = event.data || {};
  const client = event.source;

  if (data.type === 'STATUS') {
    event.waitUntil(cacheStatus().then((status) => {
      if (client) client.postMessage({ type: 'STATUS', status });
    }));
    return;
  }

  if (data.type === 'WARM') {
    event.waitUntil(warm(client, data.urls));
    return;
  }

  if (data.type === 'WARM_BG') {
    event.waitUntil(warmBackground(client, data.urls));
    return;
  }

  if (data.type === 'CLEAR') {
    event.waitUntil((async () => {
      const names = await caches.keys();
      await Promise.all(names.map((name) => caches.delete(name)));
      if (client) client.postMessage({ type: 'STATUS', status: { version: VERSION, caches: 0, count: 0, bytes: 0 } });
    })());
  }
});