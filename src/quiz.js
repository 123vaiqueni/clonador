// Quiz completo: responde ao quiz como um visitante, passo a passo, guarda cada ecrã
// (já montado, sem os scripts deles) e junta tudo numa página só, com um script
// pequeno nosso que avança de passo em passo. Assim cada pergunta fica editável.
//
// Funciona com quizzes em que os passos mudam no mesmo endereço (React/Next/Lovable)
// e com quizzes de várias páginas (/passo-2, /passo-3…). Não contorna protecções:
// se o quiz pedir login, captcha ou bloquear robôs, pára aí.

import { devices } from 'playwright';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buscarEmFalta, escaparRegex, extensao, getBrowser, HOSTS_RASTREIO, MAX_ASSET_BYTES, MAX_TOTAL_BYTES,
  reescreverCss, TIPOS_GUARDADOS, tirarPopups, validarUrl,
} from './clone.js';

const MAX_PASSOS = 60;
const TEMPO_MAX = 5 * 60 * 1000;
// Valores de teste escritos nos campos do quiz. O nome é procurado depois nos passos
// seguintes ("Clonadora, o seu plano…") e passa a mostrar o nome que o visitante escrever.
const NOME_TESTE = 'Clonadora';

// ── Corre dentro da página: marca o que se pode clicar e diz o que é cada coisa.
function lerPasso() {
  const visivel = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8 || r.bottom < 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  };
  document.querySelectorAll('[data-clon-i]').forEach((el) => el.removeAttribute('data-clon-i'));
  const base = 'button,[role=button],[role=radio],[role=checkbox],[role=option],label,a[href],input[type=submit],input[type=button],input[type=radio],input[type=checkbox],[onclick]';
  let lista = [...document.querySelectorAll(base)];
  // Cartões de resposta feitos com <div> e cursor de mão.
  for (const el of document.querySelectorAll('div,li,span')) {
    if (getComputedStyle(el).cursor === 'pointer' && (el.innerText || '').trim().length < 120) lista.push(el);
  }
  lista = [...new Set(lista)].filter(visivel);
  // Fica só o elemento clicável de fora (um <label> com <input> dentro conta uma vez).
  const conjunto = new Set(lista);
  lista = lista.filter((el) => { for (let p = el.parentElement; p; p = p.parentElement) if (conjunto.has(p)) return false; return true; });

  const host = location.hostname;
  const RE_CTA = /continuar|pr[oó]xim|avan[cç]ar|seguinte|continue|next|come[cç]ar|iniciar|quero|ver (o |meu |minha )?(plano|resultado)|descobr|enviar|confirmar|calcular|finalizar|gerar|receber|pronto|ok\b|vamos/i;
  const RE_VOLTAR = /^(voltar|back|anterior|‹|<|←|«)$/i;
  const itens = lista.map((el, i) => {
    el.setAttribute('data-clon-i', String(i));
    const texto = (el.innerText || el.value || el.getAttribute('aria-label') || el.querySelector('img')?.alt || '').replace(/\s+/g, ' ').trim();
    const r = el.getBoundingClientRect();
    let tipo = 'opcao';
    const href = el.tagName === 'A' ? el.getAttribute('href') || '' : '';
    let externo = false;
    if (href && !href.startsWith('#') && !/^javascript:/i.test(href)) {
      try { externo = new URL(href, location.href).hostname !== host; } catch { /* href estranho */ }
    }
    if (RE_VOLTAR.test(texto) || (!texto && r.left < 90 && r.top < 140 && r.width < 70)) tipo = 'voltar';
    else if (externo) tipo = 'externo';
    else if (el.disabled && el.matches('button,input')) tipo = 'desligado';
    else if (el.type === 'submit' || RE_CTA.test(texto)) tipo = 'cta';
    else if (!texto) tipo = 'icone';
    return { i, texto: texto.slice(0, 80), tipo, y: Math.round(r.top) };
  });

  const campos = [...document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=radio]):not([type=checkbox]),textarea,select')]
    .filter(visivel).map((el, j) => {
      el.setAttribute('data-clon-campo', String(j));
      const rotulo = [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), el.getAttribute('autocomplete'),
        el.labels?.[0]?.innerText, el.closest('div')?.innerText?.slice(0, 80)].filter(Boolean).join(' ').toLowerCase();
      return { j, tipo: el.tagName === 'SELECT' ? 'select' : el.type || 'text', rotulo, vazio: !el.value };
    });

  const titulo = [...document.querySelectorAll('h1,h2,h3,legend,[class*=title],[class*=question],[class*=pergunta]')]
    .filter(visivel).map((h) => h.innerText.trim()).find((t) => t.length > 3) || document.body.innerText.trim().split('\n')[0] || '';
  const texto = document.body.innerText;
  return {
    url: location.href,
    marca: location.pathname + '|' + texto.replace(/\d+/g, '#').replace(/\s+/g, ' ').slice(0, 3000),
    titulo: titulo.slice(0, 120),
    itens,
    campos,
    preco: /(R\$|US\$|€|Kz|AOA)\s?\d|\d+[,.]\d{2}\s?(kz|aoa)/i.test(texto),
  };
}

