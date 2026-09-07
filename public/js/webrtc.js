/**
 * Malha WebRTC (full mesh) para grupos pequenos.
 *
 * Cada par de participantes mantem conexoes separadas por finalidade:
 *
 *   'cam'               -> uma conexao bidirecional com camera + microfone.
 *   'screen:<id-dono>'  -> uma conexao unidirecional por tela compartilhada.
 *
 * Separar assim resolve dois problemas de uma vez. Primeiro, ligar ou desligar
 * a tela vira abrir/fechar uma conexao inteira, sem renegociar SDP no meio da
 * chamada (com 5 pares, renegociacoes simultaneas colidem e travam). Segundo,
 * a origem de cada faixa de video fica obvia pelo canal, sem precisar adivinhar
 * pelo SDP nem inventar convencoes de id de stream.
 *
 * Quem faz a oferta e sempre determinado, entao nao existe glare:
 *   - 'cam'    -> quem entrou por ultimo na sala oferece.
 *   - 'screen' -> o dono da tela oferece.
 */

/** Teto de banda da tela. Mais que isso, num mesh de 6, satura o upload. */
const SCREEN_MAX_BITRATE = 2_000_000;
/** Teto por participante na camera: 6 pessoas x 5 envios cada precisa caber. */
const CAM_MAX_BITRATE = 600_000;

const CAM_CHANNEL = 'cam';
const screenChannel = (ownerId) => `screen:${ownerId}`;

export class PeerManager {
  /**
   * @param {Object} opts
   * @param {any} opts.socket        socket.io
   * @param {RTCIceServer[]} opts.iceServers
   * @param {Object} opts.on         callbacks de UI
   */
  constructor({ socket, iceServers, on = {} }) {
    this.socket = socket;
    this.iceServers = iceServers;
    this.on = on;
    this.selfId = null;

    /** @type {Map<string, any>} */
    this.peers = new Map();

    /** Faixas locais atuais (null quando camera/microfone estao desligados). */
    this.localAudio = null;
    this.localVideo = null;

    /** Stream da tela que eu estou compartilhando agora, se houver. */
    this.screenStream = null;
  }

  setSelfId(id) {
    this.selfId = id;
  }

  /* ---------------------------------------------------------------- *
   * Participantes
   * ---------------------------------------------------------------- */

  /**
   * @param {string} id
   * @param {string} name
   * @param {boolean} initiator  true se EU devo oferecer a conexao de camera
   */
  async addPeer(id, name, initiator) {
    if (this.peers.has(id)) return;

    const record = {
      id,
      name,
      cam: null,
      screenIn: null, // a tela DELE chegando ate mim
      screenOut: null, // a MINHA tela indo ate ele
      camStream: new MediaStream(),
      screenStream: null,
    };
    this.peers.set(id, record);

    record.cam = this.#createConn(id, CAM_CHANNEL, initiator);

    if (initiator) {
      // Os transceivers sao criados vazios e em ordem fixa (audio, video). Com
      // eles no lugar desde o inicio, ligar/desligar camera e microfone depois
      // e so um replaceTrack, sem nova negociacao.
      const audioT = record.cam.pc.addTransceiver('audio', { direction: 'sendrecv' });
      const videoT = record.cam.pc.addTransceiver('video', { direction: 'sendrecv' });
      if (this.localAudio) await audioT.sender.replaceTrack(this.localAudio).catch(() => {});
      if (this.localVideo) await videoT.sender.replaceTrack(this.localVideo).catch(() => {});
      this.#limitBitrate(videoT.sender, CAM_MAX_BITRATE);
      await this.#makeOffer(record.cam, id);
    }

    // Se eu ja estou compartilhando a tela, o recem-chegado tambem precisa ver.
    if (this.screenStream) await this.#openScreenTo(id);
  }

  removePeer(id) {
    const record = this.peers.get(id);
    if (!record) return;
    for (const conn of [record.cam, record.screenIn, record.screenOut]) {
      if (conn) this.#closeConn(conn);
    }
    this.peers.delete(id);
  }

  closeAll() {
    this.stopScreen({ silent: true });
    for (const id of [...this.peers.keys()]) this.removePeer(id);
  }

  /* ---------------------------------------------------------------- *
   * Camera e microfone locais
   * ---------------------------------------------------------------- */

  /** Troca a faixa de audio em todas as conexoes de camera. */
  async setLocalAudioTrack(track) {
    this.localAudio = track;
    await this.#replaceInAllCamConns('audio', track);
  }

  /** Troca a faixa de video em todas as conexoes de camera (null = desligada). */
  async setLocalVideoTrack(track) {
    this.localVideo = track;
    await this.#replaceInAllCamConns('video', track);
  }

