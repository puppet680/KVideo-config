// 统一入口：兼容 Cloudflare Workers 和 Pages Functions
export default {
  async fetch(request, env, ctx) {
    if (env && env.KV && typeof globalThis.KV === 'undefined') {
      globalThis.KV = env.KV
    }
    return handleRequest(request)
  }
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
}

const EXCLUDE_HEADERS = new Set([
  'content-encoding', 'content-length', 'transfer-encoding',
  'connection', 'keep-alive', 'set-cookie', 'set-cookie2'
])

// 资源配置
const JSON_SOURCES = {
  'lite': {
    name: '精简版 (Lite)',
    url: 'https://raw.githubusercontent.com/puppet680/KVideo-config/refs/heads/main/lite.json'
  },
  'adult': {
    name: '精简成人版 (Adult)',
    url: 'https://raw.githubusercontent.com/puppet680/KVideo-config/refs/heads/main/adult.json'
  },
  'full': {
    name: '完整版 (Full)',
    url: 'https://raw.githubusercontent.com/puppet680/KVideo-config/refs/heads/main/KVideo-config.json'
  }
}

const FORMAT_CONFIG = {
  '0': { proxy: false },
  'raw': { proxy: false },
  '1': { proxy: true },
  'proxy': { proxy: true }
}

function addOrReplacePrefix(obj, newPrefix) {
  if (typeof obj !== 'object' || obj === null) return obj
  if (Array.isArray(obj)) return obj.map(item => addOrReplacePrefix(item, newPrefix))
  const newObj = {}
  for (const key in obj) {
    if (key === 'api' && typeof obj[key] === 'string') {
      let apiUrl = obj[key]
      const urlIndex = apiUrl.indexOf('?url=')
      if (urlIndex !== -1) apiUrl = apiUrl.slice(urlIndex + 5)
      if (!apiUrl.startsWith(newPrefix)) apiUrl = newPrefix + apiUrl
      newObj[key] = apiUrl
    } else {
      newObj[key] = addOrReplacePrefix(obj[key], newPrefix)
    }
  }
  return newObj
}

