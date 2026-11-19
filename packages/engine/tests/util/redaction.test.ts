import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  isSensitiveKey,
  maskHeaderValue,
  maskSecretPreservingShape,
  redactBodyText,
  redactHeaders,
  redactUnknown,
  redactUrl,
} from '../../src/util/redaction.js';

describe('isSensitiveKey', () => {
  it('flags common secret-bearing names', () => {
    for (const key of ['authorization', 'Authorization', 'x-api-key', 'apiKey', 'access_token', 'password', 'client_secret', 'set-cookie', 'Cookie']) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
  });

  it('does not flag ordinary names', () => {
    for (const key of ['content-type', 'user-agent', 'accept', 'name', 'id', 'monkey']) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });
});

describe('maskHeaderValue', () => {
  it('keeps the auth scheme while masking the credential', () => {
    expect(maskHeaderValue('Authorization', 'Bearer abc.def.ghi')).toBe(`Bearer ${REDACTED}`);
    expect(maskHeaderValue('Authorization', 'Basic dXNlcjpwYXNz')).toBe(`Basic ${REDACTED}`);
  });

  it('masks non-scheme secrets entirely', () => {
    expect(maskHeaderValue('x-api-key', 'plain-secret')).toBe(REDACTED);
    expect(maskHeaderValue('content-type', 'application/json')).toBe('application/json');
  });
});

describe('redactHeaders', () => {
  it('masks only sensitive headers', () => {
    const result = redactHeaders({ Authorization: 'Bearer t', 'content-type': 'application/json', Cookie: 'a=b' });
    expect(result).toEqual({ Authorization: `Bearer ${REDACTED}`, 'content-type': 'application/json', Cookie: REDACTED });
  });
});

describe('redactUrl', () => {
  it('masks sensitive query parameters', () => {
    expect(redactUrl('https://api.example.com/x?token=abc&page=2')).toBe('https://api.example.com/x?token=%5BREDACTED%5D&page=2');
  });

  it('masks userinfo credentials', () => {
    const result = redactUrl('https://user:secret@api.example.com/x');
    expect(result).not.toContain('secret');
    expect(result).toContain('%5BREDACTED%5D');
  });

  it('masks inline secrets in relative URLs', () => {
    expect(redactUrl('/callback?password=hunter2')).toBe(`/callback?password=${REDACTED}`);
  });
});

describe('redactUnknown', () => {
  it('recursively masks sensitive properties', () => {
    const input = { user: { name: 'Ada', password: 'pw', tokens: { accessToken: 'abc' } }, list: [{ secret: 's' }] };
    expect(redactUnknown(input)).toEqual({
      user: { name: 'Ada', password: REDACTED, tokens: { accessToken: REDACTED } },
      list: [{ secret: REDACTED }],
    });
  });
});

describe('redactBodyText', () => {
  it('masks JSON body fields structurally', () => {
    expect(redactBodyText('{"token":"abc","name":"x"}')).toBe(JSON.stringify({ token: REDACTED, name: 'x' }, null, 2));
  });

  it('masks key=value pairs in plain text', () => {
    expect(redactBodyText('password=hunter2&user=ada')).toContain(REDACTED);
  });

  it('returns empty input unchanged', () => {
    expect(redactBodyText('')).toBe('');
  });
});

describe('maskSecretPreservingShape', () => {
  it('keeps a short prefix/suffix for verification', () => {
    expect(maskSecretPreservingShape('abcdefghijkl')).toBe('abc…jkl');
    expect(maskSecretPreservingShape('ab')).toBe('**');
  });
});
