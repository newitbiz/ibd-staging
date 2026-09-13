import http from 'node:http';
import { loadEnvFile } from './load_env.js';
import { DomainError, seedService } from './domain.js';
import { createPool, closePool } from './db.js';
import { PostgresGrowBangladeshService } from './postgres_service.js';
import { AuthService } from './auth_service.js';
import { ROUTE_ROLES, hasAnyRole } from './roles.js';
import { AUTH_RATE_LIMITS, enforceRateLimit } from './rate_limit.js';
import { createEmailAdapter } from './email/adapter.js';
import { createVerificationDelivery } from './verification_delivery.js';

loadEnvFile();

const usePostgres = Boolean(process.env.DATABASE_URL);
const isProduction = process.env.NODE_ENV === 'production';
const allowDevUserHeader = !isProduction && process.env.ALLOW_DEV_USER_HEADER === 'true';
const pool = usePostgres ? createPool() : null;
const service = usePostgres ? new PostgresGrowBangladeshService(pool) : seedService();
const emailAdapter = createEmailAdapter();
const verificationDelivery = createVerificationDelivery({ emailAdapter });
const authService = usePostgres
  ? new AuthService(pool, { emailAdapter, verificationDelivery })
  : null;
if (usePostgres && service) {
  service.emailAdapter = emailAdapter;
}
if (usePostgres && authService && service) {
  authService.growService = service;
}
if (usePostgres && service?.ensureLegalDraftsSeeded) {
  service.ensureLegalDraftsSeeded().catch((err) => {
    console.error('legal drafts seed failed', err);
  });
}
const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || '0.0.0.0';

function corsHeaders(request) {
  const configured = (process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const origin = request.headers.origin;
  if (!origin || !configured.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization,idempotency-key,x-user-id',
    vary: 'Origin',
  };
}

function send(request, response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(request) });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function match(pathname, pattern) {
  const names = [];
  const regex = new RegExp(
    '^' +
      pattern.replace(/:([A-Za-z]+)/g, (_, name) => {
        names.push(name);
        return '([^/]+)';
      }) +
      '$',
  );
  const result = pathname.match(regex);
  if (!result) return null;
  return Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(result[index + 1])]));
}


function requestContext(request) {
  const forwarded = request.headers['x-forwarded-for'];
  const ip =
    (typeof forwarded === 'string' && forwarded.split(',')[0].trim()) ||
    request.socket?.remoteAddress ||
    null;
  const userAgent = request.headers['user-agent'] || null;
  return { ip, userAgent };
}


function clientIp(request) {
  return requestContext(request).ip || 'unknown';
}

function accountKeyFromBody(body = {}) {
  const email = body.email ? String(body.email).trim().toLowerCase() : '';
  const mobile = body.mobile ? String(body.mobile).replace(/[^\d+]/g, '') : '';
  return email || mobile || 'anonymous';
}


async function assertPasswordChangeNotRequired(actor) {
  if (!usePostgres || !actor?.userId) return;
  // Only admin-created accounts with the must-change flag are gated.
  const u = await pool.query(
    `SELECT must_change_password, created_by_admin FROM users WHERE id=$1`,
    [actor.userId],
  );
  if (u.rowCount && u.rows[0].must_change_password && u.rows[0].created_by_admin) {
    throw new DomainError(
      'PASSWORD_CHANGE_REQUIRED',
      'You must change your temporary password before continuing',
      403,
    );
  }
}

function bearerToken(request) {
  const header = request.headers.authorization || '';
  const matchResult = header.match(/^Bearer\s+(.+)$/i);
  return matchResult ? matchResult[1].trim() : null;
}

