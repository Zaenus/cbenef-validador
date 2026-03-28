const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = 3000;

app.use(cors());
// Apply a large body-parser limit for the export endpoint before the global limiter.
// body-parser skips re-parsing if the request body was already read, so this
// takes precedence over the global middleware below for that path.
app.use('/api/export-assign-cbenef', bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.json({ limit: '1mb' }));
app.use(express.static('public'));

// Rate limiter for file-upload endpoints (max 30 requests per 15 minutes per IP)
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Tente novamente em alguns minutos.' }
});

// Multer setup: store files temporarily in 'uploads/' folder
const upload = multer({ dest: 'uploads/' });

// In-memory table (loaded once or after upload)
let officialTable = [];

function loadTable() {
  const filePath = path.join(__dirname, 'data/official-cbenef.json');

  if (!fs.existsSync(filePath)) {
    console.log('⚠️  File not found: data/official-cbenef.json');
    officialTable = [];
    return;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8').trim();

    if (!content) {
      console.log('⚠️  File is empty: data/official-cbenef.json');
      officialTable = [];
      return;
    }

    officialTable = JSON.parse(content);
    console.log(`✅ Loaded ${officialTable.length} cBenef entries`);
  } catch (err) {
    console.error('❌ Failed to parse data/official-cbenef.json');
    console.error('Error:', err.message);
    console.error('→ Setting empty table and continuing...');
    officialTable = [];
  }
}

loadTable(); // initial load

// ────────────────────────────────────────────────
// NCM → cBenef mapping (optional, user-supplied)
// Each entry: { ncm, cbenef, cst?, cfop?, description? }
// ncm may be 2-8 digits (prefix match) or an exact 8-digit code.
// ────────────────────────────────────────────────
let ncmCbenefMapping = [];

function loadNcmMapping() {
  const filePath = path.join(__dirname, 'data/ncm-cbenef-mapping.json');
  if (!fs.existsSync(filePath)) {
    ncmCbenefMapping = [];
    return;
  }
  try {
    const content = fs.readFileSync(filePath, 'utf8').trim();
    ncmCbenefMapping = content ? JSON.parse(content) : [];
    console.log(`✅ Loaded ${ncmCbenefMapping.length} NCM-cBenef mapping entries`);
  } catch (err) {
    console.error('❌ Failed to parse data/ncm-cbenef-mapping.json:', err.message);
    ncmCbenefMapping = [];
  }
}
loadNcmMapping();

/**
 * Look up the most specific NCM-cBenef mapping for a given product.
 * Returns the matching entry (with the longest NCM prefix) or null.
 * Filters are applied in order: NCM prefix → optional CST → optional CFOP.
 */
function findNcmMapping(ncm, cfop, cst) {
  if (!ncm || !ncmCbenefMapping.length) return null;
  const cleanNcm = String(ncm).replace(/\D/g, '');
  if (!cleanNcm) return null;

  const candidates = ncmCbenefMapping.filter(m => {
    const mNcm = String(m.ncm || '').replace(/\D/g, '');
    if (!mNcm) return false;
    // Accept exact match or prefix (mapping NCM is a prefix of the product NCM)
    if (!cleanNcm.startsWith(mNcm)) return false;
    // Optional CST filter
    if (m.cst && String(m.cst).padStart(2, '0') !== String(cst || '').padStart(2, '0')) return false;
    // Optional CFOP filter
    if (m.cfop && String(m.cfop) !== String(cfop || '')) return false;
    return true;
  });

  if (candidates.length === 0) return null;
  // Prefer the most specific (longest) NCM prefix
  return candidates.sort((a, b) =>
    String(b.ncm).replace(/\D/g, '').length - String(a.ncm).replace(/\D/g, '').length
  )[0];
}

/**
 * Returns 'saida' when the CFOP indicates an outbound operation (5xxx, 6xxx, 7xxx),
 * 'entrada' when it indicates an inbound operation (1xxx, 2xxx, 3xxx), or null when
 * the CFOP is absent or unrecognised.
 */
