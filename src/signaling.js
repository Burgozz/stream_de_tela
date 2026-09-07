/**
 * Sinalizacao WebRTC. O servidor so encaminha SDP/ICE entre os participantes e
 * avisa quem entrou e quem saiu. Nenhum audio ou video passa por aqui.
 */
import {
  MAX_PEERS,
  addPeer,
  getRoom,
  isValidCode,
  publicPeer,
  removePeer,
  updatePeer,
} from './rooms.js';

const MAX_NOME = 32;
const MAX_MENSAGEM = 500;

/** Anti-flood simples do chat: no maximo 10 mensagens a cada 10 segundos. */
const CHAT_JANELA_MS = 10_000;
const CHAT_LIMITE = 10;

function limparNome(valor) {
  const texto = String(valor ?? '').replace(/\s+/g, ' ').trim();
  if (!texto) return 'Convidado';
  return texto.slice(0, MAX_NOME);
}

export function registerSignaling(io) {
  io.on('connection', (socket) => {
    // Estado da conexao. Fica no socket para o disconnect saber o que limpar.
    socket.data.code = null;
    socket.data.chatHits = [];

    socket.on('join', (payload, ack) => {
      const responder = typeof ack === 'function' ? ack : () => {};
      const code = String(payload?.code ?? '').toLowerCase().trim();
      const name = limparNome(payload?.name);

      if (!isValidCode(code)) {
        return responder({ ok: false, reason: 'codigo-invalido' });
      }
      if (socket.data.code) {
        return responder({ ok: false, reason: 'ja-esta-em-uma-sala' });
      }

      const resultado = addPeer(code, socket.id, name);
      if (!resultado.ok) return responder(resultado);

      const { room, peer } = resultado;
      socket.data.code = code;
      socket.join(code);

      // Os que ja estavam na sala. Quem chega e sempre quem faz a oferta de
      // camera/microfone, o que elimina qualquer chance de glare.
      const outros = [...room.peers.values()]
        .filter((p) => p.id !== socket.id)
        .map(publicPeer);

      responder({
        ok: true,
        you: publicPeer(peer),
        peers: outros,
        maxPeers: MAX_PEERS,
      });

      socket.to(code).emit('peer-joined', { peer: publicPeer(peer) });
    });

    /**
     * Encaminha SDP e ICE. `channel` identifica de qual conexao a mensagem veio
     * ('cam' ou 'screen:<id-do-dono-da-tela>'), e e a mesma string dos dois
     * lados do par.
     */
    socket.on('signal', (payload) => {
      const code = socket.data.code;
      if (!code) return;
      const to = payload?.to;
      const channel = payload?.channel;
      if (typeof to !== 'string' || typeof channel !== 'string') return;

      // So entrega para quem esta na mesma sala.
      const room = getRoom(code);
      if (!room || !room.peers.has(to)) return;

      io.to(to).emit('signal', {
        from: socket.id,
        channel,
        data: payload.data,
      });
    });

    /** Mudo, camera ligada/desligada, compartilhando ou nao. */
    socket.on('state', (payload) => {
      const code = socket.data.code;
      if (!code) return;
      const patch = {};
      if (typeof payload?.muted === 'boolean') patch.muted = payload.muted;
      if (typeof payload?.camOn === 'boolean') patch.camOn = payload.camOn;
      if (typeof payload?.sharing === 'boolean') patch.sharing = payload.sharing;
      if (Object.keys(patch).length === 0) return;

      const peer = updatePeer(code, socket.id, patch);
      if (!peer) return;
      io.to(code).emit('peer-state', { id: socket.id, ...patch });
    });

    /**
     * O dono da tela avisa que parou. Os outros fecham a conexao de tela dele.
     * Vai separado de `state` porque a UI precisa reagir na hora.
     */
    socket.on('screen-stopped', () => {
      const code = socket.data.code;
      if (!code) return;
      updatePeer(code, socket.id, { sharing: false });
      io.to(code).emit('screen-stopped', { id: socket.id });
    });

    socket.on('chat', (payload) => {
      const code = socket.data.code;
      if (!code) return;

      const texto = String(payload?.text ?? '').trim().slice(0, MAX_MENSAGEM);
      if (!texto) return;

      const agora = Date.now();
      socket.data.chatHits = socket.data.chatHits.filter(
        (t) => agora - t < CHAT_JANELA_MS,
      );
      if (socket.data.chatHits.length >= CHAT_LIMITE) return;
      socket.data.chatHits.push(agora);

      const peer = getRoom(code)?.peers.get(socket.id);
      if (!peer) return;

      // O texto vai cru; o cliente insere via textContent, nunca innerHTML.
      io.to(code).emit('chat', {
        id: socket.id,
        name: peer.name,
        text: texto,
        ts: agora,
      });
    });

    socket.on('leave', () => sair(socket));
    socket.on('disconnect', () => sair(socket));

    function sair(s) {
      const code = s.data.code;
      if (!code) return;
      s.data.code = null;
      const peer = removePeer(code, s.id);
      s.leave(code);
      if (peer) io.to(code).emit('peer-left', { id: s.id, name: peer.name });
    }
  });
}
