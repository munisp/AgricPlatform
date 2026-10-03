# Event Consumer Coverage — GAP-H05 Guardrail

**Status: deferred-with-guardrail — NOT closed.** Most emitted domain events
still have no consumer on the default deployment path. This document and the
checked-in registry (`apps/api/src/core/events/event-consumer-coverage.ts`,
enforced by `event-consumer-coverage.spec.ts`) are the guardrail: they make
the coverage gap explicit, per event name, and fail the test suite when a
newly introduced event name is left unclassified. They do **not** implement
the missing consumers, and nothing here is a production-readiness claim.

## How the event spine actually delivers

`DomainEventsService` (`apps/api/src/core/domain-events.service.ts`) is the
only writer to `events.outbox`: every event is validated against the
`{domain}.{entity}.{verb}` taxonomy, persisted to the outbox (inline
via `persist()` or transactionally via `build()` + `updateExpected`), and
then fanned out **synchronously** to in-process `EventEmitter` listeners.
With the default `EVENT_BUS_DRIVER=stub`, the external bus publish is a
labelled no-op, so the in-process fan-out is the entire delivery.

"Consumption" therefore comes in exactly five shapes today:

| # | Consumer class | Mechanism | Runs on the default path? |
| --- | --- | --- | --- |
| 1 | In-process listener | `.on(name)` synchronous fan-out | Yes — same process, same request |
| 2 | Partner webhook | `'*'` listener in `webhook-dispatch.service.ts`, filtered to 5 mapped names | Partially — delivery is best-effort, no retry (GAP-H06) |
| 3 | Analytics projector | reads `events.outbox`, upserts star marts | Only when an external scheduler calls `POST /api/v1/analytics/project` (GAP-M03) |
| 4 | Lender attribution | reads `events.outbox` inside the lender-scorecard flow | Only when the scheduler-invoked scorecard path runs (GAP-M03) |
| 5 | Fraud sentinel | reads `events.outbox`, evaluates deterministic rules | Only when flagged ON **and** an external scheduler calls its run endpoint (GAP-M03) |

Everything else is **audit-only**: the event is durable in `events.outbox`,
marked `published_at` after fan-out, and *no code reacts to it*. The
business reaction one might expect (a notification, a projection, a
webhook, a workflow) is **deferred** — it does not exist yet.

## 1. In-process listeners (13 event names)

| Event name | Listener(s) |
| --- | --- |
| `credit.collateral.claimed` | `warehouse/collateral-claim.service.ts` (pledge release / liquidation) |
| `farms.planting.status_changed` | `credit/credit.service.ts` (`onPlantingFailed`) |
| `farms.plot.created` | `geo/geo.service.ts` (H3 indexing) |
| `farms.plot.updated` | `geo/geo.service.ts` (H3 indexing) |
| `farms.plot.removed` | `geo/geo.service.ts` (H3 removal) |
| `insurance.payout.paid` | `insurance/voucher-covers.service.ts` |
| `insurance.trigger.raised` | `insurance/voucher-covers.service.ts` |
| `integration.webhook.received` | `notifications/inbound-conversations.service.ts` |
| `livestock.animal.status_changed` | `livestock-trade/insurance.service.ts`, `livestock-trade/liens.service.ts` (via shared `LIVESTOCK_ANIMAL_STATUS_CHANGED_EVENT` constant) |
| `livestock.recall.initiated` | `livestock-health/recall-notifications.listener.ts`, `livestock-trade/insurance.service.ts` |
| `marketplace.escrow.status_changed` | `marketplace/coop-pool.service.ts`, `marketplace/offtake.service.ts` |
| `voice.agent_case.created` | `voice/escalation-console.service.ts` |
| `warehouse.receipt.loss_reported` | `warehouse/ltv-guardian.service.ts` |

## 2. Partner webhook (5 event names)

`webhook-dispatch.service.ts` subscribes to `'*'` but only the names in
`DOMAIN_EVENT_MAP` are translated to the public webhook vocabulary; every
other event is ignored by the dispatcher:

| Domain event | Public webhook type |
| --- | --- |
| `learning.certificate.issued` | `course.completed` |
| `learning.enrolment.created` | `enrolment.created` |
| `partner.disbursement.recorded` | `disbursement.recorded` |
| `partner.enrolment.recorded` | `programme_enrolment.recorded` |
| `credit.coop_score.band_changed` | `coop_score.band_changed` |

