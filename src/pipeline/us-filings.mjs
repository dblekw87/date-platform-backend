import { query } from "../db/client.mjs";
import { sleep } from "./massive.mjs";

/**
 * EDGAR's quarterly filing indexes.
 *
 * form.idx lists every filing made in a quarter — form type, company, CIK, date
 * and path — as fixed-width text. Nine of them cover the two years the bars
 * cover, which is the point of using them: the per-company endpoint would be
 * sixteen thousand requests to learn the same thing.
 *
 * No key and no rate limit beyond SEC's ten a second, but the files run to tens
 * of megabytes, so rows are written in chunks rather than held whole.
 */

const chunkSize = 5000;

const quarterStart = { QTR1: "01", QTR2: "04", QTR3: "07", QTR4: "10" };

export function quarterRange(year, quarter) {
  const from = `${year}-${quarterStart[quarter]}-01`;
  const to = quarter === "QTR4"
    ? `${Number(year) + 1}-01-01`
    : `${year}-${quarterStart[{ QTR1: "QTR2", QTR2: "QTR3", QTR3: "QTR4" }[quarter]]}-01`;

  return { from, to };
}

export function quarterOf(iso) {
  const [year, month] = iso.split("-");

  return [year, `QTR${Math.floor((Number(month) - 1) / 3) + 1}`];
}

const rowPattern = /^(\S+(?:\s\S+)*?)\s{2,}(.+?)\s{2,}(\d{1,10})\s+(\d{4}-\d{2}-\d{2})\s+(\S+)\s*$/;

function parseFormIndex(text) {
  const lines = text.split("\n");
  const divider = lines.findIndex((line) => line.startsWith("-----"));

  if (divider < 0) return { rows: [], skipped: 0 };

  const rows = [];
  let skipped = 0;

  for (const line of lines.slice(divider + 1)) {
    if (line.trim().length === 0) continue;

    const match = rowPattern.exec(line);

    if (!match) {
      skipped += 1;
      continue;
    }

    const [, formType, companyName, cik, filedDate, path] = match;

    rows.push({
      // The accession is the filename, which is unique per filing and is what
      // every other SEC surface refers to it by.
      accession: path.split("/").pop().replace(/\.txt$/, ""),
      cik: Number(cik),
      companyName: companyName.trim() || null,
      filedDate,
      formType
    });
  }

  return { rows, skipped };
}

async function saveFilings(config, rows) {
  for (let index = 0; index < rows.length; index += chunkSize) {
    const chunk = rows.slice(index, index + chunkSize);

    await query(
      config,
      `INSERT INTO us_filings (cik, accession, form_type, filed_date, company_name)
       SELECT cik, accession, form_type, filed_date, company_name
       FROM unnest($1::int[], $2::text[], $3::text[], $4::date[], $5::text[])
         AS t(cik, accession, form_type, filed_date, company_name)
       ON CONFLICT (cik, accession) DO NOTHING`,
      [
        chunk.map((row) => row.cik),
        chunk.map((row) => row.accession),
        chunk.map((row) => row.formType),
        chunk.map((row) => row.filedDate),
        chunk.map((row) => row.companyName)
      ]
    );
  }
}


export async function fetchUsFilings(config, quarters, { force = false, onQuarter } = {}) {
  for (const [year, quarter] of quarters) {
    const { from, to } = quarterRange(year, quarter);

    if (!force) {
      const stored = await query(
        config,
        "SELECT count(*)::int AS n FROM us_filings WHERE filed_date >= $1 AND filed_date < $2",
        [from, to]
      );

      if (stored.rows[0].n > 0) {
        onQuarter?.({ quarter, status: "stored", stored: stored.rows[0].n, year });
        continue;
      }
    }

    const response = await fetch(
      `https://www.sec.gov/Archives/edgar/full-index/${year}/${quarter}/form.idx`,
      { headers: { "Accept-Encoding": "gzip", "User-Agent": config.sec.userAgent } }
    );

    // Quarters that have not happened yet simply are not published.
    if (response.status === 404) {
      onQuarter?.({ quarter, status: "unpublished", year });
      continue;
    }

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText} for ${year} ${quarter}`);
    }

    const { rows, skipped } = parseFormIndex(await response.text());

    await saveFilings(config, rows);
    onQuarter?.({ count: rows.length, quarter, skipped, status: "fetched", year });
    await sleep(500);
  }
}
