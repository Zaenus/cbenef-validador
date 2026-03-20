// public/script.js

// === 1. Single cBenef Validation ===
const validationForm = document.getElementById('form');
if (validationForm) {
  validationForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const uf = document.getElementById('uf').value;
    const cbenef = document.getElementById('cbenef').value.trim().toUpperCase();
    const cst = document.getElementById('cst').value.trim();

    try {
      const res = await fetch('/api/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uf, cbenef, cst })
      });

      if (!res.ok) throw new Error('Erro na resposta do servidor');

      const data = await res.json();

      const resultDiv = document.getElementById('result');
      resultDiv.style.borderColor = data.valid ? '#28a745' : '#dc3545';
      resultDiv.style.backgroundColor = data.valid ? '#e8f5e9' : '#ffebee';

      resultDiv.innerHTML = `
        <strong style="font-size:1.1em;">${data.message}</strong><br><br>
        ${data.valid ? `
          <p><b>Descrição:</b> ${data.description || '-'}</p>
          <p><b>CSTs permitidos:</b> ${data.applicableCST?.join(', ') || '-'}</p>
          <p><b>Legislação:</b> ${data.legislation || '-'}</p>
        ` : ''}
      `;
    } catch (err) {
      console.error('Erro na validação:', err);
      document.getElementById('result').innerHTML = 
        '<strong style="color:#dc3545">Erro de conexão. Tente novamente.</strong>';
    }
  });
}

// === 2. Upload Official Table ===
const uploadForm = document.getElementById('uploadForm');
if (uploadForm) {
  uploadForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const fileInput = document.getElementById('tableFile');
    if (!fileInput.files?.[0]) return;

    const formData = new FormData();
    formData.append('table', fileInput.files[0]);

    const resultDiv = document.getElementById('uploadResult');
    resultDiv.innerHTML = '<p style="color:#666;">Processando tabela oficial...</p>';

    try {
      const res = await fetch('/api/upload-table', {
        method: 'POST',
        body: formData
      });

      const data = await res.json();

      if (data.success) {
        resultDiv.style.borderColor = '#28a745';
        resultDiv.style.backgroundColor = '#e8f5e9';
        resultDiv.innerHTML = `
          <strong style="color:#28a745">✅ Sucesso!</strong><br>
          ${data.message}<br>
          <small>Agora a validação usa a versão mais recente da tabela.</small>
        `;
      } else {
        resultDiv.style.borderColor = '#dc3545';
        resultDiv.style.backgroundColor = '#ffebee';
        resultDiv.innerHTML = `<strong style="color:#dc3545">Erro:</strong> ${data.error || data.message || 'Falha desconhecida'}`;
      }
    } catch (err) {
      console.error('Erro no upload da tabela:', err);
      resultDiv.innerHTML = `<strong style="color:#dc3545">Erro de conexão: ${err.message}</strong>`;
    }
  });
}

// === 3. Bulk Validation of Company Products ===
const bulkForm = document.getElementById('bulkProductsForm');
if (bulkForm) {
  bulkForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const fileInput = document.getElementById('productsFile');
    if (!fileInput.files?.[0]) return;

    const formData = new FormData();
    formData.append('products', fileInput.files[0]);

    const resultDiv = document.getElementById('bulkProductsResult');
    resultDiv.innerHTML = '<p style="color:#666; text-align:center;">Processando produtos... Aguarde.</p>';

    try {
      const res = await fetch('/api/bulk-validate-products', {
        method: 'POST',
        body: formData
      });

      if (!res.ok) throw new Error(`Erro HTTP ${res.status}`);

      const data = await res.json();

      if (!data.success) {
        resultDiv.innerHTML = `<div style="color:#dc3545; padding:12px; background:#ffebee; border-radius:6px;">
          Erro: ${data.error || 'Falha ao processar o arquivo'}
        </div>`;
        return;
      }

      let html = `
        <p style="font-weight:bold; margin-bottom:12px;">
          Processados ${data.total} produtos
        </p>
        <table style="width:100%; border-collapse:collapse; font-size:0.95em;">
          <thead>
            <tr style="background:#f8f9fa; text-align:left;">
              <th style="padding:8px; border:1px solid #dee2e6;">Linha</th>
              <th style="padding:8px; border:1px solid #dee2e6;">Código</th>
              <th style="padding:8px; border:1px solid #dee2e6;">Produto</th>
              <th style="padding:8px; border:1px solid #dee2e6;">NCM</th>
              <th style="padding:8px; border:1px solid #dee2e6;">CFOP</th>
              <th style="padding:8px; border:1px solid #dee2e6;">CST</th>
              <th style="padding:8px; border:1px solid #dee2e6;">cBenef</th>
              <th style="padding:8px; border:1px solid #dee2e6;">Status</th>
              <th style="padding:8px; border:1px solid #dee2e6;">Mensagem</th>
            </tr>
          </thead>
          <tbody>
      `;

      data.results.forEach(r => {
        let statusColor = '#6c757d';   // default info
        if (r.status === 'OK')    statusColor = '#28a745';
        if (r.status === 'ERRO')  statusColor = '#dc3545';
        if (r.status === 'AVISO') statusColor = '#fd7e14';

        html += `
          <tr>
            <td style="padding:8px; border:1px solid #dee2e6;">${r.row}</td>
            <td style="padding:8px; border:1px solid #dee2e6;">${r.codigo_produto}</td>
            <td style="padding:8px; border:1px solid #dee2e6;">${r.nome_produto}</td>
            <td style="padding:8px; border:1px solid #dee2e6;">${r.ncm}</td>
            <td style="padding:8px; border:1px solid #dee2e6;">${r.cfop}</td>
            <td style="padding:8px; border:1px solid #dee2e6;">${r.cst}</td>
            <td style="padding:8px; border:1px solid #dee2e6;">${r.cbenef}</td>
            <td style="padding:8px; border:1px solid #dee2e6; color:${statusColor}; font-weight:bold;">${r.status}</td>
            <td style="padding:8px; border:1px solid #dee2e6;">${r.message}</td>
          </tr>
        `;
      });

      html += '</tbody></table>';
      resultDiv.innerHTML = html;

    } catch (err) {
      console.error('Erro na validação em massa:', err);
      resultDiv.innerHTML = `<div style="color:#dc3545; padding:12px; background:#ffebee; border-radius:6px;">
        Erro de conexão ou processamento: ${err.message}
      </div>`;
    }
  });
}