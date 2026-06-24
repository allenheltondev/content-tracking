import { jest } from "@jest/globals";
import { marshall } from "@aws-sdk/util-dynamodb";

// Mock the core so this suite only verifies the stream record routing.
jest.unstable_mockModule("./vectorize.mjs", () => ({
  vectorizeBlog: jest.fn(),
  removeBlogVectors: jest.fn(),
}));

const { vectorizeBlog, removeBlogVectors } = await import("./vectorize.mjs");
const { handler } = await import("./index.mjs");

const blogImage = {
  pk: "TENANT#T1",
  sk: "BLOG#B1",
  entity: "Blog",
  tenantId: "T1",
  blogId: "B1",
  title: "Hi",
  contentMarkdown: "body",
};

const record = (eventName, image) => ({
  eventName,
  dynamodb: eventName === "REMOVE"
    ? { OldImage: marshall(image) }
    : { NewImage: marshall(image) },
});

beforeEach(() => {
  jest.clearAllMocks();
  vectorizeBlog.mockResolvedValue({ skipped: false, chunkCount: 1 });
  removeBlogVectors.mockResolvedValue();
});

test("INSERT routes to vectorizeBlog with the unmarshalled blog", async () => {
  await handler({ Records: [record("INSERT", blogImage)] });
  expect(vectorizeBlog).toHaveBeenCalledTimes(1);
  expect(vectorizeBlog.mock.calls[0][0]).toMatchObject({ blogId: "B1", entity: "Blog" });
  expect(removeBlogVectors).not.toHaveBeenCalled();
});

test("MODIFY routes to vectorizeBlog", async () => {
  await handler({ Records: [record("MODIFY", blogImage)] });
  expect(vectorizeBlog).toHaveBeenCalledTimes(1);
});

test("REMOVE routes to removeBlogVectors with tenant + blog id", async () => {
  await handler({ Records: [record("REMOVE", blogImage)] });
  expect(removeBlogVectors).toHaveBeenCalledWith("T1", "B1");
  expect(vectorizeBlog).not.toHaveBeenCalled();
});

test("ignores a non-Blog NewImage (guard behind the stream filter)", async () => {
  await handler({ Records: [record("INSERT", { ...blogImage, entity: "BlogCrosspost" })] });
  expect(vectorizeBlog).not.toHaveBeenCalled();
});

test("processes every record in a batch", async () => {
  await handler({ Records: [
    record("INSERT", blogImage),
    record("MODIFY", { ...blogImage, blogId: "B2" }),
    record("REMOVE", blogImage),
  ] });
  expect(vectorizeBlog).toHaveBeenCalledTimes(2);
  expect(removeBlogVectors).toHaveBeenCalledTimes(1);
});
