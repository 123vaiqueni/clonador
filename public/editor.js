// Editor visual: abre a cópia "crua" num iframe (sem scripts), deixa editar textos,
// imagens, botões, blocos, provas sociais e pixels, e guarda o HTML.
const $ = (s) => document.querySelector(s);
const id = new URLSearchParams(location.search).get('id');
const frame = $('#ed-frame');
let meta = null;
let doc = null;
let sel = null;
let mudou = false;

function estado(msg, tipo = '') { $('#ed-estado').className = 'estado ' + tipo; $('#ed-estado').innerHTML = msg; }
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tamanho = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB');
// Caminhos da página (assets/…) vistos a partir do editor.
const abs = (src) => { try { return new URL(src, doc?.baseURI || `${location.origin}/p/${id}/`).href; } catch { return src; } };
const segundos =(ms) => (ms / 1000).toFixed(1).replace('.', ',') + ' s';

async function api(caminho, opts = {}) {
  const r = await fetch(caminho, { headers: { 'content-type': 'application/json' }, ...opts });
  if (r.status === 401) { location.href = '/login'; throw new Error('sessão'); }
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(dados.erro || 'Algo correu mal.');
  return dados;
}

const hex = (c) => {
  const m = String(c).match(/\d+(\.\d+)?/g);
  if (!m || m.length < 3) return '#000000';
  return '#' + m.slice(0, 3).map((n) => Math.round(+n).toString(16).padStart(2, '0')).join('');
};

// ── Desfazer: fotografia do <body> antes de cada alteração de estrutura.
const historico = [];
function marcar() {
  if (!doc) return;
  historico.push(doc.body.innerHTML);
  if (historico.length > 30) historico.shift();
  $('#ed-desfazer').disabled = false;
  mudou = true;
}
$('#ed-desfazer').addEventListener('click', () => {
  if (!historico.length || !doc) return;
  doc.body.innerHTML = historico.pop();
  $('#ed-desfazer').disabled = !historico.length;
  sel = null;
  $('#el-opcoes').hidden = true; $('#el-vazio').hidden = false; $('#im-editor').hidden = true;
  mudou = true;
  redesenharAba();
  estado('Desfeito.', 'ok');
});

// ── Abas
let aba = 'texto';
function modoClique() {
  if (!doc) return;
  doc.body.contentEditable = aba === 'texto' && !bloqueada() ? 'true' : 'false';
  doc.documentElement.toggleAttribute('data-ed-escolher', ['imagens', 'botoes', 'elemento', 'provas'].includes(aba));
}
function redesenharAba() {
  if (aba === 'cores') desenharPaleta();
  if (aba === 'imagens') desenharImagens();
  if (aba === 'botoes') desenharBotoes();
  if (aba === 'texto') desenharEstrutura();
  if (aba === 'pixels') desenharPixels();
  if (aba === 'velocidade') desenharVelocidade();
}
$('#ed-abas').addEventListener('click', (e) => {
  const b = e.target.closest('[data-aba]');
  if (!b) return;
  aba = b.dataset.aba;
  document.querySelectorAll('#ed-abas button').forEach((x) => x.classList.toggle('ativa', x === b));
  document.querySelectorAll('[data-painel]').forEach((p) => { p.hidden = p.dataset.painel !== aba; });
  limparDestaque();
  modoClique();
  redesenharAba();
});

// ── Vista
document.querySelectorAll('input[name=vista]').forEach((r) => r.addEventListener('change', () => {
  $('#ed-palco').classList.toggle('telemovel', r.value === 'telemovel' && r.checked);
}));
$('#ed-palco').classList.add('telemovel');

// ── Carregar
const bloqueada = () => Boolean(meta?.spa && !meta?.fotografada);
async function carregar() {
  meta = await api(`/api/clones/${id}`);
  $('#ed-nome').textContent = meta.titulo || id;
  document.title = `${meta.titulo || id} · Editor`;
  $('#ed-abrir').href = `/p/${id}/`;
  $('#mob-ativo').checked = Boolean(meta.mobile);
  $('#ed-app').hidden = !bloqueada();
  frame.src = `/p/${id}/?cru=1&t=${Date.now()}`;
}

// Só no editor (não fica guardado): mostra o que as páginas escondem até um script
// as animar, e o contorno do que está seleccionado.
const CSS_EDITOR = `[data-ed-sel]{outline:3px solid #e8590c!important;outline-offset:2px}
[data-ed-hl]{outline:3px solid #1c7ed6!important;outline-offset:2px}
[contenteditable=true] *:hover{outline:1px dashed #e8590c80}
html[data-ed-escolher] body *:hover{outline:2px dashed #e8590ccc;cursor:pointer}
.elementor-invisible,[data-aos],.wow,.animated,.reveal,.fade-in,[class*="animate__"]{visibility:visible!important;opacity:1!important;transform:none!important}`;

frame.addEventListener('load', () => {
  doc = frame.contentDocument;
  if (!doc?.body) return;
  const st = doc.createElement('style');
  st.id = 'clonador-editor';
  st.textContent = CSS_EDITOR;
  doc.head.appendChild(st);
  // Imagens "lazy" que esperavam por um script para aparecer.
  for (const img of doc.querySelectorAll('img[data-src], img[data-lazy-src]')) {
    if (!img.getAttribute('src') || /^data:/.test(img.getAttribute('src'))) img.src = img.dataset.src || img.dataset.lazySrc;
  }
  modoClique();
  doc.addEventListener('input', () => { mudou = true; });
  doc.addEventListener('click', aoClicar, true);
  doc.addEventListener('submit', (e) => e.preventDefault(), true);
  $('#tx-titulo').value = doc.title;
  historico.length = 0;
  $('#ed-desfazer').disabled = true;
  sel = null;
  redesenharAba();
});

let escolherAncora = null; // função a chamar com a secção escolhida
function aoClicar(e) {
  if (e.target.closest('a,button,form,input[type=submit]')) e.preventDefault();
  if (escolherAncora) {
    e.preventDefault(); e.stopPropagation();
    const alvo = e.target.closest('section,[id],div,h1,h2,h3') || e.target;
    if (!alvo.id) alvo.id = 'sec-' + Math.random().toString(36).slice(2, 7);
    const fn = escolherAncora; escolherAncora = null;
    fn('#' + alvo.id, alvo);
    return;
  }
  if (aba === 'texto') return;
  e.preventDefault();
  if (aba === 'imagens') {
    const img = imagemEm(e.target);
    if (img) abrirImagem(img);
    return;
  }
  if (aba === 'botoes') {
    const c = e.target.closest(SELETOR_CLICAVEL);
    if (c) destacarBotao(c);
    return;
  }
  escolher(e.target);
}