async function getCachedJSON(url) {
  const kvAvailable = typeof KV !== 'undefined' && KV && typeof KV.get === 'function'
  if (kvAvailable) {
    const cacheKey = 'CACHE_' + url
    const cached = await KV.get(cacheKey)
    if (cached) {
      try { return JSON.parse(cached) } catch (e) { await KV.delete(cacheKey) }
    }
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`)
    const data = await res.json()
    await KV.put(cacheKey, JSON.stringify(data), { expirationTtl: 600 })
    return data
  }
  const res = await fetch(url)
  return await res.json()
}

async function handleRequest(request) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS })

  const reqUrl = new URL(request.url)
  const targetUrlParam = reqUrl.searchParams.get('url')
  const formatParam = reqUrl.searchParams.get('format')
  const sourceParam = reqUrl.searchParams.get('source')
  const prefixParam = reqUrl.searchParams.get('prefix')

  const currentOrigin = reqUrl.origin
  const defaultPrefix = currentOrigin + '/?url='

  if (reqUrl.pathname === '/health') return new Response('OK', { headers: CORS_HEADERS })
  if (targetUrlParam) return handleProxyRequest(request, targetUrlParam, currentOrigin)
  if (formatParam !== null) return handleFormatRequest(formatParam, sourceParam, prefixParam, defaultPrefix)

  return handleHomePage(currentOrigin, defaultPrefix)
}

async function handleProxyRequest(request, targetUrlParam, currentOrigin) {
  if (targetUrlParam.startsWith(currentOrigin)) return errorResponse('Loop detected', {}, 400)
  try {
    const proxyRequest = new Request(targetUrlParam, {
      method: request.method,
      headers: request.headers,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? await request.arrayBuffer() : undefined,
    })
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 9000)
    const response = await fetch(proxyRequest, { signal: controller.signal })
    clearTimeout(timeoutId)

    const responseHeaders = new Headers(CORS_HEADERS)
    for (const [key, value] of response.headers) {
      if (!EXCLUDE_HEADERS.has(key.toLowerCase())) responseHeaders.set(key, value)
    }
    return new Response(response.body, { status: response.status, headers: responseHeaders })
  } catch (err) {
    return errorResponse('Proxy Error', { message: err.message }, 502)
  }
}

async function handleFormatRequest(formatParam, sourceParam, prefixParam, defaultPrefix) {
  try {
    const config = FORMAT_CONFIG[formatParam]
    if (!config) return errorResponse('Invalid format', {}, 400)
    const sourceCfg = JSON_SOURCES[sourceParam] || JSON_SOURCES['full']
    const data = await getCachedJSON(sourceCfg.url)
    const newData = config.proxy ? addOrReplacePrefix(data, prefixParam || defaultPrefix) : data
    return new Response(JSON.stringify(newData), {
      headers: { 'Content-Type': 'application/json;charset=UTF-8', ...CORS_HEADERS }
    })
  } catch (err) {
    return errorResponse('Internal Error', { message: err.message }, 500)
  }
}

async function handleHomePage(currentOrigin, defaultPrefix) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>API Proxy & Config Converter</title>
  <style>
    :root { --primary: #2563eb; --bg: #f8fafc; --text: #1e293b; --border: #e2e8f0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); max-width: 1000px; margin: 0 auto; padding: 40px 20px; line-height: 1.6; }
    .header { text-align: center; margin-bottom: 40px; }
    .card { background: white; border-radius: 16px; padding: 30px; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1); margin-bottom: 30px; border: 1px solid var(--border); }
    h2 { font-size: 1.5rem; margin-top: 0; color: #0f172a; border-left: 4px solid var(--primary); padding-left: 12px; }
    code { background: #f1f5f9; padding: 3px 8px; border-radius: 6px; font-family: monospace; font-size: 0.9em; color: #e11d48; }
    pre { background: #1e293b; color: #f8fafc; padding: 16px; border-radius: 8px; overflow-x: auto; position: relative; margin: 10px 0; }
    .btn-copy { position: absolute; right: 10px; top: 10px; background: #475569; color: white; border: none; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; }
    .btn-copy:hover { background: var(--primary); }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
    th { text-align: left; background: #f8fafc; padding: 12px; border-bottom: 2px solid var(--border); }
    td { padding: 16px 12px; border-bottom: 1px solid var(--border); }
    .source-name { font-weight: bold; color: #0f172a; display: block; margin-bottom: 4px; }
    .link-group { display: flex; flex-direction: column; gap: 8px; }
    .badge { font-size: 11px; padding: 2px 6px; border-radius: 4px; font-weight: bold; text-transform: uppercase; margin-right: 5px; }
    .badge-raw { background: #fef3c7; color: #92400e; }
    .badge-proxy { background: #dcfce7; color: #166534; }
    .url-text { font-family: monospace; font-size: 12px; color: #64748b; word-break: break-all; cursor: pointer; }
    .url-text:hover { color: var(--primary); text-decoration: underline; }
  </style>
</head>
<body>
  <div class="header">
    <h1>🔄 API 中转及订阅转换</h1>
    <p>提供 GitHub 资源中转、跨域绕过及接口自动代理化功能</p>
  </div>

  <div class="card">
    <h2>🚀 基础代理用法</h2>
    <p>直接在 URL 后附加目标地址：</p>
    <pre><code>${defaultPrefix}https://example.com/api</code><button class="btn-copy" onclick="copyText(this)">复制</button></pre>
  </div>

  <div class="card">
    <h2>📦 快捷订阅链接</h2>
    <table>
      <thead>
        <tr>
          <th>数据源名称</th>
          <th>原始 JSON (Raw)</th>
          <th>中转代理 JSON (Proxy)</th>
        </tr>
      </thead>
      <tbody>
        ${Object.entries(JSON_SOURCES).map(([key, item]) => `
        <tr>
          <td><span class="source-name">${item.name}</span><code>${key}</code></td>
          <td>
            <div class="url-text" onclick="quickCopy('${currentOrigin}/?format=0&source=${key}')">点击复制原始链接</div>
          </td>
          <td>
            <div class="url-text" onclick="quickCopy('${currentOrigin}/?format=1&source=${key}')">点击复制中转链接</div>
          </td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>

  <div class="card">
    <h2>🛠️ 进阶参数</h2>
    <ul>
      <li><code>format=0</code>: 仅获取原始 JSON 数据。</li>
      <li><code>format=1</code>: 自动给 JSON 内部的所有 <code>api</code> 字段加上代理前缀。</li>
      <li><code>prefix=xxx</code>: 自定义中转前缀（需配合 format=1 使用）。</li>
    </ul>
  </div>

  <script>
    function copyText(btn) {
      const code = btn.previousElementSibling.innerText;
      navigator.clipboard.writeText(code);
      btn.innerText = '已复制';
      setTimeout(() => btn.innerText = '复制', 1500);
    }
    function quickCopy(url) {
      navigator.clipboard.writeText(url);
      alert('链接已成功复制到剪贴板！');
    }
  </script>
</body>
</html>`

  return new Response(html, { 
    status: 200, 
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS } 
  })
}

function errorResponse(error, data = {}, status = 400) {
  return new Response(JSON.stringify({ error, ...data }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS }
  })
}
