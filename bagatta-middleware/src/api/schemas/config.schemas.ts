import { z } from 'zod';

export const configPatchSchema = z.object({
  polling_interval_seconds:        z.number().int().min(5).max(60).optional(),
  catchup_threshold_minutes:       z.number().int().min(1).max(30).optional(),
  downtime_alert_threshold_minutes:z.number().int().min(1).max(60).optional(),
  rate_limit_max_requests:         z.number().int().min(10).max(1000).optional(),
}).strict();

export type ConfigPatch = z.infer<typeof configPatchSchema>;
