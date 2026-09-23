// Motor de clonagem: abre a página num Chromium invisível, deixa-a montar-se
// (JavaScript, imagens "lazy"), copia o HTML final e todos os ficheiros que o
// browser descarregou, e reescreve os links para as cópias locais.
// Não usa IA — é uma cópia do código real, por isso sai igual e não gasta tokens.

import { chromium, devices } from 'playwright';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { detectarPixels, removerPixel } from './pixels.js';

const MAX_ASSET_BYTES = 15 * 1024 * 1024;   // vídeos grandes ficam no site original
const MAX_TOTAL_BYTES = 150 * 1024 * 1024;
const TIPOS_GUARDADOS = new Set(['stylesheet', 'image', 'font', 'media']);

let browserPromise = null;

function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      // No PC usamos o Chrome instalado (BROWSER_CHANNEL=chrome); no servidor a
      // imagem Docker já traz o Chromium do Playwright.
      channel: process.env.BROWSER_CHANNEL || (process.platform === 'win32' ? 'chrome' : undefined),
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    }).catch((err) => {
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

function ehIpPrivado(ip) {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    return v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168.');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

// Impede que alguém use o clonador para espreitar serviços internos do servidor.
export async function validarUrl(bruto) {
  let url;
  try {
    url = new URL(String(bruto).trim());
  } catch {
    throw new Error('URL inválida. Cola o endereço completo, com https://');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Só aceito links http ou https.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new Error('Esse endereço é interno — não posso clonar.');
  }
  // Se o DNS do Node falhar, deixamos o browser tentar — ele diz se o site não existe.
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((r) => r.address);
  if (ips.some(ehIpPrivado)) throw new Error('Esse endereço é interno — não posso clonar.');
  return url.toString();
}

function extensao(url, contentType = '') {
  const ct = contentType.split(';')[0].trim();
  const porTipo = {
    'text/css': '.css', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
    'image/webp': '.webp', 'image/avif': '.avif', 'image/svg+xml': '.svg', 'image/x-icon': '.ico',
    'image/vnd.microsoft.icon': '.ico', 'font/woff2': '.woff2', 'font/woff': '.woff', 'font/ttf': '.ttf',
    'font/otf': '.otf', 'application/font-woff2': '.woff2', 'application/font-woff': '.woff',
    'video/mp4': '.mp4', 'video/webm': '.webm', 'audio/mpeg': '.mp3',
  };
  if (porTipo[ct]) return porTipo[ct];
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  return /^\.[a-z0-9]{1,5}$/.test(ext) ? ext : '';
}

// Resolve url(...) e @import dentro de CSS contra a morada de onde o CSS veio.
function reescreverCss(css, baseUrl, mapear) {
  return css
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (inteiro, aspa, alvo) => {
      if (/^(data:|#|about:)/i.test(alvo.trim())) return inteiro;
      try {
        return `url("${mapear(new URL(alvo.trim(), baseUrl).toString())}")`;
      } catch {
        return inteiro;
      }
    })
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (inteiro, aspa, alvo) => {
      try {
        return `@import "${mapear(new URL(alvo, baseUrl).toString())}"`;
      } catch {
        return inteiro;
      }
    });
}

function escaparRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Corre dentro da página: tira popups, banners de cookies e janelas de país/newsletter
// que ficavam congelados na cópia (sem scripts já não fecham).
function tirarPopups() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const removidos = [];
  const candidatos = document.querySelectorAll('body *');
  for (const el of candidatos) {
    if (!el.isConnected) continue;
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
    const r = el.getBoundingClientRect();
    const area = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    const texto = (el.innerText || '').toLowerCase();
    const ehDialogo = el.matches('[role=dialog], [aria-modal=true], dialog') || /modal|popup|overlay|backdrop|newsletter/i.test(el.className + ' ' + el.id);
    const ehCookies = /cookie|consent|gdpr|privacidade|privacy/.test(texto) && texto.length < 1500;
    const cobreEcra = area > vw * vh * 0.35 && cs.position === 'fixed';
    if (ehCookies || (cs.position === 'fixed' && (cobreEcra || (ehDialogo && area > vw * vh * 0.15)))) {
      removidos.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''));
      el.remove();
    }
  }
  for (const el of [document.documentElement, document.body]) {
    if (getComputedStyle(el).overflow === 'hidden' || getComputedStyle(el).overflowY === 'hidden') {
      el.style.setProperty('overflow', 'auto', 'important');
    }
    el.classList.remove('modal-open', 'no-scroll', 'overflow-hidden', 'noscroll');
  }
  return removidos;
}

