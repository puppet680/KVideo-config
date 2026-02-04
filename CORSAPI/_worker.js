// 统一入口：兼容 Cloudflare Workers 和 Pages Functions
export default {
  async fetch(request, env, ctx) {
    if (env && env.KV && typeof globalThis.KV === 'undefined') {
      globalThis.KV = env.KV; 
    }
    // 注入允许代理的域名白名单（可选，增强安全性）
    globalThis.ALLOWED_DOMAINS = env.ALLOWED_DOMAINS || ""; 
    return handleRequest(request);
  }
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'public, max-age=3600'
};

const EXCLUDE_HEADERS = new Set([
  'content-encoding', 'content-length', 'transfer-encoding',
  'connection', 'keep-alive', 'set-cookie', 'set-cookie2', 'cf-ray', 'x-forwarded-for'
]);

const JSON_SOURCES = {
  'lite': { name: '精简版 (Lite)', url: 'https://fastly.jsdelivr.net/gh/puppet680/KVideo-config@main/lite.json' },
  'adult': { name: '精简成人版 (Adult)', url: 'https://fastly.jsdelivr.net/gh/puppet680/KVideo-config@main/adult.json' },
  'full': { name: '完整版 (Full)', url: 'https://fastly.jsdelivr.net/gh/puppet680/KVideo-config@main/KVideo-config.json' }
};

// 🔑 域名标识提取优化：增加更鲁棒的正则
function extractSourceId(apiUrl) {
  try {
    const hostname = new URL(apiUrl).hostname;
    const match = hostname.match(/([^.]+)\.(?:com|net|org|cn|top|xyz|vip|cc|icu)$|([^.]+)$/);
    let id = match ? (match[1] || match[2]) : 'source';
    return id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  } catch {
    return 'src' + Math.random().toString(36).substr(2, 4);
  }
}

// 🛠️ 递归处理优化：增加对多层嵌套的防御
function processJsonStructure(obj, newPrefix) {
  const seen = new WeakSet();
  const walk = (item) => {
    if (typeof item !== 'object' || item === null) return item;
    if (seen.has(item)) return item;
    seen.add(item);

    if (Array.isArray(item)) return item.map(walk);
    
    const newObj = {};
    for (const [key, value] of Object.entries(item)) {
      if (key === 'baseUrl' && typeof value === 'string') {
        let apiUrl = value.includes('?url=') ? value.split('?url=')[1] : value;
        const sourceId = extractSourceId(apiUrl);
        const baseUrlPath = newPrefix.split('?url=')[0];
        newObj[key] = `${baseUrlPath}p/${sourceId}?url=${encodeURIComponent(apiUrl)}`;
      } else {
        newObj[key] = walk(value);
      }
    }
    return newObj;
  };
  return walk(obj);
}

async function getCachedJSON(url) {
  const cacheKey = `JSON_CACHE_${url}`;
  if (typeof KV !== 'undefined') {
    const cached = await KV.get(cacheKey);
    if (cached) return JSON.parse(cached);
  }
  
  const res = await fetch(url, { headers: { 'User-Agent': 'Cloudflare-Worker' } });
  if (!res.ok) throw new Error(`GitHub 访问失败: ${res.status}`);
  const data = await res.json();
  
  if (typeof KV !== 'undefined') {
    await KV.put(cacheKey, JSON.stringify(data), { expirationTtl: 600 });
  }
  return data;
}

