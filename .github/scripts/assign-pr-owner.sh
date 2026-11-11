#!/usr/bin/env bash
# Assigns the delivery owner to a newly opened pull request (DEV-66).
#
# Idempotent: the current assignees are read first, and nothing is written when the owner is already there.
# The assignees endpoint silently ignores a user who cannot be assigned, so success is confirmed by reading
# the owner back from the response, never assumed from the HTTP status alone.
#
# A failure never blocks the pull request: assignment is a convenience for the owner, not a quality gate.
# It is reported as a workflow warning and in the job summary, and the job still exits 0 so that a GitHub API
# hiccup cannot leave a red check on a pull request that is otherwise ready.
set -uo pipefail

: "${REPOSITORY:?REPOSITORY is required}"
: "${PR_NUMBER:?PR_NUMBER is required}"
: "${ASSIGNEE:?ASSIGNEE is required}"

if [[ ! "$PR_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "::error::PR_NUMBER must be numeric, got '$PR_NUMBER'." >&2
  exit 1
fi

# The message carries raw gh/API error text. It is escaped as the workflow command format requires, so a
# multi-line error stays one annotation instead of having each extra line read as a workflow command.
warn() {
  local message="${1//'%'/%25}"
  message="${message//$'\r'/%0D}"
  message="${message//$'\n'/%0A}"
  echo "::warning title=Responsável não atribuído::${message}"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    local line="${1//$'\r'/ }"
    echo "- ${line//$'\n'/ }" >>"$GITHUB_STEP_SUMMARY"
  fi
}

# GitHub logins are case-insensitive; the API may return a different casing than the one configured.
has_assignee() {
  local logins=" ${1,,} "
  [[ "$logins" == *" ${ASSIGNEE,,} "* ]]
}

if ! current="$(gh api "repos/${REPOSITORY}/issues/${PR_NUMBER}" --jq '[.assignees[].login] | join(" ")' 2>&1)"; then
  warn "Não foi possível ler os responsáveis do PR #${PR_NUMBER}: ${current}. O PR segue sem atribuição automática."
  exit 0
fi

if has_assignee "$current"; then
  echo "${ASSIGNEE} já é responsável pelo PR #${PR_NUMBER}; nada a fazer."
  exit 0
fi

if ! updated="$(gh api --method POST "repos/${REPOSITORY}/issues/${PR_NUMBER}/assignees" -f "assignees[]=${ASSIGNEE}" --jq '[.assignees[].login] | join(" ")' 2>&1)"; then
  warn "A API recusou a atribuição de ${ASSIGNEE} ao PR #${PR_NUMBER}: ${updated}."
  exit 0
fi

if ! has_assignee "$updated"; then
  warn "A API respondeu sem ${ASSIGNEE} entre os responsáveis do PR #${PR_NUMBER}; o usuário pode não ter permissão de atribuição no repositório."
  exit 0
fi

echo "${ASSIGNEE} atribuído ao PR #${PR_NUMBER}."
