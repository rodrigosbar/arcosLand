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
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            fail(new Error(`Parse JSON: ${e.message}`));
          }
        });
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error('Timeout')));
      req.on('error', fail);
      function fail(err) {
        if (attempt >= retries) return reject(err);
        setTimeout(tryOnce, baseDelay * Math.pow(2, attempt - 1));
      }
    };
    tryOnce();
  });
}

function flattenKV(obj, prefix = '', lines = []) {
  if (obj === null || typeof obj !== 'object') {
    lines.push(`${prefix.replace(/\.$/, '')}=${String(obj)}`);
    return lines;
  }
  for (const k of Object.keys(obj).sort()) {
    const v = obj[k];
    const p = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object') {
      flattenKV(v, p, lines);
    } else {
      lines.push(`${p}=${String(v)}`);
    }
  }
  return lines;
}

function esc(s) {
  return s
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;');
}

// --------- ENVIO DE E-MAIL VIA MAILCHANNELS (SEM CLOUDFLARE, SEM -1) ---------

function sendAlertEmail(tempRaw, tsBr) {
  return new Promise((resolve, reject) => {
    const payload = {
      personalizations: [
        {
          to: [{ email: "rodrigosbar@gmail.com" }]
        }
      ],
      from: {
        email: "alerta@github-actions.local",
        name: "ArcosLand Monitor"
      },
      subject: `[ArcosLand] ALERTA: ${tempRaw.toFixed(2)} °C`,
      content: [
        {
          type: "text/plain",
          value:
            `Alerta de temperatura em ArcosLand.\n\n` +
            `Data/hora: ${tsBr}\n` +
            `Temperatura (sem ajuste): ${tempRaw.toFixed(2)} °C\n` +
            `Limites configurados: mínimo 24 °C, máximo 26 °C.\n\n` +
            `Origem: GitHub Actions (.github/scripts/generate.js).`
        }
      ]
    };

    const data = JSON.stringify(payload);

    const options = {
      hostname: 'api.mailchannels.net',
      path: '/tx/v1/send',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      },
      timeout: 8000
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          return reject(new Error(`HTTP ${res.statusCode}: ${body}`));
        }
        resolve();
      });
    });

    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Timeout no envio de e-mail')));
    req.write(data);
    req.end();
  });
}

// ------------------- MAIN -------------------

(async () => {
  const raw = await fetchJSONWithRetry(RTDB_URL);
  if (!raw || !raw.current || typeof raw.current.value !== 'number' || !raw.current.ts) {
    throw new Error('JSON inesperado: faltando current.ts/value');
  }

  // 🔥 Temperatura BRUTA do Firebase, SEM -1, usada para alerta e para a página
  const tempRaw = raw.current.value;
  const tsBr = new Date(raw.current.ts).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  if (Number.isFinite(tempRaw)) {
    if (tempRaw < 24 || tempRaw > 26) {
      console.log(`⚠️ Temperatura FORA do intervalo: ${tempRaw.toFixed(2)} °C — enviando e-mail...`);
      try {
        await sendAlertEmail(tempRaw, tsBr);
        console.log('📧 Alerta de temperatura enviado para rodrigosbar@gmail.com');
      } catch (e) {
        console.error('❌ Erro ao enviar e-mail de alerta:', e.message);
        // não derruba o job por causa do e-mail
      }
    } else {
      console.log(`Temperatura dentro do intervalo: ${tempRaw.toFixed(2)} °C`);
    }
  } else {
    console.warn('Temperatura bruta não é número finito, ignorando alerta.');
  }

  // 🔹 A PARTIR DAQUI: uso SEM -1 também para os arquivos/página
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const currentStr = Number.isFinite(tempRaw) ? tempRaw.toFixed(2) : 'N/A';

  // arquivos de saída
  fs.writeFileSync(path.join(OUT_DIR, 'current.txt'), currentStr, 'utf-8');
  fs.writeFileSync(path.join(OUT_DIR, 'txt'), flattenKV(raw).join('\n') + '\n', 'utf-8');
  fs.writeFileSync(path.join(OUT_DIR, 'data.json'), JSON.stringify(raw, null, 2) + '\n', 'utf-8');

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
      "dateObserved": raw.current.ts,
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
    <h2 style="margin-top:0">JSON completo</h2>
    <pre>${esc(JSON.stringify(raw, null, 2))}</pre>
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
