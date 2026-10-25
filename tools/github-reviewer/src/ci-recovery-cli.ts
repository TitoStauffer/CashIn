import { recoverCiAfterMetadataEdit } from './ci-recovery.js';

const result = await recoverCiAfterMetadataEdit({
  fetchImpl: fetch,
  repository: process.env.GITHUB_REPOSITORY ?? '',
  pullRequestNumber: Number(process.env.PR_NUMBER),
  headSha: process.env.PR_HEAD_SHA ?? '',
  token: process.env.GITHUB_TOKEN ?? '',
});

if (result.action === 'rerun_requested') {
  console.log(`Requested CI rerun ${result.runId} for the current Pull Request head.`);
} else {
  console.log(`Active CI run ${result.runId} completed successfully after the metadata edit.`);
}