// ── Corre dentro da página: fotografa o ecrã actual SEM mexer na página viva
// (o quiz continua a funcionar para o passo seguinte).
function fotografarPasso() {
  const abs = (v) => { try { return new URL(v, document.baseURI).toString(); } catch { return v; } };
  const absSrcset = (v) => v.split(',').map((p) => { const [u, ...r] = p.trim().split(/\s+/); return u ? [abs(u), ...r].join(' ') : ''; }).filter(Boolean).join(', ');
  const estilos = [...document.querySelectorAll('style')].map((el) => {
    try { const r = el.sheet?.cssRules; if (r && r.length && !el.textContent.trim()) return [...r].map((x) => x.cssText).join('\n'); } catch { /* outra origem */ }
    return null;
  });
  let adoptados = '';
  try { for (const f of document.adoptedStyleSheets || []) adoptados += [...f.cssRules].map((r) => r.cssText).join('\n'); } catch { /* nada */ }
  const imgs = [...document.querySelectorAll('img')].map((i) => (i.currentSrc && !i.currentSrc.startsWith('data:') ? i.currentSrc : i.getAttribute('src') || i.getAttribute('data-src') || ''));
  // Gráficos desenhados em <canvas> (IMC, curva até à meta) passam a imagem.
  const telas = [...document.querySelectorAll('canvas')].map((c) => { try { return c.toDataURL('image/png'); } catch { return ''; } });
  const iframesInvisiveis = [...document.querySelectorAll('iframe')].map((f) => { const r = f.getBoundingClientRect(); return r.width < 5 || r.height < 5; });

  const doc = document.documentElement.cloneNode(true);
  doc.querySelectorAll('style').forEach((el, i) => { if (estilos[i]) el.textContent = estilos[i]; });
  if (adoptados) { const st = document.createElement('style'); st.textContent = adoptados; doc.querySelector('head')?.appendChild(st); }
  doc.querySelectorAll('img').forEach((img, i) => {
    if (imgs[i]) img.setAttribute('src', imgs[i]);
    ['srcset', 'sizes', 'loading', 'data-src', 'data-srcset'].forEach((a) => img.removeAttribute(a));
  });
  doc.querySelectorAll('picture > source').forEach((el) => el.remove());
  doc.querySelectorAll('canvas').forEach((c, i) => {
    if (!telas[i] || telas[i].length < 200) return;
    const img = document.createElement('img');
    img.src = telas[i];
    img.setAttribute('style', (c.getAttribute('style') || '') + ';max-width:100%;height:auto');
    if (c.className) img.className = c.className;
    c.replaceWith(img);
  });
  doc.querySelectorAll('iframe').forEach((f, i) => { if (iframesInvisiveis[i]) f.remove(); });
  doc.querySelectorAll('script:not([type="application/ld+json"]), noscript, link[rel=preload][as=script], link[rel=modulepreload], link[rel=prefetch], base, meta[http-equiv="Content-Security-Policy" i]').forEach((el) => el.remove());
  for (const el of doc.querySelectorAll('*')) {
    for (const at of [...el.attributes]) {
      const n = at.name;
      if (/^on/i.test(n) || n === 'integrity') el.removeAttribute(n);
      else if (['src', 'href', 'poster', 'action'].includes(n) && at.value && !/^(#|javascript:|mailto:|tel:|data:)/i.test(at.value.trim())) el.setAttribute(n, abs(at.value.trim()));
      else if (n === 'srcset') el.setAttribute(n, absSrcset(at.value));
    }
  }
  const atributos = (el) => [...el.attributes].map((a) => [a.name, a.value]);
  const recursos = [...doc.querySelectorAll('img[src], video[poster], link[rel~=icon][href]')]
    .map((el) => el.getAttribute(el.tagName === 'VIDEO' ? 'poster' : el.tagName === 'LINK' ? 'href' : 'src'))
    .filter((u) => u && !u.startsWith('data:'));
  return {
    head: doc.querySelector('head')?.innerHTML || '',
    body: doc.querySelector('body')?.innerHTML || '',
    atrHtml: atributos(doc),
    atrBody: atributos(doc.querySelector('body') || doc),
    titulo: document.title,
    recursos,
  };
}

// Espera que o ecrã pare de mudar (animações de entrada, carregamentos).
async function estabilizar(page, maxMs = 6000) {
  const fim = Date.now() + maxMs;
  let antes = '';
  let iguais = 0;
  while (Date.now() < fim) {
    // Texto, imagens e animações de entrada (opacidade/posição a meio) têm de ter parado.
    const agora = await page.evaluate(() => {
      let anim = 0;
      try { anim = document.getAnimations().filter((a) => a.playState === 'running' && Number.isFinite(a.effect?.getComputedTiming?.().endTime)).length; } catch { /* sem API */ }
      let estilos = '';
      for (const el of document.querySelectorAll('[style*="opacity"],[style*="transform"]')) if (estilos.length < 4000) estilos += el.getAttribute('style');
      return { sig: document.body.innerText.replace(/\d+/g, '#').length + ':' + document.images.length + ':' + estilos.length + estilos.slice(-200), anim };
    }).catch(() => ({ sig: '', anim: 0 }));
    iguais = agora.sig === antes ? iguais + 1 : 0;
    // Parado e sem animações a correr — ou parado há tempo suficiente (animação em ciclo).
    if ((iguais >= 2 && !agora.anim) || iguais >= 6) return;
    antes = agora.sig;
    await page.waitForTimeout(350);
  }
}

// Espera que o passo mude; devolve quanto tempo levou (ou -1).
async function esperarMudanca(page, marcaAntes, maxMs) {
  const inicio = Date.now();
  while (Date.now() - inicio < maxMs) {
    await page.waitForTimeout(300);
    const m = await page.evaluate(() => location.pathname + '|' + document.body.innerText.replace(/\d+/g, '#').replace(/\s+/g, ' ').slice(0, 3000)).catch(() => null);
    if (m && m !== marcaAntes) return Date.now() - inicio;
  }
  return -1;
}

function valorTeste(c) {
  const r = c.rotulo;
  if (c.tipo === 'email' || /mail/.test(r)) return { valor: 'teste@exemplo.com', campo: 'email' };
  if (c.tipo === 'tel' || /telefone|telem|whats|celular|phone/.test(r)) return { valor: '923000000', campo: 'telefone' };
  if (/nome|name/.test(r) && c.tipo !== 'number') return { valor: NOME_TESTE, campo: 'nome' };
  if (/altura|height|\bcm\b/.test(r)) return { valor: '165', campo: 'altura' };
  if (/(meta|desejad|ideal|objetivo|alvo|goal|target)/.test(r) && /peso|weight|kg/.test(r)) return { valor: '62', campo: 'meta' };
  if (/peso|weight|\bkg\b/.test(r)) return { valor: '78', campo: 'peso' };
  if (/idade|\bage\b|anos/.test(r)) return { valor: '45', campo: 'idade' };
  if (c.tipo === 'number' || c.tipo === 'range') return { valor: '50', campo: 'numero' };
  return { valor: 'teste', campo: 'texto' };
}

async function preencherCampos(page, campos) {
  const preenchidos = [];
  for (const c of campos) {
    if (!c.vazio && c.tipo !== 'range') continue;
    const loc = page.locator(`[data-clon-campo="${c.j}"]`);
    const { valor, campo } = valorTeste(c);
    try {
      if (c.tipo === 'select') await loc.selectOption({ index: 1 }, { timeout: 3000 });
      else if (c.tipo === 'range') {
        await loc.evaluate((el) => {
          const v = String((Number(el.min || 0) + Number(el.max || 100)) / 2);
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
        });
      } else await loc.fill(valor, { timeout: 3000 });
      preenchidos.push({ j: c.j, campo });
    } catch { /* campo que não aceitou */ }
  }
  return preenchidos;
}

const clicar = (page, i) => page.locator(`[data-clon-i="${i}"]`).first().click({ timeout: 4000 }).then(() => true).catch(() => false);

// ── Percorrer o quiz
export async function clonarQuiz({ url, formato = 'telemovel', dataDir, escolhas = {}, aoProgredir = () => {} }) {
  const alvo = await validarUrl(url);
  const id = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  const pasta = path.join(dataDir, 'pages', id);
  await mkdir(path.join(pasta, 'assets'), { recursive: true });
  await mkdir(path.join(pasta, 'passos'), { recursive: true });

  const browser = await getBrowser();
  const perfil = formato === 'computador' ? { viewport: { width: 1366, height: 900 }, deviceScaleFactor: 1 } : { ...devices['Pixel 7'] };
  const context = await browser.newContext({ ...perfil, locale: 'pt-PT', ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const hostAlvo = new URL(alvo).hostname;

  // Rastreio bloqueado; e o quiz não sai para o checkout (paramos no último ecrã).
  let saiu = '';
  await page.route('**/*', (route) => {
    const req = route.request();
    const u = req.url();
    if (HOSTS_RASTREIO.some((h) => u.includes(h))) return route.abort();
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
      try {
        if (new URL(u).hostname !== hostAlvo) { saiu = u; return route.abort(); }
      } catch { /* segue */ }
    }
    return route.continue();
  });

  const capturados = new Map();
  let totalBytes = 0;
  const pendentes = [];
  page.on('response', (resp) => {
    const req = resp.request();
    const u = resp.url();
    if (!TIPOS_GUARDADOS.has(req.resourceType()) || resp.status() !== 200 || !/^https?:/.test(u) || capturados.has(u)) return;
    pendentes.push((async () => {
      try {
        const buf = await resp.body();
        if (buf.length > MAX_ASSET_BYTES || totalBytes + buf.length > MAX_TOTAL_BYTES) return;
        totalBytes += buf.length;
        capturados.set(u, { buf, contentType: resp.headers()['content-type'] || '', tipo: req.resourceType() });
      } catch { /* sem corpo */ }
    })());
  });

  const inicio = Date.now();
  const passos = [];
  const marcas = new Set();
  try {
    await page.goto(alvo, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});

    for (let n = 0; n < MAX_PASSOS && Date.now() - inicio < TEMPO_MAX; n++) {
      await estabilizar(page);
      if (n === 0) await page.evaluate(tirarPopups).catch(() => {});
      const info = await page.evaluate(lerPasso);
      if (marcas.has(info.marca)) { passos.at(-1).nota = 'O quiz voltou a um passo já visto — parei aqui.'; break; }
      marcas.add(info.marca);
      aoProgredir(`Passo ${n + 1}: ${info.titulo.slice(0, 60)}`);

      const foto = await page.evaluate(fotografarPasso);
      const miniatura = await page.screenshot({ type: 'jpeg', quality: 55, timeout: 10000 }).catch(() => null);
      if (miniatura) await writeFile(path.join(pasta, 'passos', `${n}.jpg`), miniatura);
      if (n === 0 && miniatura) await writeFile(path.join(pasta, 'thumb.jpg'), miniatura);
      const passo = { n, url: info.url, titulo: info.titulo, foto, tipo: 'final', campos: [], opcoes: [], cta: null };
      passos.push(passo);

      const opcoes = info.itens.filter((x) => x.tipo === 'opcao');
      const ctas = info.itens.filter((x) => x.tipo === 'cta');
      passo.voltar = info.itens.filter((x) => x.tipo === 'voltar').map((x) => x.i);
      passo.opcoes = opcoes.map((x) => x.i);
      passo.ctas = ctas.map((x) => x.i);

      // Página de oferta: tem preço e já não há perguntas. Fica como último passo.
      if (info.preco && !info.campos.length && opcoes.length < 2 && n > 0) { passo.tipo = 'final'; break; }

      passo.campos = await preencherCampos(page, info.campos);
      const marca = info.marca;
      let ms = -1;
      if (opcoes.length && !(passo.campos.length && ctas.length)) {
        const k = Math.min(Number(escolhas[n]) || 0, opcoes.length - 1);
        passo.escolhida = opcoes[k].i;
        await clicar(page, opcoes[k].i);
        ms = await esperarMudanca(page, marca, 2500);
        if (ms >= 0) passo.tipo = 'opcoes';
        else {
          // Várias respostas + botão "Continuar" (que às vezes só acorda depois de escolher).
          const depois = await page.evaluate(lerPasso);
          const cta = depois.itens.find((x) => x.tipo === 'cta') || depois.itens.find((x) => x.tipo === 'desligado');
          if (cta && await clicar(page, cta.i)) {
            ms = await esperarMudanca(page, marca, 4000);
            // A fotografia foi tirada com a numeração de antes: procura-se lá o mesmo botão.
            const noPasso = info.itens.find((x) => x.texto === cta.texto && ['cta', 'desligado', 'opcao'].includes(x.tipo));
            if (ms >= 0) {
              passo.tipo = 'multi';
              passo.cta = noPasso?.i ?? null;
              if (noPasso) passo.opcoes = passo.opcoes.filter((i) => i !== noPasso.i);
            }
          }
        }
      } else {
        // Depois de escrever, o botão "Continuar" costuma acordar: lê-se outra vez.
        const depois = passo.campos.length || !ctas.length ? await page.evaluate(lerPasso) : null;
        const cta = depois ? depois.itens.filter((x) => x.tipo === 'cta').at(-1) : ctas.at(-1);
        if (cta && await clicar(page, cta.i)) {
          ms = await esperarMudanca(page, marca, 4000);
          const noPasso = depois ? info.itens.find((x) => x.texto === cta.texto && x.tipo !== 'voltar') : cta;
          if (ms >= 0) { passo.tipo = passo.campos.length ? 'campos' : 'cta'; passo.cta = noPasso?.i ?? null; }
        }
      }
      if (ms < 0 && !saiu) {
        // Ecrãs de "a analisar as tuas respostas…" que avançam sozinhos.
        const espera = await esperarMudanca(page, marca, 15000);
        if (espera >= 0) { passo.tipo = 'auto'; passo.auto = Math.min(9000, Math.max(1500, espera)); ms = espera; }
      }
      if (ms < 0) { passo.tipo = 'final'; break; }
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    }
    if (!passos.length) throw new Error('Não consegui abrir o quiz.');

    await Promise.allSettled(pendentes);
    page.removeAllListeners('response');
    const guardados = new Map(capturados);
    const todosRecursos = passos.flatMap((p) => p.foto.recursos);
    await buscarEmFalta(context, guardados, passos.map((p) => p.foto.head + p.foto.body).join('\n'), passos[0].url, todosRecursos);

    // Ficheiros locais e reescrita dos endereços (como no clone normal).
    const local = new Map();
    for (const [u, a] of guardados) local.set(u, `assets/${createHash('sha1').update(u).digest('hex').slice(0, 16)}${extensao(u, a.contentType)}`);
    const mapear = (abs) => local.get(abs) || local.get(abs.split('#')[0]) || abs;
    for (const [u, a] of guardados) {
      let conteudo = a.buf;
      if (a.tipo === 'stylesheet' || a.contentType.includes('text/css')) {
        conteudo = Buffer.from(reescreverCss(a.buf.toString('utf8'), u, (x) => mapear(x).replace(/^assets\//, '')), 'utf8');
      }
      await writeFile(path.join(pasta, local.get(u)), conteudo);
    }
    const urls = [...local.keys()].sort((a, b) => b.length - a.length);
    const reescrever = (html, base) => {
      html = html.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (_, a, css, b) => a + reescreverCss(css, base, mapear) + b);
      html = html.replace(/style="([^"]*)"/gi, (_, css) => `style="${reescreverCss(css.replace(/&quot;/g, '"'), base, mapear).replace(/"/g, '&quot;')}"`);
      for (const u of urls) {
        for (const v of new Set([u, u.replace(/&/g, '&amp;')])) html = html.replace(new RegExp(escaparRegex(v) + '(?=["\'\\s,)])', 'g'), local.get(u));
      }
      return html;
    };

    const html = montar(passos, reescrever);
    await writeFile(path.join(pasta, 'index.html'), html, 'utf8');

    const meta = {
      id,
      url: alvo,
      urlFinal: passos[0].url,
      titulo: passos[0].foto.titulo || new URL(alvo).hostname,
      formato,
      modo: 'quiz',
      aviso: saiu ? 'Parei no último ecrã antes do checkout.' : passos.at(-1).nota || '',
      removidos: { rastreio: 0, antiClone: 0 },
      pixelsOriginais: [],
      meusPixels: [],
      spa: null,
      quiz: {
        passos: passos.map((p) => ({ titulo: p.titulo, tipo: p.tipo, auto: p.auto || 0, campos: p.campos.map((c) => c.campo) })),
        checkout: saiu || null,
      },
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

// ── Juntar os passos numa página: cada passo é um <div data-quiz-passo> com
// display:contents quando activo (fica igual a estar directamente no <body>).
const atrs = (lista) => lista.filter(([n]) => !/^on/i.test(n)).map(([n, v]) => ` ${n}="${String(v).replace(/"/g, '&quot;')}"`).join('');
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

function montar(passos, reescrever) {
  // Estilos de todos os passos (alguns só aparecem a meio do quiz), sem repetir.
  const vistos = new Set();
  let cabeca = '';
  for (const p of passos) {
    const head = p.foto.head;
    const blocos = head.match(/<style\b[\s\S]*?<\/style>|<link\b[^>]*rel=["']?stylesheet[^>]*>/gi) || [];
    for (const b of blocos) if (!vistos.has(b)) { vistos.add(b); cabeca += b + '\n'; }
  }
  const metas = (passos[0].foto.head.match(/<meta\b[^>]*>|<link\b[^>]*rel=["']?(icon|apple-touch-icon|preconnect)[^>]*>/gi) || [])
    .filter((m) => !/http-equiv/i.test(m)).join('\n');
  const base = passos[0].url;

  const corpo = passos.map((p, k) => {
    let b = p.foto.body;
    // O nome escrito no teste passa a ser o nome que o visitante escrever.
    if (k > 0 && passos.slice(0, k).some((q) => q.campos.some((c) => c.campo === 'nome'))) {
      b = b.replace(/>([^<]*)</g, (m, txt) => (txt.includes(NOME_TESTE) ? '>' + txt.split(NOME_TESTE).join('<span data-quiz-valor="nome"></span>') + '<' : m));
    }
    // Quem faz o quê neste passo.
    const marcar = (i, extra) => {
      b = b.replace(new RegExp(`data-clon-i="${i}"`, 'g'), `data-clon-i="${i}" ${extra}`);
    };
    if (p.tipo === 'opcoes' || p.tipo === 'multi') p.opcoes.forEach((i) => marcar(i, 'data-quiz-opcao'));
    if (p.tipo !== 'final') {
      (p.cta != null ? [p.cta] : p.ctas || []).forEach((i) => marcar(i, 'data-quiz-ir="seguinte"'));
      (p.voltar || []).forEach((i) => marcar(i, 'data-quiz-ir="anterior"'));
    }
    for (const c of p.campos) {
      b = b.replace(new RegExp(`data-clon-campo="${c.j}"`), `data-clon-campo="${c.j}" data-quiz-campo="${c.campo}"`);
    }
    // Botões "Continuar" que estavam desligados à espera de resposta.
    b = b.replace(/<(button|input)\b[^>]*data-quiz-ir="seguinte"[^>]*>/gi, (tag) => tag.replace(/\sdisabled(="[^"]*")?(?=[\s>/])/i, ''));
    const extra = p.tipo === 'auto' ? ` data-quiz-auto="${p.auto}"` : '';
    return `<div data-quiz-passo="${k}" data-quiz-foto="${k}" data-quiz-tipo="${p.tipo}" data-quiz-titulo="${escAttr(p.titulo)}"${extra}${k === 0 ? ' class="ativo"' : ''}>\n${reescrever(b, p.url)}\n</div>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html${atrs(passos[0].foto.atrHtml)}>
<head>
${metas}
<title>${escAttr(passos[0].foto.titulo)}</title>
${reescrever(cabeca, base)}
<style id="clon-quiz-css">${CSS_QUIZ}</style>
</head>
<body${atrs(passos[0].foto.atrBody)}>
${corpo}
<script id="clon-quiz-js">${JS_QUIZ}</script>
</body>
</html>`;
}

export const CSS_QUIZ = '[data-quiz-passo]{display:none}[data-quiz-passo].ativo{display:contents}[data-quiz-opcao]{cursor:pointer}[data-quiz-opcao].clon-sel{outline:3px solid currentColor;outline-offset:-3px}[data-quiz-campo].clon-falta{outline:2px solid #e03131}';

// O motor do quiz na página publicada (sem dependências; também guarda as respostas
// em window.clonQuiz e avisa cada passo com o evento "clonquiz:passo" — base das métricas).
export const JS_QUIZ = `(function(){
var P=[].slice.call(document.querySelectorAll('[data-quiz-passo]')),a=0,t,d={};
window.clonQuiz={respostas:d,passo:function(){return a},total:P.length};
function aviso(){try{window.dispatchEvent(new CustomEvent('clonquiz:passo',{detail:{passo:a,total:P.length,titulo:P[a].getAttribute('data-quiz-titulo')}}))}catch(e){}}
function valores(){[].forEach.call(document.querySelectorAll('[data-quiz-valor]'),function(s){var v=d[s.getAttribute('data-quiz-valor')];s.textContent=v||''})}
function ir(n){if(n<0||n>=P.length)return;clearTimeout(t);P[a].classList.remove('ativo');a=n;P[a].classList.add('ativo');window.scrollTo(0,0);valores();aviso();var ms=+P[a].getAttribute('data-quiz-auto');if(ms)t=setTimeout(function(){ir(a+1)},ms)}
function campos(p){var ok=true;[].forEach.call(p.querySelectorAll('[data-quiz-campo]'),function(c){if(!String(c.value||'').trim()){ok=false;c.classList.add('clon-falta')}else{c.classList.remove('clon-falta');d[c.getAttribute('data-quiz-campo')]=c.value}});return ok}
document.addEventListener('click',function(e){var p=P[a];if(!p||!p.contains(e.target))return;var el=e.target.closest('[data-quiz-ir],[data-quiz-opcao]');if(!el||!p.contains(el))return;
if(el.hasAttribute('data-quiz-opcao')){e.preventDefault();d['p'+a]=(el.innerText||'').trim();if(p.getAttribute('data-quiz-tipo')==='multi'){el.classList.toggle('clon-sel')}else{[].forEach.call(p.querySelectorAll('.clon-sel'),function(x){x.classList.remove('clon-sel')});el.classList.add('clon-sel');setTimeout(function(){ir(a+1)},250)}return}
var v=el.getAttribute('data-quiz-ir');e.preventDefault();if(v==='anterior')return ir(a-1);if(!campos(p))return;if(/^\\d+$/.test(v))return ir(+v);ir(a+1)},true);
document.addEventListener('submit',function(e){var p=P[a];if(p&&p.contains(e.target)){e.preventDefault();if(campos(p))ir(a+1)}},true);
[].forEach.call(document.querySelectorAll('[data-quiz-ir][disabled]'),function(b){b.removeAttribute('disabled')});
var ms0=+P[0].getAttribute('data-quiz-auto');if(ms0)t=setTimeout(function(){ir(1)},ms0);aviso();
})();`;
