import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { PinSessionService } from './pin-session.service.js';
import { PinSessionsController } from './pin-sessions.controller.js';
import { SessionService } from './session.service.js';

@Module({
  controllers: [AuthController, PinSessionsController],
  providers: [AuthService, PinSessionService, SessionService],
  exports: [AuthService, PinSessionService, SessionService]
})
export class AuthModule {}