// Corre dentro da página, depois de ela estar montada.
function prepararDom(manterScripts) {
  const abs = (v) => {
    try { return new URL(v, document.baseURI).toString(); } catch { return v; }
  };
  const absSrcset = (v) => v.split(',').map((parte) => {
    const [u, ...resto] = parte.trim().split(/\s+/);
    return u ? [abs(u), ...resto].join(' ') : '';
  }).filter(Boolean).join(', ');

  // CSS-in-JS (React, styled-components…) injeta regras sem texto na tag <style>:
  // sem isto a cópia ficava sem estilo.
  for (const el of document.querySelectorAll('style')) {
    try {
      const regras = el.sheet?.cssRules;
      if (regras && regras.length && !el.textContent.trim()) {
        el.textContent = Array.from(regras, (r) => r.cssText).join('\n');
      }
    } catch { /* folha de outro domínio */ }
  }
  try {
    for (const folha of document.adoptedStyleSheets || []) {
      const st = document.createElement('style');
      st.textContent = Array.from(folha.cssRules, (r) => r.cssText).join('\n');
      document.head.appendChild(st);
    }
  } catch { /* sem folhas adoptadas */ }

  // Imagens "lazy" que ainda estão com o marcador.
  for (const img of document.querySelectorAll('img')) {
    const real = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original');
    if (real && (!img.getAttribute('src') || img.getAttribute('src').startsWith('data:'))) img.setAttribute('src', real);
    const realSet = img.getAttribute('data-srcset') || img.getAttribute('data-lazy-srcset');
    if (realSet) img.setAttribute('srcset', realSet);
    img.removeAttribute('loading');
  }

  // Cada imagem fica com UMA morada — a que o browser escolheu e descarregou.
  // A cópia fica independente do tamanho do ecrã e trocar a imagem na modelagem é trocar um src.
  for (const img of document.querySelectorAll('img')) {
    if (img.currentSrc && !img.currentSrc.startsWith('data:')) img.setAttribute('src', img.currentSrc);
    if (img.getAttribute('src')) {
      img.removeAttribute('srcset');
      img.removeAttribute('sizes');
    }
  }
  document.querySelectorAll('picture > source').forEach((el) => el.remove());

  for (const el of document.querySelectorAll('[src]')) el.setAttribute('src', abs(el.getAttribute('src')));
  for (const el of document.querySelectorAll('[href]')) el.setAttribute('href', abs(el.getAttribute('href')));
  for (const el of document.querySelectorAll('[srcset]')) el.setAttribute('srcset', absSrcset(el.getAttribute('srcset')));
  for (const el of document.querySelectorAll('video[poster]')) el.setAttribute('poster', abs(el.getAttribute('poster')));
  for (const el of document.querySelectorAll('form[action]')) el.setAttribute('action', abs(el.getAttribute('action')));

  // Valores escritos em campos de formulário não vão no HTML sem isto.
  for (const el of document.querySelectorAll('input')) {
    if (el.type === 'checkbox' || el.type === 'radio') {
      if (el.checked) el.setAttribute('checked', ''); else el.removeAttribute('checked');
    } else if (el.value) el.setAttribute('value', el.value);
  }

  document.querySelectorAll('base, meta[http-equiv="Content-Security-Policy" i]').forEach((el) => el.remove());

  if (!manterScripts) {
    // Sem scripts a página fica uma fotografia fiel: sem pixels do dono original,
    // sem redireccionamentos, sem popups de cookies a reaparecer.
    document.querySelectorAll('script:not([type="application/ld+json"]), link[rel=preload][as=script], link[rel=modulepreload], link[rel=prefetch], noscript').forEach((el) => el.remove());
    // Iframes invisíveis são rastreio (Tag Manager, pixels). Os visíveis — vídeo da VSL — ficam.
    for (const f of document.querySelectorAll('iframe')) {
      const r = f.getBoundingClientRect();
      if (r.width < 5 || r.height < 5 || getComputedStyle(f).display === 'none' || getComputedStyle(f).visibility === 'hidden') f.remove();
    }
    for (const el of document.querySelectorAll('*')) {
      for (const at of Array.from(el.attributes)) {
        if (/^on/i.test(at.name)) el.removeAttribute(at.name);
      }
    }
  }

  const recursos = new Set();
  document.querySelectorAll('img[src], video[poster], link[rel~=icon][href], link[rel=apple-touch-icon][href], input[type=image][src]').forEach((el) => {
    recursos.add(el.getAttribute(el.tagName === 'VIDEO' ? 'poster' : el.tagName === 'LINK' ? 'href' : 'src'));
  });

  return { title: document.title || '', lang: document.documentElement.lang || '', recursos: [...recursos] };
}