// ── Textos
document.querySelectorAll('[data-cmd]').forEach((b) => b.addEventListener('click', () => {
  doc?.execCommand(b.dataset.cmd); mudou = true;
}));
$('#fmt-cor').addEventListener('input', (e) => { doc?.execCommand('foreColor', false, e.target.value); mudou = true; });

$('#tr-aplicar').addEventListener('click', () => {
  const de = $('#tr-de').value;
  const para = $('#tr-para').value;
  if (!doc || !de.trim()) return;
  marcar();
  let n = 0;
  const re = new RegExp(de.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  const it = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (t) => (t.parentElement?.closest('script,style') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let t = it.nextNode(); t; t = it.nextNode()) {
    const novo = t.data.replace(re, () => { n++; return para; });
    if (novo !== t.data) t.data = novo;
  }
  for (const el of doc.querySelectorAll('[alt],[title],[placeholder],input[type=submit][value]')) {
    for (const at of ['alt', 'title', 'placeholder', 'value']) {
      const v = el.getAttribute(at);
      if (v && re.test(v)) { el.setAttribute(at, v.replace(re, para)); n++; }
      re.lastIndex = 0;
    }
  }
  if (re.test(doc.title)) { doc.title = doc.title.replace(re, para); $('#tx-titulo').value = doc.title; n++; }
  $('#tr-info').textContent = n ? `✓ Trocado em ${n} sítio${n > 1 ? 's' : ''}. Carrega em Guardar.` : 'Não encontrei esse texto na página.';
  desenharEstrutura();
});

$('#tx-titulo').addEventListener('change', (e) => { if (doc) { doc.title = e.target.value; mudou = true; } });

function desenharEstrutura() {
  if (!doc) return;
  const titulos = [...doc.body.querySelectorAll('h1,h2,h3')].filter((h) => h.innerText.trim()).slice(0, 60);
  $('#tx-estrutura').innerHTML = titulos.length
    ? titulos.map((h, i) => `<li class="n${h.tagName[1]}" data-i="${i}">${esc(h.innerText.trim().slice(0, 90))}</li>`).join('')
    : '<li class="vazio">Sem títulos (h1/h2/h3) nesta página.</li>';
  $('#tx-estrutura').onclick = (e) => {
    const li = e.target.closest('[data-i]');
    if (li) destacar(titulos[li.dataset.i]);
  };
}

let destacado = null;
function limparDestaque() { destacado?.removeAttribute('data-ed-hl'); destacado = null; }
function destacar(el) {
  limparDestaque();
  if (!el) return;
  destacado = el;
  el.setAttribute('data-ed-hl', '');
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ── Enviar uma imagem (devolve o caminho dentro da página: assets/…)
async function enviar(ficheiro) {
  const r = await fetch(`/api/clones/${id}/upload`, { method: 'POST', headers: { 'content-type': ficheiro.type }, body: ficheiro });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.erro || 'Não consegui enviar a imagem.');
  return d.src;
}

// ── Imagens: <img> e fundos com imagem.
function fundoDe(el) {
  const bg = frame.contentWindow.getComputedStyle(el).backgroundImage;
  const m = bg && bg !== 'none' ? bg.match(/url\(["']?([^"')]+)["']?\)/) : null;
  return m && !/^data:image\/svg/.test(m[1]) ? m[1] : '';
}
function imagemEm(el) {
  for (let x = el; x && x !== doc.body; x = x.parentElement) {
    if (x.tagName === 'IMG') return x;
    if (fundoDe(x)) return x;
  }
  return null;
}
const srcDe = (el) => (el.tagName === 'IMG' ? el.currentSrc || el.src : fundoDe(el));

function listaImagens() {
  const lista = [];
  const y = frame.contentWindow.scrollY;
  for (const el of doc.body.querySelectorAll('*')) {
    if (el.closest('#clonador-editor')) continue;
    const src = el.tagName === 'IMG' ? (el.currentSrc || el.src) : fundoDe(el);
    if (!src || /^data:/.test(src) && src.length < 2000) continue;
    const r = el.getBoundingClientRect();
    if (el.tagName === 'IMG' && r.width * r.height > 0 && r.width * r.height < 900) continue; // ícones e pixels
    lista.push({ el, src, topo: r.height ? r.top + y : Infinity, visivel: r.width > 0 && r.height > 0, w: Math.round(r.width), h: Math.round(r.height) });
  }
  return lista.sort((a, b) => a.topo - b.topo);
}

let imagens = [];
let imgAtual = null;
function desenharImagens() {
  if (!doc) return;
  imagens = listaImagens();
  $('#im-lista').innerHTML = imagens.length ? imagens.map((im, i) => `
    <button class="ed-img ${im.visivel ? '' : 'escondida'} ${im.el === imgAtual ? 'ativa' : ''}" data-i="${i}" title="${esc(im.src.split('/').pop())}">
      <img src="${esc(im.src)}" alt="" loading="lazy">
      <span>${i < 3 && im.visivel ? 'Topo · ' : ''}${im.el.tagName === 'IMG' ? '' : 'fundo · '}${im.visivel ? `${im.w}×${im.h}` : 'escondida'}</span>
    </button>`).join('') : '<p class="ed-dica">Não encontrei imagens nesta página.</p>';
}
$('#im-lista').addEventListener('click', (e) => {
  const b = e.target.closest('[data-i]');
  if (b) abrirImagem(imagens[b.dataset.i].el);
});
function abrirImagem(el) {
  imgAtual = el;
  destacar(el);
  $('#im-editor').hidden = false;
  $('#im-titulo').textContent = el.tagName === 'IMG' ? 'Imagem' : 'Imagem de fundo';
  $('#im-previa').src = srcDe(el);
  const nat = el.tagName === 'IMG' && el.naturalWidth ? ` · ficheiro ${el.naturalWidth}×${el.naturalHeight}` : '';
  $('#im-info').textContent = `${decodeURIComponent(srcDe(el).split('/').pop().split('?')[0]).slice(0, 50)}${nat}`;
  $('#im-url').value = '';
  document.querySelectorAll('#im-lista .ed-img').forEach((b) => b.classList.toggle('ativa', imagens[b.dataset.i]?.el === el));
  $('#im-editor').scrollIntoView({ block: 'nearest' });
}
function trocarImagem(el, src, semMarcar = false) {
  if (!semMarcar) marcar();
  if (el.tagName === 'IMG') {
    el.src = src;
    for (const at of ['srcset', 'data-src', 'data-srcset', 'data-lazy-src', 'data-lazy-srcset', 'sizes']) el.removeAttribute(at);
    el.closest('picture')?.querySelectorAll('source').forEach((s) => s.remove());
  } else {
    el.style.setProperty('background-image', `url("${src}")`, 'important');
  }
}
$('#im-ficheiro').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f || !imgAtual) return;
  estado('<span class="giro"></span> A enviar imagem…');
  try {
    const src = await enviar(await comprimirFicheiro(f));
    trocarImagem(imgAtual, src);
    $('#im-previa').src = abs(src);
    estado('✓ Imagem trocada — carrega em Guardar.', 'ok');
    setTimeout(desenharImagens, 300);
  } catch (err) { estado(esc(err.message), 'erro'); }
  e.target.value = '';
});
$('#im-url').addEventListener('change', (e) => {
  const v = e.target.value.trim();
  if (!imgAtual || !v) return;
  trocarImagem(imgAtual, v);
  $('#im-previa').src = abs(v);
  setTimeout(desenharImagens, 300);
  estado('✓ Imagem trocada — carrega em Guardar.', 'ok');
});
$('#im-esconder').addEventListener('click', () => {
  if (!imgAtual) return;
  marcar();
  imgAtual.style.setProperty('display', 'none', 'important');
  $('#im-editor').hidden = true; imgAtual = null; limparDestaque();
  desenharImagens();
});
$('#im-fechar').addEventListener('click', () => { $('#im-editor').hidden = true; imgAtual = null; limparDestaque(); desenharImagens(); });

