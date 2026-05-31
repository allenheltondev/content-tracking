import { describe, expect, test } from "@jest/globals";
import {
  validateCreatorProfileUpdate,
  validateProfileImageUploadRequest,
} from "../validation/creator-profile.mjs";

const ULID = "01HZX7M6Z5GQK6T7Q8N9R0P1V2";

describe("validateCreatorProfileUpdate", () => {
  test("returns empty object for empty body", () => {
    expect(validateCreatorProfileUpdate({})).toEqual({});
  });

  test("only touches fields present in the body", () => {
    expect(validateCreatorProfileUpdate({ tagline: "Cloud educator" })).toEqual({
      tagline: "Cloud educator",
    });
  });

  test("trims simple strings and clears with null", () => {
    expect(validateCreatorProfileUpdate({ display_name: "  Allen  " })).toEqual({
      displayName: "Allen",
    });
    expect(validateCreatorProfileUpdate({ display_name: null })).toEqual({
      displayName: null,
    });
    // An all-whitespace string is treated as a clear.
    expect(validateCreatorProfileUpdate({ bio: "   " })).toEqual({ bio: null });
  });

  test("rejects an over-long display_name", () => {
    expect(() => validateCreatorProfileUpdate({ display_name: "x".repeat(81) })).toThrow(
      /at most 80 chars/,
    );
  });

  test("validates contact_email", () => {
    expect(validateCreatorProfileUpdate({ contact_email: "me@example.com" })).toEqual({
      contactEmail: "me@example.com",
    });
    expect(() => validateCreatorProfileUpdate({ contact_email: "nope" })).toThrow(
      /valid email/,
    );
  });

  test("validates accent_color", () => {
    expect(validateCreatorProfileUpdate({ accent_color: "#1A2B3C" })).toEqual({
      accentColor: "#1a2b3c",
    });
    expect(validateCreatorProfileUpdate({ accent_color: "#abc" })).toEqual({
      accentColor: "#abc",
    });
    expect(() => validateCreatorProfileUpdate({ accent_color: "blue" })).toThrow(
      /hex color/,
    );
  });

  test("dedupes niches and enforces limits", () => {
    expect(validateCreatorProfileUpdate({ niches: ["AWS", "aws", "Serverless"] })).toEqual({
      niches: ["AWS", "Serverless"],
    });
    expect(() => validateCreatorProfileUpdate({ niches: Array(21).fill("x").map((v, i) => v + i) })).toThrow(
      /at most 20 items/,
    );
    expect(validateCreatorProfileUpdate({ niches: null })).toEqual({ niches: [] });
  });

  test("social_accounts require a handle or url and floor followers", () => {
    expect(
      validateCreatorProfileUpdate({
        social_accounts: [
          { platform: "x", handle: "@allen", followers: 1234.9 },
          { platform: "youtube", url: "youtube.com/@allen" },
        ],
      }),
    ).toEqual({
      socialAccounts: [
        { platform: "x", handle: "@allen", url: null, followers: 1234 },
        { platform: "youtube", handle: null, url: "https://youtube.com/@allen", followers: null },
      ],
    });
  });

  test("social_accounts reject a bare entry with no handle or url", () => {
    expect(() =>
      validateCreatorProfileUpdate({ social_accounts: [{ platform: "x" }] }),
    ).toThrow(/handle or a url/);
  });

  test("social_accounts require a platform", () => {
    expect(() =>
      validateCreatorProfileUpdate({ social_accounts: [{ handle: "@x" }] }),
    ).toThrow(/platform is required/);
  });

  test("rate_card defaults currency to USD and validates the code", () => {
    expect(
      validateCreatorProfileUpdate({
        rate_card: [{ deliverable: "Sponsored post", price: 2500 }],
      }),
    ).toEqual({
      rateCard: [
        { deliverable: "Sponsored post", description: null, price: 2500, currency: "USD" },
      ],
    });
    expect(() =>
      validateCreatorProfileUpdate({ rate_card: [{ deliverable: "x", currency: "dollars" }] }),
    ).toThrow(/ISO 4217/);
    expect(() =>
      validateCreatorProfileUpdate({ rate_card: [{ deliverable: "x", price: -1 }] }),
    ).toThrow(/non-negative/);
  });

  test("testimonials require a quote", () => {
    expect(
      validateCreatorProfileUpdate({ testimonials: [{ quote: "Great work", author: "Jordan" }] }),
    ).toEqual({
      testimonials: [{ quote: "Great work", author: "Jordan", role: null, company: null }],
    });
    expect(() =>
      validateCreatorProfileUpdate({ testimonials: [{ author: "Jordan" }] }),
    ).toThrow(/quote is required/);
  });

  test("featured_collaborations validate brand and year", () => {
    expect(
      validateCreatorProfileUpdate({
        featured_collaborations: [{ brand: "Acme", url: "acme.example", year: 2025 }],
      }),
    ).toEqual({
      featuredCollaborations: [
        { brand: "Acme", description: null, url: "https://acme.example", year: 2025 },
      ],
    });
    expect(() =>
      validateCreatorProfileUpdate({ featured_collaborations: [{ brand: "Acme", year: 1800 }] }),
    ).toThrow(/between 1900 and 2999/);
  });

  test("audience validates percent maps and countries", () => {
    expect(
      validateCreatorProfileUpdate({
        audience: {
          age_brackets: { "18-24": 30, "25-34": 45 },
          gender: { male: 60, female: 40 },
          top_countries: [{ country: "United States", percent: 55 }],
          note: "Mostly developers",
        },
      }),
    ).toEqual({
      audience: {
        ageBrackets: { "18-24": 30, "25-34": 45 },
        gender: { male: 60, female: 40 },
        topCountries: [{ country: "United States", percent: 55 }],
        note: "Mostly developers",
      },
    });
    expect(() =>
      validateCreatorProfileUpdate({ audience: { age_brackets: { "18-24": 120 } } }),
    ).toThrow(/between 0 and 100/);
    expect(validateCreatorProfileUpdate({ audience: null })).toEqual({ audience: null });
  });

  test("public_slug accepts valid slugs and clears with null/empty", () => {
    expect(validateCreatorProfileUpdate({ public_slug: "allen-helton" })).toEqual({
      publicSlug: "allen-helton",
    });
    // Lowercased and trimmed.
    expect(validateCreatorProfileUpdate({ public_slug: "  Allen99  " })).toEqual({
      publicSlug: "allen99",
    });
    expect(validateCreatorProfileUpdate({ public_slug: null })).toEqual({ publicSlug: null });
    expect(validateCreatorProfileUpdate({ public_slug: "" })).toEqual({ publicSlug: null });
  });

  test("public_slug rejects invalid shapes", () => {
    expect(() => validateCreatorProfileUpdate({ public_slug: "ab" })).toThrow(/public_slug/); // too short
    expect(() => validateCreatorProfileUpdate({ public_slug: "Allen!" })).toThrow(/public_slug/);
    expect(() => validateCreatorProfileUpdate({ public_slug: "-allen" })).toThrow(/public_slug/);
    expect(() => validateCreatorProfileUpdate({ public_slug: "allen-" })).toThrow(/public_slug/);
    expect(() => validateCreatorProfileUpdate({ public_slug: "al--len" })).toThrow(/public_slug/);
    expect(() => validateCreatorProfileUpdate({ public_slug: "x".repeat(41) })).toThrow(/public_slug/);
  });

  test("avatar_key and logo_key must match minted keys", () => {
    expect(
      validateCreatorProfileUpdate({ avatar_key: `profile/avatar-${ULID}.png` }),
    ).toEqual({ avatarKey: `profile/avatar-${ULID}.png` });
    expect(validateCreatorProfileUpdate({ logo_key: null })).toEqual({ logoKey: null });
    expect(() =>
      validateCreatorProfileUpdate({ avatar_key: "profile/avatar-bad.png" }),
    ).toThrow(/upload endpoint/);
    expect(() =>
      validateCreatorProfileUpdate({ avatar_key: `profile/logo-${ULID}.png` }),
    ).toThrow(/upload endpoint/);
  });
});

describe("validateProfileImageUploadRequest", () => {
  test("accepts a valid kind and content type", () => {
    expect(validateProfileImageUploadRequest({ kind: "avatar", content_type: "image/png" })).toEqual({
      kind: "avatar",
      contentType: "image/png",
    });
  });

  test("rejects an unknown kind", () => {
    expect(() =>
      validateProfileImageUploadRequest({ kind: "banner", content_type: "image/png" }),
    ).toThrow(/kind must be one of/);
  });

  test("rejects an unsupported content type", () => {
    expect(() =>
      validateProfileImageUploadRequest({ kind: "logo", content_type: "image/svg+xml" }),
    ).toThrow(/content_type must be one of/);
  });
});
