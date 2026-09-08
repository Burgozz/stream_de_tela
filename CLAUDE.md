# Stream de tela guri

Chamada em grupo com compartilhamento de tela, áudio e webcam, direto no
navegador. WebRTC em malha (full mesh) para 2–6 pessoas. Sem cadastro, sem banco
de dados, sem etapa de build.

O recurso mais importante é o **compartilhamento de tela**. Áudio e webcam são
complementares. **Simplicidade de uso vem antes de recursos extras** — na
dúvida entre uma funcionalidade a mais e uma tela mais direta, escolha a tela
mais direta.

## Rodar e testar

```powershell
npm start          # http://localhost:3000
npm run dev        # reinicia a cada alteração
```

`localhost` conta como contexto seguro, então câmera, microfone e captura de
tela funcionam sem HTTPS ali. Fora de `localhost`, HTTPS é obrigatório (o README
explica o setup com mkcert).

**Como testar de verdade:** abra a mesma sala em duas abas com nomes diferentes.
Não confie só em "a página carregou" — verifique se as conexões fecharam:

```js
__meshmeet.estado()   // no console do navegador, dentro da chamada
```

Retorna cada conexão, com quem, de que tipo (`cam` / `tela-recebida` /
`tela-enviada`) e em que estado. `connected` é o esperado.

Para testar compartilhamento de tela sem depender do seletor do navegador, dá
para injetar um stream sintético:

```js
const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
const x = c.getContext('2d');
setInterval(() => { x.fillStyle = '#2fbf71'; x.fillRect(0,0,1280,720); }, 100);
await __meshmeet.peerManager.startScreen(c.captureStream(15));
__meshmeet.socket.emit('state', { sharing: true });
```

## Arquitetura — leia antes de mexer no WebRTC

O servidor **nunca** vê áudio ou vídeo. Ele guarda as salas em memória,
encaminha SDP/ICE e avisa quem entrou e quem saiu. Só isso.

A decisão central está em `public/js/webrtc.js`: **cada par de participantes usa
conexões separadas por finalidade**.

- `cam` — uma conexão bidirecional por par, com câmera e microfone.
- `screen:<id>` — uma conexão unidirecional por tela compartilhada.

**Não junte isso numa conexão só.** Parece uma simplificação óbvia (bastaria
`replaceTrack`), mas ligar/desligar a tela passaria a exigir renegociação de SDP
no meio da chamada, e com 5 pares simultâneos essas renegociações colidem
(*glare*) e travam a chamada de um jeito difícil de depurar. Com conexões
separadas, compartilhar tela é **abrir uma conexão** e parar é **fechá-la**.

Dois invariantes que sustentam isso:

1. **Quem oferece é sempre determinado.** Na conexão de câmera, quem acabou de
   entrar oferece para quem já estava; na de tela, quem compartilha oferece.
   Nunca há disputa. Se você adicionar um novo tipo de conexão, defina o papel
   de forma igualmente determinística.
2. **Os transceivers de áudio e vídeo nascem vazios na entrada**, em ordem fixa
   (áudio, vídeo). É por isso que ligar/desligar câmera e microfone durante a
   chamada é só `replaceTrack`, sem renegociar. Transceiver criado a partir de
   uma oferta remota nasce `recvonly` — o código força `sendrecv` de propósito
   em `#handleOffer`; não remova isso ou o lado que responde para de enviar.

## Arquivos

| Arquivo | Papel |
|---|---|
| `server.js` | Express + Socket.IO, rotas, HTTPS local opcional |
| `src/rooms.js` | Salas em memória, códigos `palavra-palavra-NN`, limite de 6 |
| `src/signaling.js` | Eventos: `join`, `signal`, `state`, `chat`, `leave` |
| `public/js/webrtc.js` | `PeerManager`: a malha e a sinalização |
| `public/js/room.js` | Lobby, controles, socket, orquestração |
| `public/js/media.js` | `getUserMedia`/`getDisplayMedia` e tradução dos erros |
| `public/js/ui.js` | Palco, miniaturas, abas de tela, avisos |
| `public/css/style.css` | Tema escuro, responsivo, mobile-first |

## Convenções

- **Sem framework e sem build.** HTML/CSS/JS puros, ES modules servidos como
  estão. Não introduza React, bundler ou TypeScript.
- **Sem dependência nova sem motivo forte.** Hoje são três: express, socket.io,
  dotenv.
- **Texto de interface em português.** O código atual escreve comentários e
  strings sem acento; siga o padrão do arquivo que estiver editando.
- **Nada de `innerHTML` com texto vindo de outro participante.** Chat e nomes
  usam `textContent`. Isso é proposital.
- **Erros de mídia sempre viram mensagem em português** via
  `describeMediaError()`, nunca um erro cru no console.
- **Estado "sem permissão" ≠ "desligado de propósito".** Botão âmbar escrito
  "Sem permissão" (clicável para pedir de novo) vs. botão vermelho de quem se
  mutou. Preserve essa distinção ao mexer nos controles.

## Deploy

`git push` para `main` → o Render reconstrói e republica sozinho, em 1–2
minutos. Não é preciso tocar no painel.

- URL: <https://meshmeet-6kge.onrender.com>
- **Não renomeie o serviço no Render nem o `name` do `render.yaml`** — isso muda
  a URL e quebra o link que o pessoal já tem.
- O plano grátis hiberna após ~15 min sem uso; o primeiro acesso demora ~50s.
- **Deploy derruba quem estiver em chamada** e apaga as salas ativas (elas vivem
  só na memória). Evite publicar no meio de uma conversa.

## Armadilhas do ambiente (Windows)

- `git commit -m` com uma mensagem multilinha contendo aspas é mangleado pelo
  PowerShell 5.1. Escreva a mensagem num arquivo e use `git commit -F`.
- `Out-File -Encoding utf8` grava BOM no PS 5.1, e o BOM vaza para o assunto do
  commit. Use `[System.IO.File]::WriteAllText($p, $t, (New-Object
  System.Text.UTF8Encoding($false)))`.

## Limites conhecidos

- **Sem TURN configurado.** Quem estiver atrás de NAT simétrico ou CGNAT pode
  não conectar. As variáveis (`TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL`) já
  são lidas em `/api/config`; é só preencher no Render. Ver README.
- **A malha não escala** além de ~8 pessoas: quem compartilha tela envia uma
  cópia para cada participante. Acima disso o caminho é um SFU, não um remendo
  na malha.
- Celular não compartilha tela (limitação dos navegadores móveis). O botão
  aparece desabilitado com explicação.
