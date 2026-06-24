'use strict';

const express = require('express');
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');

const app = express();
app.use(express.json());

// ── State ────────────────────────────────────────────────────────────────────
const sessions = new Map();   // sessionId → { sock, status, qr, phone }
const TOKEN    = process.env.AUTH_TOKEN || '';

// ── Logger ───────────────────────────────────────────────────────────────────
const logger = pino({ level: 'info' });

// ── Auth middleware ───────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  if (!TOKEN) return next();
  const bearer = req.headers['authorization'] || '';
  const token  = bearer.startsWith('Bearer ') ? bearer.slice(7) : bearer;
  if (token !== TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── Health check (no auth) ────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Apply auth to all other routes
app.use(authMiddleware);

// ── Root ──────────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.json({ status: 'running', sessions: [...sessions.keys()] }));

// ── Session helpers ───────────────────────────────────────────────────────────
async function createSession(sessionId) {
  const { state, saveCreds } = await useMultiFileAuthState(`sessions/${sessionId}`);
  const { version }          = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth:               state,
    printQRInTerminal:  false,
    logger:             pino({ level: 'silent' }),
  });

  const entry = { sock, status: 'connecting', qr: null, phone: null };
  sessions.set(sessionId, entry);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ qr, connection, lastDisconnect }) => {
    if (qr) {
      try {
        entry.qr = await QRCode.toDataURL(qr);
      } catch {
        entry.qr = qr;
      }
      entry.status = 'qr_pending';
      logger.info({ sessionId }, 'QR code generated');
    }

    if (connection === 'open') {
      entry.status = 'connected';
      entry.qr     = null;
      entry.phone  = sock.user?.id?.split(':')[0] ?? null;
      logger.info({ sessionId, phone: entry.phone }, 'Session connected');
    }

    if (connection === 'close') {
      const code      = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      logger.info({ sessionId, code, loggedOut }, 'Session closed');

      if (loggedOut) {
        sessions.delete(sessionId);
      } else {
        // Reconnect
        entry.status = 'reconnecting';
        logger.info({ sessionId }, 'Reconnecting…');
        await createSession(sessionId);
      }
    }
  });

  return entry;
}

// ── POST /session/start ───────────────────────────────────────────────────────
app.post('/session/start', async (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

  if (sessions.has(sessionId)) {
    const { status, phone } = sessions.get(sessionId);
    return res.json({ success: true, message: 'already exists', status, phone });
  }

  try {
    await createSession(sessionId);
    return res.json({ success: true, sessionId });
  } catch (err) {
    logger.error({ err, sessionId }, 'Failed to start session');
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /session/qr/:sessionId ────────────────────────────────────────────────
app.get('/session/qr/:sessionId', (req, res) => {
  const entry = sessions.get(req.params.sessionId);
  if (!entry)    return res.status(404).json({ error: 'session not found' });
  if (!entry.qr) return res.status(404).json({ error: 'QR not available yet — session may already be connected' });
  return res.json({ qr: entry.qr });
});

// ── GET /session/status/:sessionId ───────────────────────────────────────────
app.get('/session/status/:sessionId', (req, res) => {
  const entry = sessions.get(req.params.sessionId);
  if (!entry) return res.json({ status: 'not_found' });
  return res.json({ status: entry.status, phone: entry.phone });
});

// ── GET /session/list ─────────────────────────────────────────────────────────
app.get('/session/list', (_req, res) => {
  const list = [...sessions.entries()].map(([id, e]) => ({
    sessionId: id,
    status:    e.status,
    phone:     e.phone,
  }));
  return res.json({ sessions: list });
});

// ── POST /message/send ────────────────────────────────────────────────────────
app.post('/message/send', async (req, res) => {
  const { sessionId, to, message } = req.body || {};
  if (!sessionId || !to || !message)
    return res.status(400).json({ error: 'sessionId, to, and message are required' });

  const entry = sessions.get(sessionId);
  if (!entry) return res.status(404).json({ error: 'session not found' });
  if (entry.status !== 'connected')
    return res.status(409).json({ error: `session is not connected (status: ${entry.status})` });

  try {
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    await entry.sock.sendMessage(jid, { text: message });
    return res.json({ success: true });
  } catch (err) {
    logger.error({ err, sessionId, to }, 'Failed to send message');
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /chats/:sessionId ─────────────────────────────────────────────────────
app.get('/chats/:sessionId', (req, res) => {
  const entry = sessions.get(req.params.sessionId);
  if (!entry) return res.status(404).json({ error: 'session not found' });
  // Baileys stores chats in memory via store; return empty array if no store attached
  return res.json({ chats: [] });
});

// ── DELETE /session/disconnect/:sessionId ─────────────────────────────────────
app.delete('/session/disconnect/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const entry = sessions.get(sessionId);
  if (!entry) return res.status(404).json({ error: 'session not found' });

  try {
    await entry.sock.logout();
  } catch {
    // ignore — socket may already be closed
  }
  sessions.delete(sessionId);
  return res.json({ success: true });
});

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info({ port: PORT }, `Koko WhatsApp server listening`);
});