// Fotos do telemóvel vêm com 3–8 MB: reduzidas a 1200 px e WebP antes de enviar.
async function comprimirFicheiro(f, larguraMax = 1200) {
  if (!/^image\/(jpeg|png|webp)$/.test(f.type)) return f;
  try {
    const bmp = await createImageBitmap(f);
    const escala = Math.min(1, larguraMax / bmp.width);
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * escala); c.height = Math.round(bmp.height * escala);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/webp', 0.8));
    return blob && blob.size < f.size ? new File([blob], 'img.webp', { type: 'image/webp' }) : f;
  } catch { return f; }
}

// ── Botões e links
const SELETOR_CLICAVEL = 'a[href], button, input[type=submit], input[type=button], [onclick]';
const PALAVRAS_COMPRA = /comprar|compre|quero|garant|adquir|encomend|pedir|peça|pedido|finalizar|checkout|buy|order|add to cart|claim|sim[,!]? quero|acesso|inscrev|matricul|assin|plano|oferta|desconto/i;
let botoes = [];
let tipos = new Map(); // url -> {tipo, plataforma}

function destinoDe(el) {
  if (el.tagName === 'A') return el.getAttribute('href') || '';
  const oc = el.getAttribute('onclick') || '';
  const m = oc.match(/(?:location(?:\.href)?\s*=|window\.open\(|location\.assign\()\s*['"]([^'"]+)['"]/) || oc.match(/getElementById\(['"]([^'"]+)['"]\)/);
  if (m) return /getElementById/.test(m[0]) ? '#' + m[1] : m[1];
  const f = el.closest('form');
  return f?.getAttribute('action') || '';
}
function pôrDestino(el, url) {
  if (el.tagName === 'A') {
    el.setAttribute('href', url);
    if (url.startsWith('#')) el.removeAttribute('target');
    return;
  }
  if (el.matches('button, input')) el.setAttribute('type', 'button');
  if (!url || url === '#!') { el.removeAttribute('onclick'); return; }
  el.setAttribute('onclick', url.startsWith('#')
    ? `var a=document.getElementById('${url.slice(1).replace(/'/g, '')}');if(a)a.scrollIntoView({behavior:'smooth'});return false;`
    : `location.href='${url.replace(/'/g, '%27')}';return false;`);
}
function textoDe(el) {
  return (el.innerText || el.value || el.getAttribute('aria-label') || el.querySelector('img')?.alt || '').replace(/\s+/g, ' ').trim().slice(0, 70);
}

async function desenharBotoes() {
  if (!doc) return;
  const todos = [...doc.body.querySelectorAll(SELETOR_CLICAVEL)];
  const conjunto = new Set(todos);
  // Um botão dentro de um link conta uma vez só.
  botoes = todos.filter((el) => { const pai = el.parentElement?.closest(SELETOR_CLICAVEL); return !pai || !conjunto.has(pai); })
    .map((el) => ({ el, destino: destinoDe(el), texto: textoDe(el) }))
    .filter((b) => b.texto || b.destino);
  const novos = [...new Set(botoes.map((b) => b.destino).filter((u) => /^https?:/i.test(u) && !tipos.has(u)))];
  if (novos.length) {
    try {
      const r = await api('/api/classificar', { method: 'POST', body: JSON.stringify({ urls: novos }) });
      novos.forEach((u, i) => tipos.set(u, r[i]));
    } catch { /* fica sem classificação */ }
  }
  for (const b of botoes) {
    const t = tipos.get(b.destino);
    b.tipo = b.destino.startsWith('#') ? (b.destino === '#' || b.destino === '#!' ? 'vazio' : 'ancora')
      : /^(https?:|tel:|mailto:)/i.test(b.destino) ? (t?.tipo || 'link') : b.destino ? 'link' : 'vazio';
    b.compra = b.tipo === 'checkout' || b.tipo === 'whatsapp'
      || PALAVRAS_COMPRA.test(b.texto) || /btn|button|botao|cta/i.test(String(b.el.className));
  }
  const compra = botoes.filter((b) => b.compra);
  const outros = botoes.filter((b) => !b.compra);
  const linha = (b) => {
    const i = botoes.indexOf(b);
    const tag = { checkout: '💳 checkout', whatsapp: '💬 WhatsApp', ancora: '⚓ secção', vazio: '🚫 sem link', link: '🔗 link' }[b.tipo];
    return `<div class="bt-item ${b.tipo}" data-i="${i}">
      <div class="bt-cab"><span class="px-tag">${tag}</span><span class="bt-texto">${esc(b.texto || '(sem texto)')}</span></div>
      <input class="bt-href" data-i="${i}" value="${esc(b.destino)}" placeholder="https://…">
      <div class="bt-accoes">
        <button data-ver="${i}" title="Mostrar na página">👁</button>
        <button data-ancora="${i}" title="Fazer deslizar até uma secção (ex.: planos)">⚓ Secção</button>
        <button data-tirar="${i}" class="perigo" title="O botão fica, mas deixa de levar a algum lado">🚫 Tirar link</button>
      </div>
    </div>`;
  };
  $('#bt-lista').innerHTML = (compra.length ? `<h4>Botões de compra (${compra.length})</h4>${compra.map(linha).join('')}` : '<p class="ed-dica">Não encontrei botões de compra.</p>')
    + (outros.length ? `<details class="bt-outros"><summary>Outros links (${outros.length})</summary>${outros.map(linha).join('')}</details>` : '');
  desenharCodigo();
}

$('#bt-lista').addEventListener('change', (e) => {
  if (!e.target.matches('.bt-href')) return;
  const b = botoes[e.target.dataset.i];
  marcar();
  pôrDestino(b.el, e.target.value.trim());
  estado('✓ Link trocado — carrega em Guardar.', 'ok');
  desenharBotoes();
});
$('#bt-lista').addEventListener('click', (e) => {
  const ver = e.target.closest('[data-ver]');
  const anc = e.target.closest('[data-ancora]');
  const tirar = e.target.closest('[data-tirar]');
  if (ver) destacar(botoes[ver.dataset.ver].el);
  if (tirar) {
    marcar();
    pôrDestino(botoes[tirar.dataset.tirar].el, '#!');
    estado('✓ Link tirado — o botão já não leva a lado nenhum. Carrega em Guardar.', 'ok');
    desenharBotoes();
  }
  if (anc) {
    const b = botoes[anc.dataset.ancora];
    destacar(b.el);
    $('#bt-ancora-info').textContent = '👉 Agora clica na página na secção para onde o botão deve levar (ex.: os planos).';
    escolherAncora = (alvoId, alvo) => {
      marcar();
      pôrDestino(b.el, alvoId);
      $('#bt-ancora-info').textContent = '✓ O botão agora desliza até essa secção.';
      destacar(alvo);
      desenharBotoes();
    };
  }
});
function destacarBotao(el) {
  destacar(el);
  const i = botoes.findIndex((b) => b.el === el || b.el.contains(el));
  const linha = document.querySelector(`.bt-item[data-i="${i}"]`);
  if (linha) {
    linha.closest('details')?.setAttribute('open', '');
    linha.scrollIntoView({ block: 'center', behavior: 'smooth' });
    linha.classList.add('piscar'); setTimeout(() => linha.classList.remove('piscar'), 1200);
  }
}

$('#bt-wa-gerar').addEventListener('click', async () => {
  try {
    const r = await api(`/api/whatsapp?numero=${encodeURIComponent($('#bt-wa-num').value)}&mensagem=${encodeURIComponent($('#bt-wa-msg').value)}`);
    $('#bt-todos').value = r.link;
    estado('Link de WhatsApp pronto — carrega em “Aplicar a todos”.', 'ok');
  } catch (err) { estado(esc(err.message), 'erro'); }
});
$('#bt-aplicar-todos').addEventListener('click', () => {
  const v = $('#bt-todos').value.trim();
  if (!/^(https?:\/\/|tel:)/i.test(v)) return estado('Cola primeiro o teu link (a começar por https://).', 'erro');
  // Botões que levam aos planos (âncoras) ficam como estão.
  const alvo = botoes.filter((b) => b.compra && b.tipo !== 'ancora');
  if (!alvo.length) return estado('Não há botões de compra para trocar.', 'erro');
  marcar();
  alvo.forEach((b) => pôrDestino(b.el, v));
  // E os checkouts escondidos no código.
  for (const c of codigo) c.novo = v;
  desenharBotoes();
  estado(`✓ ${alvo.length} botões apontam para o teu link${codigo.length ? ` (+ ${codigo.length} no código)` : ''}. Botões que deslizam até aos planos ficaram como estavam. Carrega em Guardar.`, 'ok');
});

// Checkouts que só aparecem dentro de scripts: trocados ao servir a página (meta.substituicoes).
let codigo = [];
let codigoMudou = false;
async function desenharCodigo() {
  try {
    if (!codigo.loaded) {
      const lista = await api(`/api/clones/${id}/links`);
      const hrefs = new Set(botoes.map((b) => b.destino));
      codigo = lista.filter((l) => l.tipo !== 'link' && !hrefs.has(l.url));
      codigo.loaded = true;
    }
  } catch { codigo = []; }
  $('#bt-codigo').hidden = !codigo.length;
  $('#bt-codigo-lista').innerHTML = codigo.map((l, i) => `
    <div class="bt-item">
      <div class="bt-cab"><span class="px-tag">${l.tipo === 'whatsapp' ? '💬' : '💳'} ${esc(l.plataforma)}</span></div>
      <div class="ed-info" title="${esc(l.url)}">${esc(l.url)}</div>
      <input class="bt-codigo-novo" data-i="${i}" value="${esc(l.novo || '')}" placeholder="O teu link (vazio = fica o original)">
    </div>`).join('');
}
$('#bt-codigo-lista').addEventListener('input', (e) => {
  if (!e.target.matches('.bt-codigo-novo')) return;
  codigo[e.target.dataset.i].novo = e.target.value.trim();
  codigoMudou = true;
});
async function guardarCodigo() {
  if (!codigoMudou && !codigo.some((c) => c.novo)) return;
  // Mantém as trocas que já existiam para links que não estão nesta lista.
  const nesta = new Set(codigo.map((c) => c.url));
  const antigas = (meta.substituicoes || []).filter((s) => !nesta.has(s.de));
  const substituicoes = [...antigas, ...codigo.filter((c) => c.novo).map((c) => ({ de: c.url, para: c.novo }))];
  meta = await api(`/api/clones/${id}/links`, { method: 'PUT', body: JSON.stringify({ substituicoes }) });
  codigoMudou = false;
}

// ── Blocos
function escolher(el) {
  if (!el || el === doc.documentElement || el === doc.body) return;
  sel?.removeAttribute('data-ed-sel');
  sel = el;
  sel.setAttribute('data-ed-sel', '');
  $('#el-vazio').hidden = true;
  $('#el-opcoes').hidden = false;
  $('#el-tipo').textContent = el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? ' · ' + el.className.split(' ')[0] : '');
  const img = el.tagName === 'IMG' ? el : null;
  $('#el-imagem').hidden = !img;
  if (img) { $('#el-img-previa').src = img.currentSrc || img.src; $('#el-img-url').value = ''; }
  const link = el.closest(SELETOR_CLICAVEL);
  $('#el-link').hidden = !link;
  if (link) { $('#el-href').value = destinoDe(link); $('#el-ancora-info').textContent = ''; }
  const cs = frame.contentWindow.getComputedStyle(el);
  $('#el-cor').value = hex(cs.color);
  $('#el-fundo').value = hex(cs.backgroundColor);
  $('#pv-existente').hidden = !el.closest('[data-clon-carrossel]');
}

$('#el-pai').addEventListener('click', () => sel?.parentElement && sel.parentElement !== doc.body && escolher(sel.parentElement));

$('#el-img-ficheiro').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f || !sel) return;
  estado('<span class="giro"></span> A enviar imagem…');
  try {
    const src = await enviar(await comprimirFicheiro(f));
    trocarImagem(sel, src);
    $('#el-img-previa').src = abs(src);
    estado('✓ Imagem trocada — carrega em Guardar.', 'ok');
  } catch (err) { estado(esc(err.message), 'erro'); }
  e.target.value = '';
});
$('#el-img-url').addEventListener('change', (e) => {
  if (!sel || !e.target.value.trim()) return;
  trocarImagem(sel, e.target.value.trim());
  $('#el-img-previa').src = sel.src;
});
$('#el-href').addEventListener('change', (e) => {
  const a = sel?.closest(SELETOR_CLICAVEL);
  if (a) { marcar(); pôrDestino(a, e.target.value.trim()); estado('✓ Link trocado — carrega em Guardar.', 'ok'); }
});
$('#el-ancora').addEventListener('click', () => {
  const a = sel?.closest(SELETOR_CLICAVEL);
  if (!a) return;
  $('#el-ancora-info').textContent = 'Agora clica na secção de destino na página.';
  escolherAncora = (alvoId) => {
    marcar();
    pôrDestino(a, alvoId);
    $('#el-href').value = alvoId;
    $('#el-ancora-info').textContent = '✓ O botão desliza até essa secção.';
  };
});

