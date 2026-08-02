import { Controller, MessageEvent, Sse, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { User } from '@agric-platform/shared';
import { interval, map, startWith, switchMap, type Observable } from 'rxjs';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Authenticated } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { RequiresFeature } from '../../common/feature-flags/feature-flag.decorator.js';
import { FeatureFlagGuard } from '../../common/feature-flags/feature-flag.guard.js';
import { NotificationsService } from './notifications.service.js';

/** Server-side poll cadence for the stream (client stays poll-free). */
export const NOTIFICATIONS_SSE_POLL_MS = 5_000;

/**
 * Live notification stream (Wave P). Server-Sent Events via NestJS @Sse():
 * the server polls the repository on an interval and pushes the unread
 * queue; the browser EventSource client never polls.
 *
 * Flag-gated behind `notifications.sse` (fail-closed 404 when off).
 *
 * Auth: same RolesGuard semantics as the REST endpoints. EventSource cannot
 * set headers, so clients pass the OIDC bearer token as ?access_token=
 * (RFC 6750 §2.3); the development x-user-id identity likewise travels as a
 * query parameter only where header auth would be allowed.
 *
 * OPERATIONS NOTE: production proxies (nginx/ingress) must disable response
 * buffering for this route (e.g. `X-Accel-Buffering: no`, proxy_buffering
 * off) or events arrive in bursts.
 */
@ApiTags('notifications')
@Controller('notifications')
export class NotificationsStreamController {
  constructor(private readonly notifications: NotificationsService) {}

  @Sse('stream')
  @Authenticated()
  @RequiresFeature('notifications.sse')
  @UseGuards(RolesGuard, FeatureFlagGuard)
  @ApiOperation({
    summary:
      'SSE stream of the caller\'s unread notifications (feature flag notifications.sse; ' +
      'proxies must not buffer SSE responses)'
  })
  stream(@CurrentUser() actor: User | null): Observable<MessageEvent> {
    const pollMs = Number(process.env.NOTIFICATIONS_SSE_POLL_MS ?? NOTIFICATIONS_SSE_POLL_MS);
    const userId = actor!.id;
    return interval(pollMs).pipe(
      startWith(0),
      switchMap(async () => {
        const messages = await this.notifications.list({ userId });
        const unread = messages.filter((message) => message.status !== 'read');
        return unread;
      }),
      map(
        (unread): MessageEvent => ({
          data: {
            unreadCount: unread.length,
            notifications: unread,
            emittedAt: new Date().toISOString()
          }
        })
      )
    );
  }
}
