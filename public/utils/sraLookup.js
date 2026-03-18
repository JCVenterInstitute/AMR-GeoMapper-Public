/**
 * Fetches species names for a list of SRA accessions using EBI ENA API.
 * @param {string[]} accessions - Array of strings like ['SRR8194862', 'SRR123456']
 * @returns {Promise<Object>} - Object mapping accession to species name
 */
function parseTsvMap(text, accessionField, speciesField) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return {};
  const headers = lines[0].split("\t");
  const accIdx = headers.indexOf(accessionField);
  const speciesIdx = headers.indexOf(speciesField);
  if (accIdx === -1 || speciesIdx === -1) return {};

  const out = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split("\t");
    const acc = cols[accIdx];
    const species = cols[speciesIdx];
    if (acc) out[acc] = species || "";
  }
  return out;
}

async function fetchJsonOrTsv(urlJson, urlTsv) {
  const response = await fetch(urlJson);
  if (!response.ok) throw new Error(`API Error: ${response.status}`);
  const text = await response.text();
  try {
    const data = JSON.parse(text);
    if (Array.isArray(data) && data.length > 0) {
      return { type: "json", data };
    }
  } catch (_) {
    // fall through to TSV
  }
  const tsvRes = await fetch(urlTsv);
  if (!tsvRes.ok) throw new Error(`API Error: ${tsvRes.status}`);
  const tsvText = await tsvRes.text();
  return { type: "tsv", data: tsvText };
}

async function fetchSearchFallback(baseSearchUrl, query) {
  const url = `${baseSearchUrl}?result=read_run&query=${encodeURIComponent(
    query
  )}&fields=run_accession,scientific_name&format=json`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`API Error: ${response.status}`);
  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

export async function getSpeciesBatch(accessions, options = {}) {
    const { onProgress } = options;
    // 1. EBI ENA Endpoint (Mirrors NCBI SRA)
    const BASE_URL = "https://www.ebi.ac.uk/ena/portal/api/filereport";
    const SEARCH_URL = "https://www.ebi.ac.uk/ena/portal/api/search";
    
    // 2. CONFIGURATION
    const CHUNK_SIZE = 50; // Keep URL length safe (under 2000 chars)
    const results = {};
  
    // 3. HELPER: Chunk the array
    const cleaned = Array.from(
      new Set(
        (accessions || [])
          .map((a) => String(a).trim())
          .filter(Boolean)
          .map((a) => a.toUpperCase())
      )
    );
    if (cleaned.length === 0) return results;

    const chunks = [];
    for (let i = 0; i < cleaned.length; i += CHUNK_SIZE) {
      chunks.push(cleaned.slice(i, i + CHUNK_SIZE));
    }
  
    // 4. PROCESS CHUNKS
    // We use a loop instead of Promise.all to avoid hitting rate limits with too many parallel connections
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const ids = chunk.join(",");
      
      // Construct URL
      // result=read_run -> Look for SRA runs
      // fields=scientific_name -> Only get the species
      // format=json -> Easy for JS
      const urlJson = `${BASE_URL}?accession=${ids}&result=read_run&fields=run_accession,scientific_name&format=json`;
      const urlTsv = `${BASE_URL}?accession=${ids}&result=read_run&fields=run_accession,scientific_name&format=tsv`;
  
      try {
        let foundAny = false;
        const res = await fetchJsonOrTsv(urlJson, urlTsv);
        if (res.type === "json") {
          res.data.forEach((item) => {
            results[item.run_accession] = item.scientific_name;
          });
          foundAny = res.data.length > 0;
        } else {
          const mapped = parseTsvMap(
            res.data,
            "run_accession",
            "scientific_name"
          );
          Object.assign(results, mapped);
          foundAny = Object.keys(mapped).length > 0;
        }

        if (!foundAny) {
          const query = chunk.map((id) => `run_accession=${id}`).join(" OR ");
          const fallbackData = await fetchSearchFallback(SEARCH_URL, query);
          fallbackData.forEach((item) => {
            results[item.run_accession] = item.scientific_name;
          });
        }
        
      } catch (err) {
        console.error("Batch failed:", err);
        // Optional: Add logic to retry failed chunks
      }
      onProgress?.({ completed: i + 1, total: chunks.length });
    }
  
    return results;
  }
  
  // Note: intentionally no inline usage to avoid side effects on import.