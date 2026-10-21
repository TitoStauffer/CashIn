import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateMergeReadiness } from './merge-readiness.js';

const toolDirectory = fileURLToPath(new URL('..', import.meta.url));

try {
  const args = parseArguments(process.argv.slice(2));
  const environment = await loadEnvironment(args.envFile);
  const appId = required(environment, 'GITHUB_APP_ID');
  const privateKey = await loadPrivateKey(environment);
  const owner = required(environment, 'GITHUB_REPOSITORY_OWNER');
  const repository = required(environment, 'GITHUB_REPOSITORY_NAME');
  const result = await evaluateMergeReadiness({
    appId,
    privateKey,
    owner,
    repository,
    installationId: environment.GITHUB_APP_INSTALLATION_ID?.trim() || undefined,
    pullRequestNumber: args.pullRequestNumber,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.status === 'READY_TO_MERGE' ? 0 : result.status === 'BLOCKED' ? 1 : 2;
} catch (error) {
  const originalMessage = error instanceof Error ? error.message : '';
  const safeMessage = /^(?:ENOENT|EACCES|EPERM):/.test(originalMessage)
    ? 'Não foi possível ler o arquivo de configuração ou a chave privada.'
    : originalMessage || 'Não foi possível executar a avaliação.';
  const result = {
    status: 'INCONCLUSIVE',
    pullRequest: { number: null },
    evaluatedAt: new Date().toISOString(),
    evidence: {},
    reasons: [],
    limitations: [safeMessage],
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = 2;
}

function parseArguments(arguments_: string[]): { pullRequestNumber: number; envFile: string } {
  let pullRequestNumber: number | undefined;
  let envFile = resolve(toolDirectory, '.env');
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--help') {
      process.stdout.write('Usage: npm run readiness -- --pr <number> [--env-file <path>]\nOutput: JSON with READY_TO_MERGE, BLOCKED, or INCONCLUSIVE.\n');
      process.exit(0);
    }
    const value = arguments_[index + 1];
    if (!value || value.startsWith('--')) throw new Error('Use --pr <number> and optionally --env-file <path>.');
    if (argument === '--pr' && pullRequestNumber === undefined) {
      pullRequestNumber = Number(value);
      index += 1;
    } else if (argument === '--env-file') {
      envFile = resolve(value);
      index += 1;
    } else {
      throw new Error('Argumento inválido. Use --help para ver o uso.');
    }
  }
  if (!Number.isSafeInteger(pullRequestNumber) || (pullRequestNumber ?? 0) < 1) throw new Error('--pr deve conter um número positivo.');
  return { pullRequestNumber: pullRequestNumber as number, envFile };
}

async function loadEnvironment(path: string): Promise<Record<string, string | undefined>> {
  const content = await readFile(path, 'utf8');
  const values = Object.fromEntries(content.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const separator = line.indexOf('=');
      if (separator < 1) throw new Error('Arquivo de ambiente inválido.');
      const name = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
      return [name, value];
    }));
  return { ...values, ...process.env };
}

function required(environment: Record<string, string | undefined>, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Configuração obrigatória ausente: ${name}.`);
  return value;
}

async function loadPrivateKey(environment: Record<string, string | undefined>): Promise<string> {
  const configuredKey = environment.GITHUB_APP_PRIVATE_KEY?.trim();
  if (configuredKey) return configuredKey.replace(/\\n/g, '\n');
  return readFile(required(environment, 'GITHUB_APP_PRIVATE_KEY_PATH'), 'utf8');
}
