import { describe, expect, it } from 'vitest';
import { nextLocalBrokerBootstrapAttempt } from '../../src/app/local-broker-bootstrap';

describe('nextLocalBrokerBootstrapAttempt', () => {
  it('returns a token for the first default broker bootstrap attempt', () => {
    expect(
      nextLocalBrokerBootstrapAttempt(null, 'http://127.0.0.1:4318', 0, 'http://127.0.0.1:4318')
    ).toBe('http://127.0.0.1:4318::0');
  });

  it('does not re-attempt for the same broker and reload key', () => {
    expect(
      nextLocalBrokerBootstrapAttempt(
        'http://127.0.0.1:4318::0',
        'http://127.0.0.1:4318',
        0,
        'http://127.0.0.1:4318'
      )
    ).toBeNull();
  });

  it('re-attempts after an explicit reload', () => {
    expect(
      nextLocalBrokerBootstrapAttempt(
        'http://127.0.0.1:4318::0',
        'http://127.0.0.1:4318',
        1,
        'http://127.0.0.1:4318'
      )
    ).toBe('http://127.0.0.1:4318::1');
  });

  it('skips bootstrap for non-default broker urls', () => {
    expect(
      nextLocalBrokerBootstrapAttempt(
        null,
        'http://broker.example.com:4318',
        0,
        'http://127.0.0.1:4318'
      )
    ).toBeNull();
  });
});
