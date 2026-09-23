import express from 'express';
import { ZipArchive } from 'archiver';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readdir, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clonar } from './clone.js';
import { injectarPixels, removerPixel, validarMeusPixels } from './pixels.js';

const raiz = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(raiz, '..', 'data'));
const SENHA = process.env.APP_PASSWORD || '';
const PORTA = Number(process.env.PORT || 3000);
const VERSAO = process.env.GIT_SHA || process.env.VERSAO || 'local';
const ID_VALIDO = /^[a-z0-9]+-[a-f0-9]{6}$/;

await mkdir(path.join(DATA_DIR, 'pages'), { recursive: true });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));

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

const pastaDe = (id) => path.join(DATA_DIR, 'pages', id);

async function lerMeta(id) {
  try {
    return JSON.parse(await readFile(path.join(pastaDe(id), 'meta.json'), 'utf8'));
  } catch {
    return null;
  }
}

// O index.html fica como foi clonado; os teus pixels entram só na hora de servir.
async function htmlFinal(id) {
  const [html, meta] = await Promise.all([readFile(path.join(pastaDe(id), 'index.html'), 'utf8'), lerMeta(id)]);
  return injectarPixels(html, meta?.meusPixels || []);
}

// ── Páginas publicadas: abertas a toda a gente (é para aí que vai o tráfego).
app.use('/p/:id', async (req, res, next) => {
  const { id } = req.params;
  if (!ID_VALIDO.test(id)) return res.status(404).end();
  if (req.path === '/meta.json') return res.status(404).end();
  if (req.originalUrl.split('?')[0] === `/p/${id}`) return res.redirect(301, `/p/${id}/`);
  if (req.path === '/' || req.path === '/index.html') {
    try {
      res.setHeader('Cache-Control', 'no-cache');
      return res.type('html').send(await htmlFinal(id));
    } catch {
      return res.status(404).send('Página não encontrada.');
    }
  }
  express.static(pastaDe(id), { index: false, maxAge: '7d' })(req, res, next);
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

app.get('/api/clones', async (req, res) => {
  const ids = (await readdir(path.join(DATA_DIR, 'pages'))).filter((id) => ID_VALIDO.test(id));
  const metas = (await Promise.all(ids.map(lerMeta))).filter(Boolean);
  metas.sort((a, b) => b.criadoEm.localeCompare(a.criadoEm));
  res.json(metas);
});

let emCurso = 0;
app.post('/api/clones', async (req, res) => {
  if (emCurso >= 2) return res.status(429).json({ erro: 'Já estou a clonar duas páginas. Espera uns segundos.' });
  emCurso++;
  const inicio = Date.now();
  try {
    const { url, formato, manterScripts, removerPopups } = req.body || {};
    const meta = await clonar({
      url,
      formato: formato === 'computador' ? 'computador' : 'telemovel',
      manterScripts: Boolean(manterScripts),
      removerPopups: removerPopups !== false,
      dataDir: DATA_DIR,
    });
    console.log(`[clone] ${meta.id} ${meta.url} ${meta.ficheiros} ficheiros em ${Date.now() - inicio}ms`);
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

app.put('/api/clones/:id/pixels', async (req, res) => {
  if (!ID_VALIDO.test(req.params.id)) return res.status(404).end();
  try {
    const meta = await comMeta(req.params.id, (m) => { m.meusPixels = validarMeusPixels(req.body?.meusPixels); });
    res.json(meta);
  } catch (err) {
    res.status(err.status || 400).json({ erro: err.message });
  }
});

// Só faz falta quando se clonou com "Manter scripts" — sem scripts, os pixels já saíram.
app.post('/api/clones/:id/pixels/remover', async (req, res) => {
  const { id } = req.params;
  if (!ID_VALIDO.test(id)) return res.status(404).end();
  const alvo = String(req.body?.id || '');
  let removidos = 0;
  try {
    const meta = await comMeta(id, async (m) => {
      const pixel = (m.pixelsOriginais || []).find((p) => p.id === alvo);
      if (!pixel) throw Object.assign(new Error('Esse pixel não está nesta página.'), { status: 404 });
      const ficheiro = path.join(pastaDe(id), 'index.html');
      const r = removerPixel(await readFile(ficheiro, 'utf8'), alvo);
      removidos = r.removidos;
      await writeFile(ficheiro, r.html, 'utf8');
      pixel.estado = removidos ? 'removido' : 'via-gtm';
    });
    res.json({ meta, removidos });
  } catch (err) {
    res.status(err.status || 400).json({ erro: err.message });
  }
});

app.delete('/api/clones/:id', async (req, res) => {
  if (!ID_VALIDO.test(req.params.id)) return res.status(404).end();
  await rm(path.join(DATA_DIR, 'pages', req.params.id), { recursive: true, force: true });
  res.json({ ok: true });
});

app.get('/api/clones/:id/zip', async (req, res) => {
  const { id } = req.params;
  const pasta = path.join(DATA_DIR, 'pages', id);
  if (!ID_VALIDO.test(id) || !existsSync(pasta)) return res.status(404).end();
  const meta = await lerMeta(id);
  const nome = (meta?.titulo || id).normalize('NFD').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || id;
  res.attachment(`${nome}.zip`);
  const zip = new ZipArchive({ zlib: { level: 6 } });
  zip.on('error', (err) => res.destroy(err));
  zip.pipe(res);
  zip.append(await htmlFinal(id), { name: 'index.html' });
  zip.glob('**/*', { cwd: pasta, ignore: ['meta.json', 'thumb.jpg', 'index.html'] });
  await zip.finalize();
});

app.listen(PORTA, '0.0.0.0', () => {
  console.log(`Clonador (${VERSAO}) em http://localhost:${PORTA}  — dados em ${DATA_DIR}`);
  if (!SENHA) console.warn('AVISO: APP_PASSWORD não definida — o painel está aberto. Só serve no PC.');
});
