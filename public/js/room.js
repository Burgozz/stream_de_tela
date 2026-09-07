/**
 * Orquestracao da sala: lobby, controles, socket e ligacao com o PeerManager.
 */
import {
  canShareScreen,
  checkSupport,
  describeMediaError,
  getCameraTrack,
  getLocalStream,
  getMicrophoneTrack,
  getScreenStream,
  unlockAudio,
  watchSpeaking,
} from './media.js';
import { PeerManager } from './webrtc.js';
import * as ui from './ui.js';

const CODE = decodeURIComponent(location.pathname.split('/').pop() || '').toLowerCase();
const NOME_SALVO = 'meshmeet:nome';

/* Elementos ------------------------------------------------------- */
const $ = (id) => document.getElementById(id);

const lobby = $('lobby');
const lobbyForm = $('lobby-form');
const lobbyNome = $('lobby-nome');
const lobbyPreview = $('lobby-preview');
const lobbyAviso = $('lobby-aviso');
const lobbyCodigo = $('lobby-codigo');
const lobbyEntrar = $('lobby-entrar');

const salaCodigo = $('sala-codigo');
const btnCopiar = $('btn-copiar');
const contador = $('contador');
const conexaoBanner = $('conexao-banner');

const btnMic = $('btn-mic');
const btnCam = $('btn-cam');
const btnTela = $('btn-tela');
const btnChat = $('btn-chat');
const btnSair = $('btn-sair');

const chatPanel = $('chat-panel');
const chatLista = $('chat-lista');
const chatForm = $('chat-form');
const chatInput = $('chat-input');
const chatBadge = $('chat-badge');
const chatFechar = $('chat-fechar');

const saida = $('saida');
const btnVoltar = $('btn-voltar');
const btnReentrar = $('btn-reentrar');

/* Estado ---------------------------------------------------------- */
let socket = null;
let peerManager = null;
let selfId = null;
let meuNome = '';
let localStream = null; // camera + microfone locais
let previewStream = null; // stream usado so no lobby
let micLigado = true;
let camLigada = true;
let compartilhando = false;
let saiuDeProposito = false;

/**
 * "Bloqueado" e diferente de "desligado": a pessoa nao negou nada de proposito,
 * o navegador e que nao deu acesso. A UI precisa separar os dois, senao parece
 * que ela se mutou sozinha — e o botao vira o caminho de pedir a permissao.
 */
let audioBloqueado = false;
let videoBloqueado = false;

/** Participantes conhecidos (inclui voce). @type {Map<string, any>} */
const participantes = new Map();
/** Funcoes para parar de observar "quem esta falando". */
const observadoresDeVoz = new Map();

/* ------------------------------------------------------------------ *
 * Lobby
 * ------------------------------------------------------------------ */

salaCodigo.textContent = CODE;
lobbyCodigo.textContent = CODE;
lobbyNome.value = localStorage.getItem(NOME_SALVO) || '';

const problemas = checkSupport();
if (problemas.length > 0) {
  lobbyAviso.hidden = false;
  lobbyAviso.textContent = problemas.join(' ');
  lobbyEntrar.disabled = true;
}

if (!canShareScreen()) {
  btnTela.disabled = true;
  btnTela.title =
    'Este navegador nao permite compartilhar tela (comum em celulares). Voce continua vendo a tela dos outros.';
}

/** Previa da camera antes de entrar, para a pessoa se ver e ja dar a permissao. */
async function prepararPreview() {
  if (problemas.length > 0) return;
  const { stream, hasVideo, hasAudio, warning } = await getLocalStream();
  previewStream = stream;
  micLigado = hasAudio;
  camLigada = hasVideo;
  audioBloqueado = !hasAudio;
  videoBloqueado = !hasVideo;

  if (stream) {
    lobbyPreview.srcObject = stream;
    lobbyPreview.play().catch(() => {});
  }
  if (warning) {
    lobbyAviso.hidden = false;
    // Recusar a permissao nao impede a entrada, e isso precisa ficar dito.
    lobbyAviso.textContent = stream
      ? warning
      : `${warning} Voce pode entrar assim mesmo: vai ver e ouvir todo mundo, e ` +
        'da para liberar depois pelos botoes de microfone e camera.';
  }
  // Sem camera e sem microfone ainda da para entrar: vale como espectador.
  lobbyEntrar.disabled = false;
}