Caveat (GAP-H06): on the default stub-bus path a failed delivery is logged
once and lost — the `'*'` listener wraps dispatch in `.catch(warn)` and the
outbox row is marked published regardless, so the sweeper never retries it.

## 3. Analytics projector (11 event names)

`PROJECTED_EVENT_NAMES` in `analytics/projector.service.ts`:

`identity.user.registered`, `identity.user.roles_updated`, `marketplace.listing.created`, `marketplace.listing.updated`, `marketplace.order.placed`, `marketplace.order.status_changed`, `marketplace.escrow.held`, `marketplace.escrow.status_changed`, `finance.ledger.entry_posted`, `livestock.animal.registered`, `livestock.animal.status_changed`

The projector is **not** a listener: it is a batch reader invoked via
`POST /api/v1/analytics/project`. The API starts no timer; without an
external scheduler (GAP-M03) these events are never projected either.

## 4. Lender attribution (2 event names)

`LENDER_ATTRIBUTION_EVENTS` in `analytics/lender-scorecard.service.ts`:

`partner.disbursement.recorded`, `partner.enrolment.recorded`

Both names are also partner-webhook events; attribution is an additional,
scheduler-dependent reader of the same outbox rows.

## 5. Fraud sentinel (5 event names)

`SENTINEL_EVENT_NAMES` in `fraud/sentinel.service.ts`:

`agentbank.transaction.posted`, `agentbank.agent.registered`, `agentbank.agent.limits_updated`, `inputvouchers.voucher.redeemed`, `finance.ledger.entry_posted`

Detective control only (read-only on ledger/outbox), gated behind the
`float-sentinel` feature flag (default OFF) and an external scheduler call.

## 6. Explicit audit-only (345 event names)

No consumer of any class reacts to these events on any path. The outbox row
is the audit trail; the business reaction is an accepted, documented
deferral (GAP-H05). The checked-in source of truth is `AUDIT_ONLY_EVENTS`
in `apps/api/src/core/events/event-consumer-coverage.ts`.

<details><summary><code>advisory.*</code> — 11 events</summary>

- `advisory.content.published`
- `advisory.price_dispatch.failed`
- `advisory.price_dispatch.sent`
- `advisory.price_dispatch.suppressed`
- `advisory.price_dispatch.suppressed_stale`
- `advisory.price_sub.created`
- `advisory.pulse.delivered`
- `advisory.pulse.failed`
- `advisory.pulse.generated`
- `advisory.pulse.suppressed`
- `advisory.subscription.created`

</details>

<details><summary><code>agent_banking.*</code> — 7 events</summary>

- `agent_banking.forecast.computed`
- `agent_banking.merchant_payment.completed`
- `agent_banking.merchant_payment.failed`
- `agent_banking.merchant_payment.quoted`
- `agent_banking.qr.issued`
- `agent_banking.rebalance_alert.raised`
- `agent_banking.rebalance_alert.resolved`

</details>

<details><summary><code>agentbank.*</code> — 16 events</summary>

- `agentbank.agent.deregistered`
- `agentbank.agent.device_bound`
- `agentbank.agent.device_reenrolled`
- `agentbank.agent.device_revoked`
- `agentbank.agent.status_changed`
- `agentbank.reversal.initiated`
- `agentbank.reversal.posted`
- `agentbank.reversal.rejected`
- `agentbank.topup.decided`
- `agentbank.topup.requested`
- `agentbank.topup.settled`
- `agentbank.voucher.issued`
- `agentbank.voucher.redeemed`
- `agentbank.voucher.refund_due`
- `agentbank.voucher.refunded`
- `agentbank.voucher.voided`

</details>

<details><summary><code>analytics.*</code> — 2 events</summary>

- `analytics.lender_scorecard.generated`
- `analytics.scorecard_version.published`

</details>

<details><summary><code>chapter.*</code> — 5 events</summary>

- `chapter.announcement.published`
- `chapter.chapter.created`
- `chapter.event.attendance_recorded`
- `chapter.event.created`
- `chapter.event.rsvp_recorded`

</details>

<details><summary><code>community.*</code> — 5 events</summary>

- `community.mentorship.requested`
- `community.mentorship.updated`
- `community.topic.created`
- `community.topic.flagged`
- `community.topic.replied`

</details>

<details><summary><code>compliance.*</code> — 6 events</summary>

- `compliance.consent.recorded`
- `compliance.consent.revoked`
- `compliance.dsr.erasure_completed`
- `compliance.dsr.erasure_requested`
- `compliance.dsr.export_completed`
- `compliance.dsr.rejected`