let corMarcada = false;
$('#el-cor').addEventListener('input', (e) => { if (sel) { if (!corMarcada) { marcar(); corMarcada = true; } sel.style.color = e.target.value; } });
$('#el-fundo').addEventListener('input', (e) => { if (sel) { if (!corMarcada) { marcar(); corMarcada = true; } sel.style.background = e.target.value; } });
$('#el-cor').addEventListener('change', () => { corMarcada = false; });
$('#el-fundo').addEventListener('change', () => { corMarcada = false; });
$('#el-cima').addEventListener('click', () => {
  const ant = sel?.previousElementSibling;
  if (ant) { marcar(); ant.before(sel); sel.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
});
$('#el-baixo').addEventListener('click', () => {
  const prox = sel?.nextElementSibling;
  if (prox) { marcar(); prox.after(sel); sel.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
});
$('#el-esconder').addEventListener('click', () => { if (sel) { marcar(); sel.style.setProperty('display', 'none', 'important'); } });
$('#el-duplicar').addEventListener('click', () => {
  if (!sel) return;
  marcar();
  const c = sel.cloneNode(true); c.removeAttribute('data-ed-sel');
  sel.after(c);
});
$('#el-apagar').addEventListener('click', () => {
  if (!sel) return;
  marcar();
  sel.remove(); sel = null;
  $('#el-opcoes').hidden = true; $('#el-vazio').hidden = false;
});

// ── Provas sociais: carrossel que se passa com o dedo (CSS scroll-snap) e,
// na página publicada, sozinho e com pontos (um script pequeno dentro do bloco).
let fotos = [];
let carrosselAlvo = null;
function desenharFotos() {
  $('#pv-fotos').innerHTML = fotos.map((src, i) => `
    <div class="ed-img"><img src="${esc(abs(src))}" alt=""><span>
      <button data-mover="${i}" title="Passar para trás">←</button>
      <button data-tirar-foto="${i}" class="perigo" title="Tirar">✕</button></span></div>`).join('');
  $('#pv-inserir').disabled = !fotos.length;
  $('#pv-inserir').textContent = carrosselAlvo ? 'Actualizar carrossel' : 'Inserir na página';
}
$('#pv-ficheiros').addEventListener('change', async (e) => {
  const lista = [...e.target.files];
  e.target.value = '';
  for (const [i, f] of lista.entries()) {
    estado(`<span class="giro"></span> A enviar ${i + 1} de ${lista.length}…`);
    try { fotos.push(await enviar(await comprimirFicheiro(f, 900))); desenharFotos(); }
    catch (err) { estado(esc(err.message), 'erro'); return; }
  }
  estado(`✓ ${lista.length} print${lista.length > 1 ? 's' : ''} pronto${lista.length > 1 ? 's' : ''}.`, 'ok');
});
$('#pv-fotos').addEventListener('click', (e) => {
  const t = e.target.closest('[data-tirar-foto]');
  const m = e.target.closest('[data-mover]');
  if (t) fotos.splice(Number(t.dataset.tirarFoto), 1);
  if (m && Number(m.dataset.mover) > 0) { const i = Number(m.dataset.mover); [fotos[i - 1], fotos[i]] = [fotos[i], fotos[i - 1]]; }
  desenharFotos();
});
$('#pv-carregar').addEventListener('click', () => {
  carrosselAlvo = sel?.closest('[data-clon-carrossel]');
  if (!carrosselAlvo) return;
  fotos = [...carrosselAlvo.querySelectorAll('.clon-car-faixa img')].map((i) => i.getAttribute('src'));
  $('#pv-titulo').value = carrosselAlvo.querySelector('h3')?.textContent || '';
  $('#pv-auto').checked = carrosselAlvo.dataset.auto === '1';
  desenharFotos();
});

const CSS_CARROSSEL = '.clon-provas{padding:28px 0;max-width:680px;margin:0 auto}.clon-provas h3{text-align:center;margin:0 16px 16px;font-size:24px;line-height:1.2}.clon-car-faixa{display:flex;gap:12px;overflow-x:auto;scroll-snap-type:x mandatory;padding:4px 16px 10px;scrollbar-width:none;-webkit-overflow-scrolling:touch}.clon-car-faixa::-webkit-scrollbar{display:none}.clon-car-faixa img{flex:0 0 80%;max-width:80%;height:auto;scroll-snap-align:center;border-radius:14px;box-shadow:0 4px 18px rgba(0,0,0,.14);background:#fff;object-fit:contain}@media(min-width:700px){.clon-car-faixa img{flex-basis:46%;max-width:46%}}.clon-car-pontos{display:flex;justify-content:center;gap:6px;margin-top:12px}.clon-car-pontos button{width:8px;height:8px;border-radius:4px;border:0;padding:0;background:rgba(0,0,0,.25);cursor:pointer;transition:width .2s}.clon-car-pontos button.on{width:22px;background:rgba(0,0,0,.65)}';
const JS_CARROSSEL = "(function(){var s=document.currentScript.parentNode,f=s.querySelector('.clon-car-faixa'),p=s.querySelector('.clon-car-pontos'),im=f.querySelectorAll('img'),a=0,t;if(!im.length)return;p.innerHTML='';im.forEach(function(_,i){var b=document.createElement('button');b.type='button';b.setAttribute('aria-label','Foto '+(i+1));b.onclick=function(){ir(i);parar()};p.appendChild(b)});function ir(i){a=(i+im.length)%im.length;f.scrollTo({left:im[a].offsetLeft-f.offsetLeft-(f.clientWidth-im[a].clientWidth)/2,behavior:'smooth'})}function marcar(){var c=f.scrollLeft+f.clientWidth/2,m=0,d=1e9;im.forEach(function(x,i){var e=Math.abs(x.offsetLeft-f.offsetLeft+x.clientWidth/2-c);if(e<d){d=e;m=i}});a=m;[].forEach.call(p.children,function(b,i){b.className=i===m?'on':''})}function parar(){clearInterval(t)}f.addEventListener('scroll',function(){clearTimeout(f._m);f._m=setTimeout(marcar,80)},{passive:true});f.addEventListener('touchstart',parar,{passive:true});marcar();if(s.getAttribute('data-auto')==='1')t=setInterval(function(){ir(a+1)},3500)})();";

$('#pv-inserir').addEventListener('click', () => {
  if (!doc || !fotos.length) return;
  const titulo = $('#pv-titulo').value.trim();
  const html = `<section class="clon-provas" data-clon-carrossel data-auto="${$('#pv-auto').checked ? '1' : '0'}">`
    + `<style>${CSS_CARROSSEL}</style>`
    + (titulo ? `<h3>${esc(titulo)}</h3>` : '')
    + `<div class="clon-car-faixa">${fotos.map((src, i) => `<img src="${esc(src)}" alt="Cliente ${i + 1}" loading="lazy">`).join('')}</div>`
    + `<div class="clon-car-pontos"></div><script>${JS_CARROSSEL}<\/script></section>`;
  const inserir = (depois) => {
    marcar();
    const t = doc.createElement('template');
    t.innerHTML = html;
    const novo = t.content.firstElementChild;
    if (carrosselAlvo?.isConnected) carrosselAlvo.replaceWith(novo);
    else if (depois) depois.after(novo);
    else doc.body.appendChild(novo);
    carrosselAlvo = null; fotos = []; desenharFotos();
    destacar(novo);
    $('#pv-info').textContent = '✓ Carrossel na página — carrega em Guardar. Para o mudar depois, clica nele e em “Editar este carrossel”.';
  };
  if (carrosselAlvo?.isConnected) return inserir();
  $('#pv-info').textContent = '👉 Agora clica na página no bloco DEPOIS do qual queres o carrossel.';
  escolherAncora = (_, alvo) => {
    // Sobe até um bloco largo (secção), para o carrossel não ficar entalado dentro de um texto.
    let bloco = alvo;
    while (bloco.parentElement && bloco.parentElement !== doc.body && bloco.offsetWidth < doc.body.offsetWidth * 0.6) bloco = bloco.parentElement;
    inserir(bloco);
  };
});

// ── Pixels
const NOMES = {
  meta: 'Meta', tiktok: 'TikTok', google: 'Google', gtm: 'Tag Manager', kwai: 'Kwai',
  pinterest: 'Pinterest', snapchat: 'Snapchat', utmify: 'Utmify', clarity: 'Clarity', personalizado: 'Personalizado',
};
function desenharPixels() {
  if (!meta) return;
  const orig = meta.pixelsOriginais || [];
  $('#px-originais').innerHTML = orig.length ? orig.map((p) => `
    <div class="px-linha">
      <span class="px-tag">${NOMES[p.plataforma] || p.plataforma}</span>
      <code>${esc(p.id)}</code>
      ${p.estado === 'removido' ? '<span class="px-ok">removido ✓</span>'
        : p.estado === 'via-gtm' ? '<span class="px-aviso" title="Não está escrito na página — é carregado pelo Tag Manager. Remove o GTM.">vem pelo GTM</span>'
        : `<button class="perigo" data-remover-orig="${esc(p.id)}">Remover</button>`}
    </div>`).join('') : '<div class="px-vazio">Nenhum pixel encontrado.</div>';
  const meus = meta.meusPixels || [];
  $('#px-meus').innerHTML = meus.length ? meus.map((p, i) => `
    <div class="px-linha">
      <span class="px-tag meu">${NOMES[p.plataforma]}</span>
      <code>${esc(p.plataforma === 'personalizado' ? (p.codigo.slice(0, 30) + (p.codigo.length > 30 ? '…' : '')) : p.id)}</code>
      <button class="perigo" data-tirar-meu="${i}">Tirar</button>
    </div>`).join('') : '<div class="px-vazio">Ainda não adicionaste nenhum.</div>';
}
async function guardarMeus(lista) {
  meta = await api(`/api/clones/${id}/pixels`, { method: 'PUT', body: JSON.stringify({ meusPixels: lista }) });
  desenharPixels();
}
$('#px-plataforma').addEventListener('change', () => {
  const perso = $('#px-plataforma').value === 'personalizado';
  $('#px-id').hidden = perso; $('#px-codigo').hidden = !perso;
});
$('#px-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const plataforma = $('#px-plataforma').value;
  const novo = plataforma === 'personalizado' ? { plataforma, codigo: $('#px-codigo').value } : { plataforma, id: $('#px-id').value.trim() };
  try {
    await guardarMeus([...(meta.meusPixels || []), novo]);
    $('#px-id').value = ''; $('#px-codigo').value = '';
    estado('✓ Pixel adicionado — já está na página publicada. Carrega em “Verificar pixels” para confirmar.', 'ok');
  } catch (err) { estado(esc(err.message), 'erro'); }
});
$('[data-painel=pixels]').addEventListener('click', async (e) => {
  const tirar = e.target.closest('[data-tirar-meu]');
  const remover = e.target.closest('[data-remover-orig]');
  try {
    if (tirar) {
      const lista = [...meta.meusPixels]; lista.splice(Number(tirar.dataset.tirarMeu), 1);
      await guardarMeus(lista); estado('Pixel tirado.', 'ok');
    }
    if (remover) {
      if (mudou) await guardar();
      const r = await api(`/api/clones/${id}/pixels/remover`, { method: 'POST', body: JSON.stringify({ id: remover.dataset.removerOrig }) });
      meta = r.meta; desenharPixels();
      estado(r.removidos ? `✓ Removido (${r.removidos} bloco${r.removidos > 1 ? 's' : ''} de código). Verifica outra vez para confirmar.` : 'Não está escrito na página — vem pelo Tag Manager. Remove o GTM.', r.removidos ? 'ok' : 'erro');
      if (r.removidos) carregar();
    }
  } catch (err) { estado(esc(err.message), 'erro'); }
});
$('#px-verificar').addEventListener('click', async () => {
  const b = $('#px-verificar');
  b.disabled = true;
  $('#px-resultado').innerHTML = '<p class="ed-dica"><span class="giro"></span> A abrir a página publicada… (uns 15 segundos)</p>';
  try {
    if (mudou) await guardar();
    const r = await api(`/api/clones/${id}/pixels/verificar`, { method: 'POST' });
    meta = r.meta; desenharPixels();
    const meus = r.pixels.filter((p) => p.meu);
    const estranhos = r.pixels.filter((p) => !p.meu);
    const semMeu = (meta.meusPixels || []).filter((p) => p.plataforma !== 'personalizado' && !meus.some((x) => x.id === p.id));
    const outrosHosts = r.hosts.filter((h) => !/facebook|tiktok|google|kwai|pinterest|snap|clarity|utmify|rastreio-removido/.test(h));
    $('#px-resultado').innerHTML = `
      ${meus.map((p) => `<div class="px-linha ok">✅ <b>${NOMES[p.plataforma]}</b> <code>${esc(p.id)}</code> dispara${p.eventos.length ? ` · ${p.eventos.map(esc).join(', ')}` : ''}</div>`).join('')}
      ${semMeu.map((p) => `<div class="px-linha mau">⚠️ <b>${NOMES[p.plataforma]}</b> <code>${esc(p.id)}</code> não disparou — confirma o ID.</div>`).join('')}
      ${estranhos.length
        ? estranhos.map((p) => `<div class="px-linha mau">❌ Pixel de outra pessoa: <b>${NOMES[p.plataforma] || p.plataforma}</b> <code>${esc(p.id)}</code> — remove-o em cima.</div>`).join('')
        : '<div class="px-linha ok">✅ Nenhum pixel da página original dispara.</div>'}
      ${outrosHosts.length ? `<div class="px-linha mau">⚠️ Outros rastreadores: ${outrosHosts.map(esc).join(', ')}</div>` : ''}
      ${!meus.length && !semMeu.length ? '<p class="ed-dica">Ainda não tens pixels teus nesta página.</p>' : ''}
      <p class="ed-dica">Confirma também no Gestor de Eventos do Meta → Testar eventos, abrindo a página no telemóvel.</p>`;
  } catch (err) {
    $('#px-resultado').innerHTML = `<p class="estado erro">${esc(err.message)}</p>`;
  } finally { b.disabled = false; }
});

// ── Cores
let paleta = [];
function desenharPaleta() {
  if (!doc) return;
  const conta = new Map();
  for (const el of doc.body.querySelectorAll('*')) {
    const cs = frame.contentWindow.getComputedStyle(el);
    for (const c of [cs.color, cs.backgroundColor, cs.borderTopColor]) {
      if (!c || /rgba\(.*,\s*0\)$/.test(c) || c === 'transparent') continue;
      const h = hex(c); conta.set(h, (conta.get(h) || 0) + 1);
    }
  }
  paleta = [...conta].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([de]) => ({ de, para: de }));
  $('#cores-lista').innerHTML = paleta.map((p, i) => `<label class="ed-cor"><span class="amostra" style="background:${p.de}"></span><span class="seta">→</span><input type="color" data-i="${i}" value="${p.de}"></label>`).join('');
  $('#cores-aplicar').disabled = true;
}
$('#cores-lista').addEventListener('input', (e) => {
  const i = e.target.dataset.i; if (i == null) return;
  paleta[i].para = e.target.value;
  e.target.closest('.ed-cor').classList.toggle('mudou', paleta[i].para !== paleta[i].de);
  $('#cores-aplicar').disabled = !paleta.some((p) => p.para !== p.de);
});
$('#cores-aplicar').addEventListener('click', async () => {
  const mapa = Object.fromEntries(paleta.filter((p) => p.para !== p.de).map((p) => [p.de, p.para]));
  try {
    if (mudou) await guardar();
    await api(`/api/clones/${id}/cores`, { method: 'POST', body: JSON.stringify({ mapa }) });
    estado('✓ Cores trocadas em toda a página.', 'ok');
    carregar();
  } catch (err) { estado(esc(err.message), 'erro'); }
});

