import { z } from 'zod';

export const inventoryQuerySchema = z.object({
  sku:      z.string().optional(),
  status:   z.enum(['active', 'archived']).optional(),
  conflict: z.coerce.boolean().optional(),
  page:     z.coerce.number().int().min(1).default(1),
  limit:    z.coerce.number().int().min(1).max(200).default(50),
});

export const auditLogQuerySchema = z.object({
  sku:    z.string().optional(),
  origin: z.enum(['orchestrator', 'shopify_webhook', 'shopify_polling', 'alegra_polling', 'catchup_sync', 'manual_admin']).optional(),
  field:  z.enum(['stock', 'price', 'cost', 'name', 'status', 'sku']).optional(),
  from:   z.string().datetime({ offset: true }).optional(),
  to:     z.string().datetime({ offset: true }).optional(),
  alert:  z.coerce.boolean().optional(),
  page:   z.coerce.number().int().min(1).default(1),
  limit:  z.coerce.number().int().min(1).max(200).default(50),
});

export const productQuerySchema = z.object({
  status: z.enum(['active', 'archived']).optional(),
  page:   z.coerce.number().int().min(1).default(1),
  limit:  z.coerce.number().int().min(1).max(200).default(50),
});

export type InventoryQuery = z.infer<typeof inventoryQuerySchema>;
export type AuditLogQuery  = z.infer<typeof auditLogQuerySchema>;
export type ProductQuery   = z.infer<typeof productQuerySchema>;
