import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitHubReportPublisher, type ReportAgentName } from './github-report-publisher.js';

const toolDirectory = fileURLToPath(new URL('..', import.meta.url));

try {
  const args = parseArguments(process.argv.slice(2));
  const environment = await loadEnvironment(args.envFile);
  const appId = required(environment, 'GITHUB_APP_ID');
  const privateKey = await loadPrivateKey(environment);
  const owner = args.owner ?? required(environment, 'GITHUB_REPOSITORY_OWNER');
  const repository = args.repository ?? required(environment, 'GITHUB_REPOSITORY_NAME');
  const installationId = environment.GITHUB_APP_INSTALLATION_ID?.trim() || undefined;
  const reportMarkdown = await readFile(args.reportFile, 'utf8');

  const publisher = new GitHubReportPublisher({ appId, privateKey, owner, repository, installationId });
  const result = await publisher.publishReport({
    agentName: args.agentName,
    pullRequestNumber: args.pullRequestNumber,
    commitSha: args.commitSha,
    status: args.status,
    reportMarkdown,
  });

  process.stdout.write(`Report comment published on ${result.repository}#${result.pullRequestNumber}.\n${result.htmlUrl}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unexpected publication error.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

interface CliArguments {
  pullRequestNumber: number;
  commitSha: string;
  agentName: ReportAgentName;
  status: string;
  reportFile: string;
  owner?: string;
  repository?: string;
  envFile: string;
}

function parseArguments(arguments_: string[]): CliArguments {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const name = arguments_[index];
    if (name === '--help') {
      printHelp();
      process.exit(0);
    }
    const value = arguments_[index + 1];
    if (!['--pr', '--sha', '--agent', '--status', '--report-file', '--owner', '--repository', '--env-file'].includes(name)
      || !value || value.startsWith('--') || values.has(name)) {
      throw new Error('Invalid arguments. Use --help for usage.');
    }
    values.set(name, value);
    index += 1;
  }

  const pullRequestNumber = Number(values.get('--pr'));
  const agentName = values.get('--agent') as ReportAgentName;
  if (!values.has('--pr') || !values.has('--sha') || !values.has('--agent') || !values.has('--status') || !values.has('--report-file')) {
    throw new Error('Provide --pr, --sha, --agent, --status, and --report-file.');
  }
  if (!['qualityGate', 'qa', 'pm'].includes(agentName)) {
    throw new Error('--agent must be qualityGate, qa, or pm.');
  }
  if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) {
    throw new Error('--pr must be a positive integer.');
  }

  const reportFile = values.get('--report-file');
  const commitSha = values.get('--sha');
  const status = values.get('--status');
  if (!reportFile || !commitSha || !status) {
    throw new Error('Provide --sha, --status, and --report-file.');
  }

  return {
    pullRequestNumber,
    commitSha,
    agentName,
    status,
    reportFile: resolve(reportFile),
    owner: values.get('--owner'),
    repository: values.get('--repository'),
    envFile: resolve(values.get('--env-file') ?? `${toolDirectory}/.env`),
  };
}

async function loadEnvironment(path: string): Promise<Record<string, string | undefined>> {
  const text = await readFile(path, 'utf8');
  const fileValues = Object.fromEntries(
    text.split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const separator = line.indexOf('=');
        if (separator < 1) throw new Error('Invalid environment file format.');
        const name = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
        return [name, value];
      }),
  );
  return { ...fileValues, ...process.env };
}

function required(environment: Record<string, string | undefined>, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Missing required setting: ${name}.`);
  return value;
}

async function loadPrivateKey(environment: Record<string, string | undefined>): Promise<string> {
  const configuredKey = environment.GITHUB_APP_PRIVATE_KEY?.trim();
  if (configuredKey) return configuredKey.replace(/\\n/g, '\n');

  const privateKeyPath = required(environment, 'GITHUB_APP_PRIVATE_KEY_PATH');
  return readFile(privateKeyPath, 'utf8');
}

function printHelp(): void {
  process.stdout.write(
    'Usage:\n  npm run publish-report -- --pr <number> --sha <commit-sha> --agent <qualityGate|qa|pm> --status <status> --report-file <markdown-path> [--owner <owner>] [--repository <name>] [--env-file <path>]\n',
  );
}
