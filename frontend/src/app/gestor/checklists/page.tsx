/**
 * /gestor/checklists — Página própria de Modelos de Checklist.
 *
 * FIX (checklists página própria) — Os Modelos de Checklist foram movidos
 * de /gestor/configuracoes/checklists (escondido nas configurações) para
 * esta rota de topo, acessível diretamente pelo menu lateral.
 *
 * Re-exporta o componente existente para evitar duplicação de código. O
 * conteúdo (CRUD de modelos) vive no ficheiro original; esta é apenas a
 * nova rota canónica.
 */
export { default } from "@/app/gestor/configuracoes/checklists/page";
