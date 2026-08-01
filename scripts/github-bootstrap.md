# GitHub Bootstrap Runbook

One-time commands to provision the `AgricPlatform` repository per
`docs/github-strategy.md`. Requires the GitHub CLI (`gh`) authenticated with
admin rights on the target organisation or user account.

Set the owner first:

```bash
export OWNER=<org-or-user>
export REPO=AgricPlatform
```

## 1. Validate, then initial push

```bash
./scripts/validate-repo.sh

gh repo create "$OWNER/$REPO" --private \
  --description "Unified NYFN farmer platform (PRD v3.3 Phase 1)"

git remote add origin "git@github.com:$OWNER/$REPO.git"
git push -u origin main
```

## 2. Labels

```bash
# Types
gh label create "type: feature"  -R "$OWNER/$REPO" -c 0E8A16 -d "New functionality"
gh label create "type: bug"      -R "$OWNER/$REPO" -c D73A4A -d "Defect"
gh label create "type: chore"    -R "$OWNER/$REPO" -c C5DEF5 -d "Maintenance"
gh label create "type: docs"     -R "$OWNER/$REPO" -c 0075CA -d "Documentation"
gh label create "type: security" -R "$OWNER/$REPO" -c B60205 -d "Security work"
gh label create "type: debt"     -R "$OWNER/$REPO" -c FBCA04 -d "Technical debt"
gh label create "type: spike"    -R "$OWNER/$REPO" -c D4C5F9 -d "Investigation"

# Domains
for d in identity learning community opportunity chapter marketplace finance \
         notification advisory analytics admin infra; do
  gh label create "domain: $d" -R "$OWNER/$REPO" -c 1D76DB -d "Domain: $d"
done

# Modules
for m in $(seq 1 18); do
  gh label create "module: M$m" -R "$OWNER/$REPO" -c 5319E7 -d "PRD module M$m"
done

# Phases and releases
for p in P1 P2 P3; do
  gh label create "phase: $p" -R "$OWNER/$REPO" -c 0E8A16 -d "Delivery phase $p"
done
for r in R1 R2 R3; do
  gh label create "release: $r" -R "$OWNER/$REPO" -c 0052CC -d "Release $r"
done

# Priorities
for p in P0 P1 P2 P3; do
  gh label create "priority: $p" -R "$OWNER/$REPO" -c B60205 -d "Priority $p"
done

# Gates
for g in connectivity ndpr security legal payments; do
  gh label create "gate: $g" -R "$OWNER/$REPO" -c FEF2C0 -d "Release gate: $g"
done

# Status
gh label create "status: blocked"      -R "$OWNER/$REPO" -c B60205 -d "Blocked"
gh label create "status: ready"        -R "$OWNER/$REPO" -c 0E8A16 -d "Ready for pickup"
gh label create "status: needs-adr"    -R "$OWNER/$REPO" -c D4C5F9 -d "Needs architecture decision record"
gh label create "status: needs-design" -R "$OWNER/$REPO" -c FBCA04 -d "Needs design"
```

## 3. Milestones

```bash
gh api -X POST "repos/$OWNER/$REPO/milestones" \
  -f title="R1 Alpha" -f description="Identity, farmer dashboard, learning, community"
gh api -X POST "repos/$OWNER/$REPO/milestones" \
  -f title="R2 Beta" -f description="Opportunities, chapters, advisory, notifications"
gh api -X POST "repos/$OWNER/$REPO/milestones" \
  -f title="R3 Launch" -f description="Admin, partner workspace, analytics, security hardening"
gh api -X POST "repos/$OWNER/$REPO/milestones" \
  -f title="Phase 2" -f description="Marketplace, credit readiness, WhatsApp, mobile, partner revenue"
gh api -X POST "repos/$OWNER/$REPO/milestones" \
  -f title="Phase 3" -f description="Recommendations, lakehouse, USSD, commodity exchange, SDK"
```

## 4. Branch protection on `main`

```bash
gh api -X PUT "repos/$OWNER/$REPO/branches/main/protection" \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "Install and cache dependencies",
      "Build shared, API and web",
      "Unit tests and coverage",
      "Lint and typecheck",
      "Secret scan and dependency audit",
      "Bundle and artifact audit",
      "CI gate"
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": true,
    "require_last_push_approval": true
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_conversation_resolution": true,
  "lock_branch": false,
  "allow_fork_syncing": false
}
JSON
```

Notes:
- Raise `required_approving_review_count` to 2 for finance, payments, infra,
  auth, and shared-contract changes via CODEOWNERS review discipline.
- Enable squash merges only:
  `gh repo edit "$OWNER/$REPO" --enable-squash-merge --disable-merge-commit --disable-rebase-merge`

## 5. Environments and secrets

```bash
for env in dev staging production; do
  gh api -X PUT "repos/$OWNER/$REPO/environments/$env"
done

# Require manual approval for production (replace <TEAM_ID> or use user IDs):
gh api -X PUT "repos/$OWNER/$REPO/environments/production" \
  --input - <<'JSON'
{
  "reviewers": [{ "type": "Team", "id": 0 }],
  "deployment_branch_policy": { "protected_branches": true, "custom_branch_policies": false }
}
JSON
```

Add secrets per environment (never commit values):

```bash
gh secret set DATABASE_URL        -R "$OWNER/$REPO" --env production
gh secret set REDIS_URL           -R "$OWNER/$REPO" --env production
gh secret set KEYCLOAK_CLIENT_SECRET -R "$OWNER/$REPO" --env production
gh secret set PAYSTACK_SECRET_KEY -R "$OWNER/$REPO" --env production
gh secret set TERMII_API_KEY      -R "$OWNER/$REPO" --env production
# ...repeat for staging/dev with sandbox values; see .env.example for the full key list
```

## 6. Dependabot, code scanning, secret scanning

```bash
# Dependabot version updates are configured by .github/dependabot.yml.
gh api -X PUT "repos/$OWNER/$REPO/vulnerability-alerts"
gh api -X PUT "repos/$OWNER/$REPO/automated-security-fixes"

# Secret scanning + push protection (org plan permitting):
gh api -X PATCH "repos/$OWNER/$REPO" \
  -F security_and_analysis='{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"}}'

# Code scanning (CodeQL default setup):
gh api -X POST "repos/$OWNER/$REPO/code-scanning/default-setup" \
  -f state=configured -f query_suite=default -f languages='["javascript-typescript"]'
```

## 7. Verify

```bash
gh repo view "$OWNER/$REPO"
gh api "repos/$OWNER/$REPO/branches/main/protection" --jq '.required_status_checks.contexts'
gh label list -R "$OWNER/$REPO"
gh api "repos/$OWNER/$REPO/milestones" --jq '.[].title'
```