</details>

<details><summary><code>credit.*</code> — 29 events</summary>

- `credit.collateral.pledged`
- `credit.collateral.released`
- `credit.coop_score.computed`
- `credit.group.created`
- `credit.group.dissolved`
- `credit.group.exit_settled`
- `credit.group.guarantor_substituted`
- `credit.group.member_joined`
- `credit.group.member_left`
- `credit.guarantor.accepted`
- `credit.guarantor.declined`
- `credit.guarantor.demand_issued`
- `credit.guarantor.invited`
- `credit.guarantor.liable`
- `credit.guarantor.settled`
- `credit.loan.consolidated`
- `credit.loan.created`
- `credit.loan.flagged_for_review`
- `credit.loan.restructure_claimed`
- `credit.loan.restructured`
- `credit.loan.scored`
- `credit.loan.status_changed`
- `credit.product.created`
- `credit.product.updated`
- `credit.repayment.paid`
- `credit.savings.deposited`
- `credit.savings.withdrawn`
- `credit.seasonal_schedule.accepted`
- `credit.seasonal_schedule.created`

</details>

<details><summary><code>credit_passport.*</code> — 4 events</summary>

- `credit_passport.credential.issued`
- `credit_passport.credential.revoked`
- `credit_passport.credential.versioned`
- `credit_passport.disclosure.shared`

</details>

<details><summary><code>evidence.*</code> — 3 events</summary>

- `evidence.case.sealed`
- `evidence.item.added`
- `evidence.item.expunged`

</details>

<details><summary><code>farms.*</code> — 3 events</summary>

- `farms.expense.recorded`
- `farms.harvest.recorded`
- `farms.planting.created`

</details>

<details><summary><code>field_agents.*</code> — 5 events</summary>

- `field_agents.assignment.cancelled`
- `field_agents.assignment.completed`
- `field_agents.assignment.created`
- `field_agents.assignment.progress`
- `field_agents.profile.captured`

</details>

<details><summary><code>finance.*</code> — 13 events</summary>

- `finance.credit_profile.updated`
- `finance.credit_score.updated`
- `finance.document.reviewed`
- `finance.document.uploaded`
- `finance.lender.registered`
- `finance.lender_credit_readiness.pushed`
- `finance.lender_event.received`
- `finance.loan.closed`
- `finance.loan.created`
- `finance.loan.disbursed`
- `finance.loan.payment_declared`
- `finance.loan.repayment_received`
- `finance.loan.status_changed`

</details>

<details><summary><code>fraud.*</code> — 4 events</summary>

- `fraud.alert.confirmed`
- `fraud.alert.dismissed`
- `fraud.alert.raised`
- `fraud.case.resolved`

</details>

<details><summary><code>geo.*</code> — 1 events</summary>

- `geo.boundary.created`

</details>

<details><summary><code>geo_intel.*</code> — 2 events</summary>

- `geo_intel.chapter_map.computed`
- `geo_intel.flood_risk.assessed`

</details>

<details><summary><code>identity.*</code> — 5 events</summary>

- `identity.accounts.merged`
- `identity.otp.requested`
- `identity.pin_profile.registered`
- `identity.user.created`
- `identity.user.status_changed`

</details>

<details><summary><code>inputvouchers.*</code> — 10 events</summary>

- `inputvouchers.beneficiary.verified`
- `inputvouchers.programme.activated`
- `inputvouchers.programme.closed`
- `inputvouchers.programme.created`
- `inputvouchers.programme.funded`
- `inputvouchers.voucher.allocated`
- `inputvouchers.voucher.distributed`
- `inputvouchers.voucher.expired`
- `inputvouchers.voucher.refunded`
- `inputvouchers.voucher.voided`

</details>

<details><summary><code>insurance.*</code> — 14 events</summary>

- `insurance.payout.appealed`
- `insurance.payout.disputed`
- `insurance.payout.proposed`
- `insurance.payout.rejected`
- `insurance.payout.reproposed`
- `insurance.payout.settled`
- `insurance.payout.settlement_failed`
- `insurance.policy.issued`
- `insurance.regen_discount.applied`
- `insurance.regen_discount.rejected_stale_evidence`
- `insurance.voucher_cover.bound`
- `insurance.voucher_cover.payout_posted`
- `insurance.voucher_cover.quoted`
- `insurance.voucher_cover.triggered`

</details>

<details><summary><code>integrations.*</code> — 4 events</summary>