function getOperationDirection(cfop) {
  if (!cfop) return null;
  const cfopStr = String(cfop).replace(/\D/g, '');
  if (!cfopStr) return null;
  const first = cfopStr.charAt(0);
  if (first === '5' || first === '6' || first === '7') return 'saida';
  if (first === '1' || first === '2' || first === '3') return 'entrada';
  return null;
}

/**
 * Returns true when a cBenef entry's description is compatible with the given
 * operation direction ('saida' or 'entrada').
 *
 * Rules (applied after NFD accent-normalisation, so 'saída'→'saida', 'aquisição'→'aquisicao'):
 *   - If the description mentions 'saida'/'saidas' it is for outbound only.
 *   - If the description mentions 'entrada'/'entradas' or starts with 'aquisi' (aquisição)
 *     it is for inbound only.
 *   - General descriptions (no direction keyword) are compatible with both directions.
 */
function descriptionMatchesDirection(description, direction) {
  if (!description || !direction) return true;
  const norm = description.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const hasSaida   = /\bsaida/.test(norm);
  const hasEntrada = /\bentrada|\baquisi/.test(norm); // 'aquisicao' after NFD normalisation
  if (direction === 'saida')   return hasSaida || !hasEntrada;
  if (direction === 'entrada') return hasEntrada || !hasSaida;
  return true;
}

/**
 * Filters a list of specific cBenef entries by the inferred operation direction,
 * keeping entries whose description is compatible with 'saida' or 'entrada'.
 * Falls back to the original list when the direction is unknown or when filtering
 * would remove all candidates (so the caller always receives at least one option).
 */
function filterEntriesByDirection(entries, cfop) {
  const direction = getOperationDirection(cfop);
  if (!direction) return entries;
  const filtered = entries.filter(e => descriptionMatchesDirection(e.description, direction));
  // Fall back to the unfiltered list rather than returning nothing; the caller still
  // has the correct entries for ambiguous descriptions.
  return filtered.length > 0 ? filtered : entries;
}

// Validate endpoint (same as before)
app.post('/api/validate', (req, res) => {
  const { uf, cbenef, cst } = req.body;

  const result = officialTable.filter(item =>
    (!uf || item.uf === uf.toUpperCase()) &&
    item.code.toUpperCase() === cbenef.toUpperCase()
  );

  if (result.length === 0) {
    return res.json({ valid: false, message: 'Código cBenef inválido ou não encontrado.' });
  }

  const match = result[0];
  const cstValid = !cst || match.applicableCST.includes(cst.padStart(2, '0')); // ensure CST is '00', '10' etc.

  res.json({
    valid: cstValid,
    code: match.code,
    description: match.description,
    applicableCST: match.applicableCST,
    legislation: match.legislation || match.baseLegal,
    message: cstValid
      ? '✅ Válido!'
      : '⚠️ Código existe, mas não compatível com o CST informado.'
  });
});

