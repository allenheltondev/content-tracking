// Shared validation + formatting for Vendor entity.
//
// Centralized so create-vendor and update-vendor agree on field rules and
// the various read endpoints emit a consistent shape.

const NAME_MAX = 200;
const URL_MAX = 500;
const CONTACT_NAME_MAX = 200;
const CONTACT_EMAIL_MAX = 320; // RFC 5321 maximum address length
const PAYMENT_TERMS_MAX = 500;
const NOTES_MAX = 2000;
const TAG_MAX = 50;
const TAGS_MAX_COUNT = 20;

// Simple "looks like an email" check. Not RFC-perfect; just guards against
// obvious typos. Validation deeper than this is the caller's problem.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateVendorPayload(body, { requireName }) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, message: "request body must be a JSON object" };
  }

  const out = {};
  const { name, website, contact_name, contact_email, payment_terms, tags, notes } = body;

  if (name !== undefined) {
    if (typeof name !== "string" || name.trim().length === 0) {
      return { ok: false, message: "name must be a non-empty string" };
    }
    if (name.length > NAME_MAX) {
      return { ok: false, message: `name exceeds ${NAME_MAX} chars` };
    }
    out.name = name.trim();
  } else if (requireName) {
    return { ok: false, message: "name is required" };
  }

  // For all optional fields below: `undefined` means "field absent, ignore",
  // `null` means "caller wants this cleared" (forwarded so update-vendor can
  // emit a REMOVE clause). Values get validated as usual.

  if (website !== undefined) {
    if (website === null) {
      out.website = null;
    } else {
      if (typeof website !== "string" || website.length > URL_MAX) {
        return { ok: false, message: `website must be a string up to ${URL_MAX} chars` };
      }
      if (website.length > 0 && !/^https?:\/\//i.test(website)) {
        return { ok: false, message: "website must start with http:// or https://" };
      }
      out.website = website;
    }
  }

  if (contact_name !== undefined) {
    if (contact_name === null) {
      out.contact_name = null;
    } else {
      if (typeof contact_name !== "string" || contact_name.length > CONTACT_NAME_MAX) {
        return { ok: false, message: `contact_name must be a string up to ${CONTACT_NAME_MAX} chars` };
      }
      out.contact_name = contact_name;
    }
  }

  if (contact_email !== undefined) {
    if (contact_email === null) {
      out.contact_email = null;
    } else {
      if (typeof contact_email !== "string" || contact_email.length > CONTACT_EMAIL_MAX) {
        return { ok: false, message: `contact_email must be a string up to ${CONTACT_EMAIL_MAX} chars` };
      }
      if (contact_email.length > 0 && !EMAIL_RE.test(contact_email)) {
        return { ok: false, message: "contact_email must look like an email address" };
      }
      out.contact_email = contact_email;
    }
  }

  if (payment_terms !== undefined) {
    if (payment_terms === null) {
      out.payment_terms = null;
    } else {
      if (typeof payment_terms !== "string" || payment_terms.length > PAYMENT_TERMS_MAX) {
        return { ok: false, message: `payment_terms must be a string up to ${PAYMENT_TERMS_MAX} chars` };
      }
      out.payment_terms = payment_terms;
    }
  }

  if (notes !== undefined) {
    if (notes === null) {
      out.notes = null;
    } else {
      if (typeof notes !== "string" || notes.length > NOTES_MAX) {
        return { ok: false, message: `notes must be a string up to ${NOTES_MAX} chars` };
      }
      out.notes = notes;
    }
  }

  if (tags !== undefined) {
    if (tags === null) {
      out.tags = null;
    } else {
      if (!Array.isArray(tags)) {
        return { ok: false, message: "tags must be an array of strings" };
      }
      if (tags.length > TAGS_MAX_COUNT) {
        return { ok: false, message: `tags may contain at most ${TAGS_MAX_COUNT} entries` };
      }
      for (const t of tags) {
        if (typeof t !== "string" || t.length === 0 || t.length > TAG_MAX) {
          return { ok: false, message: `each tag must be a non-empty string up to ${TAG_MAX} chars` };
        }
      }
      out.tags = tags;
    }
  }

  return { ok: true, value: out };
}

export function formatVendor(row) {
  return {
    vendor_id: row.vendorId,
    name: row.name,
    website: row.website ?? null,
    contact_name: row.contact_name ?? null,
    contact_email: row.contact_email ?? null,
    payment_terms: row.payment_terms ?? null,
    tags: row.tags ?? [],
    notes: row.notes ?? null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}
