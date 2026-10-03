/**
 * Event consumer-coverage registry (GAP-H05 guardrail).
 *
 * Every domain event emitted through DomainEventsService lands durably in
 * events.outbox, but durability is NOT consumption. This registry records,
 * per event name, which consumer (if any) actually reacts to the event on
 * the default deployment path:
 *
 *   - in-process listener  — synchronous EventEmitter fan-out (.on(name))
 *   - partner webhook      — mapped to the public webhook vocabulary
 *   - analytics projector  — scheduler-invoked outbox -> star-mart reader
 *   - lender attribution   — scheduler-invoked borrower->lender attribution
 *   - fraud sentinel       — scheduler-invoked detective anomaly engine
 *   - audit-only           — NO consumer; the outbox row is the audit trail
 *                            and the business reaction is DEFERRED
 *
 * Consumer-name sets for the webhook/projector/attribution/sentinel paths
 * are imported from the single sources of truth in the consuming modules so
 * this file cannot drift from the code. The in-process listener set and the
 * audit-only set are checked in here; the colocated spec
 * (event-consumer-coverage.spec.ts) fails when a newly introduced event
 * name is not classified in either direction.
 *
 * See docs/event-consumer-coverage.md for the full narrative and caveats.
 */
import { LENDER_ATTRIBUTION_EVENTS } from '../../modules/analytics/lender-scorecard.service.js';
import { PROJECTED_EVENT_NAMES } from '../../modules/analytics/projector.service.js';
import { SENTINEL_EVENT_NAMES } from '../../modules/fraud/sentinel.service.js';
import { DOMAIN_EVENT_MAP } from '../../modules/partner-api/webhook-dispatch.service.js';

export type EventConsumerClass =
  | 'in-process-listener'
  | 'partner-webhook'
  | 'analytics-projector'
  | 'lender-attribution'
  | 'fraud-sentinel'
  | 'audit-only';

/**
 * Events with a synchronous in-process listener registered via
 * DomainEventsService.on(name, handler). Checked-in list: listener
 * registrations use both string literals and shared constants
 * (@agric-platform/shared LIVESTOCK_*_EVENT), so the spec resolves both.
 */
export const IN_PROCESS_LISTENER_EVENTS = [
  'credit.collateral.claimed',
  'farms.planting.status_changed',
  'farms.plot.created',
  'farms.plot.removed',
  'farms.plot.updated',
  'insurance.payout.paid',
  'insurance.trigger.raised',
  'integration.webhook.received',
  'livestock.animal.status_changed',
  'livestock.recall.initiated',
  'marketplace.escrow.status_changed',
  'voice.agent_case.created',
  'warehouse.receipt.loss_reported'
] as const;

/** Domain event names mapped to partner webhook deliveries. */
export const PARTNER_WEBHOOK_CONSUMED_EVENTS: readonly string[] = Object.keys(DOMAIN_EVENT_MAP);

export { LENDER_ATTRIBUTION_EVENTS, PROJECTED_EVENT_NAMES, SENTINEL_EVENT_NAMES };

/**
 * Events with NO consumer on any path. The outbox row is the audit trail;
 * the business reaction is explicitly deferred (GAP-H05). Adding a new
 * event name to the codebase without classifying it here (or into a
 * consumer set) fails event-consumer-coverage.spec.ts.
 */
