#!/usr/bin/env bash
# One-time setup so GitHub Actions can write to gs://getbedrock-downloads without
# a long-lived key. Run it yourself — it needs the gmail account, which is the
# only one with write access to the project.
#
#   ./scripts/setup-gcp-ci.sh
#
# Safe to re-run: every step checks for what it is about to create.
set -euo pipefail

ACCOUNT="arseniichistiakov@gmail.com"
PROJECT="cleveland-464404-m0"
BUCKET="gs://getbedrock-downloads"
REPO="Novelty-Labs-Stuhi/bedrock"
SA_NAME="github-actions-bedrock"
POOL="github"
PROVIDER="github"

SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
GC=(gcloud --account "$ACCOUNT" --project "$PROJECT")

# IAM is eventually consistent. A resource can be created successfully and still
# be invisible to the next API call for several seconds, which surfaces as a
# bogus "does not exist" 400.
retry() {
  local n=0
  until "$@"; do
    n=$((n + 1))
    if [ "$n" -ge 12 ]; then
      echo "    giving up after $n attempts" >&2
      return 1
    fi
    echo "    not visible yet, retrying in 5s ($n/12)" >&2
    sleep 5
  done
}

echo "==> Enabling APIs"
"${GC[@]}" services enable \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  storage.googleapis.com \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com

echo "==> Service account"
if "${GC[@]}" iam service-accounts describe "$SA_EMAIL" >/dev/null 2>&1; then
  echo "    already exists"
else
  "${GC[@]}" iam service-accounts create "$SA_NAME" --display-name "GitHub Actions (bedrock)"
  retry "${GC[@]}" iam service-accounts describe "$SA_EMAIL" >/dev/null
fi

echo "==> Granting write on $BUCKET"
retry "${GC[@]}" storage buckets add-iam-policy-binding "$BUCKET" \
  --member "serviceAccount:${SA_EMAIL}" \
  --role roles/storage.objectAdmin >/dev/null

echo "==> Granting Cloud Run deploy rights (for the download site)"
# `gcloud run deploy --source` is three services wearing a trenchcoat: Cloud Build
# compiles the Dockerfile, Artifact Registry stores the image, Cloud Run serves it.
for role in \
  roles/run.admin \
  roles/cloudbuild.builds.editor \
  roles/artifactregistry.admin \
  roles/storage.admin; do
  retry "${GC[@]}" projects add-iam-policy-binding "$PROJECT" \
    --member "serviceAccount:${SA_EMAIL}" \
    --role "$role" >/dev/null
  echo "    $role"
done

# Cloud Build runs the build as the compute default SA, so the deploying account
# needs permission to act as it.
BUILD_SA="$("${GC[@]}" projects describe "$PROJECT" --format 'value(projectNumber)')-compute@developer.gserviceaccount.com"
retry "${GC[@]}" iam service-accounts add-iam-policy-binding "$BUILD_SA" \
  --member "serviceAccount:${SA_EMAIL}" \
  --role roles/iam.serviceAccountUser >/dev/null
echo "    roles/iam.serviceAccountUser on $BUILD_SA"

echo "==> Workload identity pool"
if "${GC[@]}" iam workload-identity-pools describe "$POOL" --location global >/dev/null 2>&1; then
  echo "    already exists"
else
  "${GC[@]}" iam workload-identity-pools create "$POOL" \
    --location global --display-name "GitHub Actions"
fi

echo "==> OIDC provider"
if "${GC[@]}" iam workload-identity-pools providers describe "$PROVIDER" \
  --location global --workload-identity-pool "$POOL" >/dev/null 2>&1; then
  echo "    already exists"
else
  # The attribute-condition is not optional: without it any repository on GitHub
  # could mint a token for this pool.
  retry "${GC[@]}" iam workload-identity-pools providers create-oidc "$PROVIDER" \
    --location global --workload-identity-pool "$POOL" \
    --display-name "GitHub" \
    --issuer-uri "https://token.actions.githubusercontent.com" \
    --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
    --attribute-condition "assertion.repository_owner == 'Novelty-Labs-Stuhi'"
fi

PROJECT_NUMBER="$("${GC[@]}" projects describe "$PROJECT" --format 'value(projectNumber)')"

echo "==> Letting $REPO impersonate the service account"
retry "${GC[@]}" iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
  --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${REPO}" >/dev/null

WIF_PROVIDER="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}"

echo
echo "==> Writing the two remaining GitHub secrets"
printf '%s' "$WIF_PROVIDER" | gh secret set GCP_WIF_PROVIDER --repo "$REPO"
printf '%s' "$SA_EMAIL" | gh secret set GCP_SERVICE_ACCOUNT --repo "$REPO"

echo
echo "Done. Secrets now set:"
gh secret list --repo "$REPO"
