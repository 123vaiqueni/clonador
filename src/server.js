import express from 'express';
import { ZipArchive } from 'archiver';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { copyFile, readdir, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clonar } from './clone.js';
import { injectarPixels, removerPixel, validarMeusPixels } from './pixels.js';
import { aplicarSubstituicoes, extrairLinks, linkWhatsApp, validarSubstituicoes } from './links.js';
import { netlifyLigado, publicarNetlify, zipEmMemoria } from './publicar.js';
import { trocarCoresCss, trocarCoresHtml, validarMapa } from './cores.js';

const raiz = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(raiz, '..', 'data'));
const SENHA = process.env.APP_PASSWORD || '';
const PORTA = Number(process.env.PORT || 3000);
const VERSAO = process.env.GIT_SHA || process.env.VERSAO || 'local';
const IP_SERVIDOR = process.env.IP_SERVIDOR || '';
const ID_VALIDO = /^[a-z0-9]+-[a-f0-9]{6}$/;
const SLUG_VALIDO = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;
const DOMINIO_VALIDO = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
// Primeiros segmentos que pertencem ao próprio app — não podem ser nomes de página.
const RESERVADOS = new Set(['api', 'p', 'login', 'assets', 'style.css', 'icon.svg', 'sw.js', 'manifest.webmanifest', 'index.html', 'favicon.ico', 'robots.txt']);

await mkdir(path.join(DATA_DIR, 'pages'), { recursive: true });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
// O editor envia a página inteira ao guardar — algumas passam de 1 MB.
app.use(express.json({ limit: '25mb' }));

