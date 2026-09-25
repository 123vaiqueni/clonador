// Links da oferta: encontrar os checkouts / botões de compra e trocá-los pelos teus.
// Tal como os pixels, as trocas ficam no meta.json e são aplicadas ao servir —
// a cópia original nunca é alterada, por isso dá sempre para voltar atrás.

const CHECKOUTS = [
  [/(^|\.)hotmart\.com$|(^|\.)hotm\.art$/, 'Hotmart'],
  [/(^|\.)kiwify\.com(\.br)?$/, 'Kiwify'],
  [/(^|\.)eduzz\.com$/, 'Eduzz'],
  [/(^|\.)monetizze\.com\.br$/, 'Monetizze'],
  [/(^|\.)braip\.com$/, 'Braip'],
  [/(^|\.)perfectpay\.com\.br$/, 'PerfectPay'],
  [/(^|\.)ticto\.(com\.br|app)$/, 'Ticto'],
  [/(^|\.)kirvano\.com$/, 'Kirvano'],
  [/(^|\.)lastlink\.com$/, 'Lastlink'],
  [/(^|\.)hub\.la$|(^|\.)hubla\.com$/, 'Hubla'],
  [/(^|\.)greenn\.com\.br$/, 'Greenn'],
  [/(^|\.)payt\.com\.br$/, 'Payt'],
  [/(^|\.)cartpanda\.com$|mycartpanda\.com$/, 'CartPanda'],
  [/(^|\.)yampi\.(com\.br|io)$/, 'Yampi'],
  [/(^|\.)appmax\.com\.br$/, 'Appmax'],
  [/(^|\.)doppus\.com$/, 'Doppus'],
  [/(^|\.)clickbank\.net$|(^|\.)clkbank\.com$/, 'ClickBank'],
  [/(^|\.)digistore24\.com$/, 'Digistore24'],
  [/(^|\.)buygoods\.com$/, 'BuyGoods'],
  [/(^|\.)maxweb\.com$/, 'MaxWeb'],
  [/(^|\.)paykickstart\.com$/, 'PayKickstart'],
  [/(^|\.)samcart\.com$/, 'SamCart'],
  [/(^|\.)thrivecart\.com$/, 'ThriveCart'],
  [/(^|\.)gumroad\.com$/, 'Gumroad'],
  [/(^|\.)stripe\.com$/, 'Stripe'],
  [/(^|\.)paypal\.com$/, 'PayPal'],
  [/(^|\.)mercadopago\.com(\.br)?$/, 'Mercado Pago'],
  [/(^|\.)pagseguro\.uol\.com\.br$/, 'PagSeguro'],
];
const PALAVRAS_COMPRA = /comprar|compre|quero|garant|adquir|encomend|pedir|peça|pedido|finalizar|checkout|buy|order|add to cart|get (it|yours|access|started)|claim|yes[,!]? i|sim[,!]? quero|acesso|inscrev|matricul|assin/i;

function classificar(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase();
  if (/(^|\.)(wa\.me|whatsapp\.com)$/.test(host)) return { tipo: 'whatsapp', plataforma: 'WhatsApp' };
  for (const [re, nome] of CHECKOUTS) if (re.test(host)) return { tipo: 'checkout', plataforma: nome };
  if (/\/(checkout|checkouts|cart|carrinho|pagamento|payment|pay|order)(\/|$|\?)/i.test(u.pathname) || /^(pay|checkout|secure|compra)\./.test(host)) {
    return { tipo: 'checkout', plataforma: host };
  }
  return { tipo: 'link', plataforma: host };
}

const limparTexto = (html) => html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().slice(0, 80);
const desfazer = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

