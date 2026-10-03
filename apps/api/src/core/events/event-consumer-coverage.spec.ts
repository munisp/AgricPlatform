/**
 * GAP-H05 consumer-coverage guardrail.
 *
 * Fails when a newly introduced domain event name is not classified in the
 * consumer-coverage registry (event-consumer-coverage.ts): either into one
 * of the consumer sets (in-process listener, partner webhook, analytics
 * projector, lender attribution, fraud sentinel) or into AUDIT_ONLY_EVENTS
 * as an explicit "durable audit row, business reaction deferred" decision.
 *
 * The scan is deliberately narrow — NOT TypeScript parsing. Outbox rows can
 * only be created through DomainEventsService.publish()/build() (verified:
 * no repository appends to the outbox directly), so two targeted text
 * patterns suffice:
 *   1. first string-literal argument of .publish( / .build( call sites;
 *   2. values of `const *_EVENTS = { ... }` name maps (e.g. OFFTAKE_EVENTS).
 * Names emitted through computed expressions (template literals, ternaries)
 * cannot be extracted this way; they are accounted for via the registry's
 * DYNAMIC_EMISSION_NAMES list, whose entries must still be classified.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_ONLY_EVENTS,
  DYNAMIC_EMISSION_NAMES,
  IN_PROCESS_LISTENER_EVENTS,
  LENDER_ATTRIBUTION_EVENTS,
  PARTNER_WEBHOOK_CONSUMED_EVENTS,
  PROJECTED_EVENT_NAMES,
  SENTINEL_EVENT_NAMES,
  consumerCoverageFor
} from './event-consumer-coverage.js';

const SRC_ROOT = resolve(__dirname, '../..'); // apps/api/src
const EVENT_NAME = "[a-z_]+\\.[a-z_]+\\.[a-z_]+";
const EVENT_NAME_PATTERN = new RegExp(`^${EVENT_NAME}$`);
const PUBLISH_LITERAL = new RegExp(`\\.(?:publish|build)\\(\\s*'(${EVENT_NAME})'`, 'g');
const EVENTS_OBJECT = /const\s+[A-Z0-9_]*EVENTS[A-Z0-9_]*\s*=\s*\{([^}]*)\}/g;
const EVENTS_OBJECT_VALUE = new RegExp(`'(${EVENT_NAME})'`, 'g');
const LISTENER_LITERAL = new RegExp(`\\.on\\(\\s*'(${EVENT_NAME})'`, 'g');

/**
 * In-process listeners registered through shared constants instead of
 * string literals (e.g. LIVESTOCK_ANIMAL_STATUS_CHANGED_EVENT from
 * @agric-platform/shared in the livestock-trade insurance/liens services).
 * The literal scan cannot see those registrations, so they are listed here.
 */
const LISTENERS_VIA_SHARED_CONSTANT = ['livestock.animal.status_changed'];

function productionSources(dir: string = SRC_ROOT): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...productionSources(path));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      files.push(path);
    }
  }
  return files;
}

function emittedEventNames(): Set<string> {
  const names = new Set<string>();
  for (const file of productionSources()) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(PUBLISH_LITERAL)) {
      names.add(match[1]);
    }
    for (const objectMatch of text.matchAll(EVENTS_OBJECT)) {
      for (const valueMatch of objectMatch[1].matchAll(EVENTS_OBJECT_VALUE)) {
        names.add(valueMatch[1]);
      }
    }
  }
  return names;
}

function registeredListenerNames(): Set<string> {
  const names = new Set<string>();
  for (const file of productionSources()) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(LISTENER_LITERAL)) {
      names.add(match[1]);
    }
  }
  return names;
}