export const AUDIT_ONLY_EVENTS = [
  'advisory.content.published',
  'advisory.price_dispatch.failed',
  'advisory.price_dispatch.sent',
  'advisory.price_dispatch.suppressed',
  'advisory.price_dispatch.suppressed_stale',
  'advisory.price_sub.created',
  'advisory.pulse.delivered',
  'advisory.pulse.failed',
  'advisory.pulse.generated',
  'advisory.pulse.suppressed',
  'advisory.subscription.created',
  'agent_banking.forecast.computed',
  'agent_banking.merchant_payment.completed',
  'agent_banking.merchant_payment.failed',
  'agent_banking.merchant_payment.quoted',
  'agent_banking.qr.issued',
  'agent_banking.rebalance_alert.raised',
  'agent_banking.rebalance_alert.resolved',
  'agentbank.agent.deregistered',
  'agentbank.agent.device_bound',
  'agentbank.agent.device_reenrolled',
  'agentbank.agent.device_revoked',
  'agentbank.agent.status_changed',
  'agentbank.reversal.initiated',
  'agentbank.reversal.posted',
  'agentbank.reversal.rejected',
  'agentbank.topup.decided',
  'agentbank.topup.requested',
  'agentbank.topup.settled',
  'agentbank.voucher.issued',
  'agentbank.voucher.redeemed',
  'agentbank.voucher.refund_due',
  'agentbank.voucher.refunded',
  'agentbank.voucher.voided',
  'analytics.lender_scorecard.generated',
  'analytics.scorecard_version.published',
  'chapter.announcement.published',
  'chapter.chapter.created',
  'chapter.event.attendance_recorded',
  'chapter.event.created',
  'chapter.event.rsvp_recorded',
  'community.mentorship.requested',
  'community.mentorship.updated',
  'community.topic.created',
  'community.topic.flagged',
  'community.topic.replied',
  'compliance.consent.recorded',
  'compliance.consent.revoked',
  'compliance.dsr.erasure_completed',
  'compliance.dsr.erasure_requested',
  'compliance.dsr.export_completed',
  'compliance.dsr.rejected',
  'credit.collateral.pledged',
  'credit.collateral.released',
  'credit.coop_score.computed',
  'credit.group.created',
  'credit.group.dissolved',
  'credit.group.exit_settled',
  'credit.group.guarantor_substituted',
  'credit.group.member_joined',
  'credit.group.member_left',
  'credit.guarantor.accepted',
  'credit.guarantor.declined',
  'credit.guarantor.demand_issued',
  'credit.guarantor.invited',
  'credit.guarantor.liable',
  'credit.guarantor.settled',
  'credit.loan.consolidated',
  'credit.loan.created',
  'credit.loan.flagged_for_review',
  'credit.loan.restructure_claimed',
  'credit.loan.restructured',
  'credit.loan.scored',
  'credit.loan.status_changed',
  'credit.product.created',
  'credit.product.updated',
  'credit.repayment.paid',
  'credit.savings.deposited',
  'credit.savings.withdrawn',
  'credit.seasonal_schedule.accepted',
  'credit.seasonal_schedule.created',
  'credit_passport.credential.issued',
  'credit_passport.credential.revoked',
  'credit_passport.credential.versioned',
  'credit_passport.disclosure.shared',
  'evidence.case.sealed',
  'evidence.item.added',
  'evidence.item.expunged',
  'farms.expense.recorded',
  'farms.harvest.recorded',
  'farms.planting.created',
  'field_agents.assignment.cancelled',
  'field_agents.assignment.completed',
  'field_agents.assignment.created',
  'field_agents.assignment.progress',
  'field_agents.profile.captured',
  'finance.credit_profile.updated',
  'finance.credit_score.updated',
  'finance.document.reviewed',
  'finance.document.uploaded',
  'finance.lender.registered',
  'finance.lender_credit_readiness.pushed',
  'finance.lender_event.received',
  'finance.loan.closed',
  'finance.loan.created',
  'finance.loan.disbursed',
  'finance.loan.payment_declared',
  'finance.loan.repayment_received',
  'finance.loan.status_changed',
  'fraud.alert.confirmed',
  'fraud.alert.dismissed',
  'fraud.alert.raised',
  'fraud.case.resolved',
  'geo.boundary.created',
  'geo_intel.chapter_map.computed',
  'geo_intel.flood_risk.assessed',
  'identity.accounts.merged',
  'identity.otp.requested',
  'identity.pin_profile.registered',
  'identity.user.created',
  'identity.user.status_changed',
  'inputvouchers.beneficiary.verified',
  'inputvouchers.programme.activated',
  'inputvouchers.programme.closed',
  'inputvouchers.programme.created',
  'inputvouchers.programme.funded',
  'inputvouchers.voucher.allocated',
  'inputvouchers.voucher.distributed',
  'inputvouchers.voucher.expired',
  'inputvouchers.voucher.refunded',
  'inputvouchers.voucher.voided',
  'insurance.payout.appealed',
  'insurance.payout.disputed',
  'insurance.payout.proposed',
  'insurance.payout.rejected',
  'insurance.payout.reproposed',
  'insurance.payout.settled',
  'insurance.payout.settlement_failed',
  'insurance.policy.issued',
  'insurance.regen_discount.applied',
  'insurance.regen_discount.rejected_stale_evidence',
  'insurance.voucher_cover.bound',
  'insurance.voucher_cover.payout_posted',
  'insurance.voucher_cover.quoted',
  'insurance.voucher_cover.triggered',
  'integrations.beneficiary_import.confirmed',
  'integrations.beneficiary_import.staged',
  'integrations.external_account.linked',
  'integrations.external_account.unlinked',
  'knowledge.episode.published',
  'knowledge.episode.transcribed',
  'knowledge.resource.published',
  'knowledge.webinar.recording_attached',
  'knowledge.webinar.registration_recorded',
  'knowledge.webinar.scheduled',
  'knowledge.webinar.status_changed',
  'learning.course.created',
  'livestock.animal.transferred',
  'livestock.disease_flag.confirmed',
  'livestock.disease_flag.reported',
  'livestock.disease_flag.retracted',
  'livestock.enrolment.completed',
  'livestock.health.recorded',
  'livestock.health.reversed',
  'livestock.lot.created',
  'livestock.movement.arrived',
  'livestock.movement.started',
  'livestock.pastoralist_profile.updated',
  'livestock.permit.issued',
  'livestock.permit.revoked',
  'livestock.recall.resolved',
  'livestock_passport.passport.issued',
  'livestock_passport.passport.reinstated',
  'livestock_passport.passport.revoked',
  'livestock_passport.passport.suspended',
  'livestock_passport.passport.transfer_cancelled',
  'livestock_passport.passport.transfer_confirmed',
  'livestock_passport.passport.transfer_initiated',
  'livestock_passport.transfer.cancelled',
  'livestock_passport.transfer.confirmed',
  'livestock_passport.transfer.initiated',
  'livestock_trade.aggregation.lot_assigned',
  'livestock_trade.claim.auto_drafted',
  'livestock_trade.claim.settled',
  'livestock_trade.claim.submitted',
  'livestock_trade.cold_chain.reading_ingested',
  'livestock_trade.contract.created',
  'livestock_trade.contract.transitioned',
  'livestock_trade.disbursement.released',
  'livestock_trade.export_document.generated',
  'livestock_trade.lien.defaulted',
  'livestock_trade.lien.discharged',
  'livestock_trade.lien.margin_called',
  'livestock_trade.lien.registered',
  'livestock_trade.listing.created',
  'livestock_trade.listing.transitioned',
  'livestock_trade.policy.bound',
  'livestock_trade.policy.quoted',
  'marketplace.buyer_group.created',
  'marketplace.buyer_group.member_added',
  'marketplace.buyer_group.member_removed',
  'marketplace.buyer_group.updated',
  'marketplace.delivery.attested',
  'marketplace.delivery.geo_rejected',
  'marketplace.delivery.geo_verified',
  'marketplace.draft_order.confirmed',
  'marketplace.draft_order.created',
  'marketplace.draft_order.discarded',
  'marketplace.escrow.auto_released',
  'marketplace.invoice.issued',
  'marketplace.invoice.status_changed',
  'marketplace.offtake.accepted',
  'marketplace.offtake.amendment_accepted',
  'marketplace.offtake.amendment_proposed',
  'marketplace.offtake.amendment_rejected',
  'marketplace.offtake.created',
  'marketplace.offtake.default_remedy',
  'marketplace.offtake.defaulted',
  'marketplace.offtake.delivery_recorded',
  'marketplace.offtake.fulfilled',
  'marketplace.offtake.milestone_met',
  'marketplace.offtake.milestone_missed',
  'marketplace.offtake.renegotiation_required',
  'marketplace.ofn_order.received',
  'marketplace.ofn_syndication.completed',
  'marketplace.order.edited',
  'marketplace.order.restocked',
  'marketplace.pool.contribution_pledged',
  'marketplace.pool.created',
  'marketplace.pool.locked',
  'marketplace.pool.settled',
  'marketplace.price_list.created',
  'marketplace.price_list.entry_set',
  'marketplace.price_list.updated',
  'marketplace.product_review.submitted',
  'marketplace.promotion.created',
  'marketplace.promotion.updated',
  'marketplace.return.requested',
  'marketplace.return.status_changed',
  'marketplace.review.submitted',
  'marketplace.shipment.scheduled',
  'marketplace.shipment.status_changed',
  'marketplace.variant.created',
  'marketplace.variant.updated',
  'mechanization.booking.cancelled',
  'mechanization.booking.confirmed',
  'mechanization.booking.disputed',
  'mechanization.booking.quoted',
  'mechanization.booking.rated',
  'mechanization.booking.requested',
  'mechanization.booking.status_changed',
  'mechanization.hold.released',
  'mechanization.listing.created',
  'mechanization.listing.status_changed',
  'mechanization.operator.verification_changed',
  'notification.delivery.requested',
  'notification.preferences.updated',
  'opportunity.application.status_changed',
  'opportunity.application.submitted',
  'opportunity.posting.created',
  'partner.farm_data.received',
  'partner.report.generated',
  'pathways.club.created',
  'pathways.club.member_joined',
  'pathways.enrolment.started',
  'pathways.stage.completed',
  'pathways.template.created',
  'privacy.consent.recorded',
  'privacy.consent.revoked',
  'privacy.deletion.requested',
  'privacy.export.requested',
  'privacy.user.deleted',
  'profile.completion.updated',
  'programmes.cohort.created',
  'programmes.cohort.status_changed',
  'programmes.criterion.created',
  'programmes.enrolment.recorded',
  'programmes.enrolment.withdrawn',
  'programmes.judge.assigned',
  'programmes.milestone.created',
  'programmes.score.submitted',
  'programmes.thread.created',
  'programmes.thread.replied',
  'services.booking.requested',
  'services.booking.status_changed',
  'services.offering.created',
  'services.review.submitted',
  'services.supplier.registered',
  'services.supplier.verification_changed',
  'succession.estate.marked_deceased',
  'succession.estate.transferred',
  'sync.mutation.applied',
  'traceability.custody.recorded',
  'traceability.dds.created',
  'traceability.dds.exported',
  'traceability.dds.validated',
  'traceability.lot.aggregated',
  'traceability.lot.created',
  'traceability.lot.split',
  'traceability.plot.linked',
  'traceability.shipment.created',
  'voice.agent_case.responded',
  'voice.escalation.answered',
  'voice.escalation.claimed',
  'voice.escalation.quality_scored',
  'voice.escalation.sla_breached',
  'voice.intent.answered',
  'voice.intent.escalated',
  'voice.intent.failed',
  'voice.intent.started',
  'voice.session.escalated',
  'voice.session.resolved',
  'voice.session.started',
  'voice.transcripts.purged',
  'vslacarbon.cashcount.attested',
  'vslacarbon.contribution.recorded',
  'vslacarbon.cycle.closed',
  'vslacarbon.cycle.opened',
  'vslacarbon.estimate.recorded',
  'vslacarbon.evidence.submitted',
  'vslacarbon.group.created',
  'vslacarbon.group.dissolved',
  'vslacarbon.loan.issued',
  'vslacarbon.loan.repayment_recorded',
  'vslacarbon.loan.written_off',
  'vslacarbon.member.added',
  'vslacarbon.member.exited',
  'vslacarbon.plot.registered',
  'warehouse.bond.drawn',
  'warehouse.bond.posted',
  'warehouse.certification.checked',
  'warehouse.deposit.graded',
  'warehouse.deposit.received',
  'warehouse.ltv.observed',
  'warehouse.margin_call.cured',
  'warehouse.margin_call.raised',
  'warehouse.position.opened',
  'warehouse.receipt.issued',
  'warehouse.receipt.pledged',
  'warehouse.receipt.redeemed',
  'warehouse.receipt.released',
  'warehouse.receipt.split',
  'warehouse.receipt.status_changed',
  'warehouse.receipt.transferred',
  'warehouse.warehouse.registered'
] as const;