export function extrairLinks(html) {
  const mapa = new Map();
  const juntar = (url, texto, eBotao) => {
    url = desfazer(url.trim());
    if (!/^https?:\/\//i.test(url)) return;
    const c = classificar(url);
    if (!c) return;
    const atual = mapa.get(url) || { url, ...c, textos: [], ocorrencias: 0, botao: false };
    atual.ocorrencias++;
    if (texto && !atual.textos.includes(texto) && atual.textos.length < 4) atual.textos.push(texto);
    atual.botao ||= eBotao;
    mapa.set(url, atual);
  };

  // <a href="…">texto</a>
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = m[1].match(/\shref\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (!href) continue;
    const texto = limparTexto(m[2]);
    const eBotao = /class\s*=\s*["'][^"']*(btn|button|botao|cta|elementor-button)/i.test(m[1]) || PALAVRAS_COMPRA.test(texto);
    juntar(href, texto, eBotao);
  }
  // <form action="…">, onclick="location='…'", data-href="…"
  for (const m of html.matchAll(/<form\b[^>]*\saction\s*=\s*(["'])(https?:[^"']+)\1/gi)) juntar(m[2], 'formulário', true);
  for (const m of html.matchAll(/\s(?:onclick|data-href|data-url|data-link)\s*=\s*(["'])([^"']*?https?:\/\/[^"']+)\1/gi)) {
    const url = m[2].match(/https?:\/\/[^\s'"`)]+/)?.[0];
    if (url) juntar(url, 'botão (script)', true);
  }
  // Checkouts e WhatsApp escondidos em scripts (redireccionamentos por JavaScript).
  for (const m of html.matchAll(/https?:\/\/[^\s'"`<>)\\]+/g)) {
    const url = desfazer(m[0]);
    const c = classificar(url);
    if (c && c.tipo !== 'link' && !mapa.has(url)) juntar(url, 'no código', true);
  }

  const ordem = { checkout: 0, whatsapp: 1, link: 2 };
  return [...mapa.values()]
    .filter((l) => l.tipo !== 'link' || l.botao)
    .sort((a, b) => ordem[a.tipo] - ordem[b.tipo] || b.ocorrencias - a.ocorrencias);
}

export function validarSubstituicoes(lista) {
  if (!Array.isArray(lista)) throw new Error('Lista de links inválida.');
  if (lista.length > 200) throw new Error('Demasiados links.');
  return lista.map((s) => {
    const de = String(s?.de || '').trim();
    const para = String(s?.para || '').trim();
    if (!/^https?:\/\//i.test(de)) throw new Error('Link original inválido.');
    if (!/^(https?:\/\/|tel:|mailto:)/i.test(para)) throw new Error(`O novo link tem de começar por https:// (recebi "${para.slice(0, 40)}").`);
    if (/[\s"'<>`]/.test(para)) throw new Error('O novo link tem espaços ou aspas — confirma que o colaste bem.');
    return { de, para };
  });
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function aplicarSubstituicoes(html, substituicoes = []) {
  if (!substituicoes.length) return html;
  // Uma só passagem: um link novo nunca é substituído outra vez, mesmo que contenha
  // o antigo (ex.: o mesmo checkout com ?src=). O link tem de acabar ali — assim
  // ".../abc" não apanha ".../abcd".
  const alvo = new Map();
  for (const { de, para } of substituicoes) {
    alvo.set(de, para);
    alvo.set(de.replace(/&/g, '&amp;'), para.replace(/&/g, '&amp;'));
  }
  const chaves = [...alvo.keys()].sort((a, b) => b.length - a.length).map(escRe);
  const re = new RegExp(`(?:${chaves.join('|')})(?![^\\s"'<>\`)\\\\])`, 'g');
  return html.replace(re, (m) => alvo.get(m));
}

// wa.me a partir de um número angolano (ou internacional) + mensagem.
export function linkWhatsApp(numero, mensagem = '') {
  let n = String(numero).replace(/\D/g, '');
  if (n.length === 9 && n.startsWith('9')) n = '244' + n;
  return `https://wa.me/${n}${mensagem ? '?text=' + encodeURIComponent(mensagem) : ''}`;
}
