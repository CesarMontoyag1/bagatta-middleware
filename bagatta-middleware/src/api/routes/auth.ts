import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { prisma } from '../../db/prisma';
import { JWT_PRIVATE_KEY, env } from '../../config/env';
import { authRateLimiter } from '../middlewares/rateLimit';
import { verifyJwt, requireRole } from '../middlewares/auth';
import { loginSchema, refreshSchema } from '../schemas/auth.schemas';
import { UnauthorizedError, ValidationError, NotFoundError } from '../../utils/errors';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────
function simpleHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function generateAccessToken(userId: string, role: string): string {
  return jwt.sign(
    { sub: userId, role, jti: uuidv4() },
    JWT_PRIVATE_KEY,
    { algorithm: 'RS256', expiresIn: env.JWT_ACCESS_EXPIRES_IN as any },
  );
}

const BRUTE_FORCE_LIMIT     = 5;   // intentos fallidos
const BRUTE_FORCE_WINDOW_MS = 15 * 60 * 1000; // 15 min
const BRUTE_FORCE_BLOCK_MS  = 30 * 60 * 1000; // 30 min bloqueo

async function checkBruteForce(ip: string, email: string): Promise<void> {
  const windowStart = new Date(Date.now() - BRUTE_FORCE_WINDOW_MS);
  const failCount = await prisma.loginAttempt.count({
    where: { ipAddress: ip, email, success: false, createdAt: { gte: windowStart } },
  });
  if (failCount >= BRUTE_FORCE_LIMIT) {
    throw new UnauthorizedError(`Demasiados intentos fallidos. Espera ${BRUTE_FORCE_BLOCK_MS / 60000} minutos.`);
  }
}

// ── POST /auth/login ──────────────────────────────────────────────────────────
router.post('/login', authRateLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(JSON.stringify(parsed.error.flatten().fieldErrors));

    const { email, password } = parsed.data;
    const ip = req.ip ?? 'unknown';

    // Brute force check
    await checkBruteForce(ip, email);

    // Buscar usuario
    const user = await prisma.user.findUnique({ where: { email, isActive: true } });

    // Función para registrar intento y lanzar error genérico (no revelar si existe el email)
    const failAttempt = async () => {
      await prisma.loginAttempt.create({
        data: { userId: user?.id, ipAddress: ip, email, success: false },
      });
      throw new UnauthorizedError('Credenciales inválidas');
    };

    if (!user) { await failAttempt(); return; }

    // Verificar contraseña
    // En producción real usa bcrypt. El hash temporal del seed se detecta por el prefijo.
    let valid = false;
    if (user.passwordHash.startsWith('TEMP_SEED_HASH:')) {
      const tempHash = user.passwordHash.replace('TEMP_SEED_HASH:', '');
      valid = simpleHash(password) === tempHash;
      if (valid) {
        // Migrar a SHA256 permanente (en un proyecto real usarías bcrypt aquí)
        const newHash = simpleHash(password);
        await prisma.user.update({ where: { id: user.id }, data: { passwordHash: newHash } });
      }
    } else {
      valid = simpleHash(password) === user.passwordHash;
    }

    if (!valid) { await failAttempt(); return; }

    // Registro de éxito
    await prisma.loginAttempt.create({
      data: { userId: user.id, ipAddress: ip, email, success: true },
    });

    // Generar tokens
    const accessToken = generateAccessToken(user.id, user.role);
    const refreshTokenRaw = uuidv4();
    const refreshTokenHash = simpleHash(refreshTokenRaw);
    const refreshExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await prisma.refreshToken.create({
      data: { userId: user.id, tokenHash: refreshTokenHash, expiresAt: refreshExpiry },
    });

    res.json({
      access_token:   accessToken,
      refresh_token:  refreshTokenRaw,
      expires_in:     28800, // 8h en segundos
      role:           user.role,
      requires_totp:  false, // TOTP completo se implementa en siguiente iteración
    });

  } catch (err) {
    next(err);
  }
});

// ── POST /auth/refresh ────────────────────────────────────────────────────────
router.post('/refresh', authRateLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('refresh_token inválido');

    const { refresh_token } = parsed.data;
    const tokenHash = simpleHash(refresh_token);

    const stored = await prisma.refreshToken.findFirst({
      where: { tokenHash, expiresAt: { gt: new Date() } },
      include: { user: true },
    });

    if (!stored || !stored.user.isActive) {
      throw new UnauthorizedError('Refresh token inválido o expirado');
    }

    const accessToken = generateAccessToken(stored.user.id, stored.user.role);

    res.json({ access_token: accessToken, expires_in: 28800 });

  } catch (err) {
    next(err);
  }
});

// ── POST /auth/logout ─────────────────────────────────────────────────────────
router.post('/logout', verifyJwt, requireRole('readonly'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) {
      res.json({ message: 'Sesión cerrada' });
      return;
    }

    const tokenHash = simpleHash(parsed.data.refresh_token);
    await prisma.refreshToken.deleteMany({ where: { tokenHash } });
    res.json({ message: 'Sesión cerrada correctamente' });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /auth/sessions/:id — solo admin ────────────────────────────────────
router.delete('/sessions/:id', verifyJwt, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const deleted = await prisma.refreshToken.deleteMany({ where: { userId: req.params.id } });
    if (deleted.count === 0) throw new NotFoundError('Sesiones para ese usuario');
    res.json({ message: `${deleted.count} sesión(es) invalidada(s)` });
  } catch (err) {
    next(err);
  }
});

export default router;