const preparacao = prepararPreview();

lobbyForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const nome = lobbyNome.value.trim();
  if (!nome) {
    lobbyNome.focus();
    return;
  }
  // Se a pessoa foi mais rapida que o popup de permissao, espera a resposta
  // dela antes de entrar — senao entraria sem midia por pura corrida.
  await preparacao;
  meuNome = nome.slice(0, 32);
  localStorage.setItem(NOME_SALVO, meuNome);
  lobbyEntrar.disabled = true;
  lobbyEntrar.textContent = 'Entrando...';
  unlockAudio();
  await entrar();
});

/* ------------------------------------------------------------------ *
 * Entrada na chamada
 * ------------------------------------------------------------------ */

async function entrar() {
  // O preview vira o stream da chamada; pedir de novo abriria outro popup.
  localStream = previewStream ?? new MediaStream();
  previewStream = null;
  lobbyPreview.srcObject = null;

  let config;
  try {
    config = await fetch('/api/config').then((r) => r.json());
  } catch {
    config = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  }

  socket = io({ transports: ['websocket', 'polling'] });

  peerManager = new PeerManager({
    socket,
    iceServers: config.iceServers,
    on: {
      camStream: (id, stream) => {
        ui.setTileStream(id, stream);
        observarVoz(id, stream);
      },
      screenStream: (id, stream) => {
        const p = participantes.get(id);
        ui.addScreen(id, p?.name ?? 'Participante', stream);
      },
      screenRemoved: (id) => ui.removeScreen(id),
      screenEndedLocally: () => {
        // A pessoa clicou em "Parar compartilhamento" na barra do navegador.
        compartilhando = false;
        atualizarBotaoTela();
        ui.removeScreen(selfId);
        socket.emit('state', { sharing: false });
        ui.toast('Voce parou de compartilhar a tela.');
      },
      connectionState: (id, canal, estado) => {
        if (canal === 'cam') ui.setTileState(id, { connection: estado });
      },
    },
  });

  socket.on('connect', () => {
    conexaoBanner.hidden = true;
    socket.emit('join', { code: CODE, name: meuNome }, aoEntrar);
  });

  socket.on('disconnect', (motivo) => {
    if (saiuDeProposito) return;
    conexaoBanner.hidden = false;
    conexaoBanner.textContent =
      motivo === 'io server disconnect'
        ? 'Desconectado do servidor.'
        : 'Conexao perdida. Tentando reconectar...';
  });

  socket.on('connect_error', () => {
    conexaoBanner.hidden = false;
    conexaoBanner.textContent = 'Sem conexao com o servidor. Tentando de novo...';
  });

  socket.on('peer-joined', ({ peer }) => {
    // Quem chega e quem oferece a conexao; para mim ele e o lado passivo.
    adicionarParticipante(peer, { euOfereco: false });
    ui.toast(`${peer.name} entrou na chamada.`, { tipo: 'ok', duracao: 3500 });
  });

  socket.on('peer-left', ({ id, name }) => {
    removerParticipante(id);
    ui.toast(`${name} saiu da chamada.`, { duracao: 3500 });
  });

  socket.on('peer-state', ({ id, muted, camOn, sharing }) => {
    const p = participantes.get(id);
    if (!p) return;
    if (typeof muted === 'boolean') p.muted = muted;
    if (typeof camOn === 'boolean') p.camOn = camOn;
    if (typeof sharing === 'boolean') p.sharing = sharing;
    ui.setTileState(id, { muted: p.muted, camOn: p.camOn });
  });

  socket.on('signal', (msg) => peerManager.handleSignal(msg));

  socket.on('screen-stopped', ({ id }) => {
    if (id === selfId) return;
    peerManager.handleRemoteScreenStopped(id);
  });

  socket.on('chat', receberMensagem);

  // Alca de depuracao: no console do navegador, `__meshmeet.estado()` mostra o
  // estado de cada conexao. Ajuda muito a diagnosticar "nao vejo o fulano".
  window.__meshmeet = {
    get peerManager() {
      return peerManager;
    },
    get socket() {
      return socket;
    },
    estado() {
      const linhas = [];
      for (const [id, r] of peerManager.peers) {
        for (const [rotulo, conn] of [
          ['cam', r.cam],
          ['tela-recebida', r.screenIn],
          ['tela-enviada', r.screenOut],
        ]) {
          if (conn) {
            linhas.push({
              participante: participantes.get(id)?.name ?? id,
              conexao: rotulo,
              estado: conn.pc.connectionState,
              ice: conn.pc.iceConnectionState,
            });
          }
        }
      }
      return linhas;
    },
  };
}

