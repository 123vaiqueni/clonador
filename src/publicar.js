// Publicação em domínio grátis (nome.netlify.app) pela API da Netlify.
// Precisa de NETLIFY_TOKEN (Netlify → User settings → Applications → Personal access tokens).

import { ZipArchive } from 'archiver';
import { PassThrough } from 'node:stream';

const API = 'https://api.netlify.com/api/v1';

export const netlifyLigado = () => Boolean(process.env.NETLIFY_TOKEN);

async function netlify(caminho, opts = {}) {
  const r = await fetch(API + caminho, {
    ...opts,
    headers: { Authorization: `Bearer ${process.env.NETLIFY_TOKEN}`, ...(opts.headers || {}) },
  });
  const texto = await r.text();
  let dados = {};
  try { dados = JSON.parse(texto); } catch { /* resposta sem JSON */ }
  if (!r.ok) {
    const e = new Error(dados.message || dados.errors?.subdomain?.[0] || `Netlify respondeu ${r.status}`);
    e.status = r.status;
    e.dados = dados;
    throw e;
  }
  return dados;
}

// Junta num ZIP em memória: o index.html final (com pixels e links trocados) + os ficheiros.
export async function zipEmMemoria(pasta, htmlFinal, redirects = '') {
  const zip = new ZipArchive({ zlib: { level: 6 } });
  const saida = new PassThrough();
  const partes = [];
  saida.on('data', (c) => partes.push(c));
  const fim = new Promise((ok, falha) => { saida.on('end', ok); zip.on('error', falha); });
  zip.pipe(saida);
  zip.append(htmlFinal, { name: 'index.html' });
  if (redirects) zip.append(redirects, { name: '_redirects' });
  zip.glob('**/*', { cwd: pasta, ignore: ['meta.json', 'thumb.jpg', 'index.html', 'index.original.html', 'original/**'] });
  await zip.finalize();
  await fim;
  return Buffer.concat(partes);
}

// Cria o site (se ainda não existir) e faz o deploy. Devolve { siteId, url }.
export async function publicarNetlify({ siteId, nome, zip }) {
  if (!netlifyLigado()) throw new Error('A publicação grátis ainda não está ligada: falta o NETLIFY_TOKEN no servidor.');
  if (siteId) {
    try {
      await netlify(`/sites/${siteId}`);
    } catch (e) {
      if (e.status === 404) siteId = null; else throw e;
    }
  }
  if (!siteId) {
    let site = null;
    for (const tentativa of [nome, `${nome}-${Math.random().toString(36).slice(2, 6)}`]) {
      try {
        site = await netlify('/sites', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: tentativa }),
        });
        break;
      } catch (e) {
        if (e.status !== 422) throw e; // 422 = nome já ocupado por outra pessoa
      }
    }
    if (!site) throw new Error(`O nome "${nome}" já está ocupado na Netlify. Escolhe outro.`);
    siteId = site.id;
  }
  const deploy = await netlify(`/sites/${siteId}/deploys`, {
    method: 'POST',
    headers: { 'content-type': 'application/zip' },
    body: zip,
  });
  const site = await netlify(`/sites/${siteId}`);
  return { siteId, url: site.ssl_url || site.url, deployId: deploy.id };
}