describe('event consumer-coverage registry (GAP-H05)', () => {
  const emitted = emittedEventNames();
  const listeners = registeredListenerNames();
  const dynamic = new Set<string>(DYNAMIC_EMISSION_NAMES);

  it('scans a non-empty production event surface', () => {
    expect(emitted.size).toBeGreaterThan(100);
    expect(listeners.size).toBeGreaterThan(0);
  });

  it('classifies every emitted event name (new events must be registered)', () => {
    const unclassified = [...emitted].filter((name) => consumerCoverageFor(name).length === 0);
    expect(
      unclassified,
      `unclassified domain events — add each to a consumer set or AUDIT_ONLY_EVENTS ` +
        `in apps/api/src/core/events/event-consumer-coverage.ts (see docs/event-consumer-coverage.md)`
    ).toEqual([]);
  });

  it('keeps the checked-in lists free of stale entries (classified but never emitted)', () => {
    const checkedIn = [...IN_PROCESS_LISTENER_EVENTS, ...AUDIT_ONLY_EVENTS];
    const stale = checkedIn.filter((name) => !dynamic.has(name) && !emitted.has(name));
    expect(
      stale,
      'classified event names with no emission site — remove them or add them to DYNAMIC_EMISSION_NAMES'
    ).toEqual([]);
  });

  it('mirrors every literal in-process listener registration in the registry', () => {
    const registered = new Set<string>(IN_PROCESS_LISTENER_EVENTS);
    const unregistered = [...listeners].filter((name) => !registered.has(name));
    expect(
      unregistered,
      'in-process listeners missing from IN_PROCESS_LISTENER_EVENTS'
    ).toEqual([]);
  });

  it('keeps IN_PROCESS_LISTENER_EVENTS accurate (each entry really has a listener)', () => {
    const viaConstant = new Set<string>(LISTENERS_VIA_SHARED_CONSTANT);
    const phantom = [...IN_PROCESS_LISTENER_EVENTS].filter(
      (name) => !listeners.has(name) && !viaConstant.has(name)
    );
    expect(
      phantom,
      'registry entries with no listener registration (or extend LISTENERS_VIA_SHARED_CONSTANT)'
    ).toEqual([]);
  });

  it('never double-classifies an audit-only event as consumed', () => {
    const consumed = new Set<string>([
      ...IN_PROCESS_LISTENER_EVENTS,
      ...PARTNER_WEBHOOK_CONSUMED_EVENTS,
      ...PROJECTED_EVENT_NAMES,
      ...LENDER_ATTRIBUTION_EVENTS,
      ...SENTINEL_EVENT_NAMES
    ]);
    const overlap = [...AUDIT_ONLY_EVENTS].filter((name) => consumed.has(name));
    expect(overlap, 'events listed as both consumed and audit-only').toEqual([]);
  });

  it('classifies every dynamically emitted name too', () => {
    const unclassified = [...DYNAMIC_EMISSION_NAMES].filter(
      (name) => consumerCoverageFor(name).length === 0
    );
    expect(unclassified, 'unclassified dynamic emission names').toEqual([]);
  });

  it('keeps every registry entry inside the {domain}.{entity}.{verb} taxonomy', () => {
    const all = [
      ...IN_PROCESS_LISTENER_EVENTS,
      ...AUDIT_ONLY_EVENTS,
      ...DYNAMIC_EMISSION_NAMES
    ];
    const invalid = all.filter((name) => !EVENT_NAME_PATTERN.test(name));
    expect(invalid, 'registry entries DomainEventsService.build() would reject').toEqual([]);
  });

  it('imports the consumer sets from their single sources of truth', () => {
    // Spot-check anchors: if these sets were copied instead of imported,
    // drift in the consuming modules would go unnoticed.
    expect(PARTNER_WEBHOOK_CONSUMED_EVENTS).toContain('learning.certificate.issued');
    expect(PROJECTED_EVENT_NAMES).toContain('marketplace.order.placed');
    expect(LENDER_ATTRIBUTION_EVENTS).toContain('partner.disbursement.recorded');
    expect(SENTINEL_EVENT_NAMES).toContain('agentbank.transaction.posted');
  });
});
