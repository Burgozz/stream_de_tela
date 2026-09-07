/**
 * Salas em memoria. Nada de banco de dados: uma sala existe enquanto tiver
 * gente dentro (ou ate expirar, se ninguem chegou a entrar).
 */

export const MAX_PEERS = 6;

/** Sala criada mas nunca ocupada morre depois disso. */
const EMPTY_ROOM_TTL_MS = 15 * 60 * 1000;

/**
 * Palavras curtas, sem acento e sem ambiguidade fonetica: o codigo precisa
 * sobreviver a ser ditado por voz no WhatsApp.
 */
const ADJETIVOS = [
  'bravo', 'calmo', 'claro', 'doce', 'firme', 'forte', 'grande', 'leve',
  'livre', 'novo', 'raro', 'rapido', 'sabio', 'suave', 'vivo', 'nobre',
  'alegre', 'quente', 'fresco', 'macio', 'lindo', 'certo', 'agil', 'justo',
];

const SUBSTANTIVOS = [
  'tigre', 'lobo', 'gato', 'pato', 'urso', 'peixe', 'cavalo', 'corvo',
  'falcao', 'tatu', 'jacare', 'tucano', 'lontra', 'raposa', 'coruja', 'panda',
  'barco', 'campo', 'monte', 'rio', 'vale', 'porto', 'farol', 'trem',
];

/** @type {Map<string, Room>} */
const rooms = new Map();

/**
 * @typedef {Object} Peer
 * @property {string} id      socket id
 * @property {string} name
 * @property {boolean} muted
 * @property {boolean} camOn
 * @property {boolean} sharing
 * @property {number} joinedAt
 */

/**
 * @typedef {Object} Room
 * @property {string} code
 * @property {number} createdAt
 * @property {Map<string, Peer>} peers
 */

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

/** Gera algo como "bravo-tigre-42". */
function generateCode() {
  const numero = 10 + Math.floor(Math.random() * 90);
  return `${pick(ADJETIVOS)}-${pick(SUBSTANTIVOS)}-${numero}`;
}

export function isValidCode(code) {
  return typeof code === 'string' && /^[a-z]+-[a-z]+-\d{2}$/.test(code);
}

/** Cria uma sala vazia com um codigo livre. */
export function createRoom() {
  sweep();
  let code = generateCode();
  // ~46 mil combinacoes; a chance de colidir com uma sala ativa e minima, mas
  // e barato garantir que o codigo esta livre.
  for (let tentativas = 0; rooms.has(code) && tentativas < 50; tentativas++) {
    code = generateCode();
  }
  const room = { code, createdAt: Date.now(), peers: new Map() };
  rooms.set(code, room);
  return room;
}

export function getRoom(code) {
  return rooms.get(code) ?? null;
}

/**
 * Uma sala tambem pode nascer de alguem que abriu o link direto. Isso evita o
 * caso chato de "criei a sala, mandei o link, mas o servidor reiniciou".
 */
export function getOrCreateRoom(code) {
  if (!isValidCode(code)) return null;
  let room = rooms.get(code);
  if (!room) {
    room = { code, createdAt: Date.now(), peers: new Map() };
    rooms.set(code, room);
  }
  return room;
}

/**
 * @returns {{ok: true, peer: Peer, room: Room} | {ok: false, reason: string}}
 */
export function addPeer(code, socketId, name) {
  const room = getOrCreateRoom(code);
  if (!room) return { ok: false, reason: 'codigo-invalido' };
  if (room.peers.size >= MAX_PEERS) return { ok: false, reason: 'sala-cheia' };

  const peer = {
    id: socketId,
    name: name,
    muted: false,
    camOn: false,
    sharing: false,
    joinedAt: Date.now(),
  };
  room.peers.set(socketId, peer);
  return { ok: true, peer, room };
}

export function removePeer(code, socketId) {
  const room = rooms.get(code);
  if (!room) return null;
  const peer = room.peers.get(socketId) ?? null;
  room.peers.delete(socketId);
  if (room.peers.size === 0) rooms.delete(code);
  return peer;
}

export function updatePeer(code, socketId, patch) {
  const peer = rooms.get(code)?.peers.get(socketId);
  if (!peer) return null;
  Object.assign(peer, patch);
  return peer;
}

/** Formato enviado ao cliente (o objeto interno e o mesmo, mas fica explicito). */
export function publicPeer(peer) {
  return {
    id: peer.id,
    name: peer.name,
    muted: peer.muted,
    camOn: peer.camOn,
    sharing: peer.sharing,
  };
}

/** Remove salas vazias que ficaram para tras. */
export function sweep() {
  const agora = Date.now();
  for (const [code, room] of rooms) {
    if (room.peers.size === 0 && agora - room.createdAt > EMPTY_ROOM_TTL_MS) {
      rooms.delete(code);
    }
  }
}

export function stats() {
  let pessoas = 0;
  for (const room of rooms.values()) pessoas += room.peers.size;
  return { salas: rooms.size, pessoas };
}
