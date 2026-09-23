// Pixels: descobrir os do dono original, removê-los do HTML e injectar os teus.
// Os teus pixels não são escritos no index.html — são injectados ao servir a página,
// por isso trocar um pixel não mexe na cópia.

const DETECTORES = [
  { plataforma: 'meta', padroes: [/fbq\(\s*['"]init['"]\s*,\s*['"]?(\d{8,20})/g, /facebook\.com\/tr\/?\?[^"'\s]*?\bid=(\d{8,20})/g] },
  { plataforma: 'tiktok', padroes: [/ttq\.load\(\s*['"]([A-Z0-9]{15,30})['"]/g, /analytics\.tiktok\.com\/[^"'\s]*?sdkid=([A-Z0-9]{15,30})/g] },
  { plataforma: 'google', padroes: [/googletagmanager\.com\/gtag\/js\?id=((?:G|AW|UA|DC)-[A-Z0-9-]+)/gi, /gtag\(\s*['"]config['"]\s*,\s*['"]((?:G|AW|UA|DC)-[A-Z0-9-]+)/gi] },
  { plataforma: 'gtm', padroes: [/\b(GTM-[A-Z0-9]{4,10})\b/g] },
  { plataforma: 'kwai', padroes: [/kwaiq\.load\(\s*['"]?(\d{6,25})/g, /kwaiq\.instance\(\s*['"]?(\d{6,25})/g] },
  { plataforma: 'pinterest', padroes: [/pintrk\(\s*['"]load['"]\s*,\s*['"]?(\d{8,20})/g, /ct\.pinterest\.com\/v3\/?\?[^"'\s]*?\btid=(\d{8,20})/g] },
  { plataforma: 'snapchat', padroes: [/snaptr\(\s*['"]init['"]\s*,\s*['"]([0-9a-f-]{20,40})/gi] },
  { plataforma: 'utmify', padroes: [/window\.pixelId\s*=\s*['"]([A-Za-z0-9]{8,40})['"]/g] },
  { plataforma: 'clarity', padroes: [/clarity\.ms\/tag\/([a-z0-9]{6,15})/gi] },
];

export const NOMES = {
  meta: 'Meta (Facebook/Instagram)', tiktok: 'TikTok', google: 'Google (Ads/Analytics)', gtm: 'Google Tag Manager',
  kwai: 'Kwai', pinterest: 'Pinterest', snapchat: 'Snapchat', utmify: 'Utmify', clarity: 'Microsoft Clarity',
  personalizado: 'Código personalizado',
};

export function detectarPixels(texto) {
  const achados = new Map();
  for (const { plataforma, padroes } of DETECTORES) {
    for (const re of padroes) {
      for (const m of texto.matchAll(re)) {
        const id = m[1].toUpperCase().startsWith('G') || plataforma === 'tiktok' ? m[1].toUpperCase() : m[1];
        achados.set(`${plataforma}:${id}`, { plataforma, id });
      }
    }
  }
  return [...achados.values()];
}

// Tira do HTML tudo o que tenha o ID do pixel: scripts, <noscript>, <img>/<iframe> de rastreio.
export function removerPixel(html, id) {
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tem = new RegExp(esc, 'i');
  let removidos = 0;
  const tirar = (re) => {
    html = html.replace(re, (bloco) => {
      if (!tem.test(bloco)) return bloco;
      removidos++;
      return '';
    });
  };
  tirar(/<script\b[^>]*>[\s\S]*?<\/script>/gi);
  tirar(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi);
  tirar(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi);
  tirar(/<(?:img|link)\b[^>]*>/gi);
  return { html, removidos };
}

const VALIDAR = {
  meta: /^\d{8,20}$/,
  tiktok: /^[A-Z0-9]{15,30}$/,
  google: /^(G|AW|UA|DC)-[A-Z0-9-]{4,20}$/,
  gtm: /^GTM-[A-Z0-9]{4,10}$/,
  kwai: /^\d{6,25}$/,
  pinterest: /^\d{8,20}$/,
  snapchat: /^[0-9a-f-]{20,40}$/i,
  utmify: /^[A-Za-z0-9]{8,40}$/,
  clarity: /^[a-z0-9]{6,15}$/i,
};

export function validarMeusPixels(lista) {
  if (!Array.isArray(lista)) throw new Error('Lista de pixels inválida.');
  if (lista.length > 20) throw new Error('No máximo 20 pixels por página.');
  return lista.map((p) => {
    const plataforma = String(p?.plataforma || '');
    if (plataforma === 'personalizado') {
      const codigo = String(p.codigo || '').trim();
      if (!codigo) throw new Error('O código personalizado está vazio.');
      if (codigo.length > 20000) throw new Error('O código personalizado é demasiado grande.');
      return { plataforma, codigo, nome: String(p.nome || '').slice(0, 60) };
    }
    if (!VALIDAR[plataforma]) throw new Error('Plataforma desconhecida.');
    let id = String(p.id || '').trim();
    if (['tiktok', 'google', 'gtm'].includes(plataforma)) id = id.toUpperCase();
    if (!VALIDAR[plataforma].test(id)) throw new Error(`O ID "${id}" não parece um ID de ${NOMES[plataforma]}.`);
    return { plataforma, id };
  });
}

function codigoDe({ plataforma, id, codigo }) {
  switch (plataforma) {
    case 'meta':
      return `<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${id}');fbq('track','PageView');</script>
<noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=${id}&ev=PageView&noscript=1"></noscript>`;
    case 'tiktok':
      return `<script>!function(w,d,t){w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie","holdConsent","revokeConsent","grantConsent"],ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);ttq.instance=function(t){for(var e=ttq._i[t]||[],n=0;n<ttq.methods.length;n++)ttq.setAndDefer(e,ttq.methods[n]);return e},ttq.load=function(e,n){var r="https://analytics.tiktok.com/i18n/pixel/events.js";ttq._i=ttq._i||{},ttq._i[e]=[],ttq._i[e]._u=r,ttq._t=ttq._t||{},ttq._t[e]=+new Date,ttq._o=ttq._o||{},ttq._o[e]=n||{};var s=d.createElement("script");s.type="text/javascript",s.async=!0,s.src=r+"?sdkid="+e+"&lib="+t;var a=d.getElementsByTagName("script")[0];a.parentNode.insertBefore(s,a)};ttq.load('${id}');ttq.page();}(window,document,'ttq');</script>`;
    case 'google':
      return `<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${id}');</script>`;
    case 'gtm':
      return `<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${id}');</script>`;
    case 'kwai':
      return `<script>!function(e,t){var n=e.kwaiq=e.kwaiq||[];n.methods=["track","page","instance"];n.factory=function(e){return function(){var t=Array.prototype.slice.call(arguments);t.unshift(e);n.push(t);return n}};for(var o=0;o<n.methods.length;o++){var i=n.methods[o];n[i]=n.factory(i)}n.load=function(e){var o=t.createElement("script");o.type="text/javascript";o.async=!0;o.src="https://s1.kwai.net/kos/s101/nlav11187/pixel/events.js?sdkid="+e;var i=t.getElementsByTagName("script")[0];i.parentNode.insertBefore(o,i)}}(window,document);kwaiq.load('${id}');kwaiq.page();</script>`;
    case 'pinterest':
      return `<script>!function(e){if(!window.pintrk){window.pintrk=function(){window.pintrk.queue.push(Array.prototype.slice.call(arguments))};var n=window.pintrk;n.queue=[],n.version="3.0";var t=document.createElement("script");t.async=!0,t.src=e;var r=document.getElementsByTagName("script")[0];r.parentNode.insertBefore(t,r)}}("https://s.pinimg.com/ct/core.js");pintrk('load','${id}');pintrk('page');</script>`;
    case 'snapchat':
      return `<script>(function(e,t,n){if(e.snaptr)return;var a=e.snaptr=function(){a.handleRequest?a.handleRequest.apply(a,arguments):a.queue.push(arguments)};a.queue=[];var s='script';r=t.createElement(s);r.async=!0;r.src=n;var u=t.getElementsByTagName(s)[0];u.parentNode.insertBefore(r,u);})(window,document,'https://sc-static.net/scevent.min.js');snaptr('init','${id}');snaptr('track','PAGE_VIEW');</script>`;
    case 'utmify':
      return `<script>window.pixelId="${id}";var a=document.createElement("script");a.setAttribute("async","");a.setAttribute("defer","");a.setAttribute("src","https://cdn.utmify.com.br/scripts/pixel/pixel.js");document.head.appendChild(a);</script>`;
    case 'clarity':
      return `<script>(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window,document,"clarity","script","${id}");</script>`;
    case 'personalizado':
      return codigo;
    default:
      return '';
  }
}

export function injectarPixels(html, meusPixels = []) {
  if (!meusPixels.length) return html;
  const bloco = `\n<!-- pixels do clonador -->\n${meusPixels.map(codigoDe).join('\n')}\n<!-- /pixels do clonador -->\n`;
  return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${bloco}</head>`) : bloco + html;
}