function aoEntrar(resposta) {
  if (!resposta?.ok) {
    const mensagens = {
      'sala-cheia': `Esta sala ja esta com o maximo de participantes. Combine outra com o pessoal.`,
      'codigo-invalido': 'Este codigo de sala nao e valido.',
      'ja-esta-em-uma-sala': 'Voce ja esta nesta chamada em outra aba.',
    };
    lobbyAviso.hidden = false;
    lobbyAviso.textContent = mensagens[resposta?.reason] ?? 'Nao consegui entrar na sala.';
    lobbyEntrar.disabled = false;
    lobbyEntrar.textContent = 'Entrar na chamada';
    return;
  }

  selfId = resposta.you.id;
  peerManager.setSelfId(selfId);

  lobby.hidden = true;
  document.body.classList.add('em-chamada');

  // Minha propria miniatura.
  participantes.set(selfId, { ...resposta.you, name: meuNome, isSelf: true });
  ui.addTile(selfId, meuNome, { isSelf: true });
  ui.setTileStream(selfId, localStream);

  const audio = localStream.getAudioTracks()[0] ?? null;
  const video = localStream.getVideoTracks()[0] ?? null;
  micLigado = Boolean(audio?.enabled);
  camLigada = Boolean(video);
  audioBloqueado = !audio;
  videoBloqueado = !video;
  peerManager.localAudio = audio;
  peerManager.localVideo = video;

  ui.setTileState(selfId, { muted: !micLigado, camOn: camLigada });
  atualizarAvisoProprio();
  atualizarBotoes();

  if (audioBloqueado && videoBloqueado) {
    ui.toast(
      'Voce entrou sem microfone e sem camera. Da para acompanhar assim, ou clicar nos botoes para liberar.',
      { duracao: 10000 },
    );
  }
  if (localStream.getAudioTracks().length > 0) observarVoz(selfId, localStream);

  // Eu cheguei depois: eu ofereco a conexao de camera para quem ja estava.
  for (const peer of resposta.peers) {
    adicionarParticipante(peer, { euOfereco: true });
  }

  socket.emit('state', { muted: !micLigado, camOn: camLigada });
  atualizarContador();

  if (resposta.peers.length === 0) {
    ui.toast('Voce e o primeiro aqui. Envie o link para o pessoal entrar.', {
      tipo: 'info',
      duracao: 8000,
    });
  }
}

function adicionarParticipante(peer, { euOfereco }) {
  if (participantes.has(peer.id)) return;
  participantes.set(peer.id, { ...peer, isSelf: false });
  ui.addTile(peer.id, peer.name);
  ui.setTileState(peer.id, { muted: peer.muted, camOn: peer.camOn, connection: 'connecting' });
  peerManager.addPeer(peer.id, peer.name, euOfereco);
  atualizarContador();
}

function removerParticipante(id) {
  participantes.delete(id);
  observadoresDeVoz.get(id)?.();
  observadoresDeVoz.delete(id);
  peerManager?.removePeer(id);
  ui.removeScreen(id);
  ui.removeTile(id);
  atualizarContador();
}

function atualizarContador() {
  const n = participantes.size;
  contador.textContent = n === 1 ? '1 pessoa' : `${n} pessoas`;
}

function observarVoz(id, stream) {
  if (observadoresDeVoz.has(id)) return;
  if (stream.getAudioTracks().length === 0) return;
  const parar = watchSpeaking(stream, (falando) => {
    // Quem esta no mudo nao deve acender o indicador.
    const p = participantes.get(id);
    const mudo = id === selfId ? !micLigado : p?.muted;
    ui.setTileState(id, { speaking: falando && !mudo });
  });
  observadoresDeVoz.set(id, parar);
}

/* ------------------------------------------------------------------ *
 * Controles
 * ------------------------------------------------------------------ */

