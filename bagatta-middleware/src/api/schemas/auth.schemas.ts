import { z } from 'zod';

export const loginSchema = z.object({
  email:     z.string().email('Email inválido'),
  password:  z.string().min(8, 'Mínimo 8 caracteres'),
  totp_code: z.string().length(6).optional(),
});

export const refreshSchema = z.object({
  refresh_token: z.string().uuid('refresh_token debe ser UUID'),
});

export const totpVerifySchema = z.object({
  totp_code: z.string().length(6, 'TOTP debe tener exactamente 6 dígitos'),
});

export const changePasswordSchema = z.object({
  current_password: z.string().min(8),
  new_password:     z.string().min(12, 'La nueva contraseña debe tener mínimo 12 caracteres'),
});

export type LoginInput          = z.infer<typeof loginSchema>;
export type RefreshInput        = z.infer<typeof refreshSchema>;
export type TotpVerifyInput     = z.infer<typeof totpVerifySchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;