  async #replaceInAllCamConns(kind, track) {
    const trabalhos = [];
    for (const record of this.peers.values()) {
      if (!record.cam) continue;
      for (const transceiver of record.cam.pc.getTransceivers()) {
        if (this.#transceiverKind(transceiver) !== kind) continue;
        trabalhos.push(transceiver.sender.replaceTrack(track).catch(() => {}));
        if (kind === 'video' && track) {
          this.#limitBitrate(transceiver.sender, CAM_MAX_BITRATE);
        }
      }
    }
    await Promise.all(trabalhos);
  }

  /**
   * O tipo de um transceiver. Quando o sender esta sem faixa (camera
   * desligada), o receiver ainda diz de qual m-line ele veio.
   */
  #transceiverKind(transceiver) {
    return (
      transceiver.sender?.track?.kind ??
      transceiver.receiver?.track?.kind ??
      null
    );
  }

  /* ---------------------------------------------------------------- *
   * Compartilhamento de tela
   * ---------------------------------------------------------------- */

  /**
   * Abre uma conexao de tela para cada participante.
   * @param {MediaStream} stream
   */
  async startScreen(stream) {
    if (this.screenStream) this.stopScreen({ silent: true });
    this.screenStream = stream;

    // O botao "Parar compartilhamento" do proprio navegador encerra a faixa
    // sem avisar a pagina de nenhum outro jeito.
    const video = stream.getVideoTracks()[0];
    if (video) {
      video.addEventListener('ended', () => {
        if (this.screenStream === stream) {
          this.stopScreen();
          this.on.screenEndedLocally?.();
        }
      });
    }

    await Promise.all([...this.peers.keys()].map((id) => this.#openScreenTo(id)));
  }

  async #openScreenTo(id) {
    const record = this.peers.get(id);
    if (!record || !this.screenStream) return;
    if (record.screenOut) this.#closeConn(record.screenOut);

    const conn = this.#createConn(id, screenChannel(this.selfId), true);
    record.screenOut = conn;

    for (const track of this.screenStream.getTracks()) {
      const sender = conn.pc.addTrack(track, this.screenStream);
      if (track.kind === 'video') {
        this.#limitBitrate(sender, SCREEN_MAX_BITRATE, 'maintain-resolution');
      }
    }
    for (const t of conn.pc.getTransceivers()) t.direction = 'sendonly';

    await this.#makeOffer(conn, id);
  }

  /** @param {{silent?: boolean}} [opts] */
  stopScreen({ silent = false } = {}) {
    if (!this.screenStream) return;
    for (const track of this.screenStream.getTracks()) track.stop();
    this.screenStream = null;

    for (const record of this.peers.values()) {
      if (record.screenOut) {
        this.#closeConn(record.screenOut);
        record.screenOut = null;
      }
    }
    if (!silent) this.socket.emit('screen-stopped');
  }

  /** Chamado quando o servidor avisa que alguem parou de compartilhar. */
  handleRemoteScreenStopped(id) {
    const record = this.peers.get(id);
    if (!record) return;
    if (record.screenIn) {
      this.#closeConn(record.screenIn);
      record.screenIn = null;
    }
    record.screenStream = null;
    this.on.screenRemoved?.(id);
  }

  /* ---------------------------------------------------------------- *
   * Sinalizacao
   * ---------------------------------------------------------------- */

  /** @param {{from: string, channel: string, data: any}} msg */
  async handleSignal({ from, channel, data }) {
    const record = this.peers.get(from);
    if (!record || !data) return;

    const conn = this.#resolveConn(record, channel, data.type);
    if (!conn) return;

    try {
      if (data.type === 'offer') {
        await this.#handleOffer(conn, from, data);
      } else if (data.type === 'answer') {
        if (conn.pc.signalingState !== 'have-local-offer') return;
        await conn.pc.setRemoteDescription(data.sdp);
        conn.negotiating = false;
        await this.#drainCandidates(conn);
      } else if (data.type === 'candidate') {
        if (conn.pc.remoteDescription) {
          await conn.pc.addIceCandidate(data.candidate).catch(() => {});
        } else {
          conn.pending.push(data.candidate);
        }
      } else if (data.type === 'ice-restart') {
        // O outro lado perdeu a conexao e pediu para eu reoferecer.
        if (conn.initiator) await this.#makeOffer(conn, from, { iceRestart: true });
      }
    } catch (err) {
      console.warn('[webrtc] falha ao processar sinal', channel, data.type, err);
    }
  }

  /**
   * Descobre a qual conexao a mensagem pertence, criando a conexao de entrada
   * de tela no momento em que a oferta chega.
   */
  #resolveConn(record, channel, tipo) {
    if (channel === CAM_CHANNEL) return record.cam;

    if (channel === screenChannel(record.id)) {
      // Tela DELE. Eu sempre respondo.
      if (!record.screenIn && tipo === 'offer') {
        record.screenIn = this.#createConn(record.id, channel, false);
      }
      return record.screenIn;
    }
    if (channel === screenChannel(this.selfId)) {
      // Minha tela indo para ele.
      return record.screenOut;
    }
    return null;
  }

  async #handleOffer(conn, from, data) {
    await conn.pc.setRemoteDescription(data.sdp);

    if (conn.channel === CAM_CHANNEL) {
      // Transceivers criados a partir de uma oferta remota nascem 'recvonly'.
      // Sem forcar 'sendrecv' aqui, eu receberia audio e video mas nao enviaria
      // nada de volta.
      for (const t of conn.pc.getTransceivers()) {
        t.direction = 'sendrecv';
        const kind = this.#transceiverKind(t);
        if (kind === 'audio' && this.localAudio) {
          await t.sender.replaceTrack(this.localAudio).catch(() => {});
        } else if (kind === 'video' && this.localVideo) {
          await t.sender.replaceTrack(this.localVideo).catch(() => {});
          this.#limitBitrate(t.sender, CAM_MAX_BITRATE);
        }
      }
    }

    const answer = await conn.pc.createAnswer();
    await conn.pc.setLocalDescription(answer);
    await this.#drainCandidates(conn);
    this.#send(from, conn.channel, { type: 'answer', sdp: conn.pc.localDescription });
  }

  async #makeOffer(conn, to, { iceRestart = false } = {}) {
    if (conn.negotiating && !iceRestart) return;
    conn.negotiating = true;
    try {
      const offer = await conn.pc.createOffer({ iceRestart });
      // Uma corrida pode ter fechado a conexao enquanto a oferta era montada.
      if (conn.pc.signalingState === 'closed') return;
      await conn.pc.setLocalDescription(offer);
      this.#send(to, conn.channel, { type: 'offer', sdp: conn.pc.localDescription });
    } catch (err) {
      conn.negotiating = false;
      console.warn('[webrtc] falha ao criar oferta', conn.channel, err);
    }
  }

  async #drainCandidates(conn) {
    const fila = conn.pending.splice(0);
    for (const candidate of fila) {
      await conn.pc.addIceCandidate(candidate).catch(() => {});
    }
  }

  #send(to, channel, data) {
    this.socket.emit('signal', { to, channel, data });
  }

  /* ---------------------------------------------------------------- *
   * Conexao
   * ---------------------------------------------------------------- */

  #createConn(peerId, channel, initiator) {
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      bundlePolicy: 'max-bundle',
    });

    const conn = { pc, channel, initiator, pending: [], negotiating: false, failTimer: null };

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.#send(peerId, channel, { type: 'candidate', candidate: ev.candidate.toJSON() });
      }
    };

    pc.ontrack = (ev) => {
      const record = this.peers.get(peerId);
      if (!record) return;

      if (channel === CAM_CHANNEL) {
        record.camStream.addTrack(ev.track);
        ev.track.addEventListener('ended', () => {
          try {
            record.camStream.removeTrack(ev.track);
          } catch {
            /* ja removida */
          }
        });
        this.on.camStream?.(peerId, record.camStream);
      } else {
        if (!record.screenStream) record.screenStream = new MediaStream();
        record.screenStream.addTrack(ev.track);
        this.on.screenStream?.(peerId, record.screenStream);
      }
    };

    pc.onconnectionstatechange = () => {
      const estado = pc.connectionState;
      this.on.connectionState?.(peerId, channel, estado);

      if (estado === 'failed') {
        this.#recover(conn, peerId);
      } else if (estado === 'disconnected') {
        // 'disconnected' costuma se resolver sozinho (troca de rede, wifi
        // oscilando). So age se continuar assim.
        clearTimeout(conn.failTimer);
        conn.failTimer = setTimeout(() => {
          if (pc.connectionState === 'disconnected') this.#recover(conn, peerId);
        }, 5000);
      } else if (estado === 'connected') {
        clearTimeout(conn.failTimer);
        conn.failTimer = null;
      }
    };

    return conn;
  }

  /** Tenta reerguer a conexao com ICE restart, sempre pelo lado que oferece. */
  #recover(conn, peerId) {
    if (conn.pc.signalingState === 'closed') return;
    if (conn.initiator) {
      this.#makeOffer(conn, peerId, { iceRestart: true });
    } else {
      this.#send(peerId, conn.channel, { type: 'ice-restart' });
    }
  }

  #closeConn(conn) {
    clearTimeout(conn.failTimer);
    conn.pc.onicecandidate = null;
    conn.pc.ontrack = null;
    conn.pc.onconnectionstatechange = null;
    try {
      conn.pc.close();
    } catch {
      /* ja fechada */
    }
  }

  #limitBitrate(sender, maxBitrate, degradationPreference) {
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      params.encodings[0].maxBitrate = maxBitrate;
      if (degradationPreference) params.degradationPreference = degradationPreference;
      sender.setParameters(params).catch(() => {});
    } catch {
      // Firefox mais antigo rejeita setParameters antes de negociar; sem o
      // limite a chamada ainda funciona, so consome mais banda.
    }
  }
}
