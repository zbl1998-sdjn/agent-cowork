import { describe, expect, it } from 'vitest';

import { buildScheduleCreateRequest } from './schedules';

describe('scheduled connected-folder binding', () => {
  it('includes the selected opaque grant id in the idempotent create request', () => {
    const request = buildScheduleCreateRequest({
      name: 'weekly report',
      recipeId: 'weekly-report-beginner',
      kind: 'cron',
      cron: '0 9 * * 1',
      trustedRoot: 'C:\\workspace\\connected',
      folderGrantId: 'grant_selected-1',
    });

    expect(request.payload.folderGrantId).toBe('grant_selected-1');
  });
});
