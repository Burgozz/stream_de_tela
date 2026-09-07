/**
 * Montagem da tela da chamada.
 *
 * Regra de layout: se alguem esta compartilhando a tela, ela ocupa o palco e
 * as webcams viram miniaturas na tira lateral. Se ninguem esta, as webcams
 * ocupam o palco em grade.
 *
 * Os elementos <video> nunca sao recriados na troca de layout, so movidos de
 * container. Recriar faria o video piscar e recomecar a cada mudanca.
 */

const stage = document.getElementById('stage');
const gridEl = document.getElementById('grid');
const screenArea = document.getElementById('screen-area');
const screenTabs = document.getElementById('screen-tabs');
const filmstrip = document.getElementById('filmstrip');
const toastsEl = document.getElementById('toasts');

/** @type {Map<string, {el: HTMLElement, video: HTMLVideoElement, name: string, isSelf: boolean}>} */
const tiles = new Map();
/** @type {Map<string, {el: HTMLElement, video: HTMLVideoElement, name: string, isSelf: boolean}>} */
const screens = new Map();

/** Qual tela esta em foco quando ha mais de uma. */
let telaEmFoco = null;

function iniciais(nome) {
  const partes = nome.trim().split(/\s+/).slice(0, 2);
  return partes.map((p) => p[0] ?? '').join('').toUpperCase() || '?';
}

/* ------------------------------------------------------------------ *
 * Miniaturas de participante
 * ------------------------------------------------------------------ */

export function addTile(id, name, { isSelf = false } = {}) {
  if (tiles.has(id)) return tiles.get(id);

  const el = document.createElement('div');
  el.className = 'tile';
  el.dataset.id = id;
  if (isSelf) el.classList.add('is-self');

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  // O proprio audio nunca volta para os alto-falantes, senao vira microfonia.
  video.muted = isSelf;
  el.appendChild(video);

  const avatar = document.createElement('div');
  avatar.className = 'tile-avatar';
  avatar.textContent = iniciais(name);
  el.appendChild(avatar);

  const label = document.createElement('div');
  label.className = 'tile-label';

  const micIcon = document.createElement('span');
  micIcon.className = 'tile-mic';
  label.appendChild(micIcon);

  const nameEl = document.createElement('span');
  nameEl.className = 'tile-name';
  nameEl.textContent = isSelf ? `${name} (voce)` : name;
  label.appendChild(nameEl);

  el.appendChild(label);

  const status = document.createElement('div');
  status.className = 'tile-status';
  el.appendChild(status);

  const registro = { el, video, name, isSelf };
  tiles.set(id, registro);
  layout();
  return registro;
}

export function removeTile(id) {
  const registro = tiles.get(id);
  if (!registro) return;
  registro.video.srcObject = null;
  registro.el.remove();
  tiles.delete(id);
  layout();
}

export function setTileStream(id, stream) {
  const registro = tiles.get(id);
  if (!registro || registro.video.srcObject === stream) return;
  registro.video.srcObject = stream;
  registro.video.play().catch(() => {
    /* autoplay bloqueado ate o primeiro clique; nao e fatal */
  });
}

/**
 * @param {string} id
 * @param {{muted?: boolean, camOn?: boolean, speaking?: boolean, connection?: string}} estado
 */
export function setTileState(id, estado) {
  const registro = tiles.get(id);
  if (!registro) return;
  const { el } = registro;

  if (typeof estado.muted === 'boolean') el.classList.toggle('is-muted', estado.muted);
  if (typeof estado.camOn === 'boolean') el.classList.toggle('no-cam', !estado.camOn);
  if (typeof estado.speaking === 'boolean') el.classList.toggle('is-speaking', estado.speaking);

  if (estado.connection) {
    const ruim = estado.connection === 'failed' || estado.connection === 'disconnected';
    const conectando = estado.connection === 'connecting' || estado.connection === 'new';
    el.classList.toggle('is-trouble', ruim);
    const status = el.querySelector('.tile-status');
    if (status) {
      status.textContent = ruim ? 'reconectando...' : conectando ? 'conectando...' : '';
    }
  }
}

