import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { submitReview, verifyAccess } from './github-app.mjs';

const toolDirectory = fileURLToPath(new URL('..', import.meta.url));

try {
  const args = parseArguments(process.argv.slice(2));
  const environment = await loadEnvironment(args.envFile);
  const credentials = await loadCredentials(environment);

  if (args.command === 'verify') {
    const result = await verifyAccess({ ...credentials, pullRequestNumber: args.pullRequestNumber });
    process.stdout.write(`GitHub App access verified for ${result.pullRequest.html_url} (state: ${result.pullRequest.state}). No review was submitted.\n`);
  } else {
    const body = args.bodyFile ? await readFile(args.bodyFile, 'utf8') : args.body;

    const result = await submitReview({
      ...credentials,
      pullRequestNumber: args.pullRequestNumber,
      decision: args.decision,
      body,
    });
    process.stdout.write(`Formal review recorded: ${result.state} on PR #${args.pullRequestNumber} (${result.reviewer}).\n${result.htmlUrl}\n`);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}

function parseArguments(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    const value = args[index + 1];
    if (name === '--help') {
      printHelp();
      process.exit(0);
    }
    if (['verify', 'submit'].includes(name) && !values.command) {
      values.command = name;
      continue;
    }
    if (!['--pr', '--decision', '--body-file', '--body', '--env-file'].includes(name) || !value || value.startsWith('--')) {
      throw new Error(`Invalid arguments. Use --help for usage.`);
    }
    if (values[name]) throw new Error(`Duplicate argument: ${name}`);
    values[name] = value;
    index += 1;
  }

  if (!values.command || !values['--pr']) {
    throw new Error('Provide a command (verify or submit) and --pr.');
  }
  if (values.command === 'submit' && (!values['--decision'] || Boolean(values['--body-file']) === Boolean(values['--body']))) {
    throw new Error('For submit, provide --decision and exactly one of --body-file or --body.');
  }
  if (values.command === 'verify' && (values['--decision'] || values['--body-file'] || values['--body'])) {
    throw new Error('The verify command accepts only --pr and optional --env-file.');
  }
  return {
    command: values.command,
    pullRequestNumber: values['--pr'],
    decision: values['--decision'],
    bodyFile: values['--body-file'],
    body: values['--body'],
    envFile: values['--env-file'] ? resolve(values['--env-file']) : resolve(toolDirectory, '.env'),
  };
}

async function loadCredentials(environment) {
  const appId = required(environment, 'GITHUB_APP_ID');
  const installationId = required(environment, 'GITHUB_APP_INSTALLATION_ID');
  const privateKeyPath = required(environment, 'GITHUB_APP_PRIVATE_KEY_PATH');
  const privateKey = await readFile(privateKeyPath, 'utf8');
  return { appId, installationId, privateKey };
}

async function loadEnvironment(path) {
  const text = await readFile(path, 'utf8');
  const fileValues = Object.fromEntries(
    text.split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const separator = line.indexOf('=');
        if (separator < 1) throw new Error('Invalid environment file format.');
        const key = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
        return [key, value];
      }),
  );
  return { ...fileValues, ...process.env };
}

function required(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Missing required setting: ${name}.`);
  return value;
}

function printHelp() {
  process.stdout.write(
    'Usage:\n  npm run review -- verify --pr <number> [--env-file <path>]\n  npm run review -- submit --pr <number> --decision <APPROVED|CHANGES_REQUESTED> --body-file <path> [--env-file <path>]\n',
  );
}
