const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

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
app.post('/api/upload-table', upload.single('table'), (req, res) => {
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
// Bulk validation of your internal products
// ────────────────────────────────────────────────
app.post('/api/bulk-validate-products', upload.single('products'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    }

    const filePath = req.file.path;
    let products = [];

    // Support both .xlsx and .csv
    if (filePath.toLowerCase().endsWith('.csv')) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split(/\r?\n/);
      if (lines.length < 2) throw new Error('CSV vazio ou sem cabeçalho');

      const headers = lines[0].split(/[,;]/).map(h => h.trim().toLowerCase().replace(/"/g, ''));
      const separator = lines[0].includes(';') ? ';' : ',';

      products = lines.slice(1)
        .filter(line => line.trim())
        .map(line => {
          const values = line.split(separator).map(v => v.trim().replace(/^"|"$/g, ''));
          const obj = {};
          headers.forEach((h, i) => { obj[h] = values[i] || ''; });
          return obj;
        });
    } else {
      // XLSX
      const workbook = XLSX.readFile(filePath);
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      products = XLSX.utils.sheet_to_json(worksheet, { defval: '' });
    }

    fs.unlinkSync(filePath);

    if (products.length === 0) {
      return res.status(400).json({ error: 'Nenhum produto encontrado no arquivo.' });
    }

    const results = products.map((prod, idx) => {
      const rowNum = idx + 2; // considering header

      // Normalize fields (case insensitive keys)
      const get = (keys) => {
        for (const k of keys) {
          if (prod[k] !== undefined) return String(prod[k] || '').trim();
          const lower = Object.keys(prod).find(kl => kl.toLowerCase() === k.toLowerCase());
          if (lower) return String(prod[lower] || '').trim();
        }
        return '';
      };

      const codigo   = get(['codigo_produto', 'sku', 'codigo', 'id']);
      const nome     = get(['nome_produto', 'descricao', 'produto', 'nome']);
      const ncm      = get(['ncm']);
      const cfop     = get(['cfop']);
      let   cst      = get(['cst', 'csosn']).replace(/\D/g, '').padStart(2, '0');
      let   cbenef   = get(['cbenef', 'c_benef', 'codigo_beneficio']).toUpperCase();

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

      if (!cbenef || cbenef === '-') {
        response.status = 'AVISO';
        response.message = 'cBenef não informado. Verifique se o CST exige preenchimento.';
        return response;
      }

      const matches = officialTable.filter(item =>
        item.code.toUpperCase() === cbenef &&
        (!item.uf || item.uf === 'SP') // adapt if multi-UF later
      );

      if (matches.length === 0) {
        response.status = 'ERRO';
        response.message = 'cBenef não existe na tabela oficial.';
        return response;
      }

      const match = matches[0];
      const cstAllowed = match.applicableCST.includes(cst);

      response.description = match.description.substring(0, 120) + (match.description.length > 120 ? '...' : '');
      response.legislation = match.legislation || '-';

      if (cstAllowed) {
        response.status = 'OK';
        response.message = 'Válido para este CST';
      } else {
        response.status = 'ERRO';
        response.message = `CST ${cst} NÃO permitido (permitidos: ${match.applicableCST.join(', ') || 'nenhum listado'})`;
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

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});