btnMic.addEventListener('click', async () => {
  // Sem permissao, o botao nao alterna nada: ele pede o acesso de novo.
  if (audioBloqueado) {
    await liberarMicrofone();
    return;
  }
  const track = localStream?.getAudioTracks()[0];
  if (!track) return;
  micLigado = !micLigado;
  track.enabled = micLigado;
  socket.emit('state', { muted: !micLigado });
  ui.setTileState(selfId, { muted: !micLigado, speaking: false });
  atualizarBotoes();
});

async function liberarMicrofone() {
  try {
    const track = await getMicrophoneTrack();
    if (!track) throw new Error('sem faixa de audio');
    localStream.addTrack(track);
    await peerManager.setLocalAudioTrack(track);
    audioBloqueado = false;
    micLigado = true;
    observarVoz(selfId, localStream);
    socket.emit('state', { muted: false });
    ui.setTileState(selfId, { muted: false });
    ui.toast('Microfone liberado.', { tipo: 'ok', duracao: 3000 });
  } catch (err) {
    ui.toast(describeMediaError(err, 'microfone'), { tipo: 'erro', duracao: 9000 });
  }
  atualizarAvisoProprio();
  atualizarBotoes();
}

btnCam.addEventListener('click', async () => {
  if (camLigada) {
    // Desligar de verdade (e nao so `enabled = false`) apaga a luz da webcam.
    const track = localStream.getVideoTracks()[0];
    if (track) {
      track.stop();
      localStream.removeTrack(track);
    }
    await peerManager.setLocalVideoTrack(null);
    camLigada = false;
  } else {
    try {
      const track = await getCameraTrack();
      if (!track) throw new Error('sem faixa de video');
      localStream.addTrack(track);
      await peerManager.setLocalVideoTrack(track);
      camLigada = true;
      videoBloqueado = false;
    } catch (err) {
      videoBloqueado = true;
      ui.toast(describeMediaError(err, 'camera'), { tipo: 'erro', duracao: 9000 });
      atualizarAvisoProprio();
      atualizarBotoes();
      return;
    }
  }
  ui.setTileStream(selfId, localStream);
  ui.setTileState(selfId, { camOn: camLigada });
  socket.emit('state', { camOn: camLigada });
  atualizarAvisoProprio();
  atualizarBotoes();
});

/** Mostra na propria miniatura o que esta sem permissao. */
function atualizarAvisoProprio() {
  const faltando = [];
  if (audioBloqueado) faltando.push('microfone');
  if (videoBloqueado) faltando.push('camera');
  ui.setTileState(selfId, {
    aviso: faltando.length > 0 ? `sem permissao de ${faltando.join(' e ')}` : '',
  });
}

btnTela.addEventListener('click', async () => {
  if (compartilhando) {
    peerManager.stopScreen();
    compartilhando = false;
    ui.removeScreen(selfId);
    socket.emit('state', { sharing: false });
    atualizarBotaoTela();
    return;
  }

  let stream;
  try {
    stream = await getScreenStream();
  } catch (err) {
    // Cancelar o seletor de tela do navegador cai aqui e nao e um erro.
    if (err?.name !== 'NotAllowedError' && err?.name !== 'AbortError') {
      ui.toast(describeMediaError(err, 'tela'), { tipo: 'erro', duracao: 8000 });
    }
    return;
  }

  await peerManager.startScreen(stream);
  compartilhando = true;
  ui.addScreen(selfId, meuNome, stream, { isSelf: true });
  socket.emit('state', { sharing: true });
  atualizarBotaoTela();
});

btnSair.addEventListener('click', sair);

btnVoltar.addEventListener('click', () => {
  location.href = '/';
});

btnReentrar.addEventListener('click', () => {
  location.reload();
});

function sair() {
  saiuDeProposito = true;
  try {
    peerManager?.closeAll();
    socket?.emit('leave');
    socket?.disconnect();
  } catch {
    /* saindo mesmo assim */
  }
  for (const track of localStream?.getTracks() ?? []) track.stop();
  for (const parar of observadoresDeVoz.values()) parar();
  observadoresDeVoz.clear();
  document.body.classList.remove('em-chamada');
  saida.hidden = false;
}