async function handleRequest(request) {
  const reqUrl = new URL(request.url);
  const { pathname, searchParams, origin } = reqUrl;

  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (pathname === '/health') return new Response('OK');

  // 1. 处理代理请求 /p/{id}?url=...
  if ((pathname.startsWith('/p/') || pathname === '/') && searchParams.has('url')) {
    return handleProxyRequest(request, searchParams.get('url'));
  }

  // 2. 处理订阅格式转换
  if (searchParams.has('format')) {
    const source = searchParams.get('source') || 'full';
    const isProxy = searchParams.get('format') === '1';
    try {
      const data = await getCachedJSON(JSON_SOURCES[source].url);
      const processed = isProxy ? processJsonStructure(data, `${origin}/?url=`) : data;
      return new Response(JSON.stringify(processed), {
        headers: { 'Content-Type': 'application/json;charset=UTF-8', ...CORS_HEADERS }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
  }

  return handleHomePage(origin);
}

async function handleProxyRequest(request, targetUrl) {
  try {
    const decodedUrl = decodeURIComponent(targetUrl);
    const targetURL = new URL(decodedUrl);

    // 复制搜索参数
    const originalUrl = new URL(request.url);
    originalUrl.searchParams.delete('url');
    originalUrl.searchParams.forEach((v, k) => targetURL.searchParams.append(k, v));

    // 创建新的 Header 对象，避免直接修改 request.headers
    const newReqHeaders = new Headers(request.headers);
    newReqHeaders.set('Host', targetURL.hostname);
    newReqHeaders.delete('cf-connecting-ip');
    newReqHeaders.delete('cf-ipcountry');
    newReqHeaders.delete('cf-ray');

    const modifiedRequest = new Request(targetURL, {
      method: request.method,
      headers: newReqHeaders, // 使用修正后的 Header
      redirect: 'follow'
    });

    const response = await fetch(modifiedRequest);
    const newHeaders = new Headers(CORS_HEADERS);
    
    for (const [key, value] of response.headers) {
      if (!EXCLUDE_HEADERS.has(key.toLowerCase())) newHeaders.set(key, value);
    }

    // 解决字符编码与乱码问题
    let body = response.body;
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('json') || contentType.includes('text') || contentType.includes('xml')) {
      let text = await response.text();
      //text = text.replace(/&nbsp;/g, ' '); // 清洗不规范的空格
      return new Response(text, { status: response.status, headers: newHeaders });
    }

    return new Response(body, { status: response.status, headers: newHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Proxy Failed', message: err.message }), { status: 502 });
  }
}

async function handleHomePage(origin) {
  const tableRows = Object.entries(JSON_SOURCES).map(([key, item]) => `
    <div class="glass-card ${key === 'lite' ? 'border-cyan' : 'border-purple'}">
      <div class="card-status">
        <span class="pulse-dot ${key === 'lite' ? 'bg-cyan' : 'bg-purple'}"></span>
        <span class="status-text">source=${key}</span>
      </div>
      <h2 class="card-title">${item.name}</h2>
      <div class="button-group">
        <button class="btn btn-outline" onclick="copy('${origin}/?format=0&source=${key}')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg>
          原始订阅
        </button>
        <button class="btn btn-glow" onclick="copy('${origin}/?format=1&source=${key}')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
          代理加速
        </button>
      </div>
    </div>
  `).join('');

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>KVideo Nexus Console</title>
  <style>
    :root {
      --bg: #05070a;
      --card-bg: rgba(255, 255, 255, 0.03);
      --cyan: #00f2ff;
      --purple: #bc13fe;
      --text: #e0e6ed;
    }
    * { box-sizing: border-box; font-family: 'Inter', -apple-system, sans-serif; }
    body {
      background: var(--bg);
      background-image: radial-gradient(circle at 50% -20%, #1a1f35, transparent);
      color: var(--text);
      margin: 0; padding: 40px 20px;
      display: flex; flex-direction: column; align-items: center; min-height: 100vh;
    }
    .header { text-align: center; margin-bottom: 50px; }
    .header h1 { 
      font-size: 2.5rem; margin: 0; font-weight: 800;
      background: linear-gradient(135deg, var(--cyan), var(--purple));
      -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    }
    .header p { color: #64748b; margin-top: 10px; font-size: 0.9rem; }

    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 25px; width: 100%; max-width: 900px; }
    
    .glass-card {
      background: var(--card-bg);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: 24px; padding: 30px;
      position: relative; overflow: hidden;
      transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    }
    .glass-card:hover { transform: translateY(-10px); background: rgba(255, 255, 255, 0.06); }
    .border-cyan:hover { border-color: var(--cyan); box-shadow: 0 0 30px rgba(0, 242, 255, 0.1); }
    .border-purple:hover { border-color: var(--purple); box-shadow: 0 0 30px rgba(188, 19, 254, 0.1); }

    .card-status { display: flex; align-items: center; gap: 8px; margin-bottom: 15px; }
    .status-text { font-size: 0.75rem; color: #94a3b8; font-family: monospace; }
    .pulse-dot { width: 8px; height: 8px; border-radius: 50%; }
    .bg-cyan { background: var(--cyan); box-shadow: 0 0 10px var(--cyan); }
    .bg-purple { background: var(--purple); box-shadow: 0 0 10px var(--purple); }

    .card-title { font-size: 1.5rem; margin: 0 0 25px 0; font-weight: 700; letter-spacing: -0.5px; }

    .button-group { display: flex; gap: 12px; }
    .btn {
      flex: 1; padding: 12px; border-radius: 12px; font-size: 0.85rem; font-weight: 600;
      cursor: pointer; transition: 0.3s; display: flex; align-items: center; justify-content: center; gap: 8px;
    }
    .btn-outline { background: transparent; border: 1px solid #334155; color: #fff; }
    .btn-outline:hover { background: #334155; }
    .btn-glow { 
      background: #fff; color: #000; border: none;
      box-shadow: 0 4px 15px rgba(255, 255, 255, 0.2);
    }
    .btn-glow:hover { transform: scale(1.05); }

    .usage-card {
      margin-top: 50px; width: 100%; max-width: 900px;
      background: rgba(255, 255, 255, 0.02); border-radius: 20px; padding: 25px;
      border: 1px dashed rgba(255, 255, 255, 0.1);
    }
    .usage-card h3 { font-size: 1rem; color: #94a3b8; margin-bottom: 15px; display: flex; align-items: center; gap: 10px; }
    .usage-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; font-size: 0.8rem; color: #64748b; }
    .usage-item code { color: var(--cyan); background: rgba(0, 242, 255, 0.05); padding: 2px 5px; border-radius: 4px; }

    .toast {
      position: fixed; bottom: 30px; background: rgba(255, 255, 255, 0.95); color: #000;
      padding: 12px 25px; border-radius: 50px; font-weight: 700; font-size: 0.9rem;
      box-shadow: 0 10px 30px rgba(0,0,0,0.5); display: none; z-index: 100;
    }

    @media (max-width: 600px) {
      .button-group { flex-direction: column; }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>KVideo Nexus</h1>
    <p>Automated Distribution & Recursive Proxy Console</p>
  </div>

  <div class="grid">${tableRows}</div>

  <div class="usage-card">
    <h3><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path></svg> 使用手册</h3>
    <div class="usage-grid">
      <div class="usage-item">
        <strong>参数 <code>format</code></strong><br>
        <code>1</code>：开启 Worker 递归代理加速<br>
        <code>0</code>：直接使用源站原始链接
      </div>
      <div class="usage-item">
        <strong>参数 <code>source</code></strong><br>
        <code>lite</code>：严选高成功率极速版<br>
        <code>adult</code>：包含完整精简成人源
      </div>
      <div class="usage-item">
        <strong>万能代理</strong><br>
        拼接 <code>?url=目标链接</code> 即可通过此节点中转任何 API 或资源。
      </div>
    </div>
  </div>

  <div id="toast" class="toast">COPIED TO CLIPBOARD!</div>

  <script>
    function copy(url) {
      navigator.clipboard.writeText(url).then(() => {
        const t = document.getElementById('toast');
        t.style.display = 'block';
        setTimeout(() => t.style.display = 'none', 2000);
      });
    }
  </script>
</body>
</html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
