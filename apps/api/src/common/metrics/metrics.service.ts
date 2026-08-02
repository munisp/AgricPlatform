import { Injectable } from '@nestjs/common';
import { Counter, Histogram, register } from 'prom-client';

type HttpLabel = 'method' | 'route' | 'status';

export type OtpVerificationResult = 'success' | 'invalid' | 'locked';
export type PaymentMetricEvent = 'initiated' | 'confirmed' | 'webhook_received' | 'webhook_duplicate';

function getOrCreateCounter<T extends string>(name: string, help: string, labelNames: T[] = []): Counter<T> {
  return (
    (register.getSingleMetric(name) as Counter<T> | undefined) ??
    new Counter({ name, help, labelNames })
  );
}

function getOrCreateHistogram<T extends string>(name: string, help: string, labelNames: T[] = []): Histogram<T> {
  return (
    (register.getSingleMetric(name) as Histogram<T> | undefined) ??
    new Histogram({ name, help, labelNames })
  );
}

/**
 * Application metrics facade (observability plan §A.3). All series are
 * registered on the prom-client default registry that the PrometheusModule
 * `/metrics` controller renders. `getOrCreate*` keeps the service safe when
 * several Nest application contexts boot in one process (e2e suites).
 *
 * Cardinality rules: `route` is the parameterized Nest/Express route path
 * (never originalUrl); `status` is the HTTP status class digit string.
 */
@Injectable()
export class MetricsService {
  private readonly httpRequestsTotal = getOrCreateCounter<HttpLabel>(
    'http_requests_total',
    'HTTP requests handled, by method/route/status',
    ['method', 'route', 'status']
  );

  private readonly httpRequestDuration = getOrCreateHistogram<HttpLabel>(
    'http_request_duration_seconds',
    'HTTP request latency in seconds, by method/route/status',
    ['method', 'route', 'status']
  );

  private readonly otpRequests = getOrCreateCounter(
    'agric_otp_requests_total',
    'OTP challenges requested, by delivery channel',
    ['channel']
  );

  private readonly otpVerifications = getOrCreateCounter(
    'agric_otp_verifications_total',
    'OTP verification outcomes (success|invalid|locked)',
    ['result']
  );

  private readonly ordersCreated = getOrCreateCounter(
    'agric_orders_created_total',
    'Marketplace orders placed, by whether escrow is required',
    ['escrow']
  );

  private readonly payments = getOrCreateCounter(
    'agric_payments_total',
    'Payment lifecycle events (initiated|confirmed|webhook_received|webhook_duplicate)',
    ['event']
  );

  private readonly idempotentReplays = getOrCreateCounter(
    'agric_idempotent_replays_total',
    'Idempotency-key replays served from the cache'
  );

  private readonly errors5xx = getOrCreateCounter(
    'agric_errors_5xx_total',
    '5xx responses returned by the API exception filter'
  );

  recordHttpRequest(method: string, route: string, status: number, durationSeconds: number): void {
    const labels = { method, route, status: String(status) };
    this.httpRequestsTotal.inc(labels);
    this.httpRequestDuration.observe(labels, durationSeconds);
  }

  otpRequested(channel: string): void {
    this.otpRequests.inc({ channel });
  }

  otpVerification(result: OtpVerificationResult): void {
    this.otpVerifications.inc({ result });
  }

  orderCreated(escrowRequired: boolean): void {
    this.ordersCreated.inc({ escrow: String(escrowRequired) });
  }

  paymentEvent(event: PaymentMetricEvent): void {
    this.payments.inc({ event });
  }

  idempotentReplay(): void {
    this.idempotentReplays.inc();
  }

  error5xx(): void {
    this.errors5xx.inc();
  }
}
