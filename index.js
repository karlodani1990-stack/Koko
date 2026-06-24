'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
app.use(express.json());

const sessions = new Map();   // sessionId -> socket
const qrCodes = new Map();    // sessionId -> qr string
const sessionStatus = new Map(); // sessionId -> 'connecting' | 'connected' | 'disconnected'

const TOKEN = process.env.AUTH_TOKEN || '';
const AUTH_SESSIONS_DIR = path.join(__dirname, 'auth_sessions');

// Ensure auth_sessions directory exists
if (!fs.existsSync(AUTH_SESSIONS_DIR)) {
  fs.mkdirSync(AUTH_SESSIONS_DIR, { recursive: true });
}

// ── Bearer token authentication middleware ────────────────────────────────────
app.use((req, res, next) => {
  if (!TOKEN) return next();
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (token !== TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'running' });
});

// ── POST /session/start ───────────────────────────────────────────────────────
app.post('/session/start', async (req, res) => {
  const { sessionId } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  if (sessions.has(sessionId)) {
    return res.json({ success: true, message: 'Session already exists' });
  }

  try {
    const authDir = path.join(AUTH_SESSIONS_DIR, sessionId);
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
    });

    sessions.set(sessionId, sock);
    sessionStatus.set(sessionId, 'connecting');

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', ({ qr, connection, lastDisconnect }) => {
      if (qr) {
        qrCodes.set(sessionId, qr);
        sessionStatus.set(sessionId, 'connecting');
      }

      if (connection === 'open') {
        sessionStatus.set(sessionId, 'connected');
        qrCodes.delete(sessionId);
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        if (shouldReconnect) {
          sessionStatus.set(sessionId, 'connecting');
          sessions.delete(sessionId);
          // Caller can re-invoke /session/start to reconnect
        } else {
          sessionStatus.set(sessionId, 'disconnected');
          sessions.delete(sessionId);
          qrCodes.delete(sessionId);
        }
      }
    });

    return res.json({ success: true, message: 'Session started' });
  } catch (err) {
    console.error('Error starting session:', err);
    return res.status(500).json({ error: 'Failed to start session', details: err.message });
  }
});

// ── GET /session/qr/:sessionId ────────────────────────────────────────────────
app.get('/session/qr/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const qr = qrCodes.get(sessionId);

  if (!qr) {
    return res.status(404).json({ error: 'No QR code available for this session' });
  }

  const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`;
  return res.json({ qr, qrImageUrl });
});

// ── GET /session/status/:sessionId ────────────────────────────────────────────
app.get('/session/status/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const sock = sessions.get(sessionId);
  const status = sessionStatus.get(sessionId) || 'not_found';

  if (!sock && status === 'not_found') {
    return res.json({ status: 'not_found' });
  }

  const phone = sock?.user?.id ? sock.user.id.split(':')[0] : null;
  return res.json({ status, phone });
});

// ── POST /message/send ────────────────────────────────────────────────────────
app.post('/message/send', async (req, res) => {
  const { sessionId, to, message } = req.body;

  if (!sessionId || !to || !message) {
    return res.status(400).json({ error: 'sessionId, to, and message are required' });
  }

  const sock = sessions.get(sessionId);
  if (!sock) {
    return res.status(404).json({ error: 'Session not found' });
  }

  try {
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    return res.json({ success: true });
  } catch (err) {
    console.error('Error sending message:', err);
    return res.status(500).json({ error: 'Failed to send message', details: err.message });
  }
});

// ── DELETE /session/disconnect/:sessionId ─────────────────────────────────────
app.delete('/session/disconnect/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const sock = sessions.get(sessionId);

  if (sock) {
    try {
      await sock.logout();
    } catch (err) {
      // Ignore logout errors — socket may already be closed
    }
    sessions.delete(sessionId);
    qrCodes.delete(sessionId);
    sessionStatus.set(sessionId, 'disconnected');
  }

  return res.json({ success: true });
});

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`WhatsApp server running on port ${PORT}`);
});