- `integrations.beneficiary_import.confirmed`
- `integrations.beneficiary_import.staged`
- `integrations.external_account.linked`
- `integrations.external_account.unlinked`

</details>

<details><summary><code>knowledge.*</code> — 7 events</summary>

- `knowledge.episode.published`
- `knowledge.episode.transcribed`
- `knowledge.resource.published`
- `knowledge.webinar.recording_attached`
- `knowledge.webinar.registration_recorded`
- `knowledge.webinar.scheduled`
- `knowledge.webinar.status_changed`

</details>

<details><summary><code>learning.*</code> — 1 events</summary>

- `learning.course.created`

</details>

<details><summary><code>livestock.*</code> — 14 events</summary>

- `livestock.animal.transferred`
- `livestock.disease_flag.confirmed`
- `livestock.disease_flag.reported`
- `livestock.disease_flag.retracted`
- `livestock.enrolment.completed`
- `livestock.health.recorded`
- `livestock.health.reversed`
- `livestock.lot.created`
- `livestock.movement.arrived`
- `livestock.movement.started`
- `livestock.pastoralist_profile.updated`
- `livestock.permit.issued`
- `livestock.permit.revoked`
- `livestock.recall.resolved`

</details>

<details><summary><code>livestock_passport.*</code> — 10 events</summary>

- `livestock_passport.passport.issued`
- `livestock_passport.passport.reinstated`
- `livestock_passport.passport.revoked`
- `livestock_passport.passport.suspended`
- `livestock_passport.passport.transfer_cancelled`
- `livestock_passport.passport.transfer_confirmed`
- `livestock_passport.passport.transfer_initiated`
- `livestock_passport.transfer.cancelled`
- `livestock_passport.transfer.confirmed`
- `livestock_passport.transfer.initiated`

</details>

<details><summary><code>livestock_trade.*</code> — 17 events</summary>

- `livestock_trade.aggregation.lot_assigned`
- `livestock_trade.claim.auto_drafted`
- `livestock_trade.claim.settled`
- `livestock_trade.claim.submitted`
- `livestock_trade.cold_chain.reading_ingested`
- `livestock_trade.contract.created`
- `livestock_trade.contract.transitioned`
- `livestock_trade.disbursement.released`
- `livestock_trade.export_document.generated`
- `livestock_trade.lien.defaulted`
- `livestock_trade.lien.discharged`
- `livestock_trade.lien.margin_called`
- `livestock_trade.lien.registered`
- `livestock_trade.listing.created`
- `livestock_trade.listing.transitioned`
- `livestock_trade.policy.bound`
- `livestock_trade.policy.quoted`

</details>

<details><summary><code>marketplace.*</code> — 46 events</summary>

- `marketplace.buyer_group.created`
- `marketplace.buyer_group.member_added`
- `marketplace.buyer_group.member_removed`
- `marketplace.buyer_group.updated`
- `marketplace.delivery.attested`
- `marketplace.delivery.geo_rejected`
- `marketplace.delivery.geo_verified`
- `marketplace.draft_order.confirmed`
- `marketplace.draft_order.created`
- `marketplace.draft_order.discarded`
- `marketplace.escrow.auto_released`
- `marketplace.invoice.issued`
- `marketplace.invoice.status_changed`
- `marketplace.offtake.accepted`
- `marketplace.offtake.amendment_accepted`
- `marketplace.offtake.amendment_proposed`
- `marketplace.offtake.amendment_rejected`
- `marketplace.offtake.created`
- `marketplace.offtake.default_remedy`
- `marketplace.offtake.defaulted`
- `marketplace.offtake.delivery_recorded`
- `marketplace.offtake.fulfilled`
- `marketplace.offtake.milestone_met`
- `marketplace.offtake.milestone_missed`
- `marketplace.offtake.renegotiation_required`
- `marketplace.ofn_order.received`
- `marketplace.ofn_syndication.completed`
- `marketplace.order.edited`
- `marketplace.order.restocked`
- `marketplace.pool.contribution_pledged`
- `marketplace.pool.created`
- `marketplace.pool.locked`
- `marketplace.pool.settled`
- `marketplace.price_list.created`
- `marketplace.price_list.entry_set`
- `marketplace.price_list.updated`
- `marketplace.product_review.submitted`
- `marketplace.promotion.created`
- `marketplace.promotion.updated`
- `marketplace.return.requested`
- `marketplace.return.status_changed`
- `marketplace.review.submitted`
- `marketplace.shipment.scheduled`
- `marketplace.shipment.status_changed`
- `marketplace.variant.created`
- `marketplace.variant.updated`

