import { jest } from "@jest/globals";
import { marshall } from "@aws-sdk/util-dynamodb";

// Mock the core so this suite only verifies the stream record routing.
jest.unstable_mockModule("./vectorize.mjs", () => ({
  vectorizeContent: jest.fn(),
  removeContentVectors: jest.fn(),
}));

const { vectorizeContent, removeContentVectors } = await import("./vectorize.mjs");
const { handler } = await import("./index.mjs");

const contentImage = {
  pk: "TENANT#T1",
  sk: "CONTENT#C1",
  entity: "Content",
  tenantId: "T1",
  contentId: "C1",
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
  vectorizeContent.mockResolvedValue({ skipped: false, chunkCount: 1 });
  removeContentVectors.mockResolvedValue();
});

test("INSERT routes to vectorizeContent with the unmarshalled content", async () => {
  await handler({ Records: [record("INSERT", contentImage)] });
  expect(vectorizeContent).toHaveBeenCalledTimes(1);
  expect(vectorizeContent.mock.calls[0][0]).toMatchObject({ contentId: "C1", entity: "Content" });
  expect(removeContentVectors).not.toHaveBeenCalled();
});

test("MODIFY routes to vectorizeContent", async () => {
  await handler({ Records: [record("MODIFY", contentImage)] });
  expect(vectorizeContent).toHaveBeenCalledTimes(1);
});

test("REMOVE routes to removeContentVectors with tenant + content id", async () => {
  await handler({ Records: [record("REMOVE", contentImage)] });
  expect(removeContentVectors).toHaveBeenCalledWith("T1", "C1");
  expect(vectorizeContent).not.toHaveBeenCalled();
});

test("ignores a non-Content NewImage (guard behind the stream filter)", async () => {
  await handler({ Records: [record("INSERT", { ...contentImage, entity: "ContentPublish" })] });
  expect(vectorizeContent).not.toHaveBeenCalled();
});

test("processes every record in a batch", async () => {
  await handler({ Records: [
    record("INSERT", contentImage),
    record("MODIFY", { ...contentImage, contentId: "C2" }),
    record("REMOVE", contentImage),
  ] });
  expect(vectorizeContent).toHaveBeenCalledTimes(2);
  expect(removeContentVectors).toHaveBeenCalledTimes(1);
});
