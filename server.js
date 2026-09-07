import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import 'dotenv/config';
import express from 'express';
import { Server } from 'socket.io';

import { createRoom, getRoom, isValidCode, stats, sweep, MAX_PEERS } from './src/rooms.js';
import { registerSignaling } from './src/signaling.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.use(express.json());

// Atras do proxy do Render/Fly, para req.protocol refletir o HTTPS externo.
app.set('trust proxy', 1);

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

/** Servidores ICE. O TURN so entra na lista se estiver configurado. */
app.get('/api/config', (_req, res) => {
  const iceServers = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ];
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(',').map((u) => u.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME || undefined,
      credential: process.env.TURN_CREDENTIAL || undefined,
    });
  }
  res.json({ iceServers, maxPeers: MAX_PEERS, hasTurn: Boolean(process.env.TURN_URL) });
});

app.post('/api/rooms', (_req, res) => {
  const room = createRoom();
  res.json({ code: room.code });
});

/** Usado pela home para avisar antes de entrar num codigo que nao existe. */
app.get('/api/rooms/:code', (req, res) => {
  const code = String(req.params.code).toLowerCase();
  if (!isValidCode(code)) return res.status(400).json({ error: 'codigo-invalido' });
  const room = getRoom(code);
  res.json({
    code,
    exists: Boolean(room),
    peers: room ? room.peers.size : 0,
    full: room ? room.peers.size >= MAX_PEERS : false,
    maxPeers: MAX_PEERS,
  });
});

app.get('/healthz', (_req, res) => res.json({ ok: true, ...stats() }));

/** /sala/bravo-tigre-42 serve a pagina da chamada; o codigo vem da URL no cliente. */
app.get('/sala/:code', (req, res) => {
  if (!isValidCode(String(req.params.code).toLowerCase())) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

app.use((_req, res) => res.redirect('/'));

/**
 * Em producao (Render, Fly, etc.) o HTTPS e feito pelo proxy da plataforma e o
 * app fica em HTTP puro. MESHMEET_HTTPS=1 serve para testar em HTTPS na rede
 * local, que e o unico jeito de abrir a chamada no celular sem localhost.
 */
function createServer() {
  if (process.env.MESHMEET_HTTPS === '1') {
    const cert = process.env.SSL_CERT_FILE || './certs/cert.pem';
    const key = process.env.SSL_KEY_FILE || './certs/key.pem';
    if (!fs.existsSync(cert) || !fs.existsSync(key)) {
      console.error(
        `\nMESHMEET_HTTPS=1 mas nao encontrei os certificados:\n  ${cert}\n  ${key}\n` +
          'Veja a secao "Rodando com HTTPS local" do README.\n',
      );
      process.exit(1);
    }
    return {
      server: https.createServer(
        { cert: fs.readFileSync(cert), key: fs.readFileSync(key) },
        app,
      ),
      scheme: 'https',
    };
  }
  return { server: http.createServer(app), scheme: 'http' };
}

const { server, scheme } = createServer();

const io = new Server(server, {
  // O mesh e pequeno; um ping mais curto detecta queda de participante rapido.
  pingInterval: 10_000,
  pingTimeout: 15_000,
  maxHttpBufferSize: 1e6,
});

registerSignaling(io);

// Faxina de salas criadas e nunca usadas.
setInterval(sweep, 5 * 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`MeshMeet rodando em ${scheme}://localhost:${PORT}`);
  if (scheme === 'http') {
    console.log(
      'Aviso: em HTTP, camera/microfone/tela so funcionam via localhost.\n' +
        'Para testar no celular ou em outra maquina da rede, use HTTPS (veja o README).',
    );
  }
});
