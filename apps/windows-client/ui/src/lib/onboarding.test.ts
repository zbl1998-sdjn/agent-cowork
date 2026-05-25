import { describe, expect, it } from 'vitest';
import { getFallbackOnboarding, selectInitialRole, selectRecommendedDependencies, toOnboardingViewModel } from './onboarding';

describe('selectInitialRole', () => {
  it('uses a supported preferred role when present', () => {
    expect(selectInitialRole('research')).toBe('research');
  });

  it('prefers office for the standard first-run role list', () => {
    expect(selectInitialRole('unknown')).toBe('office');
  });

  it('falls back to the first available role when developer is unavailable', () => {
    expect(selectInitialRole(null, [{ id: 'operations', label: '运营', description: '流程' }])).toBe('operations');
  });
});

describe('onboarding fallback view model', () => {
  it('builds local fallback recommendations for the selected role', () => {
    const fallback = getFallbackOnboarding('operations', 'desktop');

    expect(fallback.selectedRole).toBe('operations');
    expect(fallback.workspaceType).toBe('desktop');
    expect(fallback.recommendations.setup.map((item) => item.id)).toContain('api-key');
    expect(fallback.dependencyCheck.route).toBe('/api/runtime/dependencies');
    expect(fallback.dependencyCheck.recommendedIds).toContain('node');
  });

  it('groups recommendations into display sections', () => {
    const vm = toOnboardingViewModel(getFallbackOnboarding('developer'));

    expect(vm.roles.map((option) => option.id)).toEqual(['office', 'developer', 'research', 'operations']);
    expect(vm.roleOptions.map((option) => option.id)).toEqual(['office', 'developer', 'research', 'operations']);
    expect(vm.selectedRole).toBe('developer');
    expect(vm.recommendationSections.map((section) => section.title)).toEqual(['推荐技能', '推荐连接器', '建议设置']);
    expect(vm.recommendationSections.every((section) => section.items.length > 0)).toBe(true);
  });

  it('accepts server role option objects', () => {
    const vm = toOnboardingViewModel({
      ...getFallbackOnboarding('developer'),
      roles: [{ id: 'research', label: '研究', description: '资料' }],
      selectedRole: 'developer',
    });

    expect(vm.selectedRole).toBe('research');
    expect(vm.roleOptions).toEqual([{ id: 'research', label: '研究', description: '资料' }]);
  });

  it('selects recommended dependency statuses', () => {
    expect(selectRecommendedDependencies([
      { id: 'node', label: 'Node runtime', status: 'available' },
      { id: 'mingit', label: 'MinGit', status: 'missing' },
      { id: 'pandoc', label: 'Pandoc', status: 'missing' },
    ], ['mingit', 'node']).map((item) => item.id)).toEqual(['node', 'mingit']);
  });
});
