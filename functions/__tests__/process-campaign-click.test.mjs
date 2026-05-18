import { jest } from '@jest/globals';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import zlib from 'zlib';

const { DynamoDBClient, PutItemCommand, UpdateItemCommand } = await import('@aws-sdk/client-dynamodb');

process.env.TABLE_NAME = 'test-table';

const { handler } = await import('../process-campaign-click.mjs');

const buildLogsEvent = (logEvents) => {
  const payload = {
    messageType: 'DATA_MESSAGE',
    owner: '123456789012',
    logGroup: '/aws/cloudfront/function/campaign-short-redirect',
    logStream: 'stream1',
    logEvents,
  };
  return {
    awslogs: {
      data: zlib.gzipSync(JSON.stringify(payload)).toString('base64'),
    },
  };
};

const campaignLog = (overrides = {}) => {
  const payload = {
    cid: 'campaign#launch-2026#link#01HXYZ',
    u: 'https://readysetcloud.io/some-post',
    src: 'linkedin',
    ip: '1.2.3.4',
    s: null,
    ...overrides,
  };
  return `2026-05-18T10:00:00Z\tREPORT\t${JSON.stringify(payload)}`;
};

describe('process-campaign-click', () => {
  let mockSend;

  beforeEach(() => {
    mockSend = jest.fn().mockResolvedValue({});
    DynamoDBClient.prototype.send = mockSend;
    jest.clearAllMocks();
  });

  test('returns processed:0 when payload has no log events', async () => {
    const event = buildLogsEvent([]);
    const res = await handler(event);
    expect(JSON.parse(res.body).processed).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('returns processed:0 on undecodable payload without throwing', async () => {
    const res = await handler({ awslogs: { data: 'not-base64-gzip!!!' } });
    expect(JSON.parse(res.body).processed).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('writes ClickEvent + AGGREGATE update for a single campaign click', async () => {
    const event = buildLogsEvent([
      { timestamp: Date.parse('2026-05-18T10:00:00Z'), message: campaignLog() },
    ]);

    await handler(event);

    expect(mockSend).toHaveBeenCalledTimes(2);
    const commands = mockSend.mock.calls.map((c) => c[0]);

    const putCmd = commands.find((c) => c instanceof PutItemCommand);
    expect(putCmd).toBeDefined();
    const item = unmarshall(putCmd.input.Item);
    expect(item.pk).toBe('LINK#01HXYZ');
    expect(item.sk).toMatch(/^CLICK#2026-05-18T10:00:00\.000Z#[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(item.gsi1pk).toBe('CAMPAIGN#launch-2026');
    expect(item.gsi1sk).toMatch(/^CLICK#2026-05-18T10:00:00\.000Z#01HXYZ$/);
    expect(item.entity).toBe('ClickEvent');
    expect(item.campaignId).toBe('launch-2026');
    expect(item.linkId).toBe('01HXYZ');
    expect(item.src).toBe('linkedin');
    expect(item.destinationUrl).toBe('https://readysetcloud.io/some-post');

    const updCmd = commands.find((c) => c instanceof UpdateItemCommand);
    expect(updCmd).toBeDefined();
    const key = unmarshall(updCmd.input.Key);
    expect(key.pk).toBe('LINK#01HXYZ');
    expect(key.sk).toBe('AGGREGATE');
    expect(updCmd.input.UpdateExpression).toContain('ADD totalClicks :one');
    expect(updCmd.input.ExpressionAttributeNames['#day']).toBe('2026-05-18');
    expect(updCmd.input.ExpressionAttributeNames['#src']).toBe('linkedin');
    const values = unmarshall(updCmd.input.ExpressionAttributeValues);
    expect(values[':ts']).toBe('2026-05-18T10:00:00.000Z');
    expect(values[':cid']).toBe('launch-2026');
    expect(values[':lid']).toBe('01HXYZ');
    expect(values[':gsi1pk']).toBe('CAMPAIGN#launch-2026');
  });

  test('ignores log events with non-campaign cid', async () => {
    const event = buildLogsEvent([
      {
        timestamp: Date.now(),
        message: 'PREFIX {"cid":"tenant#42#issue#5","u":"https://example.com","src":"email"}',
      },
    ]);

    await handler(event);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('ignores log events with no extractable JSON', async () => {
    const event = buildLogsEvent([
      { timestamp: Date.now(), message: 'INIT_START' },
      { timestamp: Date.now(), message: 'plain text no braces' },
    ]);

    await handler(event);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('ignores log events with malformed JSON', async () => {
    const event = buildLogsEvent([
      { timestamp: Date.now(), message: 'PREFIX {cid: not-quoted, broken}' },
    ]);

    await handler(event);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('ignores log events with missing cid', async () => {
    const event = buildLogsEvent([
      { timestamp: Date.now(), message: 'PREFIX {"u":"https://example.com","src":"web"}' },
    ]);

    await handler(event);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('ignores cid that does not match the campaign#X#link#Y shape', async () => {
    const event = buildLogsEvent([
      { timestamp: Date.now(), message: campaignLog({ cid: 'campaign#missing-link-part' }) },
    ]);

    await handler(event);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('defaults src to "web" when missing', async () => {
    const event = buildLogsEvent([
      { timestamp: Date.parse('2026-05-18T10:00:00Z'), message: campaignLog({ src: undefined }) },
    ]);

    await handler(event);

    const updCmd = mockSend.mock.calls
      .map((c) => c[0])
      .find((c) => c instanceof UpdateItemCommand);
    expect(updCmd.input.ExpressionAttributeNames['#src']).toBe('web');
  });

  test('retries aggregate update after ValidationException by initializing maps', async () => {
    const validationErr = Object.assign(new Error('map missing'), { name: 'ValidationException' });
    mockSend
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(validationErr)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const event = buildLogsEvent([
      { timestamp: Date.parse('2026-05-18T10:00:00Z'), message: campaignLog() },
    ]);

    const res = await handler(event);
    expect(JSON.parse(res.body).failed).toBe(0);

    const updates = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof UpdateItemCommand);
    expect(updates).toHaveLength(3);

    expect(updates[1].input.UpdateExpression).toContain('byDay = if_not_exists(byDay, :empty)');
    expect(updates[1].input.UpdateExpression).toContain('bySrc = if_not_exists(bySrc, :empty)');

    expect(updates[2].input.UpdateExpression).toContain('ADD totalClicks :one');
  });

  test('reports failures in the response without throwing', async () => {
    const fatal = Object.assign(new Error('throttle'), { name: 'ProvisionedThroughputExceededException' });
    mockSend
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(fatal);

    const event = buildLogsEvent([
      { timestamp: Date.now(), message: campaignLog() },
    ]);

    const res = await handler(event);
    const body = JSON.parse(res.body);
    expect(body.processed).toBe(1);
    expect(body.failed).toBe(1);
  });

  test('processes multiple events in a single batch', async () => {
    const event = buildLogsEvent([
      { timestamp: Date.parse('2026-05-18T10:00:00Z'), message: campaignLog({ cid: 'campaign#A#link#1' }) },
      { timestamp: Date.parse('2026-05-18T10:00:01Z'), message: campaignLog({ cid: 'campaign#A#link#2' }) },
      { timestamp: Date.parse('2026-05-18T10:00:02Z'), message: campaignLog({ cid: 'campaign#B#link#3' }) },
    ]);

    await handler(event);

    expect(mockSend).toHaveBeenCalledTimes(6);
    const puts = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof PutItemCommand);
    expect(puts).toHaveLength(3);

    const linkIds = puts.map((p) => unmarshall(p.input.Item).linkId);
    expect(linkIds).toEqual(expect.arrayContaining(['1', '2', '3']));
  });
});
