# MeshMeet

Chamada em grupo com compartilhamento de tela, áudio e webcam, direto no
navegador. Sem instalar nada, sem cadastro, sem banco de dados.

Você cria uma sala, recebe um código como `bravo-tigre-42`, manda o link no
grupo e o pessoal entra digitando só um nome.

- **Áudio e vídeo vão direto de um navegador para o outro** (WebRTC em malha).
  O servidor só apresenta os participantes entre si.
- **Feito para 4 pessoas**, funciona bem de 2 a 6.
- Roda em qualquer lugar que rode Node.js. O plano grátis do Render dá conta.

---

## Índice

1. [Rodando localmente](#rodando-localmente)
2. [Rodando com HTTPS local](#rodando-com-https-local) — necessário para testar no celular
3. [Deploy](#deploy)
4. [Sobre o TURN](#sobre-o-turn) — leia se alguém não conseguir se conectar
5. [Limitações da malha](#limitações-da-malha-e-quando-um-sfu-passa-a-valer-a-pena)
6. [Como funciona por dentro](#como-funciona-por-dentro)
7. [Estrutura de arquivos](#estrutura-de-arquivos)
8. [Solução de problemas](#solução-de-problemas)

---

## Rodando localmente

Você precisa do [Node.js](https://nodejs.org) 18 ou mais novo.

```bash
npm install
npm start
```

Abra <http://localhost:3000>.

Para testar sozinho, abra a mesma sala em duas abas (ou numa janela anônima) e
entre com nomes diferentes — você se vê e se ouve dos dois lados.

> `localhost` conta como contexto seguro, então câmera, microfone e captura de
> tela funcionam sem HTTPS. **Só em `localhost`.** Para abrir de outro aparelho
> na sua rede, siga a seção abaixo.

Durante o desenvolvimento, `npm run dev` reinicia o servidor a cada alteração.

---

## Rodando com HTTPS local

Os navegadores só liberam câmera, microfone e `getDisplayMedia` em HTTPS ou em
`localhost`. Para abrir a chamada no celular usando o IP da sua máquina
(`https://192.168.0.10:3000`), gere um certificado local com
[mkcert](https://github.com/FiloSottile/mkcert) — ele cria uma autoridade
confiável no seu sistema, então não aparece aviso de "site não seguro".

```bash
# 1. Instale o mkcert (Windows, com Chocolatey)
choco install mkcert
#    macOS: brew install mkcert
#    Linux: veja o repositório do mkcert

# 2. Registre a autoridade local (uma vez só, por máquina)
mkcert -install

# 3. Gere o certificado para localhost e para o IP da sua máquina na rede
mkdir certs
mkcert -cert-file certs/cert.pem -key-file certs/key.pem localhost 127.0.0.1 192.168.0.10
```

Troque `192.168.0.10` pelo IP da sua máquina (`ipconfig` no Windows,
`ifconfig`/`ip addr` no Linux e macOS).

Depois, copie `.env.example` para `.env` e ligue o HTTPS:

```
MESHMEET_HTTPS=1
```

```bash
npm start
```

Agora o servidor sobe em `https://localhost:3000` e você consegue abrir
`https://192.168.0.10:3000` no celular da mesma rede.

> No celular, o certificado do mkcert **não** é confiável por padrão (a
> autoridade foi instalada só no seu computador). O Android e o iOS vão mostrar
> um aviso; dá para aceitar e seguir para testes. Para uso de verdade com os
> amigos, faça o deploy — aí o HTTPS é de verdade e ninguém vê aviso nenhum.

---

## Deploy

### Render (recomendado para começar)

O repositório já traz um [`render.yaml`](render.yaml), então o Render configura
tudo sozinho.

1. Suba este projeto para um repositório no GitHub.
2. Crie uma conta em <https://render.com>.
3. **New → Blueprint**, aponte para o repositório e confirme. O Render lê o
   `render.yaml` e cria o serviço com `npm ci` + `npm start`.
4. Em poucos minutos você recebe uma URL tipo
   `https://meshmeet.onrender.com` — com HTTPS pronto, que é o que o WebRTC
   exige. Mande o link para o pessoal.

Se preferir criar na mão: **New → Web Service**, runtime Node, build `npm ci`,
start `npm start`. Não precisa configurar nada de WebSocket, o Render já
encaminha.

**A pegadinha do plano grátis:** o serviço hiberna depois de ~15 minutos sem
acesso. A primeira pessoa a abrir o link espera uns 30–50 segundos até o
servidor acordar. Quem entra depois não sente nada. Para combinar uma chamada,
abra o link um minutinho antes. O plano pago mais barato (US$ 7/mês) remove a
hibernação.

### Fly.io (alternativa que não hiberna)

O Fly mantém a máquina de pé e o consumo desta aplicação é baixíssimo (só
sinalização). Precisa do [flyctl](https://fly.io/docs/flyctl/install/):

```bash
fly launch --no-deploy      # detecta Node, gera o fly.toml
fly deploy
```

Quando o `fly launch` perguntar a porta interna, responda **3000**. O Fly já
expõe HTTPS no domínio `.fly.dev`.

### Qualquer outro lugar

O único requisito é rodar Node e permitir WebSocket. Railway, Koyeb, Cloud Run,
uma VPS com Caddy na frente — todos funcionam. A aplicação lê a porta de
`process.env.PORT`.

---

## Sobre o TURN

Este é o ponto que mais causa "funciona aqui, mas com o Fulano não conecta".

O WebRTC tenta ligar os dois navegadores diretamente. Para isso ele usa um
servidor **STUN** (que só informa "seu IP público é esse"), e os públicos do
Google já vêm configurados aqui. Na maioria das redes domésticas isso basta.

Mas algumas redes — NAT simétrico, CGNAT de operadora, Wi-Fi corporativo, certas
redes 4G/5G — não deixam a conexão direta acontecer. Nesses casos é preciso um
servidor **TURN**, que retransmite a mídia. Na prática, isso afeta uma fração
pequena mas real das conexões: se um amigo específico nunca consegue ver ninguém
enquanto os outros se veem normalmente, é quase certo que seja isso.

Como o TURN retransmite áudio e vídeo, ele consome banda de verdade e por isso
não existe um gratuito e ilimitado. Opções:

| Opção | Custo | Observação |
|---|---|---|
| [Metered](https://www.metered.ca/tools/openrelay/) | plano grátis com 500 MB/mês | Mais rápido de configurar |
| [Twilio Network Traversal](https://www.twilio.com/stun-turn) | pago por GB | Confiável, exige cartão |
| [Coturn](https://github.com/coturn/coturn) numa VPS | ~US$ 5/mês | Você administra, sem limite de tráfego |

Configurado o serviço, preencha no `.env` (ou nas variáveis de ambiente do
Render/Fly):

```
TURN_URL=turn:seu-servidor:3478
TURN_USERNAME=usuario
TURN_CREDENTIAL=senha
```

O servidor entrega isso ao navegador em `/api/config`; não precisa mexer em
código. **Sem TURN configurado a chamada continua funcionando** para todo mundo
cuja rede permite conexão direta — que é a maioria.

---

## Limitações da malha, e quando um SFU passa a valer a pena

Numa malha completa, cada pessoa envia uma cópia do próprio vídeo para cada
outra. O custo de **upload** cresce junto com o grupo, e é sempre o upload que
aperta primeiro (nas conexões domésticas ele costuma ser bem menor que o
download).

Com os limites que esta aplicação já aplica — 600 kbps por webcam e 2 Mbps para
a tela — o pior caso de quem está compartilhando a tela **e** com a câmera
ligada fica assim:

| Pessoas na sala | Upload de quem compartilha |
|---|---|
| 2 | ~2,6 Mbps |
| 4 | ~7,8 Mbps |
| 6 | ~13 Mbps |

Para 4 pessoas em qualquer fibra residencial, sobra folga. Em 6 pessoas ainda
funciona na maioria das conexões, mas quem estiver com upload baixo (ADSL, 4G
ruim, plano assimétrico antigo) vai ver a qualidade cair — o navegador reduz
resolução e taxa de quadros sozinho em vez de travar, então degrada suavemente.

Também vale saber: cada participante mantém uma conexão com cada outro. Em 6
pessoas isso dá até 5 conexões de câmera + 5 de tela por navegador. É tranquilo
para máquinas atuais, mas é o motivo de esta arquitetura não escalar para
dezenas de pessoas.

**Se um dia o grupo passar de ~8 pessoas**, o caminho é trocar a malha por um
**SFU** — um servidor que recebe uma cópia de cada participante e redistribui.
Aí cada pessoa envia só uma vez, independentemente do tamanho do grupo. O custo
é ter um servidor de mídia de verdade: banda, CPU e manutenção. As opções
seriam [mediasoup](https://mediasoup.org/) ou [Janus](https://janus.conf.meetecho.com/)
(você hospeda) ou [LiveKit](https://livekit.io/) (tem serviço gerenciado, com
plano grátis). Para 4–6 amigos, seria complexidade paga sem retorno — a malha
resolve.

---

## Como funciona por dentro

**O servidor não vê áudio nem vídeo.** Ele mantém as salas em memória, encaminha
as mensagens de sinalização (SDP e ICE) entre os participantes e avisa quando
alguém entra ou sai. É isso.

A decisão menos óbvia do projeto está no cliente: **cada par de participantes
usa conexões separadas por finalidade**.

- `cam` — uma conexão bidirecional por par, carregando câmera e microfone.
- `screen:<id>` — uma conexão unidirecional por tela compartilhada.

O caminho mais comum seria usar uma única conexão por par e trocar as faixas com
`replaceTrack`. O problema é que ligar ou desligar a tela mudaria a estrutura da
conexão e exigiria renegociar o SDP no meio da chamada — com 5 pares
simultâneos, essas renegociações colidem (o famoso *glare*) e a chamada trava de
um jeito difícil de depurar.

Com as conexões separadas, compartilhar a tela vira **abrir uma conexão nova** e
parar vira **fechá-la**. Nada é renegociado. De quebra, a origem de cada faixa
de vídeo fica explícita pelo canal, sem precisar deduzir do SDP.

Dois detalhes que sustentam isso:

- **Ninguém disputa quem faz a oferta.** Na conexão de câmera, quem acabou de
  entrar oferece para todos que já estavam; na de tela, quem compartilha
  oferece. Como o papel é sempre determinado, glare não acontece.
- **Os transceivers de áudio e vídeo são criados vazios já na entrada**, em
  ordem fixa. Por isso ligar e desligar a câmera durante a chamada é só um
  `replaceTrack`, sem renegociação — e desligar a câmera realmente para a faixa
  (a luzinha da webcam apaga) em vez de só silenciá-la.

Quedas de conexão são tratadas com *ICE restart* automático: se uma conexão fica
em `failed` (ou passa 5 segundos em `disconnected`), o lado que oferece refaz a
negociação sozinho. Se o socket cair, o Socket.IO reconecta e o participante
volta.

---

## Estrutura de arquivos

```
meshmeet/
├── server.js              Express + Socket.IO, rotas e HTTPS opcional
├── src/
│   ├── rooms.js           Salas em memória, geração dos códigos, limite de 6
│   └── signaling.js       Eventos de socket: join, signal, state, chat, leave
├── public/
│   ├── index.html         Tela inicial: criar sala ou entrar por código/link
│   ├── room.html          A chamada (lobby + palco + controles + chat)
│   ├── css/style.css      Tema escuro, responsivo, mobile-first
│   └── js/
│       ├── home.js        Criar/entrar em sala
│       ├── room.js        Orquestra lobby, controles, socket e UI
│       ├── webrtc.js      PeerManager: a malha, as conexões e a sinalização
│       ├── media.js       getUserMedia/getDisplayMedia e tradução dos erros
│       └── ui.js          Montagem do palco, miniaturas e avisos
├── render.yaml            Deploy no Render
└── .env.example           Porta, HTTPS local e TURN
```

Sem etapa de build e sem framework: os arquivos em `public/` são servidos como
estão. Para mexer no visual, edite o CSS e recarregue.

---

## Solução de problemas

**"Permissão de câmera e microfone negada"**
Clique no cadeado da barra de endereços, libere câmera e microfone e recarregue.
Dá para entrar mesmo sem liberar: você vê e ouve os outros, só não é visto.

**O botão de compartilhar tela está desabilitado**
O navegador não tem `getDisplayMedia`. Isso é normal em celulares — iPhone e a
maioria dos Android não deixam compartilhar tela pelo navegador. Você continua
vendo a tela de quem compartilha do computador.

**Entrei, mas não vejo nem ouço uma pessoa específica (as outras estão ok)**
Quase sempre é a rede dela bloqueando a conexão direta. Veja
[Sobre o TURN](#sobre-o-turn).

**Ninguém vê ninguém**
Confirme que a página está em HTTPS (ou `localhost`) e que o servidor está no
ar. Abra `/healthz` na URL do deploy: deve responder um JSON.

**Eco durante a chamada**
Alguém está com caixa de som aberta e microfone ligado. Fone resolve. O
cancelamento de eco do navegador já está ligado, mas ele não dá conta de som
alto no ambiente.

**A sala sumiu**
As salas vivem na memória do servidor. Se ele reiniciar (deploy novo, ou o
Render acordando da hibernação), as salas ativas se perdem — é só entrar de novo
com o mesmo código, que a sala é recriada.

**Depurar uma conexão específica**
Com a chamada aberta, no console do navegador:

```js
__meshmeet.estado()
```

Ele lista cada conexão com quem, de que tipo (câmera ou tela) e em que estado
está. `connected` é o esperado; `failed` indica que a conexão direta não foi
possível.
