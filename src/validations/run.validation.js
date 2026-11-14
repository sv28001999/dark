import { z } from 'zod';
import { listQuery, recordId } from './common.validation.js';

const runIdParams = z.object({ runId: recordId });

export const listRuns = listQuery;

export const getRun = z.object({ params: runIdParams });

export const cancelRun = z.object({ params: runIdParams });
