// Servidor da F3 (VM Oracle, região de origem da conta). Fixo no código: a página nunca aceita o
// endereço do servidor por parâmetro de URL (a URL pode ser montada por qualquer pessoa).
export const SERVER_HOST = 'sonda.kingszin.com.br';
export const SERVER_ORIGIN = `https://${SERVER_HOST}`;
// Registrada em todo relatório: os números de rede valem para ESTA rota (Discord → Phoenix), não
// para jogadores no Brasil em geral.
export const SERVER_REGION = 'us-phoenix-1';