// Imagens e fontes que a página referencia mas o browser não chegou a pedir
// (outros tamanhos de ecrã, estados hover, fontes de outras línguas…).
async function buscarEmFalta(context, guardados, html, urlFinal, recursos) {
  const faltam = new Set();
  const juntar = (u, base) => {
    try {
      const abs = new URL(u.trim(), base).toString().split('#')[0];
      if (/^https?:/.test(abs) && !guardados.has(abs)) faltam.add(abs);
    } catch { /* URL estranha */ }
  };
  const urlsCss = (css, base) => {
    for (const m of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) {
      if (!/^(data:|#|about:)/i.test(m[2].trim())) juntar(m[2], base);
    }
  };
  for (const u of recursos) juntar(u, urlFinal);
  for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) urlsCss(m[1], urlFinal);
  for (const m of html.matchAll(/style="([^"]*)"/gi)) urlsCss(m[1].replace(/&quot;/g, '"'), urlFinal);
  for (const [u, a] of guardados) {
    if (a.tipo === 'stylesheet') urlsCss(a.buf.toString('utf8'), u);
  }

  let total = [...guardados.values()].reduce((s, a) => s + a.buf.length, 0);
  const fila = [...faltam].slice(0, 300);
  const limite = Date.now() + 25000;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (fila.length && Date.now() < limite) {
      const u = fila.shift();
      try {
        await validarUrl(u);
        const r = await context.request.get(u, { timeout: 10000, maxRedirects: 5 });
        if (!r.ok()) continue;
        const contentType = r.headers()['content-type'] || '';
        if (/text\/html/.test(contentType)) continue;
        const buf = await r.body();
        if (buf.length > MAX_ASSET_BYTES || total + buf.length > MAX_TOTAL_BYTES) continue;
        total += buf.length;
        const tipo = /css/.test(contentType) ? 'stylesheet' : /font|woff|ttf|otf/.test(contentType + u) ? 'font' : 'image';
        guardados.set(u, { buf, contentType, tipo });
      } catch { /* fica a apontar para o original */ }
    }
  }));
}

async function rolarAteAoFim(page) {
  await page.evaluate(async () => {
    const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
    let ultimo = -1;
    for (let i = 0; i < 80; i++) {
      window.scrollBy(0, Math.round(window.innerHeight * 0.8));
      await pausa(250);
      const fim = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
      if (fim && document.documentElement.scrollHeight === ultimo) break;
      ultimo = document.documentElement.scrollHeight;
    }
    window.scrollTo(0, 0);
  });
}

