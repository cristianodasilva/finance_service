/**
 * Gera um id único no formato UUID versão 7.
 *
 * Diferente do UUID v4 (totalmente aleatório), o v7 começa com a data/hora.
 * Vantagem: ids gerados depois são "maiores" → ficam em ordem cronológica,
 * o que ajuda a paginação do extrato e o desempenho dos índices do banco.
 */
export function newId(): string {
  return Bun.randomUUIDv7();
}
