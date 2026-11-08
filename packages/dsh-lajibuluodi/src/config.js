import z from '@deepseek-ai/schemastery'
import { DEFAULT_EXCLUDES } from './options.js'

/** Loader-facing configuration schema. */
export const Config = z.object({
  enabled: z.boolean().default(true),
  recycle: z.boolean().default(true),
  dataDir: z.string().default(''),
  exclude: z.array(z.string()).default([...DEFAULT_EXCLUDES]),
  maxFiles: z.number().default(20_000),
  maxPackageFiles: z.number().default(5_000),
  maxPackageBytes: z.number().default(1_500_000_000),
  maxCopyBytes: z.number().default(64 * 1024 * 1024),
  scanIntervalMs: z.number().default(5_000),
  beforeToolBudgetMs: z.number().default(1_500),
  keepSnapshots: z.boolean().default(false),
  packagePrefix: z.string().default('DSH'),
  packageNameMaxLength: z.number().default(120),
})
