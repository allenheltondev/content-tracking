import { jest } from "@jest/globals";
import { marshall } from "@aws-sdk/util-dynamodb";

// Mock the domain so this suite only verifies stream-record routing: which
// edits trigger revalidation and with what arguments.
jest.unstable_mockModule("../../api/domain/content-review.mjs", () => ({
  revalidateSuggestions: jest.fn(),
}));

const { revalidateSuggestions } = await import("../../api/domain/content-review.mjs");
const { handler } = await import("./index.mjs");

const image = (overrides = {}) => ({
  pk: "TENANT#T1",
  sk: "CONTENT#C1",
  entity: "Content",
  tenantId: "T1",
  contentId: "C1",
  title: "Hi",
  contentMarkdown: "the body",
  updatedAt: "2026-07-18T00:00:00Z",
  ...overrides,
});

const modify = (oldImg, newImg) => ({
  eventName: "MODIFY",
  dynamodb: { OldImage: marshall(oldImg), NewImage: marshall(newImg) },
});

beforeEach(() => {
  jest.clearAllMocks();
  revalidateSuggestions.mockResolvedValue({ kept: 1, skipped: 0 });
});

test("revalidates when the body changed, passing the new body + version", async () => {
  const oldImg = image({ contentMarkdown: "the body" });
  const newImg = image({ contentMarkdown: "the edited body", updatedAt: "2026-07-18T01:00:00Z" });

  await handler({ Records: [modify(oldImg, newImg)] });

  expect(revalidateSuggestions).toHaveBeenCalledTimes(1);
  expect(revalidateSuggestions).toHaveBeenCalledWith("T1", "C1", "the edited body", {
    contentVersion: "2026-07-18T01:00:00Z",
  });
});

test("skips when the body is unchanged (title/link/id edit)", async () => {
  const oldImg = image({ title: "Hi" });
  const newImg = image({ title: "Hello there" }); // same contentMarkdown

  await handler({ Records: [modify(oldImg, newImg)] });
  expect(revalidateSuggestions).not.toHaveBeenCalled();
});

test("ignores non-MODIFY events", async () => {
  await handler({ Records: [{ eventName: "INSERT", dynamodb: { NewImage: marshall(image()) } }] });
  await handler({ eventName: "REMOVE", Records: [{ eventName: "REMOVE", dynamodb: { OldImage: marshall(image()) } }] });
  expect(revalidateSuggestions).not.toHaveBeenCalled();
});

test("guards against a non-Content entity slipping past the filter", async () => {
  const oldImg = image({ entity: "ContentSuggestion", contentMarkdown: "a" });
  const newImg = image({ entity: "ContentSuggestion", contentMarkdown: "b" });
  await handler({ Records: [modify(oldImg, newImg)] });
  expect(revalidateSuggestions).not.toHaveBeenCalled();
});

test("treats a cleared body as an empty string so all suggestions are revalidated", async () => {
  const oldImg = image({ contentMarkdown: "the body" });
  const newImg = image();
  delete newImg.contentMarkdown; // a cleared attribute is absent from the image, not undefined

  await handler({ Records: [modify(oldImg, newImg)] });
  expect(revalidateSuggestions).toHaveBeenCalledWith("T1", "C1", "", { contentVersion: "2026-07-18T00:00:00Z" });
});

test("processes each record in a batch independently", async () => {
  const rec1 = modify(image({ contentMarkdown: "a" }), image({ contentMarkdown: "a2" }));
  const rec2 = modify(image({ contentId: "C2", contentMarkdown: "b" }), image({ contentId: "C2", contentMarkdown: "b2" }));
  await handler({ Records: [rec1, rec2] });
  expect(revalidateSuggestions).toHaveBeenCalledTimes(2);
});
