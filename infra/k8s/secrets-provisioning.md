# Secrets Provisioning — `agric-secrets`

The API Deployment (`infra/k8s/api.yaml`) consumes a Secret named
`agric-secrets` via `envFrom.secretRef`. **No Secret manifest is committed to
this repository** — the previous placeholder template was removed so that
`kubectl apply -k` can never create `REPLACE_ME` values in a cluster.

## Required keys

| Key | Used for |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `KEYCLOAK_CLIENT_SECRET` | OIDC client credential |
| `MEILISEARCH_API_KEY` | Search backend key |
| `JWT_SECRET` | Token signing secret |
| `WEBHOOK_SIGNING_SECRET` | Provider webhook verification |
| `TERMII_API_KEY` | SMS/OTP provider |
| `WHATSAPP_360DIALOG_API_KEY` | WhatsApp provider |
| `MAILGUN_API_KEY` | Email provider |
| `ONESIGNAL_REST_API_KEY` | Push provider |
| `PAYSTACK_SECRET_KEY` | Payments provider |
| `MOODLE_TOKEN` | LMS bridge |
| `DISCOURSE_API_KEY` | Community bridge |
| `DIRECTUS_TOKEN` | CMS bridge |

Keys for providers still on `stub` drivers may hold empty strings; never
commit populated values.

## Option A — External Secrets Operator (recommended)

Provision a cloud secret store (e.g. AWS Secrets Manager) containing one
secret per environment, then let the External Secrets Operator materialise
`agric-secrets` in the cluster. Example (template — do not apply before the
cluster and store exist):

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: agric-secrets
  namespace: agric-platform
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-secrets-manager      # ClusterSecretStore provisioned by platform team
    kind: ClusterSecretStore
  target:
    name: agric-secrets
    creationPolicy: Owner
  dataFrom:
    - extract:
        key: agric-platform/staging    # JSON object holding the keys above
```

## Option B — Sealed Secrets (Bitnami)

Encrypt an environment Secret with the cluster's public key and commit only
the resulting `SealedSecret` manifest:

```bash
kubectl create secret generic agric-secrets --dry-run=client \
  --from-literal=DATABASE_URL='postgresql://...' \
  ... -o yaml |
kubeseal --controller-namespace=kube-system --format yaml > sealed-agric-secrets.yaml
```

Commit `sealed-agric-secrets.yaml` only — never the input.

## Option C — Manual (bootstrap / local clusters)

```bash
kubectl -n agric-platform create secret generic agric-secrets \
  --from-literal=DATABASE_URL='postgresql://...' \
  --from-literal=REDIS_URL='redis://...' \
  --from-literal=JWT_SECRET='...'
```

## Rotation

Rotate provider credentials in the source-of-truth store, then restart the
API pods (`kubectl -n agric-platform rollout restart deploy/api`) unless the
External Secrets `refreshInterval` has already propagated the change.
