/**
 * Re-exporta o componente PushNotificationSetup partilhado com o staff.
 *
 * O componente é genérico — funciona para qualquer utilizador autenticado
 * (usa /api/auth/me/push-subscribe que guarda a subscrição em req.user.id).
 * Este ficheiro existe apenas para manter os imports do painel do gestor
 * limpos (`@/components/gestor/push-notification-setup`) sem duplicar código.
 */
export { PushNotificationSetup } from "@/components/staff/push-notification-setup";
