// Testes que abrem a página publicada num Chromium, como um visitante:
// que pixels disparam de verdade, quanto tempo demora em 4G lento, e
// "fotografar" uma página app (Lovable/React) para a poder editar.

import { devices } from 'playwright';
import { getBrowser, HOSTS_RASTREIO } from './clone.js';
import { detectarPixels } from './pixels.js';

// No máximo dois testes ao mesmo tempo — cada um é um browser inteiro.
let ativos = 0;
const espera = [];
async function vez(fn) {
  if (ativos >= 2) await new Promise((r) => espera.push(r));
  ativos++;
  try { return await fn(); } finally { ativos--; espera.shift()?.(); }
}

const ehRastreio = (u) => HOSTS_RASTREIO.some((h) => u.includes(h)) || u.includes('rastreio-removido.invalid');
const perfilDe = (formato) => (formato === 'computador'
  ? { viewport: { width: 1366, height: 900 }, deviceScaleFactor: 1 }
  : { ...devices['Pixel 7'] });

async function rolar(page) {
  await page.evaluate(async () => {
    for (let i = 0; i < 60; i++) {
      window.scrollBy(0, Math.round(window.innerHeight * 0.8));
      await new Promise((r) => setTimeout(r, 200));
      if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2) break;
    }
    window.scrollTo(0, 0);
  }).catch(() => {});
}

// ── Pixels: o que dispara de facto na página.
// Os envios de eventos são bloqueados (só lidos), para o teste não sujar as estatísticas do pixel.
export function verificarPixels(url, formato) {
  return vez(async () => {
    const browser = await getBrowser();
    const ctx = await browser.newContext({ ...perfilDe(formato), ignoreHTTPSErrors: true });
    const pedidos = [];
    const eventos = [];
    try {
      const page = await ctx.newPage();
      await page.route('**/*', (route) => {
        const req = route.request();
        const u = req.url();
        if (!ehRastreio(u)) return route.continue();
        pedidos.push(u);
        if (/facebook\.com\/tr/.test(u)) {
          try {
            const q = new URL(u).searchParams;
            eventos.push({ plataforma: 'meta', id: q.get('id'), evento: q.get('ev') });
          } catch { /* sem parâmetros */ }
        }
        // Scripts dos pixels carregam (para vermos se arrancam); os envios não saem.
        return req.resourceType() === 'script' ? route.continue() : route.abort();
      });
      await page.goto(url, { waitUntil: 'load', timeout: 45000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await rolar(page);
      await page.waitForTimeout(2500);
      const achados = detectarPixels(pedidos.join('\n'));
      // Rastreadores sem ID reconhecível (Hotjar, Utmify…) aparecem pelo endereço.
      const hosts = [...new Set(pedidos.map((u) => { try { return new URL(u).hostname; } catch { return ''; } }).filter(Boolean))];
      return {
        pixels: achados.map((p) => ({
          ...p,
          eventos: [...new Set(eventos.filter((e) => e.id === p.id).map((e) => e.evento).filter(Boolean))],
        })),
        hosts,
        bloqueados: pedidos.filter((u) => u.includes('rastreio-removido.invalid')).length,
      };
    } finally {
      await ctx.close().catch(() => {});
    }
  });
}

// ── Velocidade em 4G lento num telemóvel médio (as metas que usamos nas PV).
export const METAS = { lcp: 2500, cls: 0.1, bytes: 1024 * 1024 };

export function medirVelocidade(url) {
  return vez(async () => {
    const browser = await getBrowser();
    const ctx = await browser.newContext({ ...devices['Pixel 7'], ignoreHTTPSErrors: true });
    try {
      const page = await ctx.newPage();
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8,
      });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      const recursos = new Map();
      cdp.on('Network.responseReceived', (e) => {
        if (/^https?:/.test(e.response.url)) recursos.set(e.requestId, { url: e.response.url, tipo: e.type, bytes: 0 });
      });
      cdp.on('Network.loadingFinished', (e) => { const r = recursos.get(e.requestId); if (r) r.bytes = e.encodedDataLength; });
      await page.addInitScript(() => {
        window.__vel = { lcp: 0, cls: 0, lcpEl: '' };
        try {
          new PerformanceObserver((l) => {
            for (const e of l.getEntries()) {
              window.__vel.lcp = e.startTime;
              const el = e.element;
              window.__vel.lcpEl = el ? (el.tagName.toLowerCase() + (el.currentSrc || el.src ? ' ' + (el.currentSrc || el.src).split('/').pop().slice(0, 60) : '')) : '';
            }
          }).observe({ type: 'largest-contentful-paint', buffered: true });
          new PerformanceObserver((l) => {
            for (const e of l.getEntries()) if (!e.hadRecentInput) window.__vel.cls += e.value;
          }).observe({ type: 'layout-shift', buffered: true });
        } catch { /* browser sem estas métricas */ }
      });
      const inicio = Date.now();
      await page.goto(url, { waitUntil: 'load', timeout: 90000 }).catch(() => {});
      const carregou = Date.now() - inicio;
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(800);
      const m = await page.evaluate(() => ({
        ...window.__vel,
        fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime || 0,
      })).catch(() => ({ lcp: 0, cls: 0, fcp: 0, lcpEl: '' }));

      const lista = [...recursos.values()];
      const total = lista.reduce((s, r) => s + r.bytes, 0);
      const porTipo = {};
      for (const r of lista) porTipo[r.tipo] = (porTipo[r.tipo] || 0) + r.bytes;
      const pesados = lista.filter((r) => r.bytes > 100 * 1024).sort((a, b) => b.bytes - a.bytes).slice(0, 10);
      return {
        url,
        lcp: Math.round(m.lcp),
        fcp: Math.round(m.fcp),
        cls: Math.round(m.cls * 1000) / 1000,
        lcpEl: m.lcpEl,
        carregou,
        bytes: total,
        pedidos: lista.length,
        porTipo,
        pesados,
        metas: METAS,
        medidoEm: new Date().toISOString(),
      };
    } finally {
      await ctx.close().catch(() => {});
    }
  });
}