window.addEventListener('pagehide', () => {
  if (!saiuDeProposito) socket?.emit('leave');
});

/** Em tela estreita os cinco controles so cabem lado a lado com rotulo curto. */
const telaEstreita = window.matchMedia('(max-width: 520px)');

function rotulo(curto, longo) {
  return telaEstreita.matches ? curto : longo;
}

function atualizarBotoes() {
  const PEDIR_DE_NOVO = 'Sem permissao do navegador. Clique para pedir de novo.';

  btnMic.classList.toggle('is-bloqueado', audioBloqueado);
  btnMic.classList.toggle('is-off', !micLigado && !audioBloqueado);
  btnMic.setAttribute('aria-pressed', String(!micLigado));
  btnMic.title = audioBloqueado ? PEDIR_DE_NOVO : '';
  btnMic.querySelector('.btn-texto').textContent = audioBloqueado
    ? rotulo('Sem perm.', 'Sem permissao')
    : micLigado
      ? rotulo('Mic', 'Microfone')
      : 'Mudo';

  btnCam.classList.toggle('is-bloqueado', videoBloqueado);
  btnCam.classList.toggle('is-off', !camLigada && !videoBloqueado);
  btnCam.setAttribute('aria-pressed', String(!camLigada));
  btnCam.title = videoBloqueado ? PEDIR_DE_NOVO : '';
  btnCam.querySelector('.btn-texto').textContent = videoBloqueado
    ? rotulo('Sem perm.', 'Sem permissao')
    : camLigada
      ? rotulo('Camera', 'Camera')
      : rotulo('Cam off', 'Camera off');

  atualizarBotaoTela();
}

function atualizarBotaoTela() {
  btnTela.classList.toggle('is-on', compartilhando);
  btnTela.querySelector('.btn-texto').textContent = compartilhando
    ? rotulo('Parar', 'Parar tela')
    : rotulo('Tela', 'Compartilhar');
}

// Girar o celular ou redimensionar a janela troca os rotulos.
telaEstreita.addEventListener('change', () => {
  if (selfId) atualizarBotoes();
});

/* ------------------------------------------------------------------ *
 * Link da sala
 * ------------------------------------------------------------------ */

btnCopiar.addEventListener('click', async () => {
  const link = `${location.origin}/sala/${CODE}`;
  try {
    await navigator.clipboard.writeText(link);
    ui.toast('Link copiado. Cole no grupo e chame o pessoal.', { tipo: 'ok', duracao: 3500 });
  } catch {
    // Clipboard bloqueado (http, permissao): mostra o link para copiar na mao.
    ui.toast(link, { tipo: 'info', duracao: 15000 });
  }
});

/* ------------------------------------------------------------------ *
 * Chat
 * ------------------------------------------------------------------ */

let naoLidas = 0;

btnChat.addEventListener('click', () => alternarChat());
chatFechar.addEventListener('click', () => alternarChat(false));

function alternarChat(forcar) {
  const abrir = forcar ?? chatPanel.hidden;
  chatPanel.hidden = !abrir;
  btnChat.classList.toggle('is-on', abrir);
  if (abrir) {
    naoLidas = 0;
    chatBadge.hidden = true;
    chatInput.focus();
  }
}

chatForm.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const texto = chatInput.value.trim();
  if (!texto) return;
  socket.emit('chat', { text: texto });
  chatInput.value = '';
});

function receberMensagem({ id, name, text, ts }) {
  const item = document.createElement('div');
  item.className = 'chat-msg';
  if (id === selfId) item.classList.add('is-self');

  const cabecalho = document.createElement('div');
  cabecalho.className = 'chat-msg-head';
  const hora = new Date(ts).toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
  });
  cabecalho.textContent = `${id === selfId ? 'Voce' : name} · ${hora}`;

  const corpo = document.createElement('div');
  corpo.className = 'chat-msg-body';
  // textContent, nunca innerHTML: o texto vem de outro participante.
  corpo.textContent = text;

  item.append(cabecalho, corpo);
  chatLista.appendChild(item);
  chatLista.scrollTop = chatLista.scrollHeight;

  if (chatPanel.hidden && id !== selfId) {
    naoLidas += 1;
    chatBadge.hidden = false;
    chatBadge.textContent = String(naoLidas);
  }
}
