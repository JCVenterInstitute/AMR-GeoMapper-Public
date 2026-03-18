const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const controller = {};

const DATA_ROOT = path.resolve(path.join(__dirname, "../public/data"));

function makePredicate(queryStringList) {
  const predicate = queryStringList.reduce(
    (acc, { family, genus, species }) => {
      acc[family.toLowerCase()] ??= {};
      acc[family.toLowerCase()][genus.toLowerCase()] ??= new Set();
      acc[family.toLowerCase()][genus.toLowerCase()].add(species.toLowerCase());
      return acc;
    },
    {},
  );
  return predicate;
}

/**
 * Build a projection function that strips fields the front-end doesn't need.
 * @param {Set<string>} allowedObs - observation-level field names to keep
 */
function makeProjection(allowedObs) {
  const ROW_KEYS = [
    "family",
    "genus",
    "species",
    "country",
    "state_province",
    "collection_year",
    "collection_date",
    "dataset",
    "observations",
  ];

  return function projectRow(row) {
    const out = {};
    for (const k of ROW_KEYS) {
      if (row[k] !== undefined) out[k] = row[k];
    }
    if (Array.isArray(row.observations) && allowedObs.size > 0) {
      out.observations = row.observations.map((obs) => {
        const o = {};
        for (const k of allowedObs) {
          if (obs[k] !== undefined) o[k] = obs[k];
        }
        return o;
      });
    }
    return out;
  };
}

controller.getData = async function (req, res) {
  const { species, dataFile, observationFields } = req.body;

  if (!dataFile || typeof dataFile !== "string") {
    res.status(400).json({ error: "dataFile is required" });
    return;
  }

  // Path traversal protection
  const resolved = path.resolve(
    path.join(DATA_ROOT, dataFile.replace(/^data\//, "")),
  );
  if (!resolved.startsWith(DATA_ROOT) || !resolved.endsWith(".jsonl")) {
    res.status(400).json({ error: "Invalid dataFile path" });
    return;
  }

  if (!fs.existsSync(resolved)) {
    res.status(400).json({ error: "Data file not found" });
    return;
  }

  const allowedObsFields = new Set(
    Array.isArray(observationFields) ? observationFields : [],
  );

  const input = fs.createReadStream(resolved, { encoding: "utf8" });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const predicate = makePredicate(species || []);
  const projectRow = makeProjection(allowedObsFields);

  // Stop reading if the client disconnects
  res.on("close", () => input.destroy());

  const tryRow = (row, predicate) => {
    if (Object.hasOwn(predicate, row.family.toLowerCase())) {
      if (
        Object.hasOwn(
          predicate[row.family.toLowerCase()],
          row.genus.toLowerCase(),
        )
      ) {
        if (
          predicate[row.family.toLowerCase()][row.genus.toLowerCase()].has(
            row.species.toLowerCase(),
          )
        ) {
          return true;
        }
      }
    }
    return false;
  };

  let first = true;
  res.write("[");

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (tryRow(obj, predicate)) {
        if (!first) res.write(",");
        res.write(JSON.stringify(projectRow(obj)));
        first = false;
      }
    } catch {
      // skip malformed lines
    }
  }

  res.write("]");
  res.end();
};

module.exports = controller;