// NEW: Upload + parse XLSX
app.post('/api/upload-table', uploadLimiter, upload.single('table'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    }

    const filePath = req.file.path;
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];

    const rawData = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      defval: '',
      blankrows: false
    });

    const cleaned = rawData.filter(row => row.some(cell => cell !== '' && cell != null));

    if (cleaned.length < 2) {
      fs.unlinkSync(filePath);
      return res.status(400).json({ error: 'Planilha vazia ou sem cabeçalho.' });
    }

    // Normalize headers: lowercase, remove accents, spaces → underscores
    const headers = cleaned[0].map(h => {
      let str = (h || '').toString().trim().toLowerCase();
      str = str.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); // remove accents
      str = str.replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
      return str;
    });

    console.log('Headers detected:', headers);

    // Find column indices
    const codeIdx = headers.findIndex(h =>
      h.includes('codigo') || h.includes('cbenef') || h === 'cdigo' || h.includes('c_ben')
    );

    const dispIdx = headers.findIndex(h =>
      h.includes('dispositivo') || h.includes('artigo') || h.includes('decreto') ||
      h.includes('legal') || h.includes('base')
    );

    const descIdx = headers.findIndex(h =>
      h.includes('objeto') || h.includes('descricao') || h.includes('descri') ||
      h.includes('beneficio') || h.includes('obs') || h.includes('observacao')
    );

    const obsIdx = headers.findIndex(h => h.includes('observ') || h.includes('obs'));

    // CST columns: contain 'cst' and two digits
    const cstIndices = headers
      .map((h, i) => ({ h, i }))
      .filter(({ h }) => h.includes('cst') && /\d{2}/.test(h))
      .map(o => o.i);

    console.log(`Detected ${cstIndices.length} CST columns`);

    if (codeIdx === -1) {
      console.error('CRITICAL: Could not find "Código" column!');
      fs.unlinkSync(filePath);
      return res.status(400).json({
        error: 'Coluna "Código" não encontrada na planilha. Verifique o cabeçalho.'
      });
    }

    // ← MISSING LINE WAS HERE
    const dataRows = cleaned.slice(1);

    let normalized = dataRows.map(row => {
      const codeCell = row[codeIdx] ? String(row[codeIdx]).trim().toUpperCase() : '';

      // Accept "SEM CBENEF" or SP followed by exactly 6 digits
      if (!codeCell || (codeCell !== 'SEM CBENEF' && !codeCell.match(/^SP\d{6}$/))) {
        return null;
      }

      let applicableCST = [];

      cstIndices.forEach(i => {
        const val = String(row[i] || '').trim().toUpperCase();
        // Consider "SIM", "X", "✓" or any non-empty cell as applicable
        if (val === 'SIM' || val === 'X' || val === '✓' || val !== '') {
          const header = headers[i];
          const match = header.match(/(\d{2})/);
          if (match) {
            applicableCST.push(match[1]);
          }
        }
      });

      applicableCST = [...new Set(applicableCST)].sort((a, b) => a.localeCompare(b));

      return {
        uf: 'SP',
        code: codeCell,
        description: descIdx >= 0 ? String(row[descIdx] || '').trim() : '',
        applicableCST,
        legislation: dispIdx >= 0 ? String(row[dispIdx] || '').trim() : '',
        observation: obsIdx >= 0 ? String(row[obsIdx] || '').trim() : ''
      };
    }).filter(item => item !== null && item.code);

    if (normalized.length === 0) {
      console.warn('⚠️ No valid entries parsed after processing');
      fs.unlinkSync(filePath);
      return res.status(400).json({
        success: false,
        message: 'Nenhum código válido encontrado. Verifique se há linhas com "SPxxxxxx" ou "SEM CBENEF" na coluna Código.'
      });
    }

    // Save and reload
    const jsonPath = path.join(__dirname, 'data/official-cbenef.json');
    fs.writeFileSync(jsonPath, JSON.stringify(normalized, null, 2), 'utf8');

    fs.unlinkSync(filePath);
    loadTable();

    res.json({
      success: true,
      message: `Tabela SP atualizada com ${normalized.length} códigos válidos.`,
      count: normalized.length
    });

  } catch (err) {
    console.error(err);
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: 'Erro ao processar a planilha: ' + err.message });
  }
});