/**
 * Event names emitted through computed first arguments (template literals,
 * ternaries) that the spec's literal call-site scan cannot extract. Kept so
 * the bidirectional coverage check can account for them; each name must
 * still be classified above.
 */
export const DYNAMIC_EMISSION_NAMES = [
  'agentbank.agent.device_bound',
  'agentbank.agent.device_reenrolled',
  'credit.collateral.claimed',
  'credit.collateral.released',
  'credit.guarantor.accepted',
  'credit.guarantor.declined',
  'credit.savings.deposited',
  'credit_passport.credential.issued',
  'credit_passport.credential.versioned',
  'field_agents.assignment.completed',
  'field_agents.assignment.progress',
  'livestock_passport.passport.reinstated',
  'livestock_passport.passport.revoked',
  'livestock_passport.passport.suspended',
  'livestock_passport.passport.transfer_cancelled',
  'livestock_passport.passport.transfer_confirmed',
  'livestock_passport.passport.transfer_initiated',
  'marketplace.delivery.geo_rejected',
  'marketplace.delivery.geo_verified'
] as const;

const IN_PROCESS_SET = new Set<string>(IN_PROCESS_LISTENER_EVENTS);
const AUDIT_ONLY_SET = new Set<string>(AUDIT_ONLY_EVENTS);
const PROJECTED_SET = new Set<string>(PROJECTED_EVENT_NAMES);
const LENDER_SET = new Set<string>(LENDER_ATTRIBUTION_EVENTS);
const SENTINEL_SET = new Set<string>(SENTINEL_EVENT_NAMES);
const PARTNER_SET = new Set<string>(PARTNER_WEBHOOK_CONSUMED_EVENTS);

/**
 * Every consumer class that reacts to the given event name. 'audit-only'
 * means no consumer exists at all — it is never combined with another
 * class. An empty array means the event is UNCLASSIFIED (registry drift).
 */
export function consumerCoverageFor(name: string): EventConsumerClass[] {
  const classes: EventConsumerClass[] = [];
  if (IN_PROCESS_SET.has(name)) classes.push('in-process-listener');
  if (PARTNER_SET.has(name)) classes.push('partner-webhook');
  if (PROJECTED_SET.has(name)) classes.push('analytics-projector');
  if (LENDER_SET.has(name)) classes.push('lender-attribution');
  if (SENTINEL_SET.has(name)) classes.push('fraud-sentinel');
  if (classes.length === 0 && AUDIT_ONLY_SET.has(name)) classes.push('audit-only');
  return classes;
}