// ── Sessão: um cookie assinado com a senha. Sem senha definida, fica aberto (só para o PC).
const tokenSessao = () => createHmac('sha256', SENHA).update('clonador-sessao-v1').digest('hex');
function lerCookie(req, nome) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${nome}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : '';
}
function autenticado(req) {
  if (!SENHA) return true;
  const a = Buffer.from(lerCookie(req, 'clonador'));
  const b = Buffer.from(tokenSessao());
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── Páginas guardadas
const pastaDe = (id) => path.join(DATA_DIR, 'pages', id);

async function lerMeta(id) {
  try {
    return JSON.parse(await readFile(path.join(pastaDe(id), 'meta.json'), 'utf8'));
  } catch {
    return null;
  }
}

// Índice em memória: link curto → página, domínio → página.
let porSlug = new Map();
let porDominio = new Map();
async function reconstruirIndice() {
  const ids = (await readdir(path.join(DATA_DIR, 'pages'))).filter((id) => ID_VALIDO.test(id));
  const metas = (await Promise.all(ids.map(lerMeta))).filter(Boolean);
  porSlug = new Map(metas.filter((m) => m.slug).map((m) => [m.slug, m.id]));
  porDominio = new Map(metas.flatMap((m) => (m.dominios || []).map((d) => [d, m.id])));
  return metas;
}
await reconstruirIndice();

// O index.html fica como foi clonado; pixels e links trocados entram só na hora de servir.
async function htmlFinal(id, prefixo = '/') {
  const [html, meta] = await Promise.all([readFile(path.join(pastaDe(id), 'index.html'), 'utf8'), lerMeta(id)]);
  const comLinks = aplicarSubstituicoes(html, meta?.substituicoes || []);
  const final = injectarPixels(injectarAjustes(comLinks, meta), meta?.meusPixels || []);
  return meta?.spa ? prepararApp(final, meta.spa, prefixo, true) : final;
}

// ── Páginas "app" (Lovable, React, Vite): os ficheiros do site estão nos caminhos
// originais ("/assets/x.js", "/lovable-uploads/y.png"). Quando a página é servida em
// /p/<id>/ ou /<nome>/, esses caminhos passam a apontar para lá. E o "router" da app
// tem de ver o caminho original, senão mostra a página "404" dela.
function prepararApp(texto, spa, prefixo, eHtml) {
  if (prefixo !== '/' && spa.segmentos?.length) {
    const segs = spa.segmentos.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    // Também depois de "," — os vários tamanhos de um srcset.
    texto = texto.replace(new RegExp(`(["'\`(=,]\\s*)/(${segs})(?=[/"'\`)?#\\s])`, 'g'), `$1${prefixo}$2`);
  }
  if (eHtml && prefixo !== '/' && spa.router) {
    // O endereço passa a ser o caminho original + ?_pg=<página>. A app vê o caminho
    // que conhece, e se o visitante actualizar, o servidor sabe que página servir.
    const caminho = JSON.stringify(spa.caminho || '/');
    const pg = JSON.stringify(prefixo.replace(/^\/(p\/)?|\/$/g, ''));
    const shim = `<script>(function(){var o=${caminho},p=${pg};if(location.pathname!==o){`
      + `var q=new URLSearchParams(location.search);q.set('_pg',p);`
      + `history.replaceState(history.state,'',o+'?'+q.toString()+location.hash)}})();</script>`;
    texto = /<head[^>]*>/i.test(texto) ? texto.replace(/<head[^>]*>/i, (m) => m + shim) : shim + texto;
  }
  return texto;
}

// Âncoras deslizam suavemente; com "otimizar para mobile" ligado, correcções que
// resolvem a maioria das páginas pensadas só para computador.
const CSS_MOBILE = `html,body{overflow-x:hidden!important;max-width:100%}
img,video,iframe,embed,object,svg{max-width:100%!important;height:auto}
iframe[src*="youtube"],iframe[src*="vimeo"],iframe[src*="vturb"],iframe[src*="panda"]{aspect-ratio:16/9;height:auto!important;width:100%!important}
table{display:block;max-width:100%;overflow-x:auto}
*{overflow-wrap:break-word}
@media (max-width:768px){
  [style*="width"]:not(img):not(video):not(iframe){max-width:100%!important}
  body [class*="container"],body [class*="wrapper"],body section{max-width:100%!important;box-sizing:border-box}
  body h1{font-size:clamp(26px,7.5vw,40px)!important;line-height:1.15!important}
  body h2{font-size:clamp(22px,6.2vw,32px)!important;line-height:1.2!important}
  body p,body li{font-size:max(16px,1em)}
  body a[class*="btn"],body a[class*="button"],body button{min-height:48px}
}`;
function injectarAjustes(html, meta) {
  let css = 'html{scroll-behavior:smooth}';
  if (meta?.mobile) css += '\n' + CSS_MOBILE;
  let bloco = `<style id="clonador-ajustes">${css}</style>`;
  if (meta?.mobile && !/<meta[^>]+name=["']viewport["']/i.test(html)) {
    bloco = '<meta name="viewport" content="width=device-width, initial-scale=1">' + bloco;
  }
  return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${bloco}</head>`) : bloco + html;
}

// Serve uma página a partir de um caminho relativo a ela ('/', '/assets/x.css', …).
// O que não existir na cópia é pedido ao site original (scripts que carregam
// ficheiros por caminho relativo, fontes esquecidas…).
// Caminho do ficheiro dentro da pasta da página, ou null se não existir (ou tentar sair dela).
function ficheiroDaPagina(id, subcaminho) {
  let rel = subcaminho;
  try { rel = decodeURIComponent(subcaminho); } catch { /* fica como veio */ }
  const ficheiro = path.join(pastaDe(id), path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!ficheiro.startsWith(pastaDe(id) + path.sep)) return null;
  return existsSync(ficheiro) && statSync(ficheiro).isFile() ? ficheiro : null;
}

async function servirPagina(id, subcaminho, req, res, next, prefixo = '/') {
  if (subcaminho === '/meta.json' || subcaminho === '/index.original.html' || subcaminho.startsWith('/original/')) {
    return res.status(404).end();
  }
  if (subcaminho === '/' || subcaminho === '/index.html') {
    try {
      res.setHeader('Cache-Control', 'no-cache');
      // O editor abre a cópia "crua" (sem pixels nem links trocados), para guardar só o que se editou.
      if (req.query.cru === '1' && autenticado(req)) {
        return res.type('html').send(await readFile(path.join(pastaDe(id), 'index.html'), 'utf8'));
      }
      return res.type('html').send(await htmlFinal(id, prefixo));
    } catch {
      return res.status(404).send('Página não encontrada.');
    }
  }
  const meta = await lerMeta(id);
  let rel = subcaminho;
  try { rel = decodeURIComponent(subcaminho); } catch { /* fica como veio */ }
  const ficheiro = ficheiroDaPagina(id, subcaminho);
  if (ficheiro) {
    // Nas páginas app, JS/CSS também levam os caminhos ajustados ao endereço publicado.
    if (meta?.spa && prefixo !== '/' && /\.(m?js|css|json|webmanifest)$/i.test(ficheiro)) {
      const texto = prepararApp(await readFile(ficheiro, 'utf8'), meta.spa, prefixo, false);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.type(path.extname(ficheiro)).send(texto);
    }
    return res.sendFile(ficheiro, { maxAge: '7d', dotfiles: 'deny' });
  }
  // Rota interna de uma app (ex.: /obrigado) — a app trata dela.
  if (meta?.spa && req.method === 'GET' && !path.extname(rel)) {
    return res.type('html').send(await htmlFinal(id, prefixo));
  }
  if (meta?.urlFinal && req.method === 'GET') {
    try {
      const destino = new URL(subcaminho.replace(/^\//, '') + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''), meta.urlFinal);
      return res.redirect(302, destino.toString());
    } catch { /* cai no 404 */ }
  }
  next();
}

// ── 1. Domínios próprios: se o pedido vier por um domínio ligado a uma página, é essa página.
app.use((req, res, next) => {
  const host = (req.hostname || '').toLowerCase().replace(/^www\./, '');
  const id = porDominio.get(host) || porDominio.get(`www.${host}`);
  if (!id) return next();
  servirPagina(id, req.path, req, res, next);
});

// Página "app" depois de o visitante actualizar: o endereço é o caminho original com ?_pg=.
function idDePg(pg) {
  pg = String(pg || '').toLowerCase();
  return ID_VALIDO.test(pg) ? pg : porSlug.get(pg);
}
app.use((req, res, next) => {
  if (req.method !== 'GET' || !req.query._pg || req.path.startsWith('/api/')) return next();
  const id = idDePg(req.query._pg);
  if (!id) return next();
  const prefixo = ID_VALIDO.test(String(req.query._pg)) ? `/p/${id}/` : `/${String(req.query._pg).toLowerCase()}/`;
  servirPagina(id, path.extname(req.path) ? req.path : '/', req, res, next, prefixo);
});

app.get('/api/versao', (req, res) => res.json({ versao: VERSAO }));

app.post('/api/login', (req, res) => {
  if (!SENHA) return res.json({ ok: true });
  const dada = Buffer.from(String(req.body?.senha || ''));
  const certa = Buffer.from(SENHA);
  if (dada.length !== certa.length || !timingSafeEqual(dada, certa)) {
    return res.status(401).json({ erro: 'Senha errada.' });
  }
  const seguro = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `clonador=${tokenSessao()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 60}${seguro}`);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'clonador=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// ── 2. Páginas públicas: /p/<id>/… e /<link-curto>/…
app.use('/p/:id', (req, res, next) => {
  const { id } = req.params;
  if (!ID_VALIDO.test(id)) return res.status(404).end();
  if (req.originalUrl.split('?')[0] === `/p/${id}`) return res.redirect(301, `/p/${id}/`);
  servirPagina(id, req.path, req, res, next, `/p/${id}/`);
});

app.use((req, res, next) => {
  const [, primeiro, ...resto] = req.path.split('/');
  const id = primeiro && !RESERVADOS.has(primeiro) ? porSlug.get(primeiro.toLowerCase()) : null;
  if (!id) return next();
  if (!resto.length) return res.redirect(301, `/${primeiro}/${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`);
  servirPagina(id, '/' + resto.join('/'), req, res, next, `/${primeiro}/`);
});

// ── 3. Pedidos "perdidos" de uma página (caminhos a começar por /, ex.: /wp-content/…):
// a página está em /p/<id>/, mas o script pediu à raiz. Mandamos para o site original.
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
  let ref;
  try { ref = new URL(req.get('referer') || ''); } catch { return next(); }
  if (ref.host !== req.get('host')) return next();
  const m = ref.pathname.match(/^\/p\/([a-z0-9]+-[a-f0-9]{6})\//) || ref.pathname.match(/^\/([a-z0-9-]+)\//);
  const id = (m && (ID_VALIDO.test(m[1]) ? m[1] : porSlug.get(m[1]))) || idDePg(ref.searchParams.get('_pg'));
  if (!id || existsSync(path.join(raiz, '..', 'public', req.path))) return next();
  // Primeiro a cópia (ficheiro guardado na página); se não existir, o site original.
  if (ficheiroDaPagina(id, req.path)) {
    const pg = m?.[1] || String(ref.searchParams.get('_pg') || '').toLowerCase();
    return servirPagina(id, req.path, req, res, next, ID_VALIDO.test(pg) ? `/p/${pg}/` : `/${pg}/`);
  }
  lerMeta(id).then((meta) => {
    if (!meta?.urlFinal) return next();
    res.redirect(302, new URL(req.originalUrl, meta.urlFinal).toString());
  }).catch(next);
});

// ── Daqui para baixo, só com sessão.
app.get('/login', (req, res) => res.sendFile(path.join(raiz, '..', 'public', 'login.html')));
app.use((req, res, next) => {
  if (autenticado(req)) return next();
  const livre = ['/manifest.webmanifest', '/icon.svg', '/sw.js'];
  if (livre.includes(req.path)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ erro: 'Sessão expirada. Entra outra vez.' });
  res.redirect('/login');
});
app.use(express.static(path.join(raiz, '..', 'public')));

app.get('/api/config', (req, res) => res.json({ netlify: netlifyLigado(), ipServidor: IP_SERVIDOR, versao: VERSAO }));

app.get('/api/clones', async (req, res) => {
  const metas = await reconstruirIndice();
  metas.sort((a, b) => b.criadoEm.localeCompare(a.criadoEm));
  res.json(metas);
});

let emCurso = 0;
app.post('/api/clones', async (req, res) => {
  if (emCurso >= 2) return res.status(429).json({ erro: 'Já estou a clonar duas páginas. Espera uns segundos.' });
  emCurso++;
  const inicio = Date.now();
  try {
    const { url, formato, modo, removerPopups } = req.body || {};
    const meta = await clonar({
      url,
      formato: formato === 'computador' ? 'computador' : 'telemovel',
      modo: modo === 'estatica' ? 'estatica' : 'movimento',
      removerPopups: removerPopups !== false,
      dataDir: DATA_DIR,
    });
    console.log(`[clone] ${meta.id} ${meta.url} ${meta.modo} ${meta.ficheiros} ficheiros em ${Date.now() - inicio}ms`);
    res.json(meta);
  } catch (err) {
    console.error('[clone] falhou:', err.stack || err.message);
    const msg = /Timeout/i.test(err.message)
      ? 'A página demorou demasiado a abrir. Tenta outra vez ou confirma o link.'
      : /net::ERR_NAME_NOT_RESOLVED/.test(err.message) ? 'Não encontrei esse site. Confirma o link.'
      : err.message.split('\n')[0];
    res.status(400).json({ erro: msg });
  } finally {
    emCurso--;
  }
});

// Escritas no meta.json de uma página, uma de cada vez (evita perder alterações simultâneas).
const filas = new Map();
function comMeta(id, alterar) {
  const anterior = filas.get(id) || Promise.resolve();
  const agora = anterior.catch(() => {}).then(async () => {
    const meta = await lerMeta(id);
    if (!meta) throw Object.assign(new Error('Página não encontrada.'), { status: 404 });
    await alterar(meta);
    await writeFile(path.join(pastaDe(id), 'meta.json'), JSON.stringify(meta, null, 2));
    return meta;
  });
  filas.set(id, agora);
  return agora;
}

// Envolve uma rota /api/clones/:id/… com validação do id e erros em JSON.
const rota = (fn) => async (req, res) => {
  if (!ID_VALIDO.test(req.params.id)) return res.status(404).json({ erro: 'Página não encontrada.' });
  try {
    res.json(await fn(req, req.params.id));
  } catch (err) {
    if (!err.status) console.error('[api]', err.stack || err.message);
    res.status(err.status || 400).json({ erro: err.message });
  }
};
const erro = (msg, status = 400) => Object.assign(new Error(msg), { status });

// ── Pixels
app.put('/api/clones/:id/pixels', rota((req, id) => comMeta(id, (m) => { m.meusPixels = validarMeusPixels(req.body?.meusPixels); })));

app.post('/api/clones/:id/pixels/remover', rota(async (req, id) => {
  const alvo = String(req.body?.id || '');
  let removidos = 0;
  const meta = await comMeta(id, async (m) => {
    const pixel = (m.pixelsOriginais || []).find((p) => p.id === alvo);
    if (!pixel) throw erro('Esse pixel não está nesta página.', 404);
    const ficheiro = path.join(pastaDe(id), 'index.html');
    const r = removerPixel(await readFile(ficheiro, 'utf8'), alvo);
    removidos = r.removidos;
    await writeFile(ficheiro, r.html, 'utf8');
    pixel.estado = removidos ? 'removido' : 'via-gtm';
  });
  return { meta, removidos };
}));

// ── Links (checkouts, WhatsApp, botões)
app.get('/api/clones/:id/links', rota(async (req, id) => {
  const [html, meta] = await Promise.all([readFile(path.join(pastaDe(id), 'index.html'), 'utf8'), lerMeta(id)]);
  const trocas = new Map((meta?.substituicoes || []).map((s) => [s.de, s.para]));
  return extrairLinks(html).map((l) => ({ ...l, novo: trocas.get(l.url) || '' }));
}));

app.put('/api/clones/:id/links', rota((req, id) => comMeta(id, (m) => {
  const lista = (req.body?.substituicoes || []).filter((s) => s && String(s.para || '').trim());
  m.substituicoes = validarSubstituicoes(lista);
})));

app.get('/api/whatsapp', (req, res) => {
  const n = String(req.query.numero || '').replace(/\D/g, '');
  if (n.length < 9) return res.status(400).json({ erro: 'Número inválido.' });
  res.json({ link: linkWhatsApp(n, String(req.query.mensagem || '')) });
});

// ── Publicação: link curto, domínio próprio, domínio grátis (Netlify)
app.put('/api/clones/:id/publicacao', rota(async (req, id) => {
  const slug = String(req.body?.slug ?? '').trim().toLowerCase();
  const dominios = [...new Set((req.body?.dominios || []).map((d) => String(d).trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean))];
  if (slug && (!SLUG_VALIDO.test(slug) || RESERVADOS.has(slug))) throw erro('O nome só pode ter letras minúsculas, números e hífens (ex.: oferta-emagrecer).');
  if (slug && porSlug.has(slug) && porSlug.get(slug) !== id) throw erro(`O nome "${slug}" já está a ser usado por outra página.`);
  for (const d of dominios) {
    if (!DOMINIO_VALIDO.test(d)) throw erro(`"${d}" não parece um domínio (ex.: minhaoferta.com).`);
    if (d === req.hostname.toLowerCase()) throw erro('Esse é o endereço do próprio clonador — usa outro domínio.');
    const dono = porDominio.get(d);
    if (dono && dono !== id) throw erro(`O domínio ${d} já está ligado a outra página.`);
  }
  if (dominios.length > 5) throw erro('No máximo 5 domínios por página.');
  const meta = await comMeta(id, (m) => { m.slug = slug || null; m.dominios = dominios; });
  await reconstruirIndice();
  return meta;
}));

app.post('/api/clones/:id/netlify', rota(async (req, id) => {
  const meta = await lerMeta(id);
  if (!meta) throw erro('Página não encontrada.', 404);
  const nome = String(req.body?.nome || meta.slug || meta.netlify?.nome || '').trim().toLowerCase();
  if (!SLUG_VALIDO.test(nome) || nome.length < 3) throw erro('Escolhe um nome para o site (letras, números e hífens).');
  // Ficheiros que faltem na cópia vão ao site original (como no nosso servidor).
  let origem = '';
  try { origem = new URL(meta.urlFinal).origin; } catch { /* sem origem */ }
  const zip = await zipEmMemoria(pastaDe(id), await htmlFinal(id), origem ? `/*  ${origem}/:splat  302\n` : '');
  const r = await publicarNetlify({ siteId: meta.netlify?.nome === nome ? meta.netlify?.siteId : null, nome, zip });
  return comMeta(id, (m) => { m.netlify = { nome, siteId: r.siteId, url: r.url, publicadoEm: new Date().toISOString() }; });
}));

// ── Editor
// Antes da primeira alteração guarda-se o original (index.original.html e original/*.css),
// para o botão "Repor original" poder desfazer tudo.
async function guardarOriginal(id) {
  const pasta = pastaDe(id);
  const copiaHtml = path.join(pasta, 'index.original.html');
  if (!existsSync(copiaHtml)) await copyFile(path.join(pasta, 'index.html'), copiaHtml);
  const pastaOrig = path.join(pasta, 'original');
  if (!existsSync(pastaOrig)) {
    await mkdir(pastaOrig, { recursive: true });
    for (const f of await readdir(path.join(pasta, 'assets'))) {
      if (f.endsWith('.css')) await copyFile(path.join(pasta, 'assets', f), path.join(pastaOrig, f));
    }
  }
}

app.put('/api/clones/:id/html', rota(async (req, id) => {
  const html = String(req.body?.html || '');
  if (html.length < 50 || !/<html[\s>]/i.test(html)) throw erro('O conteúdo da página veio vazio — não guardei nada.');
  await guardarOriginal(id);
  await writeFile(path.join(pastaDe(id), 'index.html'), html, 'utf8');
  return comMeta(id, (m) => { m.editadoEm = new Date().toISOString(); });
}));

const TIPOS_IMAGEM = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/svg+xml': '.svg', 'image/avif': '.avif', 'video/mp4': '.mp4' };
app.post('/api/clones/:id/upload', express.raw({ type: () => true, limit: '15mb' }), rota(async (req, id) => {
  const ext = TIPOS_IMAGEM[String(req.headers['content-type'] || '').split(';')[0]];
  if (!ext) throw erro('Formato não suportado. Usa JPG, PNG, WEBP, GIF, SVG ou MP4.');
  if (!req.body?.length) throw erro('O ficheiro veio vazio.');
  const nome = `up-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}${ext}`;
  await writeFile(path.join(pastaDe(id), 'assets', nome), req.body);
  return { src: `assets/${nome}` };
}));

app.post('/api/clones/:id/cores', rota(async (req, id) => {
  const mapa = validarMapa(req.body?.mapa);
  await guardarOriginal(id);
  const pasta = pastaDe(id);
  let ficheiros = 0;
  for (const f of await readdir(path.join(pasta, 'assets'))) {
    if (!f.endsWith('.css')) continue;
    const p = path.join(pasta, 'assets', f);
    const antes = await readFile(p, 'utf8');
    const depois = trocarCoresCss(antes, mapa);
    if (depois !== antes) { await writeFile(p, depois, 'utf8'); ficheiros++; }
  }
  const pHtml = path.join(pasta, 'index.html');
  await writeFile(pHtml, trocarCoresHtml(await readFile(pHtml, 'utf8'), mapa), 'utf8');
  await comMeta(id, (m) => { m.editadoEm = new Date().toISOString(); });
  return { ok: true, ficheiros };
}));

app.post('/api/clones/:id/repor', rota(async (req, id) => {
  const pasta = pastaDe(id);
  const copiaHtml = path.join(pasta, 'index.original.html');
  if (!existsSync(copiaHtml)) throw erro('Esta página ainda não foi editada.');
  await copyFile(copiaHtml, path.join(pasta, 'index.html'));
  const pastaOrig = path.join(pasta, 'original');
  if (existsSync(pastaOrig)) {
    for (const f of await readdir(pastaOrig)) await copyFile(path.join(pastaOrig, f), path.join(pasta, 'assets', f));
  }
  return comMeta(id, (m) => { delete m.editadoEm; m.mobile = false; });
}));

app.put('/api/clones/:id/mobile', rota((req, id) => comMeta(id, (m) => { m.mobile = Boolean(req.body?.ativo); })));

app.get('/api/clones/:id', rota(async (req, id) => {
  const meta = await lerMeta(id);
  if (!meta) throw erro('Página não encontrada.', 404);
  return meta;
}));

app.delete('/api/clones/:id', rota(async (req, id) => {
  await rm(pastaDe(id), { recursive: true, force: true });
  await reconstruirIndice();
  return { ok: true };
}));

app.get('/api/clones/:id/zip', async (req, res) => {
  const { id } = req.params;
  const pasta = pastaDe(id);
  if (!ID_VALIDO.test(id) || !existsSync(pasta)) return res.status(404).end();
  const meta = await lerMeta(id);
  const nome = (meta?.slug || meta?.titulo || id).normalize('NFD').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || id;
  res.attachment(`${nome}.zip`);
  const zip = new ZipArchive({ zlib: { level: 6 } });
  zip.on('error', (err) => res.destroy(err));
  zip.pipe(res);
  zip.append(await htmlFinal(id), { name: 'index.html' });
  zip.glob('**/*', { cwd: pasta, ignore: ['meta.json', 'thumb.jpg', 'index.html', 'index.original.html', 'original/**'] });
  await zip.finalize();
});

app.listen(PORTA, '0.0.0.0', () => {
  console.log(`Clonador (${VERSAO}) em http://localhost:${PORTA}  — dados em ${DATA_DIR}`);
  if (!SENHA) console.warn('AVISO: APP_PASSWORD não definida — o painel está aberto. Só serve no PC.');
});
