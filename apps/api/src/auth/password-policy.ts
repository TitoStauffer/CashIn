export const PASSWORD_POLICY_MESSAGE =
  "A senha deve ter pelo menos 8 caracteres, incluindo uma letra maiúscula, uma letra minúscula, um número e um caractere especial.";

export function isPasswordPolicyValid(password: string): boolean {
  return (
    [...password].length >= 8 &&
    /\p{Lu}/u.test(password) &&
    /\p{Ll}/u.test(password) &&
    /\p{N}/u.test(password) &&
    /[\p{P}\p{S}]/u.test(password)
  );
}
