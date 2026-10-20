import { existsSync } from "node:fs";

export interface JiraCredentials {
  email: string;
  apiToken: string;
}

/**
 * Loads KEY=VALUE pairs from an env file into process.env without overriding values already set.
 * Uses Node's built-in loader, so no dependency is required.
 */
export function loadEnvFile(path: string): boolean {
  if (!existsSync(path)) return false;
  process.loadEnvFile(path);
  return true;
}

export function readJiraCredentials(env: NodeJS.ProcessEnv): JiraCredentials {
  const email = env.JIRA_EMAIL?.trim();
  const apiToken = env.JIRA_API_TOKEN?.trim();
  const missing = [!email && "JIRA_EMAIL", !apiToken && "JIRA_API_TOKEN"].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`Variáveis de ambiente ausentes: ${missing.join(", ")}. Configure-as no arquivo .env do dispatcher.`);
  }
  return { email: email!, apiToken: apiToken! };
}
