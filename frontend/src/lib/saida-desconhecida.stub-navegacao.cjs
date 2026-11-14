// Só para os testes (node --test): useRouter sem Next.
module.exports = { useRouter: () => ({ push() {}, replace() {}, back() {} }) };