// ────────────────────────────────────────────────
// Upload NCM → cBenef mapping
// Accepts a CSV or XLSX file with columns: ncm, cbenef
// Optional columns: cst, cfop, description
// ────────────────────────────────────────────────
app.post('/api/upload-ncm-mapping', uploadLimiter, upload.single('mapping'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    }

    const filePath = req.file.path;
    const originalName = req.file.originalname || '';
    const rows = parseUploadedFile(filePath, originalName);
    fs.unlinkSync(filePath);

    if (rows.length === 0) {
      return res.status(400).json({ error: 'Nenhum dado encontrado no arquivo.' });
    }

    const normalizeKey = k => String(k || '').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, '');

    const getField = (obj, candidates) => {
      const objKeys = Object.keys(obj);
      for (const candidate of candidates) {
        if (obj[candidate] !== undefined) return String(obj[candidate] != null ? obj[candidate] : '').trim();
        const normCand = normalizeKey(candidate);
        const found = objKeys.find(k => normalizeKey(k) === normCand);
        if (found !== undefined) return String(obj[found] != null ? obj[found] : '').trim();
      }
      return '';
    };

    const parsed = [];
    const errors = [];

    rows.forEach((row, idx) => {
      const ncm    = getField(row, ['ncm', 'codigo_ncm', 'cod_ncm', 'Cód. NCM', 'Cod. NCM']);
      const cbenef = getField(row, ['cbenef', 'c_benef', 'codigo_beneficio', 'cBenef']).toUpperCase();
      const cst    = getField(row, ['cst', 'CST', 'csosn']);
      const cfop   = getField(row, ['cfop', 'CFOP']);
      const desc   = getField(row, ['description', 'descricao', 'obs', 'observacao', 'nota']);

      if (!ncm || !cbenef) {
        errors.push(`Linha ${idx + 2}: NCM e cBenef são obrigatórios`);
        return;
      }

      const cleanNcm = ncm.replace(/\D/g, '');
      if (!cleanNcm || cleanNcm.length < 2 || cleanNcm.length > 8) {
        errors.push(`Linha ${idx + 2}: NCM inválido "${ncm}" (deve ter 2-8 dígitos)`);
        return;
      }

      if (cbenef !== 'SEM CBENEF' && !/^[A-Z]{2}\d{6}$/.test(cbenef)) {
        errors.push(`Linha ${idx + 2}: cBenef inválido "${cbenef}" (formato esperado: UF + 6 dígitos)`);
        return;
      }

      const entry = { ncm: cleanNcm, cbenef };
      if (cst) entry.cst = String(cst).replace(/\D/g, '').padStart(2, '0');
      if (cfop) entry.cfop = String(cfop).replace(/\D/g, '');
      if (desc) entry.description = desc;

      parsed.push(entry);
    });

    if (parsed.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Nenhuma entrada válida encontrada.',
        details: errors
      });
    }

    const jsonPath = path.join(__dirname, 'data/ncm-cbenef-mapping.json');
    fs.writeFileSync(jsonPath, JSON.stringify(parsed, null, 2), 'utf8');
    loadNcmMapping();

    res.json({
      success: true,
      message: `Mapeamento NCM atualizado com ${parsed.length} entrada(s).`,
      count: parsed.length,
      ...(errors.length > 0 && { warnings: errors })
    });

  } catch (err) {
    console.error(err);
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: 'Erro ao processar o arquivo: ' + err.message });
  }
});

