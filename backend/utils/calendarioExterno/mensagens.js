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

const MENSAGENS_ESTADO = {
  casa_inativa: 'Em pausa: a casa está inativa.',
  parceiro_inativo: 'Em pausa: o proprietário está inativo.',
  empresa_inativa: 'Em pausa: a empresa está inativa.',
  casa_ligada_smoobu: 'Desligado: esta casa recebe as reservas pelo Smoobu.',
  erros_persistentes: 'Desligado: o calendário falhou durante muito tempo. Volta a testar a ligação para o reativar.',
  pelo_gestor: 'Em pausa, a pedido do gestor.',
  pelo_parceiro: 'Em pausa, a teu pedido.',
};

const mensagemErro = (codigo) => MENSAGENS_ERRO[codigo] || MENSAGENS_ERRO.outro;

module.exports = { MENSAGENS_ERRO, MENSAGENS_ESTADO, mensagemErro };
