/** Mensagens em linguagem simples (pt-PT) para os erros de leitura do calendário. Nunca levam o link. */
const MENSAGENS_ERRO = {
  timeout: 'O calendário demorou demasiado a responder. Vamos tentar outra vez mais tarde.',
  dns: 'Não foi possível encontrar o servidor do calendário. Vamos tentar outra vez mais tarde.',
  ip_bloqueado: 'O endereço deste calendário não é permitido.',
  redirect_invalido: 'O calendário redirecionou para um sítio não permitido.',
  tls: 'O certificado de segurança do servidor do calendário não é de confiança.',
  http_4xx: 'O canal recusou o pedido. Confirma se o link ainda é válido.',
  http_404_410: 'O link deixou de funcionar. Copia o link novo no canal e substitui-o aqui.',
  http_429: 'O canal pediu para esperarmos antes de ler outra vez. Vamos tentar mais tarde.',
  http_5xx: 'O servidor do canal está com problemas. Vamos tentar outra vez mais tarde.',
  tamanho: 'O calendário é demasiado grande para ser lido.',
  formato: 'O que o canal devolveu não parece um calendário válido.',
  outro: 'Não foi possível ler o calendário. Vamos tentar outra vez mais tarde.',
};

/** Erros que costumam passar sozinhos (o problema é do canal ou da rede, não do link): não pedem «Corrigir». */
const ERROS_TEMPORARIOS = new Set(['timeout', 'dns', 'http_5xx', 'http_429']);
const eErroTemporario = (codigo) => ERROS_TEMPORARIOS.has(codigo);

const ROTULOS = { airbnb: 'Airbnb', booking: 'Booking.com', vrbo: 'Vrbo' };
/** Nome do canal para mostrar («Outro canal» ou o nome dado pelo gestor nos canais genéricos). */
const canalTexto = (canal, rotulo) => (canal === 'outro' ? (rotulo || 'Outro canal') : ROTULOS[canal] || 'Outro canal');

const MENSAGENS_ESTADO = {
  casa_inativa: 'Em pausa: a casa está inativa.',
  parceiro_inativo: 'Em pausa: o proprietário está inativo.',
  empresa_inativa: 'Em pausa: a empresa está inativa.',
  casa_ligada_smoobu: 'Desligado: esta casa recebe as reservas pelo Smoobu.',
  erros_persistentes: 'Desligado: o calendário falhou durante muito tempo. Volta a testar a ligação para o reativar.',
  acordo_por_aceitar: 'Em pausa: o proprietário ainda não aceitou o Acordo de Tratamento de Dados.',
  pelo_gestor: 'Em pausa, a pedido do gestor.',
  pelo_parceiro: 'Em pausa, a teu pedido.',
};

/** Leitura suspeita por trazer reservas novas a mais de uma vez: nada foi CRIADO (não cancelado). */
const textoMuitosNovos = (n, paraGestor) => (paraGestor
  ? `Encontrámos ${n} reservas novas de uma vez. Por segurança, não criámos nenhuma. Confirma que o calendário está certo e carrega em Aceitar.`
  : 'A All2gether está a validar este calendário.');

/**
 * Mensagem de um erro de leitura. `canal` (texto) personaliza os erros passageiros; `paraGestor: false` usa
 * as palavras do proprietário (ele não corrige o link: gera um novo no canal e envia-o à All2gether).
 */
function mensagemErro(codigo, { canal = null, paraGestor = true } = {}) {
  if (eErroTemporario(codigo)) {
    const nome = canal || 'canal';
    return codigo === 'http_429'
      ? `O ${nome} pediu para esperarmos; voltamos a tentar sozinhos.`
      : `Problema temporário no ${nome}; voltamos a tentar sozinhos.`;
  }
  if (!paraGestor && codigo === 'http_404_410') {
    return `O link deixou de funcionar. Gera um link novo no ${canal || 'canal'} e envia-o à All2gether.`;
  }
  return MENSAGENS_ERRO[codigo] || MENSAGENS_ERRO.outro;
}

module.exports = { MENSAGENS_ERRO, MENSAGENS_ESTADO, mensagemErro, textoMuitosNovos, eErroTemporario, canalTexto };
