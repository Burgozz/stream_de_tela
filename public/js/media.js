/**
 * Acesso a camera, microfone e tela, com os erros do navegador traduzidos
 * para algo que da para mostrar na tela sem assustar ninguem.
 */

export const CAM_CONSTRAINTS = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30 },
  facingMode: 'user',
};

export const AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

/** O navegador suporta o minimo necessario? */
export function checkSupport() {
  const problemas = [];
  if (!window.isSecureContext) {
    problemas.push(
      'Esta pagina precisa ser aberta em HTTPS (ou localhost) para acessar camera, microfone e tela.',
    );
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    problemas.push('Este navegador nao suporta acesso a camera e microfone.');
  }
  if (!window.RTCPeerConnection) {
    problemas.push('Este navegador nao suporta WebRTC.');
  }
  return problemas;
}

const MOTIVO_IOS =
  'iPhone e iPad nao permitem compartilhar tela pelo navegador. E uma limitacao ' +
  'do proprio iOS e vale para todos os navegadores de la, inclusive Chrome e ' +
  'Firefox. Voce continua na chamada normalmente e ve a tela de quem compartilhar.';

const MOTIVO_AUSENTE =
  'Este navegador nao permite compartilhar tela. Voce continua na chamada com ' +
  'microfone e camera, e ve a tela de quem compartilhar.';

export const MOTIVO_FALHOU =
  'Este navegador ate oferece o compartilhamento de tela, mas nao conseguiu ' +
  'iniciar — costuma ser suporte incompleto. Voce continua na chamada e ve a ' +
  'tela de quem compartilhar. Pelo computador funciona.';

/**
 * iPadOS 13+ se apresenta como Mac; o numero de pontos de toque separa os dois.
 */
function ehIOS() {
  const ua = navigator.userAgent;
  return (
    /iPhone|iPad|iPod/i.test(ua) ||
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  );
}

/**
 * A existencia de getDisplayMedia nao prova que o navegador sabe capturar tela:
 * ha casos de suporte parcial em que o metodo existe e falha na hora de usar.
 * Por isso a checagem aqui e so o primeiro filtro — quem decide de verdade e a
 * tentativa real, tratada por isScreenUnsupported().
 *
 * @returns {{ok: boolean, motivo: string|null}}
 */
export function screenShareSupport() {
  if (ehIOS()) return { ok: false, motivo: MOTIVO_IOS };
  if (!navigator.mediaDevices?.getDisplayMedia) {
    return { ok: false, motivo: MOTIVO_AUSENTE };
  }
  return { ok: true, motivo: null };
}

/** Fechar o seletor de tela do navegador cai aqui. Nao e erro. */
export function isScreenCancel(err) {
  return err?.name === 'NotAllowedError' || err?.name === 'AbortError';
}

/**
 * Erros que significam "este navegador nao da conta", e nao "deu ruim agora".
 * Quando um deles aparece, o botao passa a modo indisponivel de vez.
 */
export function isScreenUnsupported(err) {
  return [
    'NotSupportedError',
    'InvalidStateError',
    'InvalidAccessError',
    'TypeError',
    'NotFoundError',
  ].includes(err?.name);
}

export function describeMediaError(err, tipo = 'camera e microfone') {
  const nome = err?.name || '';
  switch (nome) {
    case 'NotAllowedError':
    case 'SecurityError':
      return `Permissao de ${tipo} negada. Clique no cadeado da barra de enderecos, libere o acesso e tente de novo.`;
    case 'NotFoundError':
    case 'OverconstrainedError':
      return `Nenhum dispositivo de ${tipo} foi encontrado neste aparelho.`;
    case 'NotReadableError':
    case 'AbortError':
      return `Nao consegui usar ${tipo} — outro programa (Zoom, Meet, OBS...) pode estar ocupando o dispositivo. Feche os outros e tente de novo.`;
    default:
      return `Nao consegui acessar ${tipo}: ${err?.message || nome || 'erro desconhecido'}.`;
  }
}

/**
 * Pede camera + microfone. Se falhar, tenta so audio e depois so video, para
 * que quem tem apenas microfone ainda consiga entrar na chamada.
 *
 * @returns {Promise<{stream: MediaStream|null, hasAudio: boolean, hasVideo: boolean, warning: string|null}>}
 */
