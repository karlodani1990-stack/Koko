import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import makeWASocket, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';

const app = new Hono();
const sessions = new Map();
const qrCodes = new Map();
const TOKEN = process.env.AUTH_TOKEN || '';

app.use('/*', async (c, next) => {
  const auth = c.req.header('Authorization')?.replace('Bearer ', '');
  if (TOKEN && auth !== TOKEN) return c.json({ error: 'Unauthorized' }, 401);
  await next();
});

app.get('/', (c) => c.json({ status: 'running' }));

app.post('/session/start', async (c) => {
  const { sessionId } = await c.req.json();
  if (sessions.has(sessionId)) return c.json({ success: true, message: 'already exists' });
  const { state, saveCreds } = await useMultiFileAuthState(`sessions/${sessionId}`);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ version, auth: state, printQRInTerminal: false });
  sessions.set(sessionId, sock);
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', ({ qr, connection, lastDisconnect }) => {
    if (qr) qrCodes.set(sessionId, `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`);
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) sessions.delete(sessionId);
    }
  });
  return c.json({ success: true });
});

app.get('/session/qr/:sessionId', (c) => {
  const qr = qrCodes.get(c.req.param('sessionId'));
  if (!qr) return c.json({ error: 'no QR yet' }, 404);
  return c.json({ qr });
});

app.get('/session/status/:sessionId', (c) => {
  const sock = sessions.get(c.req.param('sessionId'));
  if (!sock) return c.json({ status: 'not_found' });
  const connected = sock.ws?.readyState === 1;
  return c.json({ status: connected ? 'connected' : 'connecting', phone: sock.user?.id?.split(':')[0] });
});

app.post('/message/send', async (c) => {
  const { sessionId, to, message } = await c.req.json();
  const sock = sessions.get(sessionId);
  if (!sock) return c.json({ error: 'session not found' }, 404);
  const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
  await sock.sendMessage(jid, { text: message });
  return c.json({ success: true });
});

app.get('/chats/:sessionId', (c) => {
  const sock = sessions.get(c.req.param('sessionId'));
  if (!sock) return c.json({ error: 'session not found' }, 404);
  return c.json({ chats: [] });
});

app.delete('/session/disconnect/:sessionId', async (c) => {
  const sock = sessions.get(c.req.param('sessionId'));
  if (sock) { await sock.logout(); sessions.delete(c.req.param('sessionId')); }
  return c.json({ success: true });
});

serve({ fetch: app.fetch, port: process.env.PORT || 3000 });
console.log('Server running on port', process.env.PORT || 3000)
