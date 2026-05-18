import { jest } from '@jest/globals';
import { unmarshall } from '@aws-sdk/util-dynamodb';

const { DynamoDBClient, PutItemCommand } = await import('@aws-sdk/client-dynamodb');
const {
  CloudFrontKeyValueStoreClient,
  DescribeKeyValueStoreCommand,
  PutKeyCommand,
} = await import('@aws-sdk/client-cloudfront-keyvaluestore');

process.env.TABLE_NAME = 'test-table';
process.env.KVS_ARN = 'arn:aws:cloudfront::123456789012:key-value-store/abc';
process.env.SHORT_LINK_BASE = 'https://rdyset.click/c';

const { handler } = await import('../mint-short-link.mjs');

describe('mint-short-link', () => {
  let mockDdbSend;
  let mockKvsSend;

  beforeEach(() => {
    mockDdbSend = jest.fn();
    mockKvsSend = jest.fn();
    DynamoDBClient.prototype.send = mockDdbSend;
    CloudFrontKeyValueStoreClient.prototype.send = mockKvsSend;
    jest.clearAllMocks();
  });

  const invoke = (body) => handler({ body: typeof body === 'string' ? body : JSON.stringify(body) });

  describe('validation', () => {
    test('returns 400 when body is invalid JSON', async () => {
      const res = await invoke('{not json');
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('invalid_json');
      expect(mockDdbSend).not.toHaveBeenCalled();
    });

    test('returns 400 when campaign_id missing', async () => {
      const res = await invoke({ url: 'https://example.com' });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/campaign_id/);
    });

    test('returns 400 when url is not http(s)', async () => {
      const res = await invoke({ campaign_id: 'c1', url: 'ftp://example.com' });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/url/);
    });

    test('returns 400 when url exceeds 2048 chars', async () => {
      const longUrl = 'https://example.com/' + 'a'.repeat(2050);
      const res = await invoke({ campaign_id: 'c1', url: longUrl });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/too long/);
    });

    test('returns 400 when role is not in the allowed set', async () => {
      const res = await invoke({ campaign_id: 'c1', url: 'https://example.com', role: 'banner' });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/role/);
    });

    test('accepts valid roles', async () => {
      mockDdbSend.mockResolvedValue({});
      mockKvsSend
        .mockResolvedValueOnce({ ETag: 'etag1' })
        .mockResolvedValueOnce({});

      for (const role of ['main', 'cross_post', 'social_promo']) {
        mockDdbSend.mockClear();
        mockKvsSend.mockClear();
        mockDdbSend.mockResolvedValue({});
        mockKvsSend
          .mockResolvedValueOnce({ ETag: 'etag1' })
          .mockResolvedValueOnce({});

        const res = await invoke({ campaign_id: 'c1', url: 'https://example.com', role });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).role).toBe(role);
      }
    });
  });

  describe('happy path', () => {
    test('mints code, writes KVS, writes Link row, returns wrapped URL', async () => {
      mockDdbSend.mockResolvedValue({});
      mockKvsSend
        .mockResolvedValueOnce({ ETag: 'etag-v1' })
        .mockResolvedValueOnce({});

      const res = await invoke({
        campaign_id: 'launch-2026',
        url: 'https://readysetcloud.io/some-post',
        role: 'main',
        platform: 'readysetcloud',
        notes: 'launch post',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.code).toMatch(/^[A-Za-z0-9]{6}$/);
      expect(body.short_url).toBe(`https://rdyset.click/c/${body.code}`);
      expect(body.campaign_id).toBe('launch-2026');
      expect(body.link_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(body.role).toBe('main');
      expect(body.platform).toBe('readysetcloud');
      expect(body.url).toBe('https://readysetcloud.io/some-post');

      const ddbCalls = mockDdbSend.mock.calls.map((c) => c[0]);
      expect(ddbCalls).toHaveLength(2);
      expect(ddbCalls[0]).toBeInstanceOf(PutItemCommand);
      const codeItem = unmarshall(ddbCalls[0].input.Item);
      expect(codeItem.pk).toBe(`CODE#${body.code}`);
      expect(codeItem.entity).toBe('ShortCode');
      expect(ddbCalls[0].input.ConditionExpression).toContain('attribute_not_exists');

      expect(ddbCalls[1]).toBeInstanceOf(PutItemCommand);
      const linkItem = unmarshall(ddbCalls[1].input.Item);
      expect(linkItem.pk).toBe('CAMPAIGN#launch-2026');
      expect(linkItem.sk).toBe(`LINK#${body.link_id}`);
      expect(linkItem.gsi1pk).toBe(`CODE#${body.code}`);
      expect(linkItem.entity).toBe('Link');
      expect(linkItem.code).toBe(body.code);
      expect(linkItem.role).toBe('main');
      expect(linkItem.platform).toBe('readysetcloud');
      expect(linkItem.notes).toBe('launch post');

      const kvsCalls = mockKvsSend.mock.calls.map((c) => c[0]);
      expect(kvsCalls[0]).toBeInstanceOf(DescribeKeyValueStoreCommand);
      expect(kvsCalls[1]).toBeInstanceOf(PutKeyCommand);
      expect(kvsCalls[1].input.Key).toBe(body.code);
      expect(kvsCalls[1].input.IfMatch).toBe('etag-v1');
      const kvsValue = JSON.parse(kvsCalls[1].input.Value);
      expect(kvsValue.u).toBe('https://readysetcloud.io/some-post');
      expect(kvsValue.cid).toBe(`campaign#launch-2026#link#${body.link_id}`);
    });

    test('defaults role to main and platform to unknown when omitted', async () => {
      mockDdbSend.mockResolvedValue({});
      mockKvsSend
        .mockResolvedValueOnce({ ETag: 'etag1' })
        .mockResolvedValueOnce({});

      const res = await invoke({ campaign_id: 'c1', url: 'https://example.com' });
      const body = JSON.parse(res.body);
      expect(body.role).toBe('main');
      expect(body.platform).toBe('unknown');
    });

    test('uses provided link_id when supplied', async () => {
      mockDdbSend.mockResolvedValue({});
      mockKvsSend
        .mockResolvedValueOnce({ ETag: 'etag1' })
        .mockResolvedValueOnce({});

      const res = await invoke({
        campaign_id: 'c1',
        url: 'https://example.com',
        link_id: 'my-custom-link-id',
      });
      const body = JSON.parse(res.body);
      expect(body.link_id).toBe('my-custom-link-id');

      const kvsPut = mockKvsSend.mock.calls[1][0];
      const kvsValue = JSON.parse(kvsPut.input.Value);
      expect(kvsValue.cid).toBe('campaign#c1#link#my-custom-link-id');
    });

    test('encodes default src into the KVS value when provided', async () => {
      mockDdbSend.mockResolvedValue({});
      mockKvsSend
        .mockResolvedValueOnce({ ETag: 'etag1' })
        .mockResolvedValueOnce({});

      await invoke({
        campaign_id: 'c1',
        url: 'https://example.com',
        src: 'linkedin',
      });

      const kvsPut = mockKvsSend.mock.calls[1][0];
      const kvsValue = JSON.parse(kvsPut.input.Value);
      expect(kvsValue.src).toBe('linkedin');
    });
  });

  describe('short-code allocation', () => {
    test('retries on collision then succeeds', async () => {
      const collision = Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' });
      mockDdbSend
        .mockRejectedValueOnce(collision)
        .mockRejectedValueOnce(collision)
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});
      mockKvsSend
        .mockResolvedValueOnce({ ETag: 'etag1' })
        .mockResolvedValueOnce({});

      const res = await invoke({ campaign_id: 'c1', url: 'https://example.com' });
      expect(res.statusCode).toBe(200);

      const codeAttempts = mockDdbSend.mock.calls
        .map((c) => c[0])
        .filter((cmd) => {
          if (!(cmd instanceof PutItemCommand)) return false;
          const item = unmarshall(cmd.input.Item);
          return item.entity === 'ShortCode';
        });
      expect(codeAttempts).toHaveLength(3);

      const codes = codeAttempts.map((cmd) => unmarshall(cmd.input.Item).pk);
      const unique = new Set(codes);
      expect(unique.size).toBe(3);
    });

    test('returns 503 when all retries exhausted', async () => {
      const collision = Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' });
      mockDdbSend.mockRejectedValue(collision);

      const res = await invoke({ campaign_id: 'c1', url: 'https://example.com' });
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body).error).toBe('could_not_allocate_code');
      expect(mockKvsSend).not.toHaveBeenCalled();
    });

    test('rethrows non-conditional Dynamo errors', async () => {
      const fatal = Object.assign(new Error('throttled'), { name: 'ProvisionedThroughputExceededException' });
      mockDdbSend.mockRejectedValueOnce(fatal);

      await expect(invoke({ campaign_id: 'c1', url: 'https://example.com' })).rejects.toThrow('throttled');
    });
  });

  describe('event shape', () => {
    test('handles event.body already parsed as an object', async () => {
      mockDdbSend.mockResolvedValue({});
      mockKvsSend
        .mockResolvedValueOnce({ ETag: 'etag1' })
        .mockResolvedValueOnce({});

      const res = await handler({ body: { campaign_id: 'c1', url: 'https://example.com' } });
      expect(res.statusCode).toBe(200);
    });
  });
});
