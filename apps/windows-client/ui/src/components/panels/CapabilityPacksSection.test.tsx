import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CapabilityPack } from '../../lib/api';
import {
  CapabilityPackList,
  CapabilityPacksSection,
} from './CapabilityPacksSection';

function pack(overrides: Partial<CapabilityPack> = {}): CapabilityPack {
  return {
    schemaVersion: 'agent-cowork.pack.v1',
    id: 'sample-pack',
    name: 'Sample Pack',
    version: '1.0.0',
    description: 'A governed test pack.',
    category: 'capability',
    publisher: 'Agent Cowork',
    license: 'internal',
    capabilities: ['sample.read'],
    dependencyIds: [],
    requiredPackIds: [],
    recommendedForRoles: [],
    permissions: [
      {
        kind: 'filesystem',
        scope: 'trustedRoot',
        reason: 'Read an approved workspace.',
        default: 'ask',
      },
    ],
    installMode: 'bundled',
    security: {
      signed: true,
      sandboxRequired: false,
      networkDuringRuntime: 'none',
    },
    governance: {
      status: 'bundled_trusted',
      executable: true,
      reviewRequired: false,
      reasons: [],
    },
    ...overrides,
  };
}

describe('CapabilityPacksSection', () => {
  it('starts with an explicit bounded loading state', () => {
    const html = renderToStaticMarkup(<CapabilityPacksSection />);

    expect(html).toContain('受控能力包');
    expect(html).toContain('加载能力包治理目录');
    expect(html).toContain('aria-busy="true"');
  });

  it('shows version, publisher, permissions and fail-closed governance', () => {
    const html = renderToStaticMarkup(
      <CapabilityPackList
        packs={[
          pack(),
          pack({
            id: 'planned-pack',
            name: 'Planned Pack',
            version: '2.0.0',
            requiredPackIds: ['browser-automation-pack'],
            security: {
              signed: false,
              sandboxRequired: true,
              networkDuringRuntime: 'ask',
            },
            installMode: 'plan-only',
            governance: {
              status: 'blocked',
              executable: false,
              reviewRequired: false,
              reasons: ['required_pack_blocked:browser-automation-pack'],
            },
          }),
        ]}
      />,
    );

    expect(html).toContain('Sample Pack');
    expect(html).toContain('v1.0.0');
    expect(html).toContain('Agent Cowork');
    expect(html).toContain('filesystem · trustedRoot · 每次询问');
    expect(html).toContain('Read an approved workspace.');
    expect(html).toContain('内置元数据审查通过');
    expect(html).toContain('已阻止');
    expect(html).toContain('不可执行');
    expect(html).toContain('必需能力包');
    expect(html).toContain('browser-automation-pack');
    expect(html).toContain('signed=true（仅静态清单声明，当前未执行密码学验签）');
    expect(html).toContain('signed=false（无签名声明）');
    expect(html).toContain('需要沙箱');
    expect(html).toContain('运行时网络需询问');
    expect(html).toContain('required_pack_blocked:browser-automation-pack');
    expect(html).not.toContain('安装</button>');
    expect(html).not.toContain('启用</button>');
  });
});