// ── Mobile
$('#mob-ativo').addEventListener('change', async (e) => {
  try {
    meta = await api(`/api/clones/${id}/mobile`, { method: 'PUT', body: JSON.stringify({ ativo: e.target.checked }) });
    estado(e.target.checked ? '✓ Otimização ligada (vê em “Ver”).' : 'Otimização desligada.', 'ok');
  } catch (err) { estado(esc(err.message), 'erro'); }
});

// ── Velocidade
let medicoes = {};
function cartao(nome, valor, bom, txt) {
  return `<div class="vl-cartao ${bom ? 'bom' : 'mau'}"><span>${nome}</span><b>${valor}</b><small>${txt}</small></div>`;
}
function desenharVelocidade() {
  const fontes = { ...(meta?.velocidade || {}), ...medicoes };
  const bloco = (r, titulo) => {
    if (!r) return '';
    const m = r.metas;
    const img = (r.porTipo?.Image || 0);
    return `<div class="vl-bloco"><h4>${titulo}</h4>
      <div class="vl-grelha">
        ${cartao('Imagem principal (LCP)', segundos(r.lcp), r.lcp && r.lcp <= m.lcp, 'meta ≤ 2,5 s')}
        ${cartao('Saltos (CLS)', String(r.cls).replace('.', ','), r.cls <= m.cls, 'meta ≤ 0,1')}
        ${cartao('Peso total', tamanho(r.bytes), r.bytes <= m.bytes, `meta ≤ 1 MB · imagens ${tamanho(img)}`)}
        ${cartao('Página completa', segundos(r.carregou), r.carregou <= 6000, `${r.pedidos} ficheiros`)}
      </div>
      ${r.lcpEl ? `<p class="ed-dica">Elemento principal: <code>${esc(r.lcpEl)}</code></p>` : ''}
      ${r.pesados?.length ? `<details><summary>Ficheiros mais pesados</summary><ul class="vl-pesados">${r.pesados.map((p) => `<li><span>${esc((p.nome || p.url).slice(0, 48))}</span><b>${tamanho(p.bytes)}</b></li>`).join('')}</ul></details>` : ''}
    </div>`;
  };
  $('#vl-resultado').innerHTML = (bloco(fontes.copia, 'A tua página') + bloco(fontes.original, 'A original'))
    || '<p class="ed-dica">Ainda não mediste esta página.</p>';
}
async function medir(alvo, botao) {
  botao.disabled = true;
  const antes = $('#vl-resultado').innerHTML;
  $('#vl-resultado').innerHTML = '<p class="ed-dica"><span class="giro"></span> A medir em 4G lento… (até 1 minuto)</p>' + antes;
  try {
    if (alvo === 'copia' && mudou) await guardar();
    medicoes[alvo] = await api(`/api/clones/${id}/velocidade`, { method: 'POST', body: JSON.stringify({ alvo }) });
  } catch (err) { estado(esc(err.message), 'erro'); }
  botao.disabled = false;
  desenharVelocidade();
}
$('#vl-copia').addEventListener('click', (e) => medir('copia', e.currentTarget));
$('#vl-original').addEventListener('click', (e) => medir('original', e.currentTarget));

