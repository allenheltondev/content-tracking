import { decodeCursor, encodeCursor, parseLimit } from "../services/pagination.mjs";
import { BadRequestError } from "../services/errors.mjs";

describe("pagination", () => {
  describe("encode/decode round-trip", () => {
    test("returns null for empty key", () => {
      expect(encodeCursor(null)).toBeNull();
      expect(encodeCursor(undefined)).toBeNull();
    });

    test("survives a DDB-shaped key", () => {
      const key = { pk: "VENDOR#01HV0AABBCCDDEEFFGGHHJJKKM", sk: "METADATA" };
      const token = encodeCursor(key);
      expect(token).toEqual(expect.any(String));
      expect(decodeCursor(token)).toEqual(key);
    });
  });

  describe("decodeCursor", () => {
    test("returns undefined for empty input", () => {
      expect(decodeCursor(undefined)).toBeUndefined();
      expect(decodeCursor(null)).toBeUndefined();
      expect(decodeCursor("")).toBeUndefined();
    });

    test("throws BadRequestError on garbage", () => {
      expect(() => decodeCursor("not-base64-json")).toThrow(BadRequestError);
    });
  });

  describe("parseLimit", () => {
    test("returns default when missing", () => {
      expect(parseLimit(undefined)).toBe(100);
      expect(parseLimit(null)).toBe(100);
    });

    test("parses valid integer", () => {
      expect(parseLimit("25")).toBe(25);
    });

    test("rejects out-of-range", () => {
      expect(() => parseLimit("0")).toThrow(BadRequestError);
      expect(() => parseLimit("501")).toThrow(BadRequestError);
    });

    test("rejects non-integer", () => {
      expect(() => parseLimit("abc")).toThrow(BadRequestError);
      expect(() => parseLimit("3.14")).toThrow(BadRequestError);
    });
  });
});