export function renameTile(id, name) {
  const registro = tiles.get(id);
  if (!registro) return;
  registro.name = name;
  const nameEl = registro.el.querySelector('.tile-name');
  if (nameEl) nameEl.textContent = registro.isSelf ? `${name} (voce)` : name;
  const avatar = registro.el.querySelector('.tile-avatar');
  if (avatar) avatar.textContent = iniciais(name);
}

/* ------------------------------------------------------------------ *
 * Telas compartilhadas
 * ------------------------------------------------------------------ */

export function addScreen(ownerId, name, stream, { isSelf = false } = {}) {
  let registro = screens.get(ownerId);

  if (!registro) {
    const el = document.createElement('div');
    el.className = 'screen';
    el.dataset.owner = ownerId;

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    // A previa da propria tela vai muda: o audio dela ja sai pelos alto-falantes.
    video.muted = isSelf;
    el.appendChild(video);

    const label = document.createElement('div');
    label.className = 'screen-label';
    label.textContent = isSelf ? 'Sua tela' : `Tela de ${name}`;
    el.appendChild(label);

    screenArea.appendChild(el);
    registro = { el, video, name, isSelf };
    screens.set(ownerId, registro);
  }

  if (registro.video.srcObject !== stream) {
    registro.video.srcObject = stream;
    registro.video.play().catch(() => {});
  }

  telaEmFoco = ownerId;
  layout();
  return registro;
}

export function removeScreen(ownerId) {
  const registro = screens.get(ownerId);
  if (!registro) return;
  registro.video.srcObject = null;
  registro.el.remove();
  screens.delete(ownerId);
  if (telaEmFoco === ownerId) {
    telaEmFoco = screens.size > 0 ? [...screens.keys()].at(-1) : null;
  }
  layout();
}

export function hasScreen(ownerId) {
  return screens.has(ownerId);
}

/* ------------------------------------------------------------------ *
 * Layout
 * ------------------------------------------------------------------ */

export function layout() {
  const compartilhando = screens.size > 0;
  stage.dataset.mode = compartilhando ? 'screen' : 'grid';

  // Move as miniaturas para o container certo, sem recriar nada.
  const destino = compartilhando ? filmstrip : gridEl;
  for (const { el } of tiles.values()) {
    if (el.parentElement !== destino) destino.appendChild(el);
  }
  gridEl.dataset.count = String(Math.min(tiles.size, 6));
  filmstrip.hidden = !compartilhando;

  // Foco e abas quando ha mais de uma tela.
  for (const [ownerId, { el }] of screens) {
    el.classList.toggle('is-active', ownerId === telaEmFoco);
  }
  renderScreenTabs();
}

function renderScreenTabs() {
  screenTabs.hidden = screens.size < 2;
  if (screens.size < 2) {
    screenTabs.replaceChildren();
    return;
  }
  const botoes = [...screens.entries()].map(([ownerId, { name, isSelf }]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'screen-tab';
    b.textContent = isSelf ? 'Sua tela' : name;
    b.classList.toggle('is-active', ownerId === telaEmFoco);
    b.addEventListener('click', () => {
      telaEmFoco = ownerId;
      layout();
    });
    return b;
  });
  screenTabs.replaceChildren(...botoes);
}

/* ------------------------------------------------------------------ *
 * Avisos
 * ------------------------------------------------------------------ */

/**
 * @param {string} mensagem
 * @param {{tipo?: 'info'|'erro'|'ok', duracao?: number}} [opcoes]
 */
export function toast(mensagem, { tipo = 'info', duracao = 5000 } = {}) {
  const el = document.createElement('div');
  el.className = `toast toast-${tipo}`;
  el.textContent = mensagem;

  const fechar = document.createElement('button');
  fechar.type = 'button';
  fechar.className = 'toast-close';
  fechar.setAttribute('aria-label', 'Fechar aviso');
  fechar.textContent = '×';
  fechar.addEventListener('click', () => el.remove());
  el.appendChild(fechar);

  toastsEl.appendChild(el);
  if (duracao > 0) setTimeout(() => el.remove(), duracao);
  return el;
}
