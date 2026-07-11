// Offline-only PostgreSQL migration inventory. This command deliberately has
// no apply mode: database changes remain an explicit operator approval step.
import { buildPostgresMigrationPlan } from '../apps/host/src/storage/postgres-migration-plan.js';

process.stdout.write(`${JSON.stringify(buildPostgresMigrationPlan(), null, 2)}\n`);
