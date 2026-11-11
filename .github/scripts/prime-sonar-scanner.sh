#!/usr/bin/env bash
# Installs the SonarScanner CLI into the runner tool cache, with its GPG signature verified, before
# SonarSource/sonarqube-scan-action runs. The action skips its own download and verification when the
# scanner is already cached.
#
# Why: the action imports the SonarSource key with `gpg --recv-keys` against keyserver.ubuntu.com, and
# that call has no timeout. Its fallback keyserver is only tried when the call fails, never when it
# hangs, so an unresponsive keyserver held the SonarQube job until the 15-minute job timeout (twice on
# 11/11/2026, check runs 130519550174 and 130544528864). Here every network call is bounded, the key is
# fetched over HTTPS from two keyservers in turn, and the signature check is kept: the key must have
# exactly one primary key matching the pinned fingerprint, and the signature must be a valid one by it.
set -euo pipefail

: "${SONAR_SCANNER_VERSION:?SONAR_SCANNER_VERSION is required}"
: "${RUNNER_TOOL_CACHE:?RUNNER_TOOL_CACHE is required}"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"

# Same fingerprint the action pins in src/main/gpg-verification.js.
readonly KEY_FINGERPRINT="679F1EE92B19609DE816FDE81DB198F93525EC1A"
readonly FLAVOR="linux-x64"
readonly BINARIES_URL="https://binaries.sonarsource.com/Distribution/sonar-scanner-cli"
readonly KEY_URLS=(
  "https://keyserver.ubuntu.com/pks/lookup?op=get&options=mr&search=0x${KEY_FINGERPRINT}"
  "https://keys.openpgp.org/vks/v1/by-fingerprint/${KEY_FINGERPRINT}"
)

if [[ ! "$SONAR_SCANNER_VERSION" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  echo "::error::SONAR_SCANNER_VERSION must have four numeric parts, got '$SONAR_SCANNER_VERSION'." >&2
  exit 1
fi
# The tool cache layout the action reads: toSemVer() in src/main/utils.js and tc.find(tool, version, flavor).
readonly SEMVER="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.${BASH_REMATCH[3]}-build.${BASH_REMATCH[4]}"
readonly TOOL_DIR="${RUNNER_TOOL_CACHE}/sonar-scanner-cli/${SEMVER}/${FLAVOR}"

if [[ -d "$TOOL_DIR" && -f "${TOOL_DIR}.complete" ]]; then
  echo "SonarScanner CLI ${SONAR_SCANNER_VERSION} already cached at ${TOOL_DIR}."
  exit 0
fi

WORK_DIR="$(mktemp -d "${RUNNER_TEMP}/sonar-scanner-XXXXXX")"
readonly WORK_DIR
trap 'rm -rf "$WORK_DIR"' EXIT
readonly GNUPG_DIR="${WORK_DIR}/gnupg"
mkdir -m 700 "$GNUPG_DIR"

fetch() {
  local url="$1" output="$2" max_time="$3"
  curl --fail --silent --show-error --location \
    --connect-timeout 10 --max-time "$max_time" \
    --retry 2 --retry-all-errors \
    --output "$output" "$url"
}

readonly ARCHIVE="${WORK_DIR}/scanner.zip"
readonly SIGNATURE="${WORK_DIR}/scanner.zip.asc"
readonly ARCHIVE_URL="${BINARIES_URL}/sonar-scanner-cli-${SONAR_SCANNER_VERSION}-${FLAVOR}.zip"
echo "Downloading ${ARCHIVE_URL}"
fetch "$ARCHIVE_URL" "$ARCHIVE" 300
fetch "${ARCHIVE_URL}.asc" "$SIGNATURE" 60

readonly KEY_FILE="${WORK_DIR}/sonarsource.asc"
key_fetched=false
for key_url in "${KEY_URLS[@]}"; do
  echo "Fetching the SonarSource public key from ${key_url%%/pks/*}"
  # A keyserver that does not answer is skipped after the bounded wait (30 s per attempt, up to three
  # attempts) instead of holding the job.
  if fetch "$key_url" "$KEY_FILE" 30; then
    key_fetched=true
    break
  fi
  echo "::warning::Could not fetch the SonarSource public key from ${key_url}."
done
if [[ "$key_fetched" != true ]]; then
  echo "::error::The SonarSource public key could not be fetched from any keyserver." >&2
  exit 1
fi

# Inspect before importing: exactly one primary key, and it is the pinned one. Subkey fingerprints are ignored.
primary_fingerprints="$(
  gpg --homedir "$GNUPG_DIR" --batch --with-colons --import-options show-only --import "$KEY_FILE" 2>/dev/null \
    | awk -F: '$1 == "pub" { want = 1; next } $1 == "fpr" && want { print $10; want = 0 } $1 == "sub" { want = 0 }'
)"
if [[ "$primary_fingerprints" != "$KEY_FINGERPRINT" ]]; then
  echo "::error::The downloaded key is not exactly the SonarSource key ${KEY_FINGERPRINT}." >&2
  exit 1
fi
gpg --homedir "$GNUPG_DIR" --batch --quiet --import "$KEY_FILE"

# VALIDSIG's last field is the primary key fingerprint of the signer; a good signature by any other key fails.
# The status output is captured before it is searched: piping gpg into an early-exiting grep could kill gpg
# with SIGPIPE, and under pipefail a valid signature would then be reported as invalid.
verify_status="$(gpg --homedir "$GNUPG_DIR" --batch --status-fd 1 --verify "$SIGNATURE" "$ARCHIVE" 2>/dev/null)" \
  || verify_status=""
if ! grep -Eq "^\[GNUPG:\] VALIDSIG .* ${KEY_FINGERPRINT}$" <<<"$verify_status"; then
  echo "::error::The SonarScanner CLI signature is not a valid signature by ${KEY_FINGERPRINT}." >&2
  exit 1
fi
echo "GPG signature verified for SonarScanner CLI ${SONAR_SCANNER_VERSION}."

unzip -q "$ARCHIVE" -d "${WORK_DIR}/extract"
readonly EXTRACTED="${WORK_DIR}/extract/sonar-scanner-${SONAR_SCANNER_VERSION}-${FLAVOR}"
if [[ ! -x "${EXTRACTED}/bin/sonar-scanner" ]]; then
  echo "::error::The archive does not contain sonar-scanner-${SONAR_SCANNER_VERSION}-${FLAVOR}/bin/sonar-scanner." >&2
  exit 1
fi
rm -rf "$TOOL_DIR" "${TOOL_DIR}.complete"
mkdir -p "$(dirname "$TOOL_DIR")"
mv "$EXTRACTED" "$TOOL_DIR"
touch "${TOOL_DIR}.complete"
echo "SonarScanner CLI ${SONAR_SCANNER_VERSION} cached at ${TOOL_DIR}."