async function resolveActor(request, requiredRoles = null) {
  if (!usePostgres) {
    const legacy = request.headers['x-user-id'] || 'in-memory-actor';
    return { userId: legacy, roles: ['super_admin', 'investor', 'project_owner', 'finance_officer'] };
  }

  const token = bearerToken(request);
  if (token) {
    const claims = authService.verifyAccessToken(token);
    if (!claims) throw new DomainError('UNAUTHORIZED', 'Invalid or expired access token', 401);
    const user = await authService.getUserById(claims.userId);
    if (!user || user.status !== 'active') throw new DomainError('UNAUTHORIZED', 'Account is not active', 401);
    if (requiredRoles && !hasAnyRole(user.roles, requiredRoles)) {
      throw new DomainError('FORBIDDEN', 'Insufficient role for this operation', 403);
    }
    return { userId: user.id, roles: user.roles, user };
  }

  if (allowDevUserHeader && request.headers['x-user-id']) {
    const user = await authService.getUserById(request.headers['x-user-id']);
    if (!user) throw new DomainError('UNAUTHORIZED', 'Unknown development user', 401);
    if (requiredRoles && !hasAnyRole(user.roles, requiredRoles)) {
      throw new DomainError('FORBIDDEN', 'Insufficient role for this operation', 403);
    }
    return { userId: user.id, roles: user.roles, user, viaDevHeader: true };
  }

  if (isProduction || !allowDevUserHeader) {
    if (request.headers['x-user-id']) {
      throw new DomainError('UNAUTHORIZED', 'x-user-id is not accepted as identity in this mode', 401);
    }
  }
  throw new DomainError('UNAUTHORIZED', 'Authentication required', 401);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (request.method === 'OPTIONS') {
      response.writeHead(204, corsHeaders(request));
      return response.end();
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      const database = usePostgres ? await service.health() : { status: 'ok', database: 'in_memory_demo' };
      return send(request, response, 200, {
        service: 'grow-bangladesh-backend',
        authMode: usePostgres ? (allowDevUserHeader ? 'jwt_with_optional_dev_header' : 'jwt') : 'in_memory',
        ...database,
      });
    }

    // ---- Auth routes (PostgreSQL mode) ----
    if (usePostgres && authService) {
      if (request.method === 'POST' && url.pathname === '/auth/register') {
        const body = await readJson(request);
        const ip = clientIp(request);
        const ctx = requestContext(request);
        enforceRateLimit(DomainError, `register:ip:${ip}`, AUTH_RATE_LIMITS.register);
        enforceRateLimit(
          DomainError,
          `account:${accountKeyFromBody(body)}`,
          AUTH_RATE_LIMITS.accountSoft,
        );
        return send(request, response, 201, {
          data: await authService.register({ ...body, requestContext: ctx }),
        });
      }
      if (request.method === 'POST' && url.pathname === '/auth/login') {
        const body = await readJson(request);
        const ip = clientIp(request);
        const ctx = requestContext(request);
        enforceRateLimit(DomainError, `login:ip:${ip}`, AUTH_RATE_LIMITS.login);
        enforceRateLimit(
          DomainError,
          `account:${accountKeyFromBody(body)}`,
          AUTH_RATE_LIMITS.accountSoft,
        );
        return send(request, response, 200, {
          data: await authService.login({ ...body, requestContext: ctx }),
        });
      }
      if (request.method === 'POST' && url.pathname === '/auth/otp/verify') {
        const body = await readJson(request);
        const ip = clientIp(request);
        enforceRateLimit(DomainError, `otp-verify:ip:${ip}`, AUTH_RATE_LIMITS.otpVerify);
        if (body.challengeId) {
          enforceRateLimit(
            DomainError,
            `otp-verify:challenge:${body.challengeId}`,
            AUTH_RATE_LIMITS.otpVerify,
          );
        }
        return send(request, response, 200, { data: await authService.verifyOtp(body) });
      }
      if (request.method === 'POST' && url.pathname === '/auth/token/refresh') {
        const body = await readJson(request);
        return send(request, response, 200, { data: await authService.refresh(body) });
      }
      if (request.method === 'POST' && url.pathname === '/auth/logout') {
        const body = await readJson(request);
        return send(request, response, 200, {
          data: await authService.logout({
            refreshToken: body.refreshToken,
            accessToken: bearerToken(request) || body.accessToken,
          }),
        });
      }

      if (request.method === 'POST' && url.pathname === '/auth/change-password-required') {
        const actor = await resolveActor(request);
        const body = await readJson(request);
        return send(request, response, 200, {
          data: await authService.changeRequiredPassword({
            userId: actor.userId,
            currentPassword: body.currentPassword,
            newPassword: body.newPassword,
          }),
        });
      }

      // ---- Email verification (primary activation path) ----
      if (request.method === 'POST' && url.pathname === '/auth/email/send-verification') {
        const body = await readJson(request);
        const ip = clientIp(request);
        const ctx = requestContext(request);
        enforceRateLimit(DomainError, `email-resend:ip:${ip}`, AUTH_RATE_LIMITS.emailResend);
        enforceRateLimit(
          DomainError,
          `email-resend:account:${accountKeyFromBody(body)}`,
          AUTH_RATE_LIMITS.emailResend,
        );
        return send(request, response, 200, {
          data: await authService.sendEmailVerification({ ...body, requestContext: ctx }),
        });
      }
      if (request.method === 'POST' && url.pathname === '/auth/email/resend') {
        const body = await readJson(request);
        const ip = clientIp(request);
        const ctx = requestContext(request);
        enforceRateLimit(DomainError, `email-resend:ip:${ip}`, AUTH_RATE_LIMITS.emailResend);
        enforceRateLimit(
          DomainError,
          `email-resend:account:${accountKeyFromBody(body)}`,
          AUTH_RATE_LIMITS.emailResend,
        );
        return send(request, response, 200, {
          data: await authService.resendEmailVerification({ ...body, requestContext: ctx }),
        });
      }
      if (request.method === 'POST' && url.pathname === '/auth/email/verify-code') {
        const body = await readJson(request);
        const ip = clientIp(request);
        const ctx = requestContext(request);
        enforceRateLimit(DomainError, `email-verify:ip:${ip}`, AUTH_RATE_LIMITS.emailVerify);
        enforceRateLimit(
          DomainError,
          `email-verify:account:${accountKeyFromBody(body)}`,
          AUTH_RATE_LIMITS.emailVerify,
        );
        return send(request, response, 200, {
          data: await authService.verifyEmailCode({ ...body, requestContext: ctx }),
        });
      }
      if (request.method === 'GET' && url.pathname === '/auth/email/verify') {
        const token = url.searchParams.get('token');
        const ip = clientIp(request);
        const ctx = requestContext(request);
        enforceRateLimit(DomainError, `email-verify:ip:${ip}`, AUTH_RATE_LIMITS.emailVerify);
        try {
          const data = await authService.verifyEmailToken({ token, requestContext: ctx });
          const accept = request.headers.accept || '';
          if (accept.includes('text/html')) {
            const dest = `${(process.env.APP_PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, '')}/verify-email/result?status=success`;
            response.writeHead(302, { location: dest, ...corsHeaders(request) });
            return response.end();
          }
          return send(request, response, 200, { data });
        } catch (error) {
          if (error instanceof DomainError) {
            const accept = request.headers.accept || '';
            if (accept.includes('text/html')) {
              const statusMap = {
                EMAIL_VERIFY_EXPIRED: 'expired',
                EMAIL_VERIFY_USED: 'already_used',
                EMAIL_ALREADY_VERIFIED: 'already_used',
                EMAIL_VERIFY_INVALID: 'invalid',
                EMAIL_VERIFY_LOCKED: 'invalid',
                EMAIL_TOKEN_REQUIRED: 'invalid',
              };
              const st = statusMap[error.code] || 'invalid';
              const dest = `${(process.env.APP_PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, '')}/verify-email/result?status=${st}`;
              response.writeHead(302, { location: dest, ...corsHeaders(request) });
              return response.end();
            }
          }
          throw error;
        }
      }
      if (request.method === 'POST' && url.pathname === '/auth/password/forgot') {
        const body = await readJson(request);
        const ip = clientIp(request);
        enforceRateLimit(DomainError, `otp-request:ip:${ip}`, AUTH_RATE_LIMITS.otpRequest);
        enforceRateLimit(
          DomainError,
          `account:${accountKeyFromBody(body)}`,
          AUTH_RATE_LIMITS.accountSoft,
        );
        return send(request, response, 200, { data: await authService.requestPasswordReset(body) });
      }
      if (request.method === 'POST' && url.pathname === '/auth/password/reset') {
        const body = await readJson(request);
        return send(request, response, 200, { data: await authService.resetPassword(body) });
      }
      if (request.method === 'GET' && url.pathname === '/auth/me') {
        const actor = await resolveActor(request);
        return send(request, response, 200, { data: actor.user });
      }
      if (request.method === 'POST' && url.pathname === '/auth/sessions/revoke') {
        const actor = await resolveActor(request, ['super_admin', 'support']);
        const body = await readJson(request);
        const targetUserId = body.userId || actor.userId;
        return send(request, response, 200, {
          data: await authService.revokeAllSessions(targetUserId, actor.userId),
        });
      }
    }


    let params;

    if (request.method === 'GET' && url.pathname === '/categories') {
      // Active categories are non-sensitive marketplace metadata (browse filters + owner create).
      return send(request, response, 200, { data: await service.listActiveCategories() });
    }

    if (request.method === 'GET' && url.pathname === '/admin/categories') {
      const actor = await resolveActor(request, ROUTE_ROLES.listAdminCategories);
      const includeInactive = url.searchParams.get('includeInactive') !== 'false';
      return send(request, response, 200, {
        data: await service.listAdminCategories({ includeInactive }),
      });
    }

    if (request.method === 'POST' && url.pathname === '/admin/categories') {
      const actor = await resolveActor(request, ROUTE_ROLES.mutateCategories);
      const body = await readJson(request);
      return send(request, response, 201, {
        data: await service.createCategory(body, actor.userId, { requestContext: requestContext(request) }),
      });
    }

    if (request.method === 'POST' && url.pathname === '/admin/categories/reorder') {
      const actor = await resolveActor(request, ROUTE_ROLES.mutateCategories);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.reorderCategories(body.orderedIds || body.ids || [], actor.userId, {
          requestContext: requestContext(request),
        }),
      });
    }

    params = match(url.pathname, '/admin/categories/:id/activate');
    if (request.method === 'POST' && params) {
      const actor = await resolveActor(request, ROUTE_ROLES.mutateCategories);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.setCategoryActive(params.id, true, actor.userId, {
          requestContext: requestContext(request),
          reason: body.reason || '',
        }),
      });
    }

    params = match(url.pathname, '/admin/categories/:id/deactivate');
    if (request.method === 'POST' && params) {
      const actor = await resolveActor(request, ROUTE_ROLES.mutateCategories);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.setCategoryActive(params.id, false, actor.userId, {
          requestContext: requestContext(request),
          reason: body.reason || '',
        }),
      });
    }

    params = match(url.pathname, '/admin/categories/:id');
    if (request.method === 'POST' && params) {
      const actor = await resolveActor(request, ROUTE_ROLES.mutateCategories);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.updateCategory(params.id, body, actor.userId, {
          requestContext: requestContext(request),
        }),
      });
    }


    // ---- Phase 3: investor profile + bank ----
    if (request.method === 'GET' && (url.pathname === '/me/profile' || url.pathname === '/profile')) {
      const actor = await resolveActor(request, ROUTE_ROLES.getMyProfile);
      return send(request, response, 200, { data: await service.getInvestorProfile(actor.userId) });
    }

    if ((request.method === 'PATCH' || request.method === 'PUT') && (url.pathname === '/me/profile' || url.pathname === '/profile')) {
      const actor = await resolveActor(request, ROUTE_ROLES.updateMyProfile);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.updateInvestorProfile(actor.userId, body, actor.userId, {
          requestContext: requestContext(request),
        }),
      });
    }

    if (request.method === 'GET' && (url.pathname === '/me/bank' || url.pathname === '/bank')) {
      const actor = await resolveActor(request, ROUTE_ROLES.getMyBank);
      return send(request, response, 200, { data: await service.getInvestorBank(actor.userId) });
    }

    if ((request.method === 'PUT' || request.method === 'PATCH') && (url.pathname === '/me/bank' || url.pathname === '/bank')) {
      const actor = await resolveActor(request, ROUTE_ROLES.upsertMyBank);
      const body = await readJson(request);
      const result = await service.upsertInvestorBank(actor.userId, body, actor.userId, {
        requestContext: requestContext(request),
      });
      return send(request, response, 200, { data: result });
    }

    params = match(url.pathname, '/admin/investors/:id/bank');
    if (request.method === 'GET' && params) {
      // Explicit owner denial: project_owner must never read investor bank details.
      const actor = await resolveActor(request);
      if (actor.roles.includes('project_owner') && !hasAnyRole(actor.roles, ROUTE_ROLES.getAdminInvestorBank)) {
        throw new DomainError('FORBIDDEN', 'Project owners cannot access investor bank information', 403);
      }
      if (!hasAnyRole(actor.roles, ROUTE_ROLES.getAdminInvestorBank)) {
        throw new DomainError('FORBIDDEN', 'Insufficient role for this operation', 403);
      }
      return send(request, response, 200, { data: await service.getInvestorBank(params.id) });
    }

    params = match(url.pathname, '/admin/investors/:id/bank/verify');
    if (request.method === 'POST' && params) {
      const actor = await resolveActor(request);
      if (actor.roles.includes('project_owner') && !hasAnyRole(actor.roles, ROUTE_ROLES.verifyInvestorBank)) {
        throw new DomainError('FORBIDDEN', 'Project owners cannot access investor bank information', 403);
      }
      if (!hasAnyRole(actor.roles, ROUTE_ROLES.verifyInvestorBank)) {
        throw new DomainError('FORBIDDEN', 'Insufficient role for this operation', 403);
      }
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.verifyInvestorBank(params.id, actor.userId, {
          status: body.status || 'verified',
          note: body.note || body.reason || '',
          requestContext: requestContext(request),
        }),
      });
    }

    params = match(url.pathname, '/admin/investors/:id/kyc');
    if (request.method === 'POST' && params) {
      const actor = await resolveActor(request, ROUTE_ROLES.setInvestorKycStatus);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.setInvestorKycStatus(params.id, actor.userId, body.status || body.kycStatus, {
          reason: body.reason || '',
          requestContext: requestContext(request),
        }),
      });
    }

    if (request.method === 'GET' && url.pathname === '/projects') {
      const categorySlug = url.searchParams.get('category') || url.searchParams.get('categorySlug');
      const termMinDays = url.searchParams.get('termMinDays') || url.searchParams.get('termMin');
      const termMaxDays = url.searchParams.get('termMaxDays') || url.searchParams.get('termMax');
      const unitPriceMinPoisha = url.searchParams.get('unitPriceMinPoisha') || url.searchParams.get('unitPriceMin');
      const unitPriceMaxPoisha = url.searchParams.get('unitPriceMaxPoisha') || url.searchParams.get('unitPriceMax');
      const status = url.searchParams.get('status');
      return send(request, response, 200, {
        data: await service.listPublishedProjects({
          categorySlug,
          termMinDays,
          termMaxDays,
          unitPriceMinPoisha,
          unitPriceMaxPoisha,
          status,
        }),
      });
    }

    params = match(url.pathname, '/projects/:slug');
    if (request.method === 'GET' && params && usePostgres) {
      return send(request, response, 200, {
        data: await service.getPublishedProjectBySlug(params.slug),
      });
    }

    if (request.method === 'POST' && url.pathname === '/owner/projects') {
      const actor = await resolveActor(request, ROUTE_ROLES.createProject);
      const body = await readJson(request);
      const project = await service.createProject(body, actor.userId);
      return send(request, response, 201, { data: project });
    }

    // Legacy alias kept for existing Flutter create dialog
    if (request.method === 'POST' && url.pathname === '/projects') {
      const actor = await resolveActor(request, ROUTE_ROLES.createProject);
      const body = await readJson(request);
      const project = await service.createProject(
        usePostgres ? body : { ...body, ownerId: actor.userId },
        actor.userId,
      );
      return send(request, response, 201, { data: project });
    }

    params = match(url.pathname, '/projects/:id/investment-preview');
    if (request.method === 'GET' && params && usePostgres) {
      // Public marketplace preview (auth optional) — no PII
      const units = Number(url.searchParams.get('units') || '1');
      return send(request, response, 200, {
        data: await service.previewInvestmentForProject(params.id, units),
      });
    }
    if (request.method === 'POST' && url.pathname === '/investments/preview' && usePostgres) {
      const body = await readJson(request);
      const units = Number(body.units || 1);
      if (body.projectId) {
        return send(request, response, 200, {
          data: await service.previewInvestmentForProject(body.projectId, units),
        });
      }
      // Raw calc without project (integer poisha + bps)
      const { previewInvestmentCalculation } = await import('./application_workflow.js');
      return send(request, response, 200, {
        data: previewInvestmentCalculation({
          unitInvestmentPoisha: Number(body.unitInvestmentPoisha),
          administrationFeeBps: Number(body.administrationFeeBps),
          units,
        }),
      });
    }

    if (request.method === 'POST' && url.pathname === '/applications') {
      const actor = await resolveActor(request, ROUTE_ROLES.applyForUnits);
      const body = await readJson(request);
      const application = await service.applyForUnits({
        ...body,
        investorId: actor.userId,
        requestContext: requestContext(request),
      }, actor.userId);
      return send(request, response, 201, { data: application });
    }

    params = match(url.pathname, '/admin/projects/:id/publish');
    if (request.method === 'POST' && params) {
      const actor = await resolveActor(request, ROUTE_ROLES.publishProject);
      const body = await readJson(request);
      const project = await service.publishProject(params.id, actor.userId, body.terms || body);
      return send(request, response, 200, { data: project });
    }

    if (request.method === 'GET' && url.pathname === '/admin/projects' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.listAdminProjects);
      const status = url.searchParams.get('status');
      const reviewQueue = url.searchParams.get('reviewQueue') === 'true';
      return send(request, response, 200, {
        data: await service.listAdminProjects({ status, reviewQueue }),
      });
    }

    if (request.method === 'POST' && url.pathname === '/admin/projects' && usePostgres) {
      const actor = await resolveActor(request, ['super_admin']);
      await assertPasswordChangeNotRequired(actor);
      const body = await readJson(request);
      // Full admin-create/publish workflow (bypasses owner submission; mandatory fields + audit).
      return send(request, response, 201, {
        data: await service.adminCreateProject(actor.userId, body, requestContext(request)),
      });
    }

    params = match(url.pathname, '/admin/projects/:id/request-changes');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.requestProjectChanges);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.requestProjectChanges(params.id, actor.userId, body.reason),
      });
    }

    params = match(url.pathname, '/admin/projects/:id/reject');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.rejectProject);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.rejectProject(params.id, actor.userId, body.reason),
      });
    }

    params = match(url.pathname, '/admin/projects/:id/approve');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.approveProject);
      return send(request, response, 200, {
        data: await service.approveProject(params.id, actor.userId),
      });
    }

    params = match(url.pathname, '/admin/projects/:id/pause');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.pauseProject);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.pauseProject(params.id, actor.userId, body.reason || ''),
      });
    }

    params = match(url.pathname, '/admin/projects/:id/resume');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.pauseProject);
      return send(request, response, 200, {
        data: await service.resumeProject(params.id, actor.userId),
      });
    }

    params = match(url.pathname, '/admin/projects/:id/close-funding');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.closeFunding);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.closeFunding(params.id, actor.userId, body.reason || ''),
      });
    }

    params = match(url.pathname, '/admin/projects/:id/versions');
    if (request.method === 'GET' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.listAdminProjectVersions);
      return send(request, response, 200, {
        data: await service.listProjectVersions(params.id, { actorId: actor.userId, asAdmin: true }),
      });
    }

    params = match(url.pathname, '/admin/projects/:id');
    if (params && usePostgres && (request.method === 'GET' || request.method === 'PATCH' || request.method === 'POST')) {
      if (request.method === 'GET') {
        const actor = await resolveActor(request, ROUTE_ROLES.getAdminProject);
        return send(request, response, 200, { data: await service.getAdminProject(params.id) });
      }
      const actor = await resolveActor(request, ROUTE_ROLES.updateAdminProject);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.updateAdminProject(params.id, body, actor.userId),
      });
    }

    params = match(url.pathname, '/admin/applications/:id/approve');
    if (request.method === 'POST' && params) {
      const actor = await resolveActor(request, ROUTE_ROLES.approveApplication);
      return send(request, response, 200, {
        data: await service.approveApplication(params.id, actor.userId),
      });
    }

    params = match(url.pathname, '/admin/applications/:id/reject');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.rejectApplication);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.rejectApplication(params.id, actor.userId, body.reason),
      });
    }

    params = match(url.pathname, '/admin/applications/:id/request-changes');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.requestApplicationChanges);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.requestApplicationChanges(params.id, actor.userId, body.reason),
      });
    }

    params = match(url.pathname, '/admin/applications/:id/start-review');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.startApplicationReview);
      return send(request, response, 200, {
        data: await service.startApplicationReview(params.id, actor.userId),
      });
    }

    params = match(url.pathname, '/admin/applications/:id');
    if (request.method === 'GET' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.getAdminApplication);
      return send(request, response, 200, {
        data: await service.getAdminApplication(params.id),
      });
    }

    if (request.method === 'POST' && url.pathname === '/payments') {
      const actor = await resolveActor(request, ROUTE_ROLES.submitPayment);
      const body = await readJson(request);
      const paymentInput = usePostgres
        ? {
            ...body,
            idempotencyKey: request.headers['idempotency-key'] || body.idempotencyKey,
            requestContext: requestContext(request),
          }
        : body;
      return send(request, response, 201, { data: await service.submitPayment(paymentInput, actor.userId) });
    }

    params = match(url.pathname, '/admin/payments/:id/verify');
    if (request.method === 'POST' && params) {
      const actor = await resolveActor(request, ROUTE_ROLES.verifyPayment);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.verifyPayment(params.id, actor.userId, body.reviewNote || '', {
          requestContext: requestContext(request),
          actorRoles: actor.roles,
          overrideMakerChecker: Boolean(body.overrideMakerChecker),
          overrideReason: body.overrideReason || '',
        }),
      });
    }

    params = match(url.pathname, '/admin/payments/:id/reject');
    if (request.method === 'POST' && params) {
      const actor = await resolveActor(request, ROUTE_ROLES.rejectPayment);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.rejectPayment(params.id, actor.userId, body.reviewNote || '', {
          requestContext: requestContext(request),
          actorRoles: actor.roles,
        }),
      });
    }

    if (request.method === 'GET' && url.pathname === '/admin/payments') {
      const actor = await resolveActor(request, ROUTE_ROLES.listAdminPayments);
      const status = url.searchParams.get('status') || 'verification_pending';
      return send(request, response, 200, {
        data: await service.listAdminPayments({ status }),
      });
    }

    if (request.method === 'GET' && url.pathname === '/admin/applications') {
      const actor = await resolveActor(request, ROUTE_ROLES.listAdminApplications);
      const status = url.searchParams.get('status') || null;
      return send(request, response, 200, {
        data: await service.listAdminApplications({ status, reviewQueue: !status }),
      });
    }

    if (request.method === 'GET' && url.pathname === '/applications/mine') {
      const actor = await resolveActor(request, ROUTE_ROLES.listMyApplications);
      const status = url.searchParams.get('status');
      return send(request, response, 200, {
        data: await service.listMyApplications(actor.userId, { status }),
      });
    }

    params = match(url.pathname, '/applications/mine/:id');
    if (request.method === 'GET' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.getMyApplication);
      return send(request, response, 200, {
        data: await service.getMyApplication(params.id, actor.userId),
      });
    }

    params = match(url.pathname, '/applications/:id/resubmit');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.resubmitApplication);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.resubmitApplication(params.id, actor.userId, body),
      });
    }

    params = match(url.pathname, '/applications/:id/cancel');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.cancelApplication);
      return send(request, response, 200, {
        data: await service.cancelApplication(params.id, actor.userId),
      });
    }

    if (request.method === 'GET' && url.pathname === '/owner/projects') {
      const actor = await resolveActor(request, ROUTE_ROLES.listOwnerProjects);
      return send(request, response, 200, {
        data: await service.listOwnerProjects(actor.userId),
      });
    }

    params = match(url.pathname, '/owner/projects/:id/submit');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.submitProject);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.submitOwnerProject(params.id, actor.userId, body.reviewFee || body.fee || body),
      });
    }

    params = match(url.pathname, '/owner/projects/:id/resubmit');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.resubmitProject);
      return send(request, response, 200, {
        data: await service.resubmitOwnerProject(params.id, actor.userId),
      });
    }

    params = match(url.pathname, '/owner/projects/:id/versions');
    if (request.method === 'GET' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.listOwnerProjectVersions);
      return send(request, response, 200, {
        data: await service.listProjectVersions(params.id, { actorId: actor.userId, asAdmin: false }),
      });
    }

    params = match(url.pathname, '/owner/projects/:id');
    if (params && usePostgres && (request.method === 'GET' || request.method === 'PATCH' || request.method === 'POST')) {
      if (request.method === 'GET') {
        const actor = await resolveActor(request, ROUTE_ROLES.getOwnerProject);
        return send(request, response, 200, {
          data: await service.getOwnerProject(params.id, actor.userId),
        });
      }
      const actor = await resolveActor(request, ROUTE_ROLES.updateOwnerProject);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.updateOwnerProject(params.id, body, actor.userId),
      });
    }


    // --- Project Owner feature pack ---
    if (request.method === 'GET' && url.pathname === '/owner/home-metrics' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.ownerHomeMetrics);
      return send(request, response, 200, { data: await service.getOwnerHomeMetrics(actor.userId) });
    }

    if (request.method === 'GET' && url.pathname === '/owner/reports/summary' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.ownerReport);
      return send(request, response, 200, { data: await service.getOwnerReportSummary(actor.userId) });
    }

    if (request.method === 'GET' && url.pathname === '/owner/reports/download.csv' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.ownerReport);
      const file = await service.downloadOwnerReportCsv(actor.userId);
      const wantJson = url.searchParams.get('format') === 'json' && url.searchParams.get('raw') !== '1';
      if (!wantJson) {
        response.writeHead(200, {
          'content-type': file.contentType,
          'content-disposition': `attachment; filename="${file.filename}"`,
          'cache-control': 'no-store',
          ...corsHeaders(request),
        });
        response.end(file.body);
        return;
      }
      return send(request, response, 200, { data: file });
    }

    if (request.method === 'GET' && url.pathname === '/owner/reports/summary.pdf' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.ownerReport);
      const file = await service.downloadOwnerReportPdf(actor.userId);
      const pdfBytes = Buffer.isBuffer(file.body) ? file.body : Buffer.from(file.body);
      response.writeHead(200, {
        'content-type': file.contentType,
        'content-disposition': `attachment; filename="${file.filename}"`,
        'content-length': pdfBytes.length,
        'cache-control': 'no-store',
        'x-fictional-demo': 'FICTIONAL DEMO - NOT A REAL DOCUMENT',
        ...corsHeaders(request),
      });
      response.end(pdfBytes);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/owner/invest-opportunities' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.ownerInvestOpportunities);
      return send(request, response, 200, {
        data: await service.listOwnerInvestOpportunities(actor.userId),
      });
    }

    if (request.method === 'GET' && url.pathname === '/owner/interest-inbox' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.ownerInterestInbox);
      const unreadOnly = url.searchParams.get('unreadOnly') === 'true';
      return send(request, response, 200, {
        data: await service.listOwnerInterestInbox(actor.userId, { unreadOnly }),
      });
    }

    params = match(url.pathname, '/owner/interest-inbox/:applicationId/read');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.ownerInterestInbox);
      return send(request, response, 200, {
        data: await service.markOwnerInterestRead(actor.userId, params.applicationId),
      });
    }

    params = match(url.pathname, '/owner/projects/:id/review-fee');
    if (params && usePostgres) {
      if (request.method === 'GET') {
        const actor = await resolveActor(request, ROUTE_ROLES.ownerReviewFee);
        return send(request, response, 200, {
          data: await service.getOwnerProjectReviewFee(params.id, actor.userId),
        });
      }
      if (request.method === 'POST') {
        const actor = await resolveActor(request, ROUTE_ROLES.ownerReviewFee);
        const body = await readJson(request);
        return send(request, response, 200, {
          data: await service.submitOwnerProjectReviewFee(params.id, actor.userId, body),
        });
      }
    }

    params = match(url.pathname, '/owner/projects/:id/updates');
    if (params && usePostgres) {
      if (request.method === 'GET') {
        const actor = await resolveActor(request, ROUTE_ROLES.ownerProjectUpdates);
        return send(request, response, 200, {
          data: await service.listProjectUpdates(params.id, { actorId: actor.userId, asOwner: true }),
        });
      }
      if (request.method === 'POST') {
        const actor = await resolveActor(request, ROUTE_ROLES.ownerProjectUpdates);
        const body = await readJson(request);
        return send(request, response, 201, {
          data: await service.createOwnerProjectUpdate(params.id, actor.userId, body),
        });
      }
    }

    params = match(url.pathname, '/projects/:id/updates');
    if (request.method === 'GET' && params && usePostgres) {
      // Public/investor feed for marketplace-visible projects (auth optional but preferred)
      let actorId = null;
      try {
        const actor = await resolveActor(request, ROUTE_ROLES.publicProjectUpdates);
        actorId = actor.userId;
      } catch (_) {
        /* allow unauthenticated read for published */
      }
      return send(request, response, 200, {
        data: await service.listProjectUpdates(params.id, { actorId, asOwner: false }),
      });
    }

    params = match(url.pathname, '/owner/projects/:id/milestones');
    if (params && usePostgres) {
      if (request.method === 'GET') {
        const actor = await resolveActor(request, ROUTE_ROLES.ownerMilestones);
        return send(request, response, 200, {
          data: await service.listProjectMilestones(params.id, { actorId: actor.userId, asOwner: true }),
        });
      }
      if (request.method === 'POST') {
        const actor = await resolveActor(request, ROUTE_ROLES.ownerMilestones);
        const body = await readJson(request);
        return send(request, response, 201, {
          data: await service.upsertOwnerProjectMilestone(params.id, actor.userId, body),
        });
      }
    }

    params = match(url.pathname, '/owner/projects/:id/milestones/:milestoneId');
    if (request.method === 'DELETE' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.ownerMilestones);
      return send(request, response, 200, {
        data: await service.deleteOwnerProjectMilestone(params.id, params.milestoneId, actor.userId),
      });
    }

    params = match(url.pathname, '/projects/:id/milestones');
    if (request.method === 'GET' && params && usePostgres) {
      return send(request, response, 200, {
        data: await service.listProjectMilestones(params.id, { asOwner: false }),
      });
    }

    params = match(url.pathname, '/owner/projects/:id/funding-request');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.ownerFundingRequest);
      const body = await readJson(request);
      return send(request, response, 201, {
        data: await service.requestOwnerFundingAction(params.id, actor.userId, body),
      });
    }

    params = match(url.pathname, '/owner/projects/:id/export.csv');
    if (request.method === 'GET' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.ownerReport);
      const file = await service.downloadOwnerProjectCsv(params.id, actor.userId);
      const wantJson = url.searchParams.get('format') === 'json' && url.searchParams.get('raw') !== '1';
      if (!wantJson) {
        response.writeHead(200, {
          'content-type': file.contentType,
          'content-disposition': `attachment; filename="${file.filename}"`,
          'cache-control': 'no-store',
          ...corsHeaders(request),
        });
        response.end(file.body);
        return;
      }
      return send(request, response, 200, { data: file });
    }

    params = match(url.pathname, '/owner/projects/:id/photos');
    if (params && usePostgres) {
      if (request.method === 'GET') {
        const actor = await resolveActor(request, ROUTE_ROLES.ownerProjectPhotos);
        return send(request, response, 200, {
          data: await service.listOwnerProjectPhotoSignedUrls(params.id, actor.userId, {
            asOwner: true,
            roles: actor.roles,
          }),
        });
      }
      if (request.method === 'POST') {
        const actor = await resolveActor(request, ROUTE_ROLES.ownerProjectPhotos);
        const body = await readJson(request);
        return send(request, response, 201, {
          data: await service.uploadOwnerProjectPhoto(params.id, actor.userId, {
            filename: body.filename,
            mimeType: body.mimeType,
            base64Content: body.base64Content,
            requestContext: requestContext(request),
          }),
        });
      }
      if (request.method === 'PUT') {
        const actor = await resolveActor(request, ROUTE_ROLES.ownerProjectPhotos);
        const body = await readJson(request);
        return send(request, response, 200, {
          data: await service.setOwnerProjectPhotoDocumentIds(
            params.id,
            actor.userId,
            body.photoDocumentIds,
          ),
        });
      }
    }

    params = match(url.pathname, '/projects/:id/photos');
    if (request.method === 'GET' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.publicProjectPhotos);
      return send(request, response, 200, {
        data: await service.listOwnerProjectPhotoSignedUrls(params.id, actor.userId, {
          asOwner: false,
          roles: actor.roles,
        }),
      });
    }

    if (request.method === 'GET' && url.pathname === '/benchmarks/categories' && usePostgres) {
      await resolveActor(request, ROUTE_ROLES.categoryBenchmark);
      const slug = url.searchParams.get('categorySlug');
      return send(request, response, 200, {
        data: await service.getCategoryBenchmarkStub(slug),
      });
    }

    if (request.method === 'GET' && url.pathname === '/admin/review-fee-settings' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.adminReviewFee);
      return send(request, response, 200, { data: await service.getAdminReviewFeeSettings() });
    }

    if (request.method === 'PUT' && url.pathname === '/admin/review-fee-settings' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.adminReviewFee);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.updateAdminReviewFeeSettings(
          actor.userId,
          body.amountPoisha ?? body.projectReviewFeePoisha,
        ),
      });
    }

    if (request.method === 'GET' && url.pathname === '/admin/project-review-fees' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.adminReviewFee);
      const status = url.searchParams.get('status');
      return send(request, response, 200, {
        data: await service.listAdminProjectReviewFees({ status }),
      });
    }

    params = match(url.pathname, '/admin/projects/:id/review-fee/verify');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.adminReviewFee);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.verifyAdminProjectReviewFee(params.id, actor.userId, body),
      });
    }

    if (request.method === 'GET' && url.pathname === '/admin/funding-requests' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.adminFundingRequests);
      const status = url.searchParams.get('status') || 'pending';
      return send(request, response, 200, {
        data: await service.listAdminFundingRequests({ status }),
      });
    }

    params = match(url.pathname, '/admin/funding-requests/:id/review');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.adminFundingRequests);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.reviewAdminFundingRequest(params.id, actor.userId, body),
      });
    }


    // --- Dashboard layouts + preferred role shell ---
    if (request.method === 'GET' && url.pathname === '/me/dashboard-layout' && usePostgres) {
      const actor = await resolveActor(request);
      await assertPasswordChangeNotRequired(actor);
      const roleShell = url.searchParams.get('roleShell') || 'investor';
      return send(request, response, 200, { data: await service.getDashboardLayout(actor.userId, roleShell) });
    }
    if (request.method === 'PUT' && url.pathname === '/me/dashboard-layout' && usePostgres) {
      const actor = await resolveActor(request);
      await assertPasswordChangeNotRequired(actor);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.putDashboardLayout(actor.userId, body.roleShell || url.searchParams.get('roleShell'), body.cardOrder, requestContext(request)),
      });
    }
    if (request.method === 'POST' && url.pathname === '/me/dashboard-layout/reset' && usePostgres) {
      const actor = await resolveActor(request);
      await assertPasswordChangeNotRequired(actor);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.resetDashboardLayout(actor.userId, body.roleShell || url.searchParams.get('roleShell'), requestContext(request)),
      });
    }
    if (request.method === 'GET' && url.pathname === '/me/preferred-role-shell' && usePostgres) {
      const actor = await resolveActor(request);
      await assertPasswordChangeNotRequired(actor);
      return send(request, response, 200, { data: await service.getPreferredRoleShell(actor.userId) });
    }
    if (request.method === 'PUT' && url.pathname === '/me/preferred-role-shell' && usePostgres) {
      const actor = await resolveActor(request);
      await assertPasswordChangeNotRequired(actor);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.putPreferredRoleShell(
          actor.userId,
          body.preferredRoleShell || body.shell || body.mode,
          requestContext(request),
        ),
      });
    }

    // --- Admin create investor / project / messaging / stages ---
    if (request.method === 'POST' && url.pathname === '/admin/investors' && usePostgres) {
      const actor = await resolveActor(request, ['super_admin']);
      await assertPasswordChangeNotRequired(actor);
      const body = await readJson(request);
      return send(request, response, 201, {
        data: await service.adminCreateInvestor(actor.userId, body, requestContext(request)),
      });
    }
    if (request.method === 'GET' && url.pathname === '/admin/dashboard-cards' && usePostgres) {
      const actor = await resolveActor(request, ['super_admin', 'finance_officer', 'project_reviewer', 'support']);
      await assertPasswordChangeNotRequired(actor);
      return send(request, response, 200, { data: await service.getAdminDashboardCards() });
    }

    params = match(url.pathname, '/admin/projects/:id/lifecycle');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ['super_admin', 'project_reviewer']);
      await assertPasswordChangeNotRequired(actor);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.adminProjectLifecycle(params.id, actor.userId, body.action, {
          ...requestContext(request),
          reason: body.reason,
        }),
      });
    }
    params = match(url.pathname, '/admin/projects/:id/disbursement-stages');
    if (params && usePostgres) {
      if (request.method === 'GET') {
        const actor = await resolveActor(request, ['super_admin', 'finance_officer', 'project_reviewer']);
        await assertPasswordChangeNotRequired(actor);
        return send(request, response, 200, { data: await service.listProjectDisbursementStages(params.id) });
      }
      if (request.method === 'PUT') {
        const actor = await resolveActor(request, ['super_admin', 'finance_officer']);
        await assertPasswordChangeNotRequired(actor);
        const body = await readJson(request);
        return send(request, response, 200, {
          data: await service.setProjectDisbursementStages(params.id, actor.userId, body.stages || body, requestContext(request)),
        });
      }
    }
    params = match(url.pathname, '/admin/disbursement-stages/:id/status');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ['super_admin', 'finance_officer']);
      await assertPasswordChangeNotRequired(actor);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.updateDisbursementStageStatus(params.id, actor.userId, body, requestContext(request)),
      });
    }
    params = match(url.pathname, '/admin/support/cases/:id/assign');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ['super_admin', 'support']);
      await assertPasswordChangeNotRequired(actor);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.adminAssignSupportCase(params.id, actor.userId, body.assigneeId || actor.userId, requestContext(request)),
      });
    }
    params = match(url.pathname, '/admin/support/cases/:id/internal-note');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ['super_admin', 'support']);
      await assertPasswordChangeNotRequired(actor);
      const body = await readJson(request);
      return send(request, response, 201, {
        data: await service.adminAddSupportInternalNote(params.id, actor.userId, body.body || body.note, requestContext(request)),
      });
    }
    params = match(url.pathname, '/admin/support/cases/:id/reopen');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ['super_admin', 'support']);
      await assertPasswordChangeNotRequired(actor);
      return send(request, response, 200, {
        data: await service.adminReopenSupportCase(params.id, actor.userId, requestContext(request)),
      });
    }
    if (request.method === 'GET' && url.pathname === '/admin/messaging/overview' && usePostgres) {
      const actor = await resolveActor(request, ['super_admin', 'support']);
      await assertPasswordChangeNotRequired(actor);
      return send(request, response, 200, { data: await service.adminMessagingOverview() });
    }
    params = match(url.pathname, '/admin/applications/:id/approve-with-deadline');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.approveApplication);
      await assertPasswordChangeNotRequired(actor);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.approveApplicationWithDeadline(params.id, actor.userId, body, requestContext(request)),
      });
    }

    // --- Owner status / funds / investments / stages ---
    if (request.method === 'GET' && url.pathname === '/owner/status-cards' && usePostgres) {
      const actor = await resolveActor(request, ['project_owner']);
      await assertPasswordChangeNotRequired(actor);
      return send(request, response, 200, { data: await service.getOwnerStatusCards(actor.userId) });
    }
    if (request.method === 'GET' && url.pathname === '/owner/projects-by-status' && usePostgres) {
      const actor = await resolveActor(request, ['project_owner']);
      await assertPasswordChangeNotRequired(actor);
      const status = url.searchParams.get('status');
      return send(request, response, 200, { data: await service.listOwnerProjectsByStatus(actor.userId, status) });
    }
    if (request.method === 'GET' && url.pathname === '/owner/funds-raised' && usePostgres) {
      const actor = await resolveActor(request, ['project_owner']);
      await assertPasswordChangeNotRequired(actor);
      return send(request, response, 200, { data: await service.getOwnerFundsRaisedDetail(actor.userId) });
    }
    if (request.method === 'GET' && url.pathname === '/owner/investments' && usePostgres) {
      const actor = await resolveActor(request, ['project_owner', 'investor']);
      await assertPasswordChangeNotRequired(actor);
      return send(request, response, 200, { data: await service.listOwnerInvestments(actor.userId) });
    }

    if (request.method === 'GET' && url.pathname === '/owner/dashboard-separation' && usePostgres) {
      const actor = await resolveActor(request, ['project_owner']);
      await assertPasswordChangeNotRequired(actor);
      return send(request, response, 200, { data: await service.getOwnerDashboardSeparation(actor.userId) });
    }
    params = match(url.pathname, '/owner/projects/:id/disbursement-stages');
    if (request.method === 'GET' && params && usePostgres) {
      const actor = await resolveActor(request, ['project_owner']);
      await assertPasswordChangeNotRequired(actor);
      return send(request, response, 200, {
        data: await service.listProjectDisbursementStages(params.id, { ownerUserId: actor.userId }),
      });
    }


    // --- Super Admin pack: overview, settings, disbursements, share units ---
    if (request.method === 'GET' && url.pathname === '/admin/overview' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.adminOverview);
      return send(request, response, 200, { data: await service.getAdminOverview() });
    }

    if (request.method === 'GET' && url.pathname === '/admin/overview/projects' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.adminOverview);
      return send(request, response, 200, {
        data: await service.listAdminOverviewProjects({
          status: url.searchParams.get('status'),
          tab: url.searchParams.get('tab'),
          limit: Number(url.searchParams.get('limit') || 100),
        }),
      });
    }

    if (request.method === 'GET' && url.pathname === '/admin/overview/allocations' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.adminOverview);
      return send(request, response, 200, {
        data: await service.listAdminOverviewAllocations({
          projectId: url.searchParams.get('projectId'),
          limit: Number(url.searchParams.get('limit') || 100),
        }),
      });
    }

    if (request.method === 'GET' && url.pathname === '/admin/overview/investors' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.adminOverview);
      return send(request, response, 200, {
        data: await service.listAdminOverviewInvestors({
          q: url.searchParams.get('q') || '',
          limit: Number(url.searchParams.get('limit') || 50),
          offset: Number(url.searchParams.get('offset') || 0),
        }),
      });
    }

    if (request.method === 'GET' && url.pathname === '/admin/overview/owners' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.adminOverview);
      return send(request, response, 200, {
        data: await service.listAdminOverviewOwners({
          q: url.searchParams.get('q') || '',
          publishedOnly: url.searchParams.get('publishedOnly'),
          limit: Number(url.searchParams.get('limit') || 50),
          offset: Number(url.searchParams.get('offset') || 0),
        }),
      });
    }

    params = match(url.pathname, '/admin/overview/customers/:id');
    if (request.method === 'GET' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.adminOverview);
      return send(request, response, 200, {
        data: await service.getAdminCustomerSupportProfile(params.id),
      });
    }

    params = match(url.pathname, '/admin/overview/investors/:id/profile-review-requests');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.adminOverview);
      const body = await readJson(request);
      return send(request, response, 201, {
        data: await service.createProfileReviewRequest(actor.userId, params.id, {
          reason: body.reason,
          requiredFields: body.requiredFields || body.required_fields || [],
          adminNote: body.adminNote ?? body.admin_note ?? null,
        }),
      });
    }

    params = match(url.pathname, '/admin/overview/profile-review-requests/:id/complete');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.adminOverview);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.completeProfileReviewRequest(actor.userId, params.id, {
          status: body.status || 'done',
          adminNote: body.adminNote ?? body.admin_note ?? null,
        }),
      });
    }

    if (request.method === 'GET' && url.pathname === '/me/profile-review-requests' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.getMyIdentity);
      return send(request, response, 200, {
        data: await service.listMyProfileReviewRequests(actor.userId),
      });
    }

    if (request.method === 'GET' && url.pathname === '/admin/overview/project-update-overdue' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.adminOverview);
      return send(request, response, 200, {
        data: await service.listProjectUpdateOverdue({
          limit: Number(url.searchParams.get('limit') || 100),
        }),
      });
    }

    params = match(url.pathname, '/admin/overview/project-update-overdue/:projectId/actions');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.adminOverview);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.actOnProjectUpdateOverdue(actor.userId, params.projectId, {
          action: body.action,
          note: body.note ?? null,
        }),
      });
    }

    params = match(url.pathname, '/admin/projects/:id/status-update-cadence');
    if (request.method === 'PUT' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.adminOverview);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.setProjectStatusUpdateCadence(
          actor.userId,
          params.id,
          body.statusUpdateCadenceDays ?? body.cadenceDays ?? body.days,
        ),
      });
    }

    params = match(url.pathname, '/admin/projects/:id/status-update-history');
    if (request.method === 'GET' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.adminOverview);
      return send(request, response, 200, {
        data: await service.listProjectStatusUpdateHistory(params.id, {
          limit: Number(url.searchParams.get('limit') || 50),
        }),
      });
    }

    if (request.method === 'GET' && url.pathname === '/admin/settings/service-charge' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.adminSettings);
      await service.assertRoleRouteAccess(actor.roles, 'settings');
      return send(request, response, 200, { data: await service.getServiceChargeSettings() });
    }

    if (request.method === 'PUT' && url.pathname === '/admin/settings/service-charge' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.adminSettings);
      await service.assertRoleRouteAccess(actor.roles, 'settings');
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.updateServiceChargeSettings(
          actor.userId,
          body.administrationFeeBps ?? body.serviceChargeBps ?? body.bps,
        ),
      });
    }

    if (request.method === 'GET' && url.pathname === '/admin/settings/role-access' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.adminSettings);
      await service.assertRoleRouteAccess(actor.roles, 'settings');
      return send(request, response, 200, { data: await service.getRoleRouteAccess() });
    }

    if (request.method === 'PUT' && url.pathname === '/admin/settings/role-access' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.adminSettings);
      await service.assertRoleRouteAccess(actor.roles, 'settings');
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.updateRoleRouteAccess(actor.userId, body),
      });
    }

    if (request.method === 'POST' && url.pathname === '/admin/staff-users' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.adminStaffUsers);
      await service.assertRoleRouteAccess(actor.roles, 'settings');
      const body = await readJson(request);
      return send(request, response, 201, {
        data: await service.createStaffUser(actor.userId, body),
      });
    }

    params = match(url.pathname, '/admin/projects/:id/share-units');
    if (request.method === 'PUT' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.adminShareUnits);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.setProjectShareUnits(
          params.id,
          actor.userId,
          body.totalUnits ?? body.shareCount ?? body.units,
        ),
      });
    }

    params = match(url.pathname, '/admin/projects/:id/disbursement-rules');
    if (params && usePostgres) {
      if (request.method === 'GET') {
        const actor = await resolveActor(request, ROUTE_ROLES.adminDisbursementRules);
        return send(request, response, 200, {
          data: await service.getProjectDisbursementRules(params.id),
        });
      }
      if (request.method === 'PUT') {
        const actor = await resolveActor(request, ROUTE_ROLES.adminDisbursementRules);
        const body = await readJson(request);
        return send(request, response, 200, {
          data: await service.setProjectDisbursementRules(params.id, actor.userId, {
            rules: body.rules,
            notes: body.notes,
          }),
        });
      }
    }

    if (request.method === 'GET' && url.pathname === '/admin/disbursement-requests' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.adminDisbursements);
      await service.assertRoleRouteAccess(actor.roles, 'disbursements');
      return send(request, response, 200, {
        data: await service.listAdminDisbursementRequests({
          status: url.searchParams.get('status'),
          projectId: url.searchParams.get('projectId'),
          limit: Number(url.searchParams.get('limit') || 100),
        }),
      });
    }

    if (request.method === 'GET' && url.pathname === '/admin/disbursement-ledger' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.adminDisbursements);
      await service.assertRoleRouteAccess(actor.roles, 'disbursements');
      return send(request, response, 200, {
        data: await service.getAdminDisbursementLedger({
          projectId: url.searchParams.get('projectId'),
          limit: Number(url.searchParams.get('limit') || 100),
        }),
      });
    }

    params = match(url.pathname, '/admin/disbursement-requests/:id/start-review');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.adminDisbursements);
      await service.assertRoleRouteAccess(actor.roles, 'disbursements');
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.startDisbursementReview(params.id, actor.userId, body),
      });
    }

    params = match(url.pathname, '/admin/disbursement-requests/:id/approve');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.adminDisbursements);
      await service.assertRoleRouteAccess(actor.roles, 'disbursements');
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.approveDisbursement(params.id, actor.userId, body),
      });
    }

    params = match(url.pathname, '/admin/disbursement-requests/:id/reject');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.adminDisbursements);
      await service.assertRoleRouteAccess(actor.roles, 'disbursements');
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.rejectDisbursement(params.id, actor.userId, body),
      });
    }

    params = match(url.pathname, '/admin/disbursement-requests/:id/record-paid');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.adminDisbursements);
      await service.assertRoleRouteAccess(actor.roles, 'disbursements');
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.recordDisbursementPaid(params.id, actor.userId, body),
      });
    }

    params = match(url.pathname, '/owner/projects/:id/disbursement-requests');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.ownerDisbursementRequest);
      const body = await readJson(request);
      return send(request, response, 201, {
        data: await service.createOwnerDisbursementRequest(params.id, actor.userId, {
          amountPoisha: body.amountPoisha,
          explanation: body.explanation,
          projectUpdateText: body.projectUpdateText ?? body.projectUpdate,
        }),
      });
    }

    if (request.method === 'GET' && url.pathname === '/owner/disbursement-requests' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.listOwnerDisbursements);
      return send(request, response, 200, {
        data: await service.listOwnerDisbursementRequests(actor.userId, {
          status: url.searchParams.get('status'),
        }),
      });
    }

    // --- Phase 6: Exit requests / Exit payment (display-only) ---
    params = match(url.pathname, '/investments/:id/exit-requests');
    if (params && usePostgres) {
      if (request.method === 'POST') {
        const actor = await resolveActor(request, ROUTE_ROLES.exitRequest);
        const body = await readJson(request);
        return send(request, response, 201, {
          data: await service.submitExitRequest(params.id, body, actor.userId, {
            requestContext: requestContext(request),
          }),
        });
      }
      if (request.method === 'GET') {
        const actor = await resolveActor(request, ROUTE_ROLES.listMyExitRequests);
        const canViewAny = hasAnyRole(actor.roles, ['super_admin', 'finance_officer', 'auditor']);
        return send(request, response, 200, {
          data: await service.listExitRequestsForAllocation(params.id, actor.userId, { canViewAny }),
        });
      }
    }

    params = match(url.pathname, '/investments/:id/exit-eligibility');
    if (request.method === 'GET' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.getInvestment);
      const canViewAny = hasAnyRole(actor.roles, ['super_admin', 'finance_officer', 'auditor']);
      return send(request, response, 200, {
        data: await service.getExitEligibility(params.id, actor.userId, { canViewAny }),
      });
    }

    if (request.method === 'GET' && url.pathname === '/exit-requests' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.listMyExitRequests);
      const canViewAny = hasAnyRole(actor.roles, ['super_admin', 'finance_officer', 'auditor']);
      const investorId = url.searchParams.get('investorId');
      const allocationId = url.searchParams.get('allocationId');
      if (investorId && !canViewAny) {
        throw new DomainError('FORBIDDEN', 'You cannot filter exit requests for other investors', 403);
      }
      return send(request, response, 200, {
        data: await service.listMyExitRequests(actor.userId, {
          canViewAny,
          investorId: investorId || null,
          allocationId: allocationId || null,
        }),
      });
    }

    if (request.method === 'GET' && url.pathname === '/admin/exit-requests' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.listAdminExitRequests);
      const status = url.searchParams.get('status');
      return send(request, response, 200, {
        data: await service.listAdminExitRequests({
          status: status || null,
        }),
      });
    }

    params = match(url.pathname, '/admin/exit-requests/:id/start-review');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.reviewExitRequest);
      return send(request, response, 200, {
        data: await service.startExitReview(params.id, actor.userId, {
          requestContext: requestContext(request),
        }),
      });
    }

    params = match(url.pathname, '/admin/exit-requests/:id/approve');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.reviewExitRequest);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.approveExitRequest(params.id, body, actor.userId, {
          requestContext: requestContext(request),
        }),
      });
    }

    params = match(url.pathname, '/admin/exit-requests/:id/reject');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.reviewExitRequest);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.rejectExitRequest(params.id, body, actor.userId, {
          requestContext: requestContext(request),
        }),
      });
    }

    params = match(url.pathname, '/admin/exit-requests/:id/complete');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.reviewExitRequest);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.completeExitRequest(params.id, body, actor.userId, {
          requestContext: requestContext(request),
        }),
      });
    }

    params = match(url.pathname, '/exit-requests/:id/cancel');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.cancelExitRequest);
      return send(request, response, 200, {
        data: await service.cancelExitRequest(params.id, actor.userId, {
          requestContext: requestContext(request),
        }),
      });
    }

    params = match(url.pathname, '/exit-requests/:id');
    if (request.method === 'GET' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.getExitRequest);
      const canViewAny = hasAnyRole(actor.roles, ['super_admin', 'finance_officer', 'auditor']);
      return send(request, response, 200, {
        data: await service.getExitRequest(params.id, actor.userId, { canViewAny }),
      });
    }

    // --- Phase 5: projections / Approved distributions ---
    if (request.method === 'GET' && url.pathname === '/admin/allocations' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.listAdminAllocations);
      const investorId = url.searchParams.get('investorId');
      const q = url.searchParams.get('q');
      const args = {
        status: url.searchParams.get('status') || 'active',
        projectId: url.searchParams.get('projectId'),
        investorId,
        q,
        limit: Number(url.searchParams.get('limit') || 100),
      };
      const data = (investorId || q)
        ? await service.listAdminAllocationsFiltered(args)
        : await service.listAdminAllocations(args);
      return send(request, response, 200, { data });
    }

    if (request.method === 'GET' && url.pathname === '/admin/profit-confirmations' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.listAdminProfitConfirmations);
      const allocationId = url.searchParams.get('allocationId');
      return send(request, response, 200, {
        data: await service.listAdminProfitConfirmations({
          allocationId: allocationId || null,
        }),
      });
    }

    params = match(url.pathname, '/admin/allocations/:id/profit-confirmations');
    if (params && usePostgres) {
      if (request.method === 'POST') {
        const actor = await resolveActor(request, ROUTE_ROLES.profitConfirmation);
        const body = await readJson(request);
        return send(request, response, 201, {
          data: await service.declareProfitConfirmation(params.id, body, actor.userId, {
            requestContext: requestContext(request),
          }),
        });
      }
      if (request.method === 'GET') {
        const actor = await resolveActor(request, ROUTE_ROLES.listAdminProfitConfirmations);
        return send(request, response, 200, {
          data: await service.listApprovedDistributions(params.id, actor.userId, { canViewAny: true }),
        });
      }
    }

    params = match(url.pathname, '/investments/:id/approved-distributions');
    if (request.method === 'GET' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.listApprovedDistributions);
      const canViewAny = hasAnyRole(actor.roles, ['super_admin', 'finance_officer', 'auditor']);
      return send(request, response, 200, {
        data: await service.listApprovedDistributions(params.id, actor.userId, { canViewAny }),
      });
    }

    params = match(url.pathname, '/profit-confirmations/:id');
    if (request.method === 'GET' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.getProfitConfirmation);
      const canViewAny = hasAnyRole(actor.roles, ['super_admin', 'finance_officer', 'auditor']);
      return send(request, response, 200, {
        data: await service.getProfitConfirmation(params.id, actor.userId, { canViewAny }),
      });
    }

    if (request.method === 'GET' && url.pathname === '/investments') {
      const actor = await resolveActor(request, ROUTE_ROLES.listInvestments);
      if (usePostgres) {
        const canViewAny = hasAnyRole(actor.roles, ['super_admin', 'finance_officer', 'auditor']);
        const investorId = url.searchParams.get('investorId');
        const projectId = url.searchParams.get('projectId');
        if (investorId && !canViewAny) {
          throw new DomainError('FORBIDDEN', 'You cannot filter investments for other investors', 403);
        }
        // Investor shell must never silently aggregate every investor's holdings for staff.
        // Default to the caller's own allocations unless staff explicitly passes investorId/projectId.
        const scopedInvestorId = investorId || (canViewAny && !projectId ? actor.userId : null);
        return send(request, response, 200, {
          data: await service.listInvestments({
            actorId: actor.userId,
            canViewAny,
            investorId: scopedInvestorId,
            projectId: projectId || null,
          }),
        });
      }
      return send(request, response, 200, { data: [] });
    }

    params = match(url.pathname, '/investments/:id');
    if (request.method === 'GET' && params) {
      const actor = await resolveActor(request, ROUTE_ROLES.getInvestment);
      if (usePostgres) {
        const canViewAny = hasAnyRole(actor.roles, ['super_admin', 'finance_officer', 'auditor']);
        const investorFilter = canViewAny ? undefined : actor.userId;
        return send(request, response, 200, { data: await service.getInvestment(params.id, investorFilter) });
      }
      return send(request, response, 200, { data: await service.getInvestment(params.id) });
    }

    // ---- Phase 7: Referral rewards ----
    if (request.method === 'GET' && url.pathname === '/referrals/me' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.getMyReferrals);
      return send(request, response, 200, {
        data: await service.getMyReferralDashboard(actor.userId),
      });
    }

    if (request.method === 'POST' && url.pathname === '/referrals/attach' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.attachReferral);
      const body = await readJson(request);
      const ip = clientIp(request);
      enforceRateLimit(DomainError, `referral-attach:ip:${ip}`, AUTH_RATE_LIMITS.referralAttach);
      enforceRateLimit(
        DomainError,
        `referral-attach:user:${actor.userId}`,
        AUTH_RATE_LIMITS.referralAttach,
      );
      return send(request, response, 201, {
        data: await service.attachReferralCode(actor.userId, body, {
          requestContext: requestContext(request),
        }),
      });
    }

    if (request.method === 'GET' && url.pathname === '/referrals/code' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.getMyReferrals);
      return send(request, response, 200, {
        data: await service.ensureMyReferralCode(actor.userId),
      });
    }

    if (request.method === 'GET' && url.pathname === '/admin/referral-settings' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.getReferralSettings);
      return send(request, response, 200, { data: await service.getReferralSettings() });
    }

    if (request.method === 'PUT' && url.pathname === '/admin/referral-settings' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.updateReferralSettings);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.updateReferralSettings(body, actor.userId, {
          requestContext: requestContext(request),
        }),
      });
    }

    if (request.method === 'GET' && url.pathname === '/admin/referral-rewards' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.listAdminReferralRewards);
      const status = url.searchParams.get('status') || null;
      const limit = url.searchParams.get('limit') || 100;
      return send(request, response, 200, {
        data: await service.listAdminReferralRewards({ status, limit }),
      });
    }

    params = match(url.pathname, '/admin/referral-rewards/:id/approve');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.reviewReferralReward);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.approveReferralReward(params.id, body, actor.userId, {
          requestContext: requestContext(request),
        }),
      });
    }

    params = match(url.pathname, '/admin/referral-rewards/:id/reject');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.reviewReferralReward);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.rejectReferralReward(params.id, body, actor.userId, {
          requestContext: requestContext(request),
        }),
      });
    }

    params = match(url.pathname, '/admin/referral-rewards/:id/reverse');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.reviewReferralReward);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.reverseReferralReward(params.id, body, actor.userId, {
          requestContext: requestContext(request),
        }),
      });
    }

    params = match(url.pathname, '/referral-rewards/:id');
    if (request.method === 'GET' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.getReferralReward);
      const canViewAny = hasAnyRole(actor.roles, ['super_admin', 'finance_officer', 'auditor']);
      return send(request, response, 200, {
        data: await service.getReferralReward(params.id, actor.userId, { canViewAny }),
      });
    }

    // ---- Phase 8: Performance reports + Available payable + audit ----
    if (request.method === 'GET' && url.pathname === '/owner/performance-reports' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.listOwnerPerformanceReports);
      const projectId = url.searchParams.get('projectId') || null;
      const status = url.searchParams.get('status') || null;
      const limit = url.searchParams.get('limit') || 100;
      return send(request, response, 200, {
        data: await service.listOwnerPerformanceReports(actor.userId, { projectId, status, limit }),
      });
    }

    params = match(url.pathname, '/owner/projects/:id/performance-reports');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.submitPerformanceReport);
      const body = await readJson(request);
      return send(request, response, 201, {
        data: await service.submitPerformanceReport(params.id, body, actor.userId, {
          requestContext: requestContext(request),
        }),
      });
    }

    if (request.method === 'GET' && url.pathname === '/admin/performance-reports' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.listAdminPerformanceReports);
      const status = url.searchParams.get('status') || null;
      const projectId = url.searchParams.get('projectId') || null;
      const limit = url.searchParams.get('limit') || 100;
      return send(request, response, 200, {
        data: await service.listAdminPerformanceReports({ status, projectId, limit }),
      });
    }

    params = match(url.pathname, '/admin/performance-reports/:id/start-review');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.reviewPerformanceReport);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.startPerformanceReportReview(params.id, body, actor.userId, {
          requestContext: requestContext(request),
        }),
      });
    }

    params = match(url.pathname, '/admin/performance-reports/:id/approve');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.reviewPerformanceReport);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.approvePerformanceReport(params.id, body, actor.userId, {
          requestContext: requestContext(request),
        }),
      });
    }

    params = match(url.pathname, '/admin/performance-reports/:id/reject');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.reviewPerformanceReport);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.rejectPerformanceReport(params.id, body, actor.userId, {
          requestContext: requestContext(request),
        }),
      });
    }

    params = match(url.pathname, '/admin/performance-reports/:id/generate-distributions');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.reviewPerformanceReport);
      return send(request, response, 200, {
        data: await service.generateDistributionsFromPerformanceReport(params.id, actor.userId, {
          requestContext: requestContext(request),
        }),
      });
    }

    params = match(url.pathname, '/performance-reports/:id');
    if (request.method === 'GET' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.getPerformanceReport);
      const canViewAny = hasAnyRole(actor.roles, ['super_admin', 'finance_officer', 'auditor']);
      return send(request, response, 200, {
        data: await service.getPerformanceReport(params.id, actor.userId, { canViewAny }),
      });
    }

    if (request.method === 'GET' && url.pathname === '/investor/available-payable' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.getAvailablePayable);
      const canViewAny = hasAnyRole(actor.roles, ['super_admin', 'finance_officer', 'auditor']);
      const investorId = canViewAny && url.searchParams.get('investorId')
        ? url.searchParams.get('investorId')
        : actor.userId;
      if (!canViewAny && investorId !== actor.userId) {
        return send(request, response, 403, { error: { code: 'FORBIDDEN', message: 'You can only view your own Available payable amount' } });
      }
      // Investors only (or staff viewing); owners without investor role blocked by ROUTE_ROLES
      return send(request, response, 200, {
        data: await service.getInvestorAvailablePayable(investorId),
      });
    }




    params = match(url.pathname, '/projects/:id/share-link');
    if (request.method === 'GET' && params && usePostgres) {
      const actor = await resolveActor(request);
      await assertPasswordChangeNotRequired(actor);
      return send(request, response, 200, {
        data: await service.getProjectShareLink(actor.userId, params.id),
      });
    }

    // ---- Investor pack ----
    if (request.method === 'GET' && url.pathname === '/investor/home' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.investorHome);
      return send(request, response, 200, { data: await service.getInvestorHome(actor.userId) });
    }

    if (request.method === 'GET' && url.pathname === '/investor/maturity-report' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.investorMaturityReport);
      return send(request, response, 200, { data: await service.getInvestorMaturityReport(actor.userId) });
    }

    if (request.method === 'GET' && url.pathname === '/investor/referral-reward-payout-requests' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.investorReferralPayout);
      return send(request, response, 200, {
        data: await service.listMyReferralRewardPayoutRequests(actor.userId, {
          limit: url.searchParams.get('limit') || 50,
        }),
      });
    }

    if (request.method === 'POST' && url.pathname === '/investor/referral-reward-payout-requests' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.investorReferralPayout);
      const body = await readJson(request);
      return send(request, response, 201, {
        data: await service.createReferralRewardPayoutRequest(actor.userId, body, {
          requestContext: requestContext(request),
        }),
      });
    }

    if (request.method === 'GET' && url.pathname === '/admin/referral-reward-payout-requests' && usePostgres) {
      await resolveActor(request, ROUTE_ROLES.adminReferralPayout);
      return send(request, response, 200, {
        data: await service.listAdminReferralRewardPayoutRequests({
          status: url.searchParams.get('status') || null,
          limit: url.searchParams.get('limit') || 100,
        }),
      });
    }

    params = match(url.pathname, '/admin/referral-reward-payout-requests/:id/start-review');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.adminReferralPayout);
      return send(request, response, 200, {
        data: await service.startReferralRewardPayoutReview(params.id, actor.userId, {
          requestContext: requestContext(request),
        }),
      });
    }

    params = match(url.pathname, '/admin/referral-reward-payout-requests/:id/approve');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.adminReferralPayout);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.approveReferralRewardPayoutRequest(params.id, actor.userId, body, {
          requestContext: requestContext(request),
        }),
      });
    }

    params = match(url.pathname, '/admin/referral-reward-payout-requests/:id/reject');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.adminReferralPayout);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.rejectReferralRewardPayoutRequest(params.id, actor.userId, body, {
          requestContext: requestContext(request),
        }),
      });
    }

    params = match(url.pathname, '/admin/referral-reward-payout-requests/:id/record-paid');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.adminReferralPayout);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.recordReferralRewardPayoutPaid(params.id, actor.userId, body, {
          requestContext: requestContext(request),
        }),
      });
    }

    if (request.method === 'POST' && url.pathname === '/investor/referral-reward/apply-to-application' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.investorApplyReferralReward);
      const body = await readJson(request);
      return send(request, response, 201, {
        data: await service.applyReferralRewardTowardShares(actor.userId, body, {
          requestContext: requestContext(request),
        }),
      });
    }

    if (request.method === 'GET' && url.pathname === '/investor/referrals/purchase-history' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.referralPurchaseHistory);
      return send(request, response, 200, {
        data: await service.getReferralPurchaseHistory(actor.userId),
      });
    }

    if (request.method === 'GET' && url.pathname === '/investor/support/cases' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.investorSupport);
      return send(request, response, 200, {
        data: await service.listMySupportCases(actor.userId, {
          limit: url.searchParams.get('limit') || 50,
        }),
      });
    }

    if (request.method === 'POST' && url.pathname === '/investor/support/cases' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.investorSupport);
      const body = await readJson(request);
      return send(request, response, 201, {
        data: await service.createSupportCase(actor.userId, body, {
          requestContext: requestContext(request),
        }),
      });
    }

    params = match(url.pathname, '/investor/support/cases/:id');
    if (request.method === 'GET' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.investorSupport);
      return send(request, response, 200, {
        data: await service.getSupportCase(params.id, actor.userId, { isStaff: false }),
      });
    }

    params = match(url.pathname, '/investor/support/cases/:id/messages');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.investorSupport);
      const body = await readJson(request);
      return send(request, response, 201, {
        data: await service.addSupportMessage(params.id, actor.userId, body, { isStaff: false }, {
          requestContext: requestContext(request),
        }),
      });
    }

    if (request.method === 'GET' && url.pathname === '/admin/support/cases' && usePostgres) {
      await resolveActor(request, ROUTE_ROLES.adminSupport);
      return send(request, response, 200, {
        data: await service.listAdminSupportCases({
          status: url.searchParams.get('status') || null,
          limit: url.searchParams.get('limit') || 100,
        }),
      });
    }

    params = match(url.pathname, '/admin/support/cases/:id');
    if (request.method === 'GET' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.adminSupport);
      return send(request, response, 200, {
        data: await service.getSupportCase(params.id, actor.userId, { isStaff: true }),
      });
    }

    params = match(url.pathname, '/admin/support/cases/:id/messages');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.adminSupport);
      const body = await readJson(request);
      return send(request, response, 201, {
        data: await service.addSupportMessage(params.id, actor.userId, body, { isStaff: true }, {
          requestContext: requestContext(request),
        }),
      });
    }

    params = match(url.pathname, '/admin/support/cases/:id/close');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.adminSupport);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.closeSupportCase(params.id, actor.userId, body, {
          requestContext: requestContext(request),
        }),
      });
    }

    if (request.method === 'POST' && url.pathname === '/investor/project-owner-access-request' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.investorOwnerAccess);
      const body = await readJson(request);
      return send(request, response, 201, {
        data: await service.requestProjectOwnerAccess(actor.userId, body, {
          requestContext: requestContext(request),
        }),
      });
    }

    if (request.method === 'GET' && url.pathname === '/investor/project-owner-access-requests' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.investorOwnerAccess);
      return send(request, response, 200, {
        data: await service.listMyProjectOwnerAccessRequests(actor.userId),
      });
    }

    if (request.method === 'GET' && url.pathname === '/admin/project-owner-access-requests' && usePostgres) {
      await resolveActor(request, ROUTE_ROLES.adminOwnerAccess);
      return send(request, response, 200, {
        data: await service.listAdminProjectOwnerAccessRequests({
          status: url.searchParams.get('status') || null,
          limit: url.searchParams.get('limit') || 100,
        }),
      });
    }

    params = match(url.pathname, '/admin/project-owner-access-requests/:id/review');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.adminOwnerAccess);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.reviewProjectOwnerAccessRequest(params.id, actor.userId, body, {
          requestContext: requestContext(request),
        }),
      });
    }

    // ---- Final Demo / UAT routes (A–M) ----
    if (request.method === 'GET' && url.pathname === '/staging/meta' && usePostgres) {
      await resolveActor(request, ROUTE_ROLES.stagingMeta);
      return send(request, response, 200, {
        data: {
          environment: 'TEST/STAGING',
          bannersOn: true,
          ...service.getStorageBackendInfo(),
          demoCalc: service.getDemoCalcReport(),
          productionReady: false,
          googlePlay: false,
          liveGateways: false,
        },
      });
    }

    if (request.method === 'GET' && url.pathname === '/admin/users' && usePostgres) {
      await resolveActor(request, ROUTE_ROLES.listAdminUsers);
      const data = await service.listAdminUsers({
        q: url.searchParams.get('q') || '',
        role: url.searchParams.get('role') || null,
        lifecycle: url.searchParams.get('lifecycle') || null,
        verificationStatus: url.searchParams.get('verificationStatus') || null,
        limit: url.searchParams.get('limit') || 50,
        offset: url.searchParams.get('offset') || 0,
      });
      return send(request, response, 200, { data });
    }

    params = match(url.pathname, '/admin/users/:id');
    if (request.method === 'GET' && params && usePostgres) {
      await resolveActor(request, ROUTE_ROLES.getAdminUser);
      return send(request, response, 200, { data: await service.getAdminUserProfile(params.id) });
    }
    if (request.method === 'PATCH' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.updateAdminUser);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.updateAdminUserFields(params.id, actor.userId, body, requestContext(request)),
      });
    }

    params = match(url.pathname, '/admin/users/:id/lifecycle');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.setUserLifecycle);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.setUserLifecycle(params.id, actor.userId, body, requestContext(request)),
      });
    }

    params = match(url.pathname, '/admin/users/:id/hard-delete');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.setUserLifecycle);
      const data = await service.tryHardDeleteUnusedStagingUser(params.id, actor.userId, requestContext(request));
      return send(request, response, 200, { data });
    }

    if (request.method === 'GET' && url.pathname === '/me/identity' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.getMyIdentity);
      return send(request, response, 200, { data: await service.getMyIdentity(actor.userId) });
    }
    if (request.method === 'PUT' && url.pathname === '/me/identity' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.updateMyIdentity);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.upsertIdentityVerification(actor.userId, actor.userId, body, requestContext(request)),
      });
    }

    params = match(url.pathname, '/admin/users/:id/identity/review');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.reviewIdentity);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.reviewIdentityVerification(params.id, actor.userId, body, requestContext(request)),
      });
    }

    if (request.method === 'GET' && url.pathname === '/me/profile-completion' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.getProfileCompletion);
      return send(request, response, 200, { data: await service.getProfileCompletion(actor.userId) });
    }
    params = match(url.pathname, '/admin/users/:id/profile-completion');
    if (request.method === 'GET' && params && usePostgres) {
      await resolveActor(request, ROUTE_ROLES.getAdminUser);
      return send(request, response, 200, { data: await service.getProfileCompletion(params.id) });
    }

    if (request.method === 'GET' && url.pathname === '/me/related-persons' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.relatedPersonsOwn);
      return send(request, response, 200, {
        data: await service.listRelatedPersons(actor.userId, actor.userId, { roles: actor.roles }),
      });
    }
    if (request.method === 'POST' && url.pathname === '/me/related-persons' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.relatedPersonsOwn);
      const body = await readJson(request);
      const row = await service.createRelatedPerson(actor.userId, actor.userId, body, requestContext(request));
      return send(request, response, 201, { data: row });
    }
    params = match(url.pathname, '/admin/users/:id/related-persons');
    if (request.method === 'GET' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.relatedPersonsCompliance);
      return send(request, response, 200, {
        data: await service.listRelatedPersons(params.id, actor.userId, { roles: actor.roles }),
      });
    }

    if (request.method === 'POST' && url.pathname === '/documents' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.uploadDocument);
      const body = await readJson(request);
      const doc = await service.uploadPrivateDocument({
        ownerUserId: actor.userId,
        actorId: actor.userId,
        subjectType: body.subjectType || 'other',
        subjectId: body.subjectId || null,
        documentKind: body.documentKind || 'upload',
        filename: body.filename,
        mimeType: body.mimeType,
        base64Content: body.base64Content,
        requestContext: requestContext(request),
      });
      return send(request, response, 201, { data: doc });
    }
    params = match(url.pathname, '/documents/:id');
    if (request.method === 'GET' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.getDocument);
      return send(request, response, 200, {
        data: await service.getPrivateDocumentMeta(params.id, actor.userId, {
          roles: actor.roles,
          requestContext: requestContext(request),
        }),
      });
    }
    params = match(url.pathname, '/documents/:id/signed-url');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.getDocument);
      return send(request, response, 200, {
        data: await service.createDocumentSignedUrl(params.id, actor.userId, {
          roles: actor.roles,
          requestContext: requestContext(request),
        }),
      });
    }
    params = match(url.pathname, '/documents/:id/content');
    if (request.method === 'GET' && params && usePostgres) {
      const actorId = url.searchParams.get('actor');
      const exp = url.searchParams.get('exp');
      const sig = url.searchParams.get('sig');
      const { document, bytes } = await service.readDocumentContent(params.id, { actorId, exp, sig });
      response.writeHead(200, {
        'content-type': document.mimeType,
        'content-length': bytes.length,
        'content-disposition': `attachment; filename="${document.sanitizedFilename}"`,
        'x-fictional-demo': 'FICTIONAL DEMO - NOT A REAL DOCUMENT',
        ...corsHeaders(request),
      });
      return response.end(bytes);
    }

    params = match(url.pathname, '/owner/businesses/:id/verification-items');
    if (request.method === 'GET' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.businessVerification);
      await service.ensureBusinessVerificationItems(params.id);
      return send(request, response, 200, { data: { items: await service.listBusinessVerificationItems(params.id) } });
    }
    params = match(url.pathname, '/owner/businesses/:id/verification-items/:code');
    if (request.method === 'PATCH' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.businessVerification);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.updateBusinessVerificationItem(
          params.id, params.code, actor.userId, body, requestContext(request),
        ),
      });
    }
    params = match(url.pathname, '/admin/businesses/:id/approve');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.reviewIdentity);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.approveBusinessProfile(params.id, actor.userId, body.note, requestContext(request)),
      });
    }

    // ----- Legal documents / agreement acceptance -----
    if (request.method === 'GET' && url.pathname === '/legal/production-gate' && usePostgres) {
      return send(request, response, 200, { data: await service.getLegalProductionGate() });
    }
    if (request.method === 'GET' && url.pathname === '/legal/signup-packet' && usePostgres) {
      const role = url.searchParams.get('role') || 'investor';
      return send(request, response, 200, { data: await service.getSignupLegalPacket(role) });
    }
    params = match(url.pathname, '/legal/documents/:type/published');
    if (params && request.method === 'GET' && usePostgres) {
      const language = url.searchParams.get('language') || 'en';
      return send(request, response, 200, {
        data: await service.getPublishedLegalDocument(params.type, language),
      });
    }
    if (request.method === 'GET' && url.pathname === '/admin/legal-documents' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.legalDocumentsAdmin);
      return send(request, response, 200, { data: await service.listLegalDocumentsAdmin() });
    }
    params = match(url.pathname, '/admin/legal-documents/:type/drafts');
    if (params && request.method === 'POST' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.legalDocumentsAdmin);
      const body = await readJson(request);
      return send(request, response, 201, {
        data: await service.createLegalDocumentDraft(params.type, actor.userId, body),
      });
    }
    params = match(url.pathname, '/admin/legal-document-versions/:id');
    if (params && request.method === 'GET' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.legalDocumentsPublic);
      return send(request, response, 200, { data: await service.getLegalDocumentVersion(params.id) });
    }
    if (params && request.method === 'PATCH' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.legalDocumentsAdmin);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.updateLegalDocumentDraft(params.id, actor.userId, body),
      });
    }
    params = match(url.pathname, '/admin/legal-document-versions/:id/publish');
    if (params && request.method === 'POST' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.legalDocumentsAdmin);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.publishLegalDocumentVersion(params.id, actor.userId, body),
      });
    }
    params = match(url.pathname, '/admin/legal-document-versions/:id/download');
    if (params && request.method === 'GET' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.legalDocumentsAdmin);
      const format = url.searchParams.get('format') || 'html';
      const asJson = url.searchParams.get('json') === '1' || (request.headers.accept || '').includes('application/json');
      const file = await service.downloadLegalDocumentVersion(params.id, format);
      if (asJson) {
        return send(request, response, 200, { data: file });
      }
      response.writeHead(200, {
        'content-type': file.contentType,
        'content-disposition': `attachment; filename="${file.filename}"`,
        ...corsHeaders(request),
      });
      response.end(file.body);
      return;
    }
    params = match(url.pathname, '/admin/legal-documents/:id/audit');
    if (params && request.method === 'GET' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.legalDocumentsAudit);
      return send(request, response, 200, { data: await service.listLegalDocumentAudit(params.id) });
    }
    if (request.method === 'GET' && url.pathname === '/me/legal/pending' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.legalAcceptOwn);
      const me = await authService.getUserById(actor.userId);
      return send(request, response, 200, {
        data: await service.getPendingLegalGate(actor.userId, me.roles || actor.roles || []),
      });
    }
    if (request.method === 'POST' && url.pathname === '/me/legal/pending/accept' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.legalAcceptOwn);
      const body = await readJson(request);
      const me = await authService.getUserById(actor.userId);
      return send(request, response, 200, {
        data: await service.completePendingLegalGate(
          actor.userId,
          { ...body, roles: me.roles || actor.roles || [] },
          requestContext(request),
        ),
      });
    }
    if (request.method === 'GET' && url.pathname === '/me/legal/acceptances' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.legalAcceptOwn);
      return send(request, response, 200, { data: await service.listMyLegalAcceptances(actor.userId) });
    }
    params = match(url.pathname, '/me/legal/acceptances/:id');
    if (params && request.method === 'GET' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.legalAcceptOwn);
      const isStaff = hasAnyRole(actor.roles, ROUTE_ROLES.legalDocumentsAudit);
      return send(request, response, 200, {
        data: await service.getLegalAcceptance(params.id, actor.userId, isStaff),
      });
    }
    params = match(url.pathname, '/applications/:id/investment-agreement/preview');
    if (params && request.method === 'GET' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.legalPurchaseAgreement);
      return send(request, response, 200, {
        data: await service.previewProjectInvestmentAgreement({
          applicationId: params.id,
          investorId: actor.userId,
        }),
      });
    }
    params = match(url.pathname, '/applications/:id/investment-agreement/accept');
    if (params && request.method === 'POST' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.legalPurchaseAgreement);
      const body = await readJson(request);
      return send(request, response, 200, {
        data: await service.acceptProjectInvestmentAgreement(
          {
            applicationId: params.id,
            investorId: actor.userId,
            viewedAt: body.viewedAt,
            capitalMayBeLostAck: body.capitalMayBeLostAck,
            projectionNotGuaranteedAck: body.projectionNotGuaranteedAck,
            templateVersionId: body.templateVersionId,
          },
          requestContext(request),
        ),
      });
    }
    params = match(url.pathname, '/admin/project-investment-agreements/:id/resend-email');
    if (params && request.method === 'POST' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.legalResendPurchaseEmail);
      return send(request, response, 200, {
        data: await service.resendProjectInvestmentAgreementEmail(params.id, actor.userId),
      });
    }

    if (request.method === 'GET' && url.pathname === '/me/agreements' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.myAgreements);
      return send(request, response, 200, { data: await service.getMyAgreements(actor.userId) });
    }
    params = match(url.pathname, '/admin/agreements/:id/resend-email');
    if (request.method === 'POST' && params && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.resendAgreementEmail);
      return send(request, response, 200, {
        data: await service.resendAgreementEmail(params.id, actor.userId, requestContext(request)),
      });
    }


    if (request.method === 'GET' && url.pathname === '/admin/audit-logs' && usePostgres) {
      const actor = await resolveActor(request, ROUTE_ROLES.listAuditLogs);
      const prefixes = url.searchParams.get('prefix') || url.searchParams.get('prefixes') || null;
      const limit = url.searchParams.get('limit') || 100;
      return send(request, response, 200, {
        data: await service.listAuditLogs({ prefixes, limit }),
      });
    }

    return send(request, response, 404, { error: { code: 'ROUTE_NOT_FOUND', message: 'Route was not found' } });
  } catch (error) {
    if (error instanceof DomainError) {
      if (error.code === 'RATE_LIMITED' && error.retryAfterSeconds) {
        response.setHeader('retry-after', String(error.retryAfterSeconds));
      }
      return send(request, response, error.httpStatus, { error: { code: error.code, message: error.message } });
    }
    if (error instanceof SyntaxError) {
      return send(request, response, 400, { error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON' } });
    }
    if (error && error.message && error.message.includes('JWT_SECRET')) {
      return send(request, response, 500, {
        error: { code: 'AUTH_MISCONFIGURED', message: 'Server authentication is not configured' },
      });
    }
    console.error(error);
    return send(request, response, 500, { error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error' } });
  }
});

server.listen(port, host, () => {
  console.log(
    `Invest in Bd backend listening on http://${host}:${port} (${usePostgres ? 'postgresql' : 'in-memory demo'}; auth=${usePostgres ? (allowDevUserHeader ? 'jwt+dev-header' : 'jwt') : 'n/a'})`,
  );
});

async function shutdown(signal) {
  console.log(`${signal} received; shutting down`);
  server.close(async () => {
    if (pool) await closePool(pool);
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
