import * as devto from "./devto.mjs";
import * as medium from "./medium.mjs";
import * as hashnode from "./hashnode.mjs";

// Registry keyed by platform name (matching the credential keys and
// parse-blog's BLOG_PLATFORMS). The cross-post durable function looks up
// the adapter by platform and calls publish().
export const adapters = {
  dev: devto,
  medium,
  hashnode,
};

export function getAdapter(platform) {
  const adapter = adapters[platform];
  if (!adapter) {
    throw new Error(`No publish adapter for platform "${platform}"`);
  }
  return adapter;
}