</details>

<details><summary><code>mechanization.*</code> — 11 events</summary>

- `mechanization.booking.cancelled`
- `mechanization.booking.confirmed`
- `mechanization.booking.disputed`
- `mechanization.booking.quoted`
- `mechanization.booking.rated`
- `mechanization.booking.requested`
- `mechanization.booking.status_changed`
- `mechanization.hold.released`
- `mechanization.listing.created`
- `mechanization.listing.status_changed`
- `mechanization.operator.verification_changed`

</details>

<details><summary><code>notification.*</code> — 2 events</summary>

- `notification.delivery.requested`
- `notification.preferences.updated`

</details>

<details><summary><code>opportunity.*</code> — 3 events</summary>

- `opportunity.application.status_changed`
- `opportunity.application.submitted`
- `opportunity.posting.created`

</details>

<details><summary><code>partner.*</code> — 2 events</summary>

- `partner.farm_data.received`
- `partner.report.generated`

</details>

<details><summary><code>pathways.*</code> — 5 events</summary>

- `pathways.club.created`
- `pathways.club.member_joined`
- `pathways.enrolment.started`
- `pathways.stage.completed`
- `pathways.template.created`

</details>

<details><summary><code>privacy.*</code> — 5 events</summary>

- `privacy.consent.recorded`
- `privacy.consent.revoked`
- `privacy.deletion.requested`
- `privacy.export.requested`
- `privacy.user.deleted`

</details>

<details><summary><code>profile.*</code> — 1 events</summary>

- `profile.completion.updated`

</details>

<details><summary><code>programmes.*</code> — 10 events</summary>

- `programmes.cohort.created`
- `programmes.cohort.status_changed`
- `programmes.criterion.created`
- `programmes.enrolment.recorded`
- `programmes.enrolment.withdrawn`
- `programmes.judge.assigned`
- `programmes.milestone.created`
- `programmes.score.submitted`
- `programmes.thread.created`
- `programmes.thread.replied`

</details>

<details><summary><code>services.*</code> — 6 events</summary>

- `services.booking.requested`
- `services.booking.status_changed`
- `services.offering.created`
- `services.review.submitted`
- `services.supplier.registered`
- `services.supplier.verification_changed`

</details>

<details><summary><code>succession.*</code> — 2 events</summary>

- `succession.estate.marked_deceased`
- `succession.estate.transferred`

</details>

<details><summary><code>sync.*</code> — 1 events</summary>

- `sync.mutation.applied`

</details>

<details><summary><code>traceability.*</code> — 9 events</summary>

- `traceability.custody.recorded`
- `traceability.dds.created`
- `traceability.dds.exported`
- `traceability.dds.validated`
- `traceability.lot.aggregated`
- `traceability.lot.created`
- `traceability.lot.split`
- `traceability.plot.linked`
- `traceability.shipment.created`

</details>

<details><summary><code>voice.*</code> — 13 events</summary>

- `voice.agent_case.responded`
- `voice.escalation.answered`
- `voice.escalation.claimed`
- `voice.escalation.quality_scored`
- `voice.escalation.sla_breached`
- `voice.intent.answered`
- `voice.intent.escalated`
- `voice.intent.failed`
- `voice.intent.started`
- `voice.session.escalated`
- `voice.session.resolved`
- `voice.session.started`
- `voice.transcripts.purged`

</details>

<details><summary><code>vslacarbon.*</code> — 14 events</summary>

- `vslacarbon.cashcount.attested`
- `vslacarbon.contribution.recorded`
- `vslacarbon.cycle.closed`
- `vslacarbon.cycle.opened`
- `vslacarbon.estimate.recorded`
- `vslacarbon.evidence.submitted`
- `vslacarbon.group.created`
- `vslacarbon.group.dissolved`
- `vslacarbon.loan.issued`
- `vslacarbon.loan.repayment_recorded`
- `vslacarbon.loan.written_off`
- `vslacarbon.member.added`
- `vslacarbon.member.exited`
- `vslacarbon.plot.registered`

</details>

<details><summary><code>warehouse.*</code> — 17 events</summary>

