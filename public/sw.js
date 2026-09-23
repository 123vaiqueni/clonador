// Só existe para o telemóvel aceitar instalar o app. Não guarda nada em cache:
// o clonador precisa sempre do servidor.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
