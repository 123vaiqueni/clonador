// Trocar cores em toda a página: CSS dos ficheiros, blocos <style> e style="".
// As cores chegam do editor como "r,g,b" (o que o browser calcula) e são
// reconhecidas em qualquer formato: #abc, #aabbcc, #aabbccdd, rgb(), rgba(), white/black.

const NOMEADAS = { white: '255,255,255', black: '0,0,0' };
const RE_COR = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b|rgba?\(\s*\d{1,3}\s*,?\s*\d{1,3}\s*,?\s*\d{1,3}\s*(?:[,/]\s*[\d.]+%?\s*)?\)|\b(?:white|black)\b/gi;

function ler(token) {
  const t = token.toLowerCase();
  if (NOMEADAS[t]) return { rgb: NOMEADAS[t], alfa: 1 };
  if (t.startsWith('#')) {
    let h = t.slice(1);
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return { rgb: `${n(0)},${n(2)},${n(4)}`, alfa: h.length === 8 ? n(6) / 255 : 1 };
  }
  const nums = t.match(/[\d.]+%?/g) || [];
  const a = nums[3] ? (nums[3].endsWith('%') ? parseFloat(nums[3]) / 100 : parseFloat(nums[3])) : 1;
  return { rgb: nums.slice(0, 3).map((x) => Math.round(parseFloat(x))).join(','), alfa: a };
}

const hexParaRgb = (hex) => {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};

export function validarMapa(mapa) {
  if (!Array.isArray(mapa) || !mapa.length) throw new Error('Não há cores para trocar.');
  return mapa.slice(0, 40).map((m) => {
    const de = String(m?.de || '').replace(/\s/g, '');
    const para = String(m?.para || '').toLowerCase();
    if (!/^\d{1,3},\d{1,3},\d{1,3}$/.test(de)) throw new Error('Cor original inválida.');
    if (!/^#[0-9a-f]{6}$/.test(para)) throw new Error('Cor nova inválida.');
    return { de, para };
  });
}

function trocarEmCss(css, mapa) {
  const alvo = new Map(mapa.map((m) => [m.de, m.para]));
  return css.replace(RE_COR, (token) => {
    const { rgb, alfa } = ler(token);
    const novo = alvo.get(rgb);
    if (!novo) return token;
    if (alfa < 1) return `rgba(${hexParaRgb(novo).join(',')},${+alfa.toFixed(3)})`;
    return novo;
  });
}

// No HTML só mexemos dentro de CSS — um href="#abc" não é uma cor.
export function trocarCoresHtml(html, mapa) {
  return html
    .replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (_, a, css, b) => a + trocarEmCss(css, mapa) + b)
    .replace(/(\sstyle=")([^"]*)(")/gi, (_, a, css, b) => a + trocarEmCss(css, mapa) + b);
}

export { trocarEmCss as trocarCoresCss };