// ── Página app (Lovable/React/Vite): o HTML guardado é quase vazio — o conteúdo é
// montado por JavaScript. Para editar, guarda-se a página já montada, sem scripts.
export function fotografar(url, formato) {
  return vez(async () => {
    const browser = await getBrowser();
    const ctx = await browser.newContext({ ...perfilDe(formato), ignoreHTTPSErrors: true });
    try {
      const page = await ctx.newPage();
      await page.route('**/*', (route) => (ehRastreio(route.request().url()) ? route.abort() : route.continue()));
      await page.goto(url, { waitUntil: 'load', timeout: 45000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await rolar(page);
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(1000);
      return await page.evaluate(() => {
        document.querySelectorAll('script, link[rel=modulepreload], link[rel=preload][as=script], #clonador-ajustes').forEach((el) => el.remove());
        // Comentários com os pixels do clonador e o que eles deixaram na página.
        const it = document.createNodeIterator(document.documentElement, NodeFilter.SHOW_COMMENT);
        const comentarios = [];
        for (let n = it.nextNode(); n; n = it.nextNode()) comentarios.push(n);
        let dentro = false;
        for (const c of comentarios) {
          if (c.data.trim() === 'pixels do clonador') dentro = true;
          if (dentro) {
            let s = c.nextSibling;
            while (s && !(s.nodeType === 8 && s.data.trim() === '/pixels do clonador')) { const prox = s.nextSibling; s.remove(); s = prox; }
            dentro = false;
          }
        }
        comentarios.forEach((c) => c.remove());
        return '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
      });
    } finally {
      await ctx.close().catch(() => {});
    }
  });
}
