import { describe, expect, it } from 'vitest';

import { createTrustedDevices } from '../../src/relay/trusted-devices.js';

describe('TrustedDevices 叠加', () => {
  it('activate 后 isActive=true；deactivate 后回落本地判定', () => {
    const trusted = createTrustedDevices(
      (deviceId) => deviceId === 'dev_local',
    );
    expect(trusted.isActive('dev_local')).toBe(true);
    expect(trusted.isActive('dev_phone')).toBe(false);

    trusted.activate('dev_phone');
    expect(trusted.isActive('dev_phone')).toBe(true);

    trusted.deactivate('dev_phone');
    expect(trusted.isActive('dev_phone')).toBe(false);
    expect(trusted.isActive('dev_local')).toBe(true);
  });

  it('重复 activate 幂等；deactivate 未知设备不报错', () => {
    const trusted = createTrustedDevices(() => false);
    trusted.activate('dev_phone');
    trusted.activate('dev_phone');
    expect(trusted.isActive('dev_phone')).toBe(true);
    trusted.deactivate('dev_phone');
    trusted.deactivate('dev_phone');
    expect(trusted.isActive('dev_phone')).toBe(false);
  });
});