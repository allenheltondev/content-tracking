import { ulid } from "ulid";
import { BadRequestError } from "../services/errors.mjs";
import { jsonResponse } from "../services/http-handler.mjs";
import { buildVendorReportSnapshot } from "../domain/vendor-report.mjs";
import { renderVendorReportHtml } from "../services/report-renderer.mjs";
import { putReportHtml, signReportUrl } from "../services/vendor-report-store.mjs";
import { listReportRecords, saveReportRecord } from "../domain/vendor-report-record.mjs";
import { VENDOR_ID_RE } from "../validation/vendor.mjs";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function registerVendorReportRoutes(app) {
  // POST /vendors/:vendorId/report
  //
  // Generates a fresh report: builds the snapshot, renders the HTML,
  // stores it in the private reports bucket, persists a record, and
  // returns a signed CloudFront link. The period comes from the body
  // (falling back to query string), parsed exactly like GET /revenue:
  // either `year` or `startDate`/`endDate`, defaulting to the current year.
  app.post("/vendors/:vendorId/report", async ({ event, params }) => {
    const vendorId = requireValidVendorId(params.vendorId);
    const { startDate, endDate } = parsePeriod(periodSource(event));

    const snapshot = await buildVendorReportSnapshot({ vendorId, startDate, endDate });

    const reportId = ulid();
    snapshot.report.id = reportId;

    const html = renderVendorReportHtml(snapshot);
    const key = await putReportHtml({ vendorId, reportId, html });
    const { url, expiresAt } = signReportUrl(key);

    await saveReportRecord({
      vendorId,
      reportId,
      key,
      generatedAt: snapshot.report.generatedAt,
      dataAsOf: snapshot.report.dataAsOf,
      period: snapshot.report.period,
      currency: snapshot.report.currency,
      summary: snapshot.summary,
    });

    return jsonResponse(201, {
      reportId,
      url,
      expiresAt,
      dataAsOf: snapshot.report.dataAsOf,
      period: snapshot.report.period,
      currency: snapshot.report.currency,
      summary: snapshot.summary,
    });
  });

  // GET /vendors/:vendorId/reports
  //
  // Lists previously-generated reports newest-first, minting a FRESH
  // signed link for each so a vendor can be re-sent a working URL without
  // regenerating the report.
  app.get("/vendors/:vendorId/reports", async ({ params }) => {
    const vendorId = requireValidVendorId(params.vendorId);
    const records = await listReportRecords(vendorId);

    const reports = records.map((record) => {
      const { url, expiresAt } = signReportUrl(record.key);
      return {
        reportId: record.reportId,
        generatedAt: record.generatedAt,
        dataAsOf: record.dataAsOf,
        period: record.period,
        currency: record.currency,
        url,
        expiresAt,
      };
    });

    return jsonResponse(200, { vendor_id: vendorId, reports });
  });
}

function requireValidVendorId(vendorId) {
  if (!VENDOR_ID_RE.test(vendorId ?? "")) {
    throw new BadRequestError(
      "vendorId must be 1-80 characters of letters, digits, underscores, or hyphens",
    );
  }
  return vendorId;
}

// The POST body is optional. When present it must be JSON; period params
// live there but fall back to the query string. An empty/absent body is
// fine — the period defaults to the current year.
function periodSource(event) {
  const query = event?.queryStringParameters ?? {};
  if (!event?.body) {
    return query;
  }
  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    throw new BadRequestError("Invalid JSON body");
  }
  if (body === null || typeof body !== "object") {
    return query;
  }
  // Body wins, but fall back to query for any field it omits.
  return {
    year: body.year ?? query.year,
    startDate: body.startDate ?? query.startDate,
    endDate: body.endDate ?? query.endDate,
  };
}

// Mirrors routes/revenue.mjs: `year` XOR `startDate`/`endDate`, ISO date
// validation, year-range validation, defaulting to the current calendar
// year. Kept in sync with that endpoint's rules and messages.
function parsePeriod(params) {
  if (params.startDate !== undefined || params.endDate !== undefined) {
    if (params.year !== undefined) {
      throw new BadRequestError("use either year or startDate/endDate, not both");
    }
    if (params.startDate !== undefined && !ISO_DATE_RE.test(params.startDate)) {
      throw new BadRequestError("startDate must be YYYY-MM-DD");
    }
    if (params.endDate !== undefined && !ISO_DATE_RE.test(params.endDate)) {
      throw new BadRequestError("endDate must be YYYY-MM-DD");
    }
    return {
      startDate: params.startDate || `${new Date().getUTCFullYear()}-01-01`,
      endDate: params.endDate || `${new Date().getUTCFullYear()}-12-31`,
    };
  }

  const year = params.year !== undefined ? Number(params.year) : new Date().getUTCFullYear();
  if (!Number.isInteger(year) || year < 1900 || year > 2999) {
    throw new BadRequestError("year must be an integer between 1900 and 2999");
  }
  return {
    startDate: `${year}-01-01`,
    endDate: `${year}-12-31`,
  };
}