// ────────────────────────────────────────────────
// Bulk validation of your internal products
// ────────────────────────────────────────────────
app.post('/api/bulk-validate-products', uploadLimiter, upload.single('products'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    }

    const filePath = req.file.path;
    const originalName = req.file.originalname || '';

    const products = parseUploadedFile(filePath, originalName);
    fs.unlinkSync(filePath);

    if (products.length === 0) {
      return res.status(400).json({ error: 'Nenhum produto encontrado no arquivo.' });
    }

    const results = products.map((prod, idx) => {
      const rowNum = idx + 2; // considering header

      // Normalize fields (case-insensitive + accent-insensitive key lookup)
      const get = (keys) => {
        const prodKeys = Object.keys(prod);
        for (const k of keys) {
          if (prod[k] !== undefined) return String(prod[k] != null ? prod[k] : '').trim();
          const normK = normalizeForDetection(k);
          const found = prodKeys.find(pk => normalizeForDetection(pk) === normK);
          if (found !== undefined) return String(prod[found] != null ? prod[found] : '').trim();
        }
        return '';
      };

      const codigo  = get(['Código', 'Codigo', 'codigo', 'codigo_produto', 'SKU', 'sku', 'ID', 'id']);
      const nome    = get(['Descrição', 'Descricao', 'descricao', 'nome_produto', 'Produto', 'produto', 'nome']);
      const ncm     = get(['Cód. NCM', 'Cod. NCM', 'Código NCM', 'NCM', 'ncm', 'codigo_ncm']);
      const cfop    = get(['CFOP', 'cfop']);
      let   cst     = get(['CST', 'cst', 'CSOSN', 'csosn']).replace(/\D/g, '').padStart(2, '0');
      let   cbenef  = get(['cbenef', 'c_benef', 'codigo_beneficio', 'cBenef']).toUpperCase();

      const response = {
        row: rowNum,
        codigo_produto: codigo || '(sem código)',
        nome_produto: nome || '(sem nome)',
        ncm: ncm || '-',
        cfop: cfop || '-',
        cst: cst || '-',
        cbenef: cbenef || '-',
        status: 'INFO',
        message: '',
        description: ''
      };

      // Generic catch-all codes that should not be auto-suggested when specific benefit entries exist
      const GENERIC_CBENEF_CODES = ['SEM CBENEF', 'SP099090'];

      // Pre-compute applicable entries for this CST once, reused by suggestCbenef and message formatting
      const cstEntries = cst && cst !== '-'
        ? officialTable.filter(item => item.applicableCST.includes(cst))
        : [];

      // Helper: find the best cBenef suggestion for a given CST.
      // When NCM and CFOP are available they are used to narrow down from multiple CST matches
      // via the user-supplied NCM-cBenef mapping before falling back to CST-only logic.
      // Returns the single specific entry when there is exactly one, 'SEM CBENEF' when only
      // generic options exist, or null when multiple specific options are available and a
      // product-level review is required to pick the right one.
      const suggestCbenef = (cstCode) => {
        if (!cstCode || cstCode === '-') return null;
        const entries = cstCode === cst ? cstEntries : officialTable.filter(item => item.applicableCST.includes(cstCode));
        if (entries.length === 0) return null;
        const specificEntries = entries.filter(e => !GENERIC_CBENEF_CODES.includes(e.code));
        if (specificEntries.length === 1) return specificEntries[0].code;
        if (specificEntries.length === 0) return 'SEM CBENEF';
        // Multiple specific options — first filter by operation direction (saída vs entrada)
        // derived from the CFOP, then try to refine using NCM + CFOP mapping.
        const candidates = filterEntriesByDirection(specificEntries, cfop !== '-' ? cfop : '');
        if (ncm && ncm !== '-') {
          const ncmEntry = findNcmMapping(ncm, cfop !== '-' ? cfop : '', cstCode);
          if (ncmEntry) {
            const confirmed = candidates.find(e => e.code === ncmEntry.cbenef);
            if (confirmed) return confirmed.code;
          }
        }
        // Fall back to the first direction-matched candidate
        return candidates[0].code;
      };

      if (!cbenef || cbenef === '-') {
        const sugerido = suggestCbenef(cst);
        response.status = 'AVISO';
        response.cbenef_sugerido = sugerido || '-';
        response.message = sugerido
          ? `cBenef não informado. Código recomendado para CST ${cst}: ${sugerido}`
          : `cBenef não informado. Nenhum cBenef encontrado para CST ${cst}.`;
        return response;
      }

      const matches = officialTable.filter(item =>
        item.code.toUpperCase() === cbenef &&
        (!item.uf || item.uf === 'SP') // adapt if multi-UF later
      );

      if (matches.length === 0) {
        const sugerido = suggestCbenef(cst);
        response.status = 'ERRO';
        response.cbenef_sugerido = sugerido || '-';
        response.message = sugerido
          ? `cBenef não existe na tabela oficial. Código recomendado para CST ${cst}: ${sugerido}`
          : `cBenef não existe na tabela oficial. Nenhum cBenef encontrado para CST ${cst}.`;
        return response;
      }

      const match = matches[0];
      const cstAllowed = match.applicableCST.includes(cst);

      response.description = match.description.substring(0, 120) + (match.description.length > 120 ? '...' : '');
      response.legislation = match.legislation || '-';

      if (cstAllowed) {
        response.cbenef_sugerido = '-';
        response.status = 'OK';
        response.message = 'Válido para este CST';
      } else {
        const sugerido = suggestCbenef(cst);
        response.cbenef_sugerido = sugerido || '-';
        response.status = 'ERRO';
        response.message = sugerido
          ? `CST ${cst} NÃO permitido para este cBenef. Código recomendado: ${sugerido}`
          : `CST ${cst} NÃO permitido (permitidos: ${match.applicableCST.join(', ') || 'nenhum listado'}).`;
      }

      return response;
    });

    res.json({
      success: true,
      total: results.length,
      results
    });

  } catch (err) {
    console.error(err);
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: 'Erro ao processar arquivo: ' + err.message });
  }
});

