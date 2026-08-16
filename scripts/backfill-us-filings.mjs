import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * Downloads EDGAR's quarterly filing indexes into us_filings.
 *
 * form.idx lists every filing made in a quarter — form type, company, CIK, date
 * and path — as fixed-width text. Nine of them cover the two years the bars
 * cover, which is the whole point of using them: the per-company endpoint would
 * be sixteen thousand requests to learn the same thing.
 *
 * No key and no rate limit beyond SEC's ten-a-second, but the files run to tens
 * of megabytes, so rows are written in chunks rather than held whole.
 *
 * Usage:
 *   npm run us:filings
 */

const config = readConfig();

const quarters = [
  ["2024", "QTR3"], ["2024", "QTR4"],
  ["2025", "QTR1"], ["2025", "QTR2"], ["2025", "QTR3"], ["2025", "QTR4"],
  ["2026", "QTR1"], ["2026", "QTR2"], ["2026", "QTR3"]
];

const chunkSize = 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * form.idx is column-aligned, but not to its own header: the header writes
 * "Company Name" at column 12 while the rows pad the form type out to 17, so
 * slicing at the header offsets cuts the date in half and Postgres is handed
 * "2024-09".
 *
 * Read from the right instead, where the shape is unambiguous — the path has no
 * spaces, the date is ISO, and the CIK is digits. Only the company name can
 * contain runs of spaces, and it is the field nothing is keyed on.
 */
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

async function saveFilings(rows) {
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

for (const [year, quarter] of quarters) {
  const stored = await query(
    config,
    "SELECT count(*)::int AS n FROM us_filings WHERE filed_date >= $1 AND filed_date < $2",
    [`${year}-${{ QTR1: "01", QTR2: "04", QTR3: "07", QTR4: "10" }[quarter]}-01`,
      quarter === "QTR4" ? `${Number(year) + 1}-01-01` : `${year}-${{ QTR1: "04", QTR2: "07", QTR3: "10" }[quarter]}-01`]
  );

  if (stored.rows[0].n > 0) {
    console.log(`${year} ${quarter} already stored (${stored.rows[0].n})`);
    continue;
  }

  const response = await fetch(
    `https://www.sec.gov/Archives/edgar/full-index/${year}/${quarter}/form.idx`,
    { headers: { "Accept-Encoding": "gzip", "User-Agent": config.sec.userAgent } }
  );

  // Quarters that have not happened yet simply are not published.
  if (response.status === 404) {
    console.log(`${year} ${quarter} not published`);
    continue;
  }

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${year} ${quarter}`);
  }

  const { rows, skipped } = parseFormIndex(await response.text());

  await saveFilings(rows);

  console.log(`${year} ${quarter} ${rows.length} filings${skipped > 0 ? ` · ${skipped} unparsed` : ""}`);
  await sleep(500);
}

console.log("done");
process.exit(0);
