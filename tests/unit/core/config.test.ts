import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config';

describe('config', () => {
  it('loads sane defaults', () => {
    const cfg = loadConfig({} as NodeJS.ProcessEnv);
    expect(cfg.port).toBe(3000);
    expect(cfg.failureMode).toBe('fail-closed');
    expect(cfg.defaultRule.algorithm).toBe('token-bucket');
  });
});
