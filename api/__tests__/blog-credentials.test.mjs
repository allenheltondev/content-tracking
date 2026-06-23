import { jest } from "@jest/globals";

// The module reads ENVIRONMENT at import time (like ga-secrets.mjs), so it
// must be set before the dynamic import below.
process.env.ENVIRONMENT = "staging";

const getParameter = jest.fn();
const ssmSend = jest.fn();

class SSMClient {
  send(...args) {
    return ssmSend(...args);
  }
}
class PutParameterCommand {
  constructor(input) {
    this.input = input;
  }
}

jest.unstable_mockModule("@aws-lambda-powertools/parameters/ssm", () => ({ getParameter }));
jest.unstable_mockModule("@aws-sdk/client-ssm", () => ({ SSMClient, PutParameterCommand }));

const {
  blogCredentialsParam,
  getBlogCredentials,
  getBlogCredential,
  writeBlogCredentials,
} = await import("../services/blog-credentials.mjs");

const TENANT = "allen.helton";
const PARAM = "/booked/staging/tenants/allen.helton/blog-credentials";
const CREDS = { dev: "dev-key", medium: "medium-token", "medium-cookie": "cookie", hashnode: "hn-token" };

function notFoundError() {
  const err = new Error("ParameterNotFound: not configured");
  err.name = "ParameterNotFound";
  return err;
}

beforeEach(() => {
  getParameter.mockReset();
  ssmSend.mockReset();
});

describe("blogCredentialsParam", () => {
  it("builds the per-tenant SecureString path under /booked/{env}", () => {
    expect(blogCredentialsParam(TENANT)).toBe(PARAM);
  });

  it("throws when tenantId is missing", () => {
    expect(() => blogCredentialsParam()).toThrow(/tenantId is required/);
    expect(() => blogCredentialsParam("")).toThrow(/tenantId is required/);
  });
});

describe("getBlogCredentials", () => {
  it("reads, decrypts, and parses the JSON blob", async () => {
    getParameter.mockResolvedValue(JSON.stringify(CREDS));

    const result = await getBlogCredentials(TENANT);

    expect(result).toEqual(CREDS);
    expect(getParameter).toHaveBeenCalledWith(PARAM, { decrypt: true, forceFetch: false });
  });

  it("passes forceFetch through to bypass the cache", async () => {
    getParameter.mockResolvedValue(JSON.stringify(CREDS));

    await getBlogCredentials(TENANT, { forceFetch: true });

    expect(getParameter).toHaveBeenCalledWith(PARAM, { decrypt: true, forceFetch: true });
  });

  it("returns null when the parameter is not configured", async () => {
    getParameter.mockRejectedValue(notFoundError());

    await expect(getBlogCredentials(TENANT)).resolves.toBeNull();
  });

  it("returns null when the value is empty", async () => {
    getParameter.mockResolvedValue(undefined);

    await expect(getBlogCredentials(TENANT)).resolves.toBeNull();
  });

  it("throws on malformed JSON", async () => {
    getParameter.mockResolvedValue("{ not json");

    await expect(getBlogCredentials(TENANT)).rejects.toThrow(/not valid JSON/);
  });

  it("rethrows non-not-found SSM errors", async () => {
    getParameter.mockRejectedValue(new Error("AccessDenied"));

    await expect(getBlogCredentials(TENANT)).rejects.toThrow(/AccessDenied/);
  });
});

describe("getBlogCredential", () => {
  it("returns a single platform credential", async () => {
    getParameter.mockResolvedValue(JSON.stringify(CREDS));

    await expect(getBlogCredential(TENANT, "hashnode")).resolves.toBe("hn-token");
  });

  it("returns null when the tenant has no credentials", async () => {
    getParameter.mockRejectedValue(notFoundError());

    await expect(getBlogCredential(TENANT, "dev")).resolves.toBeNull();
  });

  it("throws when credentials exist but the key is missing", async () => {
    getParameter.mockResolvedValue(JSON.stringify({ dev: "dev-key" }));

    await expect(getBlogCredential(TENANT, "hashnode")).rejects.toThrow(/missing key "hashnode"/);
  });
});

describe("writeBlogCredentials", () => {
  it("writes a SecureString with overwrite", async () => {
    ssmSend.mockResolvedValue({});

    await writeBlogCredentials(TENANT, CREDS);

    expect(ssmSend).toHaveBeenCalledTimes(1);
    const command = ssmSend.mock.calls[0][0];
    expect(command).toBeInstanceOf(PutParameterCommand);
    expect(command.input).toEqual({
      Name: PARAM,
      Type: "SecureString",
      Value: JSON.stringify(CREDS),
      Overwrite: true,
    });
  });
});