// ────────────────────────────────────────────────
// Helper: parse rows from XLSX or CSV, auto-detecting the real header row.
// ERP reports often have multiple intro rows (company name, title, group
// filter, etc.) before the actual column-header row.  We scan the first
// MAX_SCAN_ROWS rows and pick the first one that contains ≥2 known
// column-name keywords as the real header row; everything before it is
// treated as metadata and skipped.
// ────────────────────────────────────────────────

const HEADER_KEYWORDS = [
  'codigo', 'descri', 'tribut', 'ncm', 'cst', 'cfop', 'produto', 'sku', 'benef', 'cest', 'gtin'
];
const MAX_SCAN_ROWS = 25;

function normalizeForDetection(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Given an array of raw rows (each row is an array of cell values),
 * returns the index of the first row that looks like column headers.
 * Falls back to 0 if nothing is found.
 */
function findHeaderRowIndex(rawRows) {
  for (let i = 0; i < Math.min(rawRows.length, MAX_SCAN_ROWS); i++) {
    const row = rawRows[i];
    const normCells = row.map(normalizeForDetection);
    const hits = HEADER_KEYWORDS.filter(kw => normCells.some(c => c.includes(kw)));
    if (hits.length >= 2) return i;
  }
  return 0;
}

/**
 * Convert an array of raw rows into an array of objects using the
 * detected header row.  Blank/null rows after the header are dropped.
 */
function rawRowsToObjects(rawRows) {
  const headerIdx = findHeaderRowIndex(rawRows);
  const headers = rawRows[headerIdx].map(h => String(h || '').trim());
  return rawRows
    .slice(headerIdx + 1)
    .filter(row => row.some(cell => cell !== '' && cell !== null))
    .map(row => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = row[i] !== undefined ? row[i] : ''; });
      return obj;
    });
}

/**
 * Parse an uploaded file (XLSX or CSV) into an array of row objects,
 * handling multi-row ERP report headers automatically.
 */
function parseUploadedFile(filePath, originalName) {
  if ((originalName || '').toLowerCase().endsWith('.csv')) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) throw new Error('CSV vazio ou sem cabeçalho');
    const sep = lines[0].includes(';') ? ';' : ',';
    const rawRows = lines.map(line =>
      line.split(sep).map(v => v.trim().replace(/^"|"$/g, ''))
    );
    return rawRowsToObjects(rawRows);
  }

  // XLSX / XLS
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    defval: '',
    blankrows: false
  });
  return rawRowsToObjects(rawRows);
}

// ────────────────────────────────────────────────
// Helpers for parsing CST and CFOP from "Tribut." column
// ────────────────────────────────────────────────

const VALID_CSTS = ['00', '10', '20', '30', '40', '41', '50', '51', '60', '70', '90'];

