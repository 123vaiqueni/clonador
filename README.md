# Clonador

Cola a URL de uma oferta, recebe uma cópia fiel servida pelo teu próprio domínio.
Primeira peça do fluxo **minerar → clonar → modelar → publicar** para tráfego direto.

Não usa IA para copiar: abre a página num Chromium, deixa-a montar-se, copia o HTML
final e todas as imagens/CSS/fontes, e reescreve os links. Sai igual e não gasta tokens.

## O que faz
- Versão **telemóvel** ou **computador** da página.
- **Tira popups** (cookies, newsletter, escolha de país) e **tira os scripts** do dono
  original — pixels, Tag Manager, redireccionamentos. Pode-se manter scripts se a página
  depender deles (sliders, contadores).
- Cada página fica em `/p/<id>/` — pública, pronta para receber tráfego.
- Descarregar em ZIP.

## Correr no PC
```
npm install
npm start          # http://localhost:3000 — sem APP_PASSWORD fica aberto
```
No Windows usa o Chrome instalado (`BROWSER_CHANNEL=chrome` por omissão).

## Servidor (Easypanel)
- Build pelo `Dockerfile` (imagem oficial do Playwright, já traz o Chromium).
- Variáveis: `APP_PASSWORD` (obrigatória), `PORT=3000`.
- Volume montado em `/data` — é lá que ficam as páginas. Sem volume, perdem-se a cada deploy.
- Confirmar versão: `GET /api/versao`.

## Limites
- Páginas atrás de login, captcha ou Cloudflare "a verificar o browser" podem falhar.
- Formulários e checkouts deixam de funcionar (apontam para o servidor original) — é
  isso que a modelagem vai substituir (WhatsApp, checkout próprio).
- Vídeos acima de 15 MB continuam a vir do site original.