// Converte para WebP (largura de telemóvel) as imagens guardadas na cópia que pesam mais de 120 KB.
$('#vl-comprimir').addEventListener('click', async () => {
  if (!doc) return;
  const b = $('#vl-comprimir');
  b.disabled = true;
  const info = $('#vl-comprimir-info');
  const lista = listaImagens().filter((im) => new URL(im.src, location.href).origin === location.origin && !/\.(svg|gif)(\?|$)/i.test(im.src));
  const porSrc = new Map();
  for (const im of lista) { if (!porSrc.has(im.src)) porSrc.set(im.src, []); porSrc.get(im.src).push(im.el); }
  let feitas = 0; let poupado = 0; let marcado = false;
  let n = 0;
  for (const [src, els] of porSrc) {
    n++;
    info.innerHTML = `<span class="giro"></span> A ver imagem ${n} de ${porSrc.size}…`;
    try {
      const blob = await (await fetch(src)).blob();
      if (blob.size < 120 * 1024 || !/^image\/(jpeg|png|webp)/.test(blob.type)) continue;
      const largura = Math.max(...els.map((el) => el.getBoundingClientRect().width || 0), 0);
      const novo = await comprimirFicheiro(new File([blob], 'x', { type: blob.type }), Math.min(1200, Math.max(720, Math.round(largura * 2))));
      if (novo.size > blob.size * 0.8) continue;
      const caminho = await enviar(novo);
      if (!marcado) { marcar(); marcado = true; }
      els.forEach((el) => trocarImagem(el, caminho, true));
      feitas++; poupado += blob.size - novo.size;
    } catch { /* imagem que não deu para ler — fica */ }
  }
  info.textContent = feitas ? `✓ ${feitas} imagem${feitas > 1 ? 'ns' : ''} comprimida${feitas > 1 ? 's' : ''} — menos ${tamanho(poupado)}. Carrega em Guardar e mede outra vez.`
    : 'Nenhuma imagem pesada para comprimir (as que vêm de outros sites ficam como estão).';
  b.disabled = false;
});

