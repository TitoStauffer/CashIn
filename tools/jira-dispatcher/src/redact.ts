const SENSITIVE_ENV_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|CREDENTIAL)/i;

const MASK = "[REDACTED]";

interface SecretRule {
  pattern: RegExp;
  replace: (match: string, ...groups: string[]) => string;
}

const SECRET_RULES: SecretRule[] = [
  // Authorization header values.
  { pattern: /\b(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replace: (_m, scheme) => `${scheme} ${MASK}` },
  // Atlassian, GitHub and OpenAI-style tokens.
  { pattern: /\bATATT[A-Za-z0-9_\-=]{20,}/g, replace: () => MASK },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replace: () => MASK },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: () => MASK },
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}/g, replace: () => MASK },
  // key=value or "key": "value" pairs with sensitive key names.
  {
    pattern: /((?:\\?")?(?:password|passwd|api[_-]?token|token|secret|api[_-]?key|authorization)(?:\\?")?\s*[:=]\s*)(\\?"[^"\\]*\\?"|'[^']*'|[^\s,;&}"]+)/gi,
    replace: (match, prefix, value) => {
      // "Authorization: Bearer x" is already handled by the header rule above.
      if (/^(Basic|Bearer)$/i.test(value)) return match;
      const quote = value.startsWith('\\"') ? '\\"' : value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : "";
      return `${prefix}${quote}${MASK}${quote}`;
    }
  },
  // Credentials embedded in URLs (https://user:secret@host).
  { pattern: /(:\/\/[^:/\s@]+:)[^@\s/]+(@)/g, replace: (_m, before, at) => `${before}${MASK}${at}` }
];

/**
 * Removes known secret values and common secret shapes from text before it is persisted or printed.
 */
export class Redactor {
  private readonly secrets: string[];

  constructor(secretValues: Iterable<string | undefined> = []) {
    this.secrets = [...new Set([...secretValues].filter(isRedactable))].sort((a, b) => b.length - a.length);
  }

  static fromEnvironment(env: NodeJS.ProcessEnv, extra: Iterable<string | undefined> = []): Redactor {
    const values: (string | undefined)[] = [...extra];
    for (const [name, value] of Object.entries(env)) {
      if (SENSITIVE_ENV_NAME.test(name)) values.push(value);
    }
    return new Redactor(values);
  }

  redact(text: string): string {
    let result = text;
    for (const secret of this.secrets) {
      result = result.split(secret).join(MASK);
      // Secrets may also appear JSON-escaped or Base64-encoded inside Basic auth headers.
      const encoded = Buffer.from(secret, "utf8").toString("base64");
      if (encoded.length >= 8) result = result.split(encoded).join(MASK);
    }
    for (const rule of SECRET_RULES) {
      result = result.replace(rule.pattern, (match: string, ...groups: unknown[]) =>
        rule.replace(match, ...(groups.filter((g) => typeof g === "string") as string[]))
      );
    }
    return result;
  }
}

function isRedactable(value: string | undefined): value is string {
  // Very short values (e.g. "1", "true") would destroy unrelated log content.
  return typeof value === "string" && value.trim().length >= 6;
}
