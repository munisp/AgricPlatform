# open-appsec local policy drop-in (wave FABRIC)

When `APPSEC_AGENT_TOKEN` is not set (no SaaS profile), the open-appsec
agent reads its local policy from this directory (`/ext/appsec` in the
agent container, e.g. a `local_policy.yaml`). No policy file is committed:
the profile is a scaffold and its runtime behaviour has NOT been verified
in this wave — see docs/integration-fabric.md.
