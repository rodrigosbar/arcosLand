const https = require('https');
const fs = require('fs');
const path = require('path');

const RTDB_URL = process.env.RTDB_URL;
const OUT_DIR  = process.env.OUT_DIR || 'public';
const BASE_URL = (process.env.BASE_URL || 'https://arcosland.pages.dev').replace(/\/$/,'');

if (!RTDB_URL) {
  console.error('RTDB_URL não definido');
  process.exit(2);
}

function fetchJSONWithRetry(url, retries = 3, baseDelay = 600, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryOnce = () => {
      attempt++;
      const req = https.get(url, { headers: { Accept: 'application/json', 'Cache-Control': 'no-store' } }, (res) => {
        if (res.statusCode && res.statusCode >= 400) { res.resume(); return fail(new Error(`HTTP ${res.statusCode}`)); }
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { fail(new Error(`Parse JSON: ${e.message}`)); } });
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error('Timeout')));
      req.on('error', fail);
      function fail(err){ if (attempt >= retries) return reject(err); setTimeout(tryOnce, baseDelay * Math.pow(2, attempt-1)); }
    };
    tryOnce();
  });
}

function minusOneDeg(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(minusOneDeg);
  const out = {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (k === 'value' && typeof v === 'number' && Number.isFinite(v)) out[k] = Number((v - 1).toFixed(2));
    else if (v && typeof v === 'object') out[k] = minusOneDeg(v);
    else out[k] = v;
  }
  return out;
}

function flattenKV(obj, prefix = '', lines = []) {
  if (obj === null || typeof obj !== 'object') {
    lines.push(`${prefix.replace(/\.$/,'')}=${String(obj)}`);
    return lines;
  }
  for (const k of Object.keys(obj).sort()) {
    const v = obj[k], p = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object') flattenKV(v, p, lines);
    else lines.push(`${p}=${String(v)}`);
  }
  return lines;
}

function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

(async () => {
  const raw = await fetchJSONWithRetry(RTDB_URL);
  if (!raw || !raw.current || typeof raw.current.value !== 'number' || !raw.current.ts) {
    throw new Error('JSON inesperado: faltando current.ts/value');
  }

  const adj = minusOneDeg(raw);
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const currentStr = Number.isFinite(adj.current.value) ? adj.current.value.toFixed(2) : 'N/A';
  fs.writeFileSync(path.join(OUT_DIR, 'current.txt'), currentStr, 'utf-8');
  fs.writeFileSync(path.join(OUT_DIR, 'txt'), flattenKV(adj).join('\n') + '\n', 'utf-8');
  fs.writeFileSync(path.join(OUT_DIR, 'data.json'), JSON.stringify(adj, null, 2) + '\n', 'utf-8');

  const tsBr = new Date(adj.current.ts).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    "name": "ArcosLand Temperatura",
    "description": "Temperatura do aquário ArcosLand publicada periodicamente.",
    "creator": { "@type": "Person", "name": "Rodrigo Soares" },
    "variableMeasured": {
      "@type": "PropertyValue",
      "name": "Temperatura da água",
      "value": Number(currentStr),
      "unitCode": "CEL",
      "dateObserved": adj.current.ts,
      "measurementTechnique": "DS18B20 via NodeMCU ESP8266"
    },
    "distribution": [
      { "@type": "DataDownload", "encodingFormat": "application/json", "contentUrl": "./data.json" },
      { "@type": "DataDownload", "encodingFormat": "text/plain",  "contentUrl": "./current.txt" },
      { "@type": "DataDownload", "encodingFormat": "text/plain",  "contentUrl": "./txt" }
    ]
  };

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="description" content="Temperatura atual do aquário ArcosLand, extraída do Firebase e publicada a cada 5 minutos.">
  <meta name="robots" content="index,follow">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ArcosLand — Temperatura Atual</title>
  <link rel="canonical" href="${BASE_URL}/">
  <style>
    :root { color-scheme: light dark; }
    body { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background:#f8f9fa; color:#222; margin:0; padding:24px; }
    h1 { font-family: system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans; font-weight:600; text-align:center; margin: 0 0 12px; }
    p.lead { text-align:center; margin: 0 0 20px; }
    .card { background:#fff; border:1px solid #ddd; border-radius:12px; padding:16px; box-shadow:0 2px 8px rgba(0,0,0,.06); max-width:980px; margin:0 auto 16px; }
    pre { margin:0; overflow:auto; }
    .muted { color:#666; font-size:.9em; text-align:center; margin-top:12px; }
  </style>
</head>
<body>
  <h1>🌡️ Temperatura do aquário ArcosLand</h1>
  <p class="lead">No dia <strong>${tsBr}</strong>, a temperatura do aquário é <strong>${currentStr} °C</strong>.</p>

  <div class="card">
    <h2 style="margin-top:0">JSON completo (ajustado −1&nbsp;°C)</h2>
    <pre>${esc(JSON.stringify(adj, null, 2))}</pre>
  </div>

  <p class="muted">Atualizado automaticamente via GitHub Actions (a cada 5 minutos).</p>

  <script type="application/ld+json">
${esc(JSON.stringify(jsonLd))}
  </script>
</body>
</html>`;
  fs.writeFileSync(path.join(OUT_DIR, 'index.html'), html, 'utf-8');

  fs.writeFileSync(path.join(OUT_DIR, '_headers'), `/*
Cache-Control: no-store, no-cache, must-revalidate, max-age=0
Pragma: no-cache
Expires: 0
`, 'utf-8');

  fs.writeFileSync(path.join(OUT_DIR, 'robots.txt'), `User-agent: *
Allow: /
`, 'utf-8');

  const nowIso = new Date().toISOString();
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${BASE_URL}/</loc><lastmod>${nowIso}</lastmod><changefreq>always</changefreq><priority>1.0</priority></url>
  <url><loc>${BASE_URL}/data.json</loc><lastmod>${nowIso}</lastmod><changefreq>always</changefreq><priority>0.9</priority></url>
  <url><loc>${BASE_URL}/current.txt</loc><lastmod>${nowIso}</lastmod><changefreq>always</changefreq><priority>0.9</priority></url>
  <url><loc>${BASE_URL}/txt</loc><lastmod>${nowIso}</lastmod><changefreq>always</changefreq><priority>0.8</priority></url>
</urlset>`;
  fs.writeFileSync(path.join(OUT_DIR, 'sitemap.xml'), sitemap, 'utf-8');

  console.log('✅ OK: arquivos gerados em', OUT_DIR);
})().catch((err) => {
  console.error('❌ ERRO:', err);
  process.exit(1);
});
