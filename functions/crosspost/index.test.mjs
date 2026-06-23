import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";
process.env.ENVIRONMENT = "staging";

// Mock every collaborator and the durable wrapper so we can drive the
// orchestration with a fake context.
jest.unstable_mockModule("@aws/durable-execution-sdk-js", () => ({
  withDurableExecution: (fn) => fn,
}));
jest.unstable_mockModule("../../api/domain/blog.mjs", () => ({
  getBlog: jest.fn(),
  listBlogsByTenant: jest.fn(),
  startCrosspostRun: jest.fn(),
  recordCrosspostResult: jest.fn(),
  completeCrosspostRun: jest.fn(),
}));
jest.unstable_mockModule("../../api/domain/tenant.mjs", () => ({ getTenant: jest.fn() }));
jest.unstable_mockModule("../../api/services/blog-credentials.mjs", () => ({ getBlogCredentials: jest.fn() }));
jest.unstable_mockModule("../../api/services/parse-blog.mjs", () => ({ transformBlogForPlatform: jest.fn() }));
jest.unstable_mockModule("../../api/services/blog-platforms/index.mjs", () => ({ getAdapter: jest.fn() }));

const {
  getBlog,
  listBlogsByTenant,
  startCrosspostRun,
  recordCrosspostResult,
  completeCrosspostRun,
} = await import("../../api/domain/blog.mjs");
const { getTenant } = await import("../../api/domain/tenant.mjs");
const { getBlogCredentials } = await import("../../api/services/blog-credentials.mjs");
const { transformBlogForPlatform } = await import("../../api/services/parse-blog.mjs");
const { getAdapter } = await import("../../api/services/blog-platforms/index.mjs");
const { handler } = await import("./index.mjs");

// Fake durable context: steps run their fn immediately, waits are recorded,
// map runs each branch sequentially and exposes a BatchResult-like object.
function makeContext(waitCalls) {
  const step = async (nameOrFn, maybeFn) => {
    const fn = typeof nameOrFn === "function" ? nameOrFn : maybeFn;
    return fn({ logger: { info() {}, error() {} } });
  };
  const wait = async (duration) => { waitCalls.push(duration); };
  const map = async (_name, items, mapFunc) => {
    const all = [];
    for (let i = 0; i < items.length; i++) {
      all.push({ result: await mapFunc(makeContext(waitCalls), items[i], i, items), index: i, status: "SUCCEEDED" });
    }
    return { all, getResults: () => all.map((a) => a.result), hasFailure: false, status: "SUCCEEDED" };
  };
  return { step, wait, map };
}

const TENANT = "tenant-1";
const blog = { blogId: "B1", title: "Hi", contentMarkdown: "body", canonicalUrl: "https://rsc.io/blog/hi" };

beforeEach(() => {
  jest.clearAllMocks();
  getBlog.mockResolvedValue(blog);
  getTenant.mockResolvedValue({
    canonicalBaseUrl: "https://rsc.io",
    platforms: { dev: { organizationId: "2491" }, medium: { publicationId: "PUB" } },
  });
  listBlogsByTenant.mockResolvedValue({ items: [blog] });
  getBlogCredentials.mockResolvedValue({ dev: "dk", medium: "mk" });
  transformBlogForPlatform.mockReturnValue({ body: "TBODY", tags: ["t"] });
  startCrosspostRun.mockResolvedValue({});
  recordCrosspostResult.mockResolvedValue({});
  completeCrosspostRun.mockResolvedValue({});
});

test("publishes each platform, records results, finalizes succeeded", async () => {
  getAdapter.mockImplementation((platform) => ({
    publish: jest.fn(async () => ({ id: `${platform}-id`, url: `https://${platform}/x` })),
  }));

  const waitCalls = [];
  const event = { tenantId: TENANT, blogId: "B1", runId: "R1", platforms: [{ platform: "dev", delaySeconds: 0 }, { platform: "medium", delaySeconds: 0 }] };
  const result = await handler(event, makeContext(waitCalls));

  expect(startCrosspostRun).toHaveBeenCalledWith(TENANT, "B1", { runId: "R1", platforms: event.platforms });
  expect(transformBlogForPlatform).toHaveBeenCalledWith(expect.objectContaining({ platform: "dev", baseUrl: "https://rsc.io", catalog: [blog] }));
  expect(recordCrosspostResult).toHaveBeenCalledWith(TENANT, "B1", "dev", expect.objectContaining({ runId: "R1", status: "succeeded", url: "https://dev/x", id: "dev-id" }));
  expect(recordCrosspostResult).toHaveBeenCalledWith(TENANT, "B1", "medium", expect.objectContaining({ status: "succeeded" }));
  expect(completeCrosspostRun).toHaveBeenCalledWith(TENANT, "B1", "R1", "succeeded");
  expect(result.status).toBe("succeeded");
  expect(waitCalls).toEqual([]); // no stagger
});

test("waits for staggered platforms before publishing", async () => {
  getAdapter.mockImplementation((platform) => ({ publish: jest.fn(async () => ({ id: `${platform}-id`, url: "u" })) }));

  const waitCalls = [];
  const event = { tenantId: TENANT, blogId: "B1", runId: "R1", platforms: [{ platform: "dev", delaySeconds: 259200 }] };
  await handler(event, makeContext(waitCalls));

  expect(waitCalls).toEqual([{ seconds: 259200 }]);
});

test("a failing platform is recorded failed and the run is failed, without aborting others", async () => {
  getAdapter.mockImplementation((platform) => ({
    publish: jest.fn(async () => {
      if (platform === "medium") throw new Error("401 unauthorized");
      return { id: "dev-id", url: "https://dev/x" };
    }),
  }));

  const event = { tenantId: TENANT, blogId: "B1", runId: "R1", platforms: [{ platform: "dev", delaySeconds: 0 }, { platform: "medium", delaySeconds: 0 }] };
  const result = await handler(event, makeContext([]));

  expect(recordCrosspostResult).toHaveBeenCalledWith(TENANT, "B1", "dev", expect.objectContaining({ status: "succeeded" }));
  expect(recordCrosspostResult).toHaveBeenCalledWith(TENANT, "B1", "medium", expect.objectContaining({ status: "failed", error: expect.stringContaining("401") }));
  expect(completeCrosspostRun).toHaveBeenCalledWith(TENANT, "B1", "R1", "failed");
  expect(result.status).toBe("failed");
});

test("a record-step failure propagates (not swallowed) so the run is not finalized", async () => {
  // Publish succeeded, but persisting the result fails — this must NOT be
  // converted to a normal failed outcome, or the copy/root state would be
  // left out of sync with the published post. It propagates for durable retry.
  getAdapter.mockImplementation(() => ({ publish: jest.fn(async () => ({ id: "x", url: "https://dev/x" })) }));
  recordCrosspostResult.mockRejectedValueOnce(new Error("DynamoDB throttled"));

  const event = { tenantId: TENANT, blogId: "B1", runId: "R1", platforms: [{ platform: "dev", delaySeconds: 0 }] };

  await expect(handler(event, makeContext([]))).rejects.toThrow(/throttled/);
  expect(completeCrosspostRun).not.toHaveBeenCalled();
});
