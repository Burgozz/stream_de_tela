/** Tela inicial: criar uma sala ou entrar em uma existente. */

const btnCriar = document.getElementById('btn-criar');
const formEntrar = document.getElementById('form-entrar');
const inputCodigo = document.getElementById('input-codigo');
const erro = document.getElementById('erro');

function mostrarErro(mensagem) {
  erro.hidden = false;
  erro.textContent = mensagem;
}

function limparErro() {
  erro.hidden = true;
  erro.textContent = '';
}

/** Aceita tanto "bravo-tigre-42" quanto o link inteiro colado. */
function extrairCodigo(valor) {
  const texto = valor.trim().toLowerCase();
  const doLink = texto.match(/\/sala\/([a-z]+-[a-z]+-\d{2})/);
  if (doLink) return doLink[1];
  const solto = texto.match(/^[a-z]+-[a-z]+-\d{2}$/);
  return solto ? texto : null;
}

btnCriar.addEventListener('click', async () => {
  limparErro();
  btnCriar.disabled = true;
  btnCriar.textContent = 'Criando...';
  try {
    const resposta = await fetch('/api/rooms', { method: 'POST' });
    if (!resposta.ok) throw new Error('falha ao criar');
    const { code } = await resposta.json();
    location.href = `/sala/${code}`;
  } catch {
    mostrarErro('Nao consegui criar a sala. Verifique sua conexao e tente de novo.');
    btnCriar.disabled = false;
    btnCriar.textContent = 'Criar uma sala';
  }
});

formEntrar.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  limparErro();

  const code = extrairCodigo(inputCodigo.value);
  if (!code) {
    mostrarErro('Digite um codigo no formato palavra-palavra-numero, ou cole o link da sala.');
    inputCodigo.focus();
    return;
  }

  // Aviso antecipado é melhor que entrar e descobrir que a sala está cheia.
  try {
    const info = await fetch(`/api/rooms/${code}`).then((r) => r.json());
    if (info.full) {
      mostrarErro(`A sala ${code} ja esta cheia (${info.maxPeers} pessoas).`);
      return;
    }
  } catch {
    /* se a checagem falhar, deixa entrar assim mesmo */
  }

  location.href = `/sala/${code}`;
});