export async function getLocalStream({ audio = true, video = true } = {}) {
  const tentativas = [];
  if (audio && video) tentativas.push({ audio: AUDIO_CONSTRAINTS, video: CAM_CONSTRAINTS });
  if (audio) tentativas.push({ audio: AUDIO_CONSTRAINTS, video: false });
  if (video) tentativas.push({ audio: false, video: CAM_CONSTRAINTS });

  let ultimoErro = null;
  for (let i = 0; i < tentativas.length; i++) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(tentativas[i]);
      const hasAudio = stream.getAudioTracks().length > 0;
      const hasVideo = stream.getVideoTracks().length > 0;
      // Se caiu num fallback, avisa o que ficou faltando.
      const warning =
        i === 0
          ? null
          : hasAudio && !hasVideo
            ? 'Entrei so com o microfone — a camera nao esta disponivel.'
            : !hasAudio && hasVideo
              ? 'Entrei so com a camera — o microfone nao esta disponivel.'
              : null;
      return { stream, hasAudio, hasVideo, warning };
    } catch (err) {
      ultimoErro = err;
      // Se a pessoa negou a permissao, insistir com outras combinacoes so gera
      // mais popups. Desiste na hora.
      if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') break;
    }
  }

  return {
    stream: null,
    hasAudio: false,
    hasVideo: false,
    warning: describeMediaError(ultimoErro),
  };
}

/** Liga a camera sozinha (usado quando a pessoa entrou sem video). */
export async function getCameraTrack() {
  const stream = await navigator.mediaDevices.getUserMedia({ video: CAM_CONSTRAINTS });
  return stream.getVideoTracks()[0] ?? null;
}

/** Liga o microfone sozinho (usado quando a pessoa entrou sem audio). */
export async function getMicrophoneTrack() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
  return stream.getAudioTracks()[0] ?? null;
}

/**
 * Captura da tela. `contentHint = 'detail'` diz ao encoder para priorizar
 * nitidez de texto em vez de fluidez, que e o certo para compartilhar tela.
 */
export async function getScreenStream() {
  const video = {
    frameRate: { ideal: 15, max: 30 },
    width: { max: 1920 },
    height: { max: 1080 },
  };

  let stream;
  try {
    // Audio da aba: o Chrome oferece a opcao no proprio seletor de tela.
    stream = await navigator.mediaDevices.getDisplayMedia({
      video,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (err) {
    // Firefox e Safari nao capturam audio da tela e algumas versoes recusam a
    // chamada so por causa das restricoes de audio. Tenta de novo sem elas.
    if (err?.name === 'NotAllowedError' || err?.name === 'AbortError') throw err;
    stream = await navigator.mediaDevices.getDisplayMedia({ video });
  }

  const faixa = stream.getVideoTracks()[0];
  // Suporte incompleto pode devolver um stream sem video em vez de recusar.
  if (!faixa) {
    for (const t of stream.getTracks()) t.stop();
    const err = new Error('getDisplayMedia devolveu um stream sem video');
    err.name = 'NotSupportedError';
    throw err;
  }
  if ('contentHint' in faixa) faixa.contentHint = 'detail';
  return stream;
}

/* ------------------------------------------------------------------ *
 * Indicador de quem esta falando
 * ------------------------------------------------------------------ */

let audioCtx = null;

function getAudioContext() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = new Ctx();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}

/**
 * Observa o volume de um stream e chama `onChange(falando)` quando o estado
 * muda. Retorna uma funcao para parar de observar.
 */
export function watchSpeaking(stream, onChange) {
  const ctx = getAudioContext();
  if (!ctx || stream.getAudioTracks().length === 0) return () => {};

  let source;
  try {
    source = ctx.createMediaStreamSource(stream);
  } catch {
    return () => {};
  }

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.4;
  source.connect(analyser);

  const buffer = new Uint8Array(analyser.frequencyBinCount);
  let falando = false;
  let silencioDesde = 0;
  let raf = 0;
  let ativo = true;

  function tick() {
    if (!ativo) return;
    analyser.getByteFrequencyData(buffer);
    let soma = 0;
    for (let i = 0; i < buffer.length; i++) soma += buffer[i];
    const media = soma / buffer.length;

    const agora = performance.now();
    if (media > 12) {
      silencioDesde = 0;
      if (!falando) {
        falando = true;
        onChange(true);
      }
    } else if (falando) {
      // Segura o indicador por um instante para nao piscar entre as palavras.
      if (!silencioDesde) silencioDesde = agora;
      else if (agora - silencioDesde > 600) {
        falando = false;
        onChange(false);
      }
    }
    raf = requestAnimationFrame(tick);
  }
  raf = requestAnimationFrame(tick);

  return () => {
    ativo = false;
    cancelAnimationFrame(raf);
    try {
      source.disconnect();
      analyser.disconnect();
    } catch {
      /* ja desconectado */
    }
  };
}

/** Destrava o AudioContext no primeiro clique (politica de autoplay). */
export function unlockAudio() {
  getAudioContext();
}