- `warehouse.bond.drawn`
- `warehouse.bond.posted`
- `warehouse.certification.checked`
- `warehouse.deposit.graded`
- `warehouse.deposit.received`
- `warehouse.ltv.observed`
- `warehouse.margin_call.cured`
- `warehouse.margin_call.raised`
- `warehouse.position.opened`
- `warehouse.receipt.issued`
- `warehouse.receipt.pledged`
- `warehouse.receipt.redeemed`
- `warehouse.receipt.released`
- `warehouse.receipt.split`
- `warehouse.receipt.status_changed`
- `warehouse.receipt.transferred`
- `warehouse.warehouse.registered`

</details>

## Honest caveats (read before relying on any of this)

1. **The default stub bus has no external consumer.** The Fluvio/Kafka
   drivers are producer-only — the `consume()` helper in
   `core/events/fluvio-event-bus.driver.ts` has no caller. Selecting
   `EVENT_BUS_DRIVER=kafka` publishes events to a broker, but nothing in
   this repository consumes them back.
2. **Unconsumed events are durable but inert.** Audit-only events persist
   in `events.outbox` and are marked published after the (no-op) fan-out.
   Durability is not delivery: any business reaction to those
   345 event names is deferred until a consumer is
   implemented.
3. **Published audit rows are subject to the retention horizon.** The
   default compliance policy (`infra/postgres/118_compliance_retention_webhook_outbox.sql`)
   hard-prunes `events.outbox` rows 90 days after `published_at`
   (`anonymize_not_delete = false`; an operator can flip it to payload
   tombstoning). Audit-only history therefore has a bounded lifetime, and
   **dead-lettered rows are never matched by retention at all** — they
   accumulate with full payloads indefinitely (GAP-M20).
4. **The outbox sweeper requires an external scheduler.** The API starts
   no timers (GAP-M03): `POST /admin/outbox/sweep` must be invoked
   externally, the five backstop CronJobs in `infra/k8s/cronjobs/` are not
   part of any kustomization, and `SWEEPERS_ENABLED` defaults off. Without
   that wiring, retries never fire and the projector/sentinel never run.
5. **Listener dedup is incomplete (GAP-M09).** Only the recall-notification
   listener (plus whatsapp / partner-dispatch paths) guards with
   `EventDedupService`. A sweeper re-drive re-executes *every* listener;
   correctness for the rest rests on unverified per-handler write
   idempotency.
6. **Partner webhook delivery is not at-least-once** on the default path
   (GAP-H06 — see §2).
7. **Outbox reads are bounded at 1000 rows per pass** (GAP-L03): deep
   backlogs drain over many sweeper/projector invocations.
8. **Field-agents event taxonomy fixed.** The field-agents events were
   previously emitted as `field-agents.assignment.*` and
   `field-agents.profile.captured` with a hyphen and were **rejected by the
   taxonomy validator** in `DomainEventsService.build()`, so those publish
   calls threw at runtime. They are now emitted as
   `field_agents.assignment.created`, `field_agents.assignment.progress`,
   `field_agents.assignment.completed`,
   `field_agents.assignment.cancelled` and
   `field_agents.profile.captured`, and are classified **audit-only** in
   this registry (no listener, webhook, projector, attribution or sentinel
   consumes them; `assignment.progress`/`assignment.completed` are emitted
   through a ternary and are therefore also listed in
   `DYNAMIC_EMISSION_NAMES`). Note the mobile /
   web offline-queue `kind` string `field-agents.assignment.progress` is a
   client-side queue identifier, not a DomainEventsService name, and was
   deliberately left unchanged.

## Maintaining the registry (the guardrail)

- Registry: `apps/api/src/core/events/event-consumer-coverage.ts`.
- Enforcement: `apps/api/src/core/events/event-consumer-coverage.spec.ts`
  scans production sources for `.publish(...)`, `.build(...)`, `*_EVENTS`
  name maps, and `.on(...)` listener registrations, and fails when:
  - an emitted event name has no classification (add it to a consumer set
    or to `AUDIT_ONLY_EVENTS` as an explicit deferral);
  - a checked-in name is no longer emitted anywhere (stale entry);
  - a listener registration is missing from `IN_PROCESS_LISTENER_EVENTS`
    (or vice versa);
  - an event is listed as both consumed and audit-only.
- The webhook/projector/attribution/sentinel name sets are **imported from
  the consuming modules** (`DOMAIN_EVENT_MAP`, `PROJECTED_EVENT_NAMES`,
  `LENDER_ATTRIBUTION_EVENTS`, `SENTINEL_EVENT_NAMES`), so those paths
  cannot drift from the registry.
- Events emitted through computed names (template literals / ternaries)
  are listed in `DYNAMIC_EMISSION_NAMES` and must still be classified.