function parseCSTFromTribut(tributStr) {
  if (tributStr === '' || tributStr === null || tributStr === undefined) return '';
  const s = String(tributStr).trim();
  if (!s) return '';

  // Direct exact match (e.g. "40", "41", "0" → "00")
  const direct = s.padStart(2, '0');
  if (VALID_CSTS.includes(direct)) return direct;

  // 3-digit CST code (origin digit + 2-digit situation, e.g. "360" → "60", "300" → "00")
  // Handles full 3-digit codes: the first digit is the merchandise origin (0–8) and the
  // last two digits are the situation code.  Origin-0 codes (e.g. "060") already reach
  // this function as "60" because Excel drops the leading zero when storing as a number.
  if (/^\d{3}$/.test(s)) {
    const situation = s.slice(1);
    if (VALID_CSTS.includes(situation)) return situation;
  }

  // Single-digit shorthand: treat as the tens digit of a 2-digit situation code
  // (e.g. "3" → "30", "7" → "70", "0" → "00")
  if (/^\d$/.test(s)) {
    const candidate = s + '0';
    if (VALID_CSTS.includes(candidate)) return candidate;
  }

  // 2-digit number embedded in the string (e.g. "CST: 40", "5102/40")
  const numMatches = s.match(/\b(\d{1,2})\b/g) || [];
  for (const m of numMatches) {
    const padded = m.padStart(2, '0');
    if (VALID_CSTS.includes(padded)) return padded;
  }

  // Text-based fallbacks (normalized, no accents)
  const norm = s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (/nao.tributad|nao.incid|nao_tributad/.test(norm)) return '41';
  if (/tributad/.test(norm)) return '00';
  if (/isen/.test(norm)) return '40';
  if (/reduc/.test(norm)) return '20';
  if (/suspens/.test(norm)) return '50';
  if (/diferim/.test(norm)) return '60';
  if (/outr/.test(norm)) return '90';

  return '';
}

function parseCFOPFromTribut(tributStr) {
  if (!tributStr) return '';
  // CFOP: 4-digit code starting with 1-3, 5, 6, or 7
  const m = String(tributStr).match(/\b([1-35-7][0-9]{3})\b/);
  return m ? m[1] : '';
}

