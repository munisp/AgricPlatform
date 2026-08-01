#!/usr/bin/env bash
# validate-repo.sh — run the Phase 1 quality gates locally before pushing.
#
# Usage:
#   ./scripts/validate-repo.sh            # full validation
#   SKIP_INSTALL=1 ./scripts/validate-repo.sh   # reuse existing node_modules
#
# Gates (from SPEC.md):
#   npm install succeeds from a clean checkout
#   TypeScript compile and production builds pass
#   Shared unit tests pass
#   Lint passes where configured
#   No secrets committed
set -euo pipefail

cd "$(dirname "$0")/.."

info()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
fail()  { printf '\033[1;31mFAIL:\033[0m %s\n' "$*" >&2; exit 1; }

# --- 1. Install -------------------------------------------------------------
if [ "${SKIP_INSTALL:-0}" != "1" ]; then
  info "Installing dependencies (npm ci when lockfile exists, else npm install)"
  if [ -f package-lock.json ]; then
    npm ci
  else
    npm install
  fi
else
  info "SKIP_INSTALL=1 — reusing existing node_modules"
fi

# --- 2. Typecheck -----------------------------------------------------------
info "Typecheck"
npm run typecheck --workspaces --if-present

# --- 3. Lint ----------------------------------------------------------------
info "Lint"
npm run lint --workspaces --if-present

# --- 4. Tests ---------------------------------------------------------------
info "Unit tests"
npm run test --workspaces --if-present

# --- 5. Production builds ---------------------------------------------------
info "Production builds"
npm run build --workspaces --if-present

# --- 6. Secret scan ---------------------------------------------------------
# Heuristic scan of tracked files for common secret shapes. This is a safety
# net, not a replacement for GitHub secret scanning / push protection.
info "Scanning tracked files for obvious secrets"
PATTERNS='BEGIN (RSA|OPENSSH|EC|DSA|PGP) PRIVATE KEY'
PATTERNS+='|AKIA[0-9A-Z]{16}'                                  # AWS access key id
PATTERNS+='|sk_live_[0-9A-Za-z]{16,}'                          # Stripe-style live key
PATTERNS+='|paystack_sk_live_[0-9A-Za-z]+'                     # Paystack live secret
PATTERNS+='|xox[baprs]-[0-9A-Za-z-]{10,}'                      # Slack tokens
PATTERNS+='|gh[pousr]_[0-9A-Za-z]{36,}'                        # GitHub tokens
PATTERNS+='|AIza[0-9A-Za-z_-]{35}'                             # Google API key

if git grep -nIE "$PATTERNS" -- . ':(exclude).env.example' ':(exclude)scripts/validate-repo.sh' > /tmp/agric-secret-scan.$$ 2>/dev/null; then
  cat /tmp/agric-secret-scan.$$ >&2
  rm -f /tmp/agric-secret-scan.$$
  fail "Potential secrets found in tracked files (see above)."
fi
rm -f /tmp/agric-secret-scan.$$

# Flag .env files that are accidentally tracked
if git ls-files --error-unmatch .env >/dev/null 2>&1; then
  fail ".env is tracked by git — remove it (only .env.example may be committed)."
fi

info "All validation gates passed."
