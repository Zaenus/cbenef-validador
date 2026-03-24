# cBenef Validador

Ferramenta web para validação e sugestão de códigos **cBenef** (Código de Benefício Fiscal) do ICMS, desenvolvida para auxiliar empresas no cumprimento das obrigações fiscais acessórias relacionadas ao Estado de São Paulo (SP).

---

## Funcionalidades

- **Validação de código único** — verifica se um cBenef é válido para um determinado CST
- **Atualização da tabela oficial** — importa a tabela oficial de cBenef a partir de um arquivo `.xlsx` da SEFAZ
- **Validação em massa de produtos** — valida uma lista de produtos (`.xlsx` ou `.csv`) contra os cBenef cadastrados
- **Sugestão automática de cBenef** — sugere códigos aplicáveis com base no CST, NCM e CFOP de cada produto
- **Mapeamento NCM → cBenef** — permite configurar mapeamentos NCM/CFOP/CST para refinar sugestões quando há múltiplos cBenef possíveis para um mesmo CST

---

## Tecnologias

- **Node.js** + **Express** (back-end)
- **Multer** (upload de arquivos)
- **XLSX** (leitura de planilhas)
- **HTML/CSS/JavaScript** (interface web)

---

## Pré-requisitos

- [Node.js](https://nodejs.org/) v18 ou superior
- npm

---

## Instalação

```bash
# Clone o repositório
git clone https://github.com/Zaenus/cbenef-validador.git
cd cbenef-validador

# Instale as dependências
npm install
```

---

## Uso

```bash
node server.js
```

Acesse a interface em **http://localhost:3000**.

---

## Interface Web

A interface é dividida em quatro abas:

| Aba | Descrição |
|-----|-----------|
| **1 – Validar Código** | Valida um cBenef informado manualmente (UF + código + CST) |
| **2 – Atualizar Tabela** | Importa a tabela oficial via upload de arquivo `.xlsx` |
| **3 – Validar Produtos** | Valida uma lista de produtos em massa (`.xlsx` ou `.csv`) |
| **4 – Sugerir cBenef** | Sugere códigos cBenef para uma lista de produtos usando CST, NCM e CFOP |
| **5 – Mapeamento NCM** | Configura o mapeamento NCM → cBenef para refinar sugestões automáticas |

---

## API

Todos os endpoints utilizam o método `POST`.

### `POST /api/validate`

Valida um código cBenef individual.

**Corpo (JSON):**
```json
{
  "uf": "SP",
  "cbenef": "SP011540",
  "cst": "00"
}
```

**Resposta:**
```json
{
  "valid": true,
  "code": "SP011540",
  "description": "...",
  "applicableCST": ["00", "10", "20"],
  "legislation": "Portaria SRE XX/XXXX",
  "message": "✅ Válido!"
}
```

---

### `POST /api/upload-table`

Atualiza a tabela oficial de cBenef a partir de um arquivo `.xlsx`.

**Corpo (multipart/form-data):**
- `table` — arquivo `.xlsx` com as colunas: `codigo`/`cbenef`, `descricao`, `observacao` e colunas de CST

**Resposta:**
```json
{
  "success": true,
  "message": "Tabela SP atualizada com 310 códigos válidos.",
  "count": 310
}
```

---

### `POST /api/bulk-validate-products`

Valida em massa uma lista de produtos contra a tabela oficial.

**Corpo (multipart/form-data):**
- `products` — arquivo `.xlsx` ou `.csv` com as colunas:
  `codigo_produto`, `nome_produto`, `ncm`, `cfop`, `cst`, `cbenef`

**Resposta:** array de objetos com o resultado de cada linha (`OK`, `ERRO` ou `AVISO`).

---

### `POST /api/assign-cbenef`

Sugere códigos cBenef para cada produto com base no CST, NCM e CFOP.

**Corpo (multipart/form-data):**
- `products` — arquivo `.xlsx` ou `.csv` com as colunas:
  `Código`, `Descrição`, `Tribut.`, `Cód. NCM`

**Resposta:**
```json
[
  {
    "row": 2,
    "codigo": "PROD001",
    "cst": "40",
    "cbenef_sugerido": "SP099090",
    "opcoes": ["SP099090"],
    "status": "OK",
    "message": "1 opção para CST 40"
  }
]
```

---

### `POST /api/upload-ncm-mapping`

Atualiza o mapeamento NCM → cBenef usado para refinar sugestões quando há múltiplos códigos possíveis para um dado CST.

**Corpo (multipart/form-data):**
- `mapping` — arquivo `.xlsx` ou `.csv` com as colunas:
  - `ncm` *(obrigatório)* — código NCM de 2 a 8 dígitos (prefixos são aceitos)
  - `cbenef` *(obrigatório)* — código cBenef correspondente
  - `cst` *(opcional)* — restringe a um CST específico
  - `cfop` *(opcional)* — restringe a um CFOP específico
  - `description` *(opcional)* — observação livre

**Resposta:**
```json
{
  "success": true,
  "message": "Mapeamento NCM atualizado com 5 entrada(s).",
  "count": 5
}
```

---

## Estrutura do Projeto

```
cbenef-validador/
├── data/
│   ├── official-cbenef.json       # Tabela oficial de cBenef (SP)
│   └── ncm-cbenef-mapping.json    # Mapeamento NCM → cBenef (configurável)
├── public/
│   ├── index.html                 # Interface web
│   └── script.js                  # Lógica do cliente
├── server.js                      # Servidor Express e endpoints da API
├── package.json
└── README.md
```

---

## Licença

ISC
