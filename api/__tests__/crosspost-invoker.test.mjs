import { jest } from "@jest/globals";

process.env.CROSSPOST_FUNCTION_ARN = "arn:aws:lambda:us-east-1:123:function:crosspost:live";

const send = jest.fn();
class LambdaClient {
  send(...args) {
    return send(...args);
  }
}
class InvokeCommand {
  constructor(input) {
    this.input = input;
  }
}
jest.unstable_mockModule("@aws-sdk/client-lambda", () => ({ LambdaClient, InvokeCommand }));

const { startCrosspostExecution } = await import("../services/crosspost-invoker.mjs");

beforeEach(() => send.mockReset());

test("async-invokes the crosspost alias with the JSON payload", async () => {
  send.mockResolvedValue({ StatusCode: 202 });

  const payload = { tenantId: "t", blogId: "B1", runId: "R1", platforms: [{ platform: "dev", delaySeconds: 0 }] };
  await startCrosspostExecution(payload);

  const cmd = send.mock.calls[0][0];
  expect(cmd).toBeInstanceOf(InvokeCommand);
  expect(cmd.input.FunctionName).toBe("arn:aws:lambda:us-east-1:123:function:crosspost:live");
  expect(cmd.input.InvocationType).toBe("Event");
  expect(JSON.parse(Buffer.from(cmd.input.Payload).toString())).toEqual(payload);
});

test("throws when the invoke is not accepted", async () => {
  send.mockResolvedValue({ StatusCode: 500, FunctionError: "Unhandled" });
  await expect(startCrosspostExecution({ tenantId: "t" })).rejects.toThrow(/Failed to start cross-post execution/);
});