// ────────────────────────────────────────────────
// Assign cBenef to products based on CST/CFOP
// ────────────────────────────────────────────────
app.post('/api/assign-cbenef', uploadLimiter, upload.single('products'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    }

    const filePath = req.file.path;
    const originalName = req.file.originalname || '';

    const rows = parseUploadedFile(filePath, originalName);
    fs.unlinkSync(filePath);

    if (rows.length === 0) {
      return res.status(400).json({ error: 'Nenhum produto encontrado no arquivo.' });
    }

    // Case-insensitive field lookup with accent normalisation
    const normalizeKey = k => String(k || '').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, '');

    const getField = (obj, candidates) => {
      const objKeys = Object.keys(obj);
      for (const candidate of candidates) {
        // Exact key
        if (obj[candidate] !== undefined) return String(obj[candidate] != null ? obj[candidate] : '').trim();
        // Case-insensitive / accent-insensitive key
        const normCand = normalizeKey(candidate);
        const found = objKeys.find(k => normalizeKey(k) === normCand);
        if (found !== undefined) return String(obj[found] != null ? obj[found] : '').trim();
      }
      return '';
    };

    const results = rows.map((row, idx) => {
      const rowNum = idx + 2;

      const codigo   = getField(row, ['Código', 'Codigo', 'codigo', 'SKU', 'ID', 'codigo_produto']);
      const descricao = getField(row, ['Descrição', 'Descricao', 'descricao', 'Produto', 'nome_produto', 'Descricao do Produto']);
      const tribut   = getField(row, ['Tribut.', 'Tribut', 'Tributação', 'Tributacao', 'tributacao', 'CST', 'cst', 'tributacao_icms']);
      const ncm      = getField(row, ['Cód. NCM', 'Cod. NCM', 'Código NCM', 'Codigo NCM', 'NCM', 'ncm', 'codigo_ncm']);
      const cest     = getField(row, ['CEST', 'cest']);
      const gtin     = getField(row, ['GTIN', 'gtin', 'EAN', 'ean', 'codigo_barras']);

      // Allow explicit separate CFOP / CST columns; fall back to parsing Tribut.
      const cfopExplicit = getField(row, ['CFOP', 'cfop']);
      const cstExplicitRaw = getField(row, ['CST', 'cst', 'CSOSN', 'csosn']).replace(/\D/g, '');
      const cstExplicit = cstExplicitRaw ? cstExplicitRaw.padStart(2, '0') : '';

      const cfop = cfopExplicit || parseCFOPFromTribut(tribut);
      const cst  = (cstExplicit && VALID_CSTS.includes(cstExplicit))
        ? cstExplicit
        : parseCSTFromTribut(tribut);

      // Find applicable cBenef entries by CST
      const applicableEntries = cst
        ? officialTable.filter(item => item.applicableCST.includes(cst))
        : [];

      // Generic catch-all codes that should not be auto-suggested when specific benefit entries exist
      const GENERIC_CODES = ['SEM CBENEF', 'SP099090'];

      // Partition applicable entries into specific benefits and generic catch-all codes in a single pass
      const specificEntries = [];
      const genericEntries = [];
      for (const e of applicableEntries) {
        (GENERIC_CODES.includes(e.code) ? genericEntries : specificEntries).push(e);
      }

      let cbenefSugerido = '-';
      let status = 'INFO';
      let message = '';

      if (!cst) {
        status = 'AVISO';
        message = 'CST não identificado';
      } else if (applicableEntries.length === 0) {
        status = 'INFO';
        message = `CST ${cst} não requer cBenef`;
        cbenefSugerido = 'Não aplicável';
      } else if (applicableEntries.length === 1) {
        // Only one option — suggest it directly
        cbenefSugerido = applicableEntries[0].code;
        status = 'OK';
        message = `cBenef identificado para CST ${cst}: ${cbenefSugerido}`;
      } else if (specificEntries.length === 0) {
        // Only generic options available (e.g. SEM CBENEF / SP099090)
        cbenefSugerido = 'SEM CBENEF';
        status = 'OK';
        message = `cBenef identificado para CST ${cst}: SEM CBENEF`;
      } else if (specificEntries.length === 1) {
        // Exactly one specific benefit matches this CST — suggest it
        cbenefSugerido = specificEntries[0].code;
        status = 'OK';
        message = `cBenef identificado para CST ${cst}: ${cbenefSugerido}`;
      } else {
        // Multiple specific options — first filter by operation direction (saída vs entrada)
        // derived from the CFOP, then try to narrow down using NCM + CFOP mapping.
        const candidates = filterEntriesByDirection(specificEntries, cfop);

        const ncmEntry = ncm ? findNcmMapping(ncm, cfop || '', cst) : null;
        const confirmedEntry = ncmEntry
          ? candidates.find(e => e.code === ncmEntry.cbenef)
          : null;

        // Use NCM-confirmed entry when available, otherwise fall back to the best direction-matched candidate
        cbenefSugerido = confirmedEntry ? confirmedEntry.code : candidates[0].code;
        status = confirmedEntry ? 'OK' : 'AVISO';
        message = confirmedEntry
          ? `cBenef identificado por NCM ${ncm} / CST ${cst}: ${cbenefSugerido}`
          : `cBenef recomendado para CST ${cst}: ${cbenefSugerido} — confirme se é o correto para este produto`;
      }

      return {
        row: rowNum,
        codigo: codigo || '(sem código)',
        descricao: descricao || '(sem descrição)',
        ncm: ncm || '-',
        cest: cest || '-',
        gtin: gtin || '-',
        cfop: cfop || '-',
        cst: cst || '-',
        cbenef_sugerido: cbenefSugerido,
        status,
        message
      };
    });

    res.json({ success: true, total: results.length, results });

  } catch (err) {
    console.error(err);
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: 'Erro ao processar arquivo: ' + err.message });
  }
});

// POST /api/export-assign-cbenef - Export assign-cBenef results to Excel
app.post('/api/export-assign-cbenef', (req, res) => {
  const { results } = req.body;

  if (!Array.isArray(results) || results.length === 0) {
    return res.status(400).json({ error: 'Nenhum resultado para exportar.' });
  }

  const worksheetData = results.map(r => ({
    'Linha': r.row,
    'Código': r.codigo,
    'Descrição': r.descricao,
    'NCM': r.ncm,
    'CEST': r.cest,
    'GTIN': r.gtin,
    'CFOP': r.cfop,
    'CST': r.cst,
    'cBenef Recomendado': r.cbenef_sugerido,
    'Status': r.status,
    'Mensagem': r.message
  }));

  const worksheet = XLSX.utils.json_to_sheet(worksheetData);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'cBenef');

  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Disposition', 'attachment; filename="atribuir-cbenef.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
});

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});