export async function clonar({ url, formato = 'telemovel', manterScripts = false, removerPopups = true, dataDir }) {
  const alvo = await validarUrl(url);
  const id = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  const pasta = path.join(dataDir, 'pages', id);
  const pastaAssets = path.join(pasta, 'assets');
  await mkdir(pastaAssets, { recursive: true });

  const browser = await getBrowser();
  const perfil = formato === 'computador'
    ? { viewport: { width: 1366, height: 900 }, deviceScaleFactor: 1 }
    : { ...devices['Pixel 7'] };
  const context = await browser.newContext({ ...perfil, locale: 'pt-PT', ignoreHTTPSErrors: true });
  const page = await context.newPage();

  const capturados = new Map(); // url -> { buf, contentType, tipo }
  let totalBytes = 0;
  const pendentes = [];
  const pedidos = []; // todas as moradas pedidas — é por aqui que se apanham pixels carregados via GTM
  page.on('request', (req) => { if (pedidos.length < 3000) pedidos.push(req.url()); });
  page.on('response', (resp) => {
    const req = resp.request();
    if (!TIPOS_GUARDADOS.has(req.resourceType())) return;
    if (resp.status() !== 200) return;
    const u = resp.url();
    if (!/^https?:/.test(u) || capturados.has(u)) return;
    pendentes.push((async () => {
      try {
        const buf = await resp.body();
        if (buf.length > MAX_ASSET_BYTES || totalBytes + buf.length > MAX_TOTAL_BYTES) return;
        totalBytes += buf.length;
        capturados.set(u, { buf, contentType: resp.headers()['content-type'] || '', tipo: req.resourceType() });
      } catch { /* resposta sem corpo (redirect, cancelada) */ }
    })());
  });

  try {
    // Sites lentos não fazem falhar: basta o servidor ter respondido; o resto é
    // esperado com tolerância e seguimos com o que já estiver carregado.
    await page.goto(alvo, { waitUntil: 'commit', timeout: 40000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 40000 }).catch(() => {});
    await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
    await rolarAteAoFim(page).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1200);

    if (removerPopups) await page.evaluate(tirarPopups).catch(() => []);

    const miniatura = await page.screenshot({ type: 'jpeg', quality: 70, timeout: 15000 }).catch(() => null);
    if (miniatura) await writeFile(path.join(pasta, 'thumb.jpg'), miniatura);

    // Pixels do dono original — lidos antes de os scripts saírem.
    const textoScripts = await page.evaluate(() => Array.from(document.querySelectorAll('script, noscript, iframe, img'),
      (el) => `${el.src || ''} ${el.tagName === 'SCRIPT' || el.tagName === 'NOSCRIPT' ? el.textContent : ''}`).join('\n')).catch(() => '');
    const pixelsOriginais = detectarPixels(`${textoScripts}\n${pedidos.join('\n')}`)
      .map((p) => ({ ...p, estado: manterScripts ? 'ativo' : 'removido' }));

    const info = await page.evaluate(prepararDom, manterScripts);
    let html = await page.content();
    const urlFinal = page.url();
    if (!manterScripts) {
      // Restos fora dos scripts (imagens de 1px de rastreio com o ID).
      for (const p of pixelsOriginais) html = removerPixel(html, p.id).html;
    }
    await Promise.allSettled(pendentes);
    page.removeAllListeners('response');
    // Fotografia da lista: respostas que ainda cheguem depois disto ficam de fora.
    const guardados = new Map(capturados);
    await buscarEmFalta(context, guardados, html, urlFinal, info.recursos);

    // Nome local para cada ficheiro capturado.
    const local = new Map();
    for (const [u, a] of guardados) {
      const nome = createHash('sha1').update(u).digest('hex').slice(0, 16) + extensao(u, a.contentType);
      local.set(u, `assets/${nome}`);
    }
    const semHash = (u) => u.split('#')[0];
    const mapear = (abs) => local.get(abs) || local.get(semHash(abs)) || abs;

    // CSS: os caminhos dentro do CSS são relativos à pasta assets/.
    for (const [u, a] of guardados) {
      let conteudo = a.buf;
      if (a.tipo === 'stylesheet' || a.contentType.includes('text/css')) {
        const css = reescreverCss(a.buf.toString('utf8'), u, (abs) => {
          const l = mapear(abs);
          return l.startsWith('assets/') ? l.slice('assets/'.length) : l;
        });
        conteudo = Buffer.from(css, 'utf8');
      }
      await writeFile(path.join(pasta, local.get(u)), conteudo);
    }

    // HTML: estilos inline e <style> primeiro, depois todos os URLs absolutos capturados.
    html = html.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (_, a, css, b) => a + reescreverCss(css, urlFinal, mapear) + b);
    html = html.replace(/style="([^"]*)"/gi, (inteiro, css) => {
      const desfeito = css.replace(/&quot;/g, '"');
      const novo = reescreverCss(desfeito, urlFinal, mapear).replace(/"/g, '&quot;');
      return `style="${novo}"`;
    });
    const urls = [...local.keys()].sort((a, b) => b.length - a.length);
    for (const u of urls) {
      const destino = local.get(u);
      for (const variante of new Set([u, u.replace(/&/g, '&amp;')])) {
        html = html.replace(new RegExp(escaparRegex(variante) + '(?=["\'\\s,)])', 'g'), destino);
      }
    }

    await writeFile(path.join(pasta, 'index.html'), html, 'utf8');

    const meta = {
      id,
      url: alvo,
      urlFinal,
      titulo: info.title || new URL(urlFinal).hostname,
      formato,
      manterScripts,
      pixelsOriginais,
      meusPixels: [],
      ficheiros: guardados.size,
      bytes: [...guardados.values()].reduce((s, a) => s + a.buf.length, 0),
      criadoEm: new Date().toISOString(),
    };
    await writeFile(path.join(pasta, 'meta.json'), JSON.stringify(meta, null, 2));
    return meta;
  } catch (err) {
    await rm(pasta, { recursive: true, force: true }).catch(() => {});
    throw err;
  } finally {
    await context.close().catch(() => {});
  }
}
