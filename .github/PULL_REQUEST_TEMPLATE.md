## Summary
<!-- What does this PR change and why? Link the issue: Closes #123 -->

## Type of change
- [ ] Feature
- [ ] Bug fix
- [ ] Chore / maintenance
- [ ] Documentation
- [ ] Security

## Scope
<!-- Check all that apply and add matching labels (domain:, module:, phase:) -->
- [ ] `apps/web`
- [ ] `apps/api`
- [ ] `packages/shared`
- [ ] `infra` / CI/CD
- [ ] Docs

## Checklist
- [ ] Follows Conventional Commits (e.g. `feat(learning): ...`)
- [ ] `npm run validate` passes locally (typecheck, lint, test, build)
- [ ] Tests added/updated for behaviour changes
- [ ] No secrets or credentials committed (checked with `scripts/validate-repo.sh`)
- [ ] Mutating API routes accept an idempotency key where retries are possible
- [ ] Domain events emitted via the outbox use `{domain}.{entity}.{verb}`
- [ ] External providers accessed only through adapter interfaces
- [ ] NDPR/NDPA impact considered (consent, export, deletion) where personal data is touched
- [ ] Docs updated (README / docs/) if setup or contracts changed

## Screenshots / recordings
<!-- For UI changes, include before/after. -->

## Deployment notes
<!-- Migrations, env vars, provider configuration, or rollout steps. Write "None" if not applicable. -->