// ── Página app → editável
$('#ed-fotografar').addEventListener('click', async () => {
  const b = $('#ed-fotografar');
  b.disabled = true;
  estado('<span class="giro"></span> A montar a página e a guardá-la como página normal… (até 1 minuto)');
  try {
    meta = await api(`/api/clones/${id}/fotografar`, { method: 'POST' });
    estado('✓ Pronto — já podes editar. “Repor original” volta à app.', 'ok');
    carregar();
  } catch (err) { estado(esc(err.message), 'erro'); }
  b.disabled = false;
});

// ── Guardar / Repor
async function guardar() {
  if (!doc) return;
  limparDestaque();
  const copia = doc.documentElement.cloneNode(true);
  copia.querySelector('#clonador-editor')?.remove();
  copia.removeAttribute('data-ed-escolher');
  copia.querySelectorAll('[data-ed-sel],[data-ed-hl]').forEach((x) => { x.removeAttribute('data-ed-sel'); x.removeAttribute('data-ed-hl'); });
  copia.querySelector('body')?.removeAttribute('contenteditable');
  const dt = doc.doctype ? `<!doctype ${doc.doctype.name}>\n` : '<!doctype html>\n';
  if (mudou) await api(`/api/clones/${id}/html`, { method: 'PUT', body: JSON.stringify({ html: dt + copia.outerHTML }) });
  await guardarCodigo();
  mudou = false;
}
$('#ed-guardar').addEventListener('click', async () => {
  estado('A guardar…');
  try { await guardar(); estado('✓ Guardado — já está na página publicada.', 'ok'); }
  catch (err) { estado(esc(err.message), 'erro'); }
});
$('#ed-repor').addEventListener('click', async () => {
  if (!confirm('Desfazer TODAS as edições e voltar à página como foi clonada?')) return;
  try {
    await api(`/api/clones/${id}/repor`, { method: 'POST' });
    mudou = false; codigo = []; estado('✓ Reposto.', 'ok'); carregar();
  } catch (err) { estado(esc(err.message), 'erro'); }
});
window.addEventListener('beforeunload', (e) => { if (mudou || codigoMudou) e.preventDefault(); });
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); $('#ed-guardar').click(); }
});

if (!id) location.href = '/';
else carregar().catch((err) => estado(esc(err.message), 'erro'));
