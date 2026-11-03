import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DefaultFinancialImportParser, OfxFinancialImportParser } from "./financial-imports.parser.js";
import { inspectCsv, parseCsvConfiguration, parseCsvInspectionOverrides } from "./financial-imports.csv.js";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));

async function fixture(name: string): Promise<Buffer> {
  return readFile(`${fixtures}${name}`);
}

test("parses common OFX 1.x bank statements without losing monetary precision", async () => {
  const result = await new OfxFinancialImportParser().parse({
    format: "ofx",
    fileName: "valid-bank.ofx",
    content: await fixture("valid-bank.ofx"),
  });

  assert.deepEqual(result.items.map((item) => ({
    date: item.date,
    amount: item.signedAmount,
    type: item.type,
    externalId: item.externalId,
  })), [
    { date: "2026-10-20", amount: "1500.50", type: "income", externalId: "income-1" },
    { date: "2026-10-21", amount: "-125.50", type: "expense", externalId: "expense-1" },
    { date: "2026-10-22", amount: "-300.00", type: "transfer", externalId: "transfer-1" },
  ]);
  assert.equal(result.items[1]?.description, "Mercado & Companhia");
  assert.match(result.items[0]?.recordHash ?? "", /^[0-9a-f]{64}$/);
  assert.deepEqual(result.sourceMetadata, {
    currency: "BRL",
    bankId: "001",
    accountType: "CHECKING",
    accountReferenceHash: result.sourceMetadata?.accountReferenceHash,
    ofxVersion: "102",
  });
  assert.match(result.sourceMetadata?.accountReferenceHash ?? "", /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(result.sourceMetadata).includes("00012345-6"), false);
});

test("parses OFX 2.x XML statements", async () => {
  const result = await new OfxFinancialImportParser().parse({
    format: "ofx",
    fileName: "valid-xml.ofx",
    content: await fixture("valid-xml.ofx"),
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.date, "2026-02-28");
  assert.equal(result.items[0]?.signedAmount, "-10.01");
  assert.equal(
    result.items[0]?.description,
    "Padaria & Filial </STMTTRN> Centro <STMTTRN> <STMTRS> </STMTRS> <CCACCTFROM> <CCSTMTTRNRS> &amp;",
  );
  assert.equal(result.sourceMetadata?.currency, "BRL");
  assert.equal(result.sourceMetadata?.bankId, "341");
});

test("ignores structural OFX tags inside XML comments", async () => {
  const document = `<?xml version="1.0" encoding="UTF-8"?>
<OFX><!-- <STMTRS><CCACCTFROM><STMTTRN></STMTTRN> -->
<BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL</CURDEF>
<BANKACCTFROM><ACCTID>123</ACCTID></BANKACCTFROM><BANKTRANLIST>
<STMTTRN><DTPOSTED>20261020</DTPOSTED><TRNAMT>-10.00</TRNAMT><FITID>1</FITID>
<NAME>Compra<!-- <MEMO>falso</MEMO> --> segura</NAME></STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

  const result = await new OfxFinancialImportParser().parse({
    format: "ofx",
    fileName: "comments.ofx",
    content: Buffer.from(document),
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.signedAmount, "-10.00");
  assert.equal(result.items[0]?.description, "Compra segura");
});

test("scans large sequences of comments and CDATA blocks without quadratic degradation", { timeout: 5_000 }, async () => {
  const document = (noise: string) => `<?xml version="1.0" encoding="UTF-8"?>
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>${noise}<CURDEF>BRL</CURDEF>
<BANKACCTFROM><ACCTID>123</ACCTID></BANKACCTFROM><BANKTRANLIST>
<STMTTRN><DTPOSTED>20261020</DTPOSTED><TRNAMT>-10.00</TRNAMT><FITID>1</FITID>
<NAME>Compra segura</NAME></STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
  const parser = new OfxFinancialImportParser();
  const comments = "<!-- ignored -->".repeat(10_000);
  const cdataBlocks = "<NOTE><![CDATA[ignored]]></NOTE>".repeat(10_000);

  const commentResult = await parser.parse({
    format: "ofx",
    fileName: "many-comments.ofx",
    content: Buffer.from(document(comments)),
  });
  const cdataResult = await parser.parse({
    format: "ofx",
    fileName: "many-cdata.ofx",
    content: Buffer.from(document(cdataBlocks)),
  });

  assert.deepEqual(
    [commentResult.items[0]?.signedAmount, cdataResult.items[0]?.signedAmount],
    ["-10.00", "-10.00"],
  );
  assert.deepEqual(
    [commentResult.items[0]?.description, cdataResult.items[0]?.description],
    ["Compra segura", "Compra segura"],
  );
});

test("preserves multiline NAME and MEMO values in OFX descriptions", async () => {
  const document = `<?xml version="1.0" encoding="UTF-8"?>
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL</CURDEF>
<BANKACCTFROM><ACCTID>123</ACCTID></BANKACCTFROM><BANKTRANLIST>
<STMTTRN><DTPOSTED>20261020</DTPOSTED><TRNAMT>-10.00</TRNAMT><FITID>1</FITID>
<NAME>Pagamento
mensal</NAME><MEMO>Parcela 1
de 2</MEMO></STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

  const result = await new OfxFinancialImportParser().parse({
    format: "ofx",
    fileName: "multiline.ofx",
    content: Buffer.from(document),
  });
  const singleLineResult = await new OfxFinancialImportParser().parse({
    format: "ofx",
    fileName: "single-line.ofx",
    content: Buffer.from(document
      .replace("Pagamento\nmensal", "Pagamento mensal")
      .replace("Parcela 1\nde 2", "Parcela 1 de 2")),
  });

  assert.equal(result.items[0]?.description, "Pagamento mensal — Parcela 1 de 2");
  assert.equal(result.items[0]?.recordHash, singleLineResult.items[0]?.recordHash);
});

test("rejects multiple bank statements before mixing accounts, currencies or FITIDs", async () => {
  const statement = (currency: string, accountId: string) => `<STMTTRNRS><STMTRS>
<CURDEF>${currency}</CURDEF><BANKACCTFROM><ACCTID>${accountId}</ACCTID></BANKACCTFROM>
<BANKTRANLIST><STMTTRN><DTPOSTED>20261020</DTPOSTED><TRNAMT>-10.00</TRNAMT>
<FITID>same-fitid</FITID><NAME>Compra</NAME></STMTTRN></BANKTRANLIST>
</STMTRS></STMTTRNRS>`;
  const document = `<OFX><BANKMSGSRSV1>${statement("BRL", "account-1")}${statement("USD", "account-2")}</BANKMSGSRSV1></OFX>`;

  await assert.rejects(
    new OfxFinancialImportParser().parse({
      format: "ofx",
      fileName: "multiple-accounts.ofx",
      content: Buffer.from(document),
    }),
    /apenas um extrato bancário/i,
  );
});

test("keeps valid records visible and explains malformed OFX records", async () => {
  const result = await new OfxFinancialImportParser().parse({
    format: "ofx",
    fileName: "partial-invalid.ofx",
    content: await fixture("partial-invalid.ofx"),
  });

  assert.equal(result.items.length, 5);
  assert.equal(result.items[0]?.validationStatus, undefined);
  assert.equal(result.items[1]?.validationStatus, "invalid");
  assert.equal(result.items[1]?.isRepairable, true);
  assert.match(result.items[1]?.errorMessage ?? "", /data/i);
  assert.equal(result.items[2]?.isRepairable, false);
  assert.match(result.items[2]?.errorMessage ?? "", /valor/i);
  assert.equal(result.items[3]?.isRepairable, false);
  assert.match(result.items[3]?.errorMessage ?? "", /FITID/i);
  assert.equal(result.items[4]?.validationStatus, "duplicate");
  assert.equal(result.items[4]?.isRepairable, false);
});

test("decodes the Windows-1252 encoding commonly declared by OFX 1.x", async () => {
  const source = [
    "OFXHEADER:100", "VERSION:102", "ENCODING:USASCII", "CHARSET:1252", "", "<OFX>",
    "<BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL",
    "<BANKACCTFROM><ACCTID>123</BANKACCTFROM><BANKTRANLIST>",
    "<STMTTRN><DTPOSTED>20261020<TRNAMT>-1.00<FITID>1<NAME>Café</STMTTRN>",
    "</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>",
  ].join("\r\n");
  const content = Buffer.from(source.replace("é", "\u00e9"), "latin1");
  const result = await new OfxFinancialImportParser().parse({ format: "ofx", fileName: "cp1252.ofx", content });

  assert.equal(result.items[0]?.description, "Café");
});

test("decodes ISO-8859-1 declarations and UTF-16 XML exports", async () => {
  const xml = (encoding: string) => [
    `<?xml version="1.0" encoding="${encoding}"?>`,
    "<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL",
    "<BANKACCTFROM><ACCTID>123</ACCTID></BANKACCTFROM><BANKTRANLIST>",
    "<STMTTRN><DTPOSTED>20261020</DTPOSTED><TRNAMT>-1.00</TRNAMT><FITID>1</FITID><NAME>Café</NAME></STMTTRN>",
    "</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>",
  ].join("\n");
  const iso = Buffer.from(xml("ISO-8859-1").replace("é", "\u00e9"), "latin1");
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml("UTF-16"), "utf16le")]);

  const isoResult = await new OfxFinancialImportParser().parse({ format: "ofx", fileName: "iso.ofx", content: iso });
  const utf16Result = await new OfxFinancialImportParser().parse({ format: "ofx", fileName: "utf16.ofx", content: utf16 });

  assert.equal(isoResult.items[0]?.description, "Café");
  assert.equal(utf16Result.items[0]?.description, "Café");
});

test("rejects unsupported account documents, currencies, encodings and CSV dispatch", async () => {
  const parser = new OfxFinancialImportParser();
  const base = (body: string, header = "ENCODING:UTF-8\nCHARSET:UTF-8\n") => Buffer.from(
    `${header}<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>${body}</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`,
  );

  await assert.rejects(
    parser.parse({ format: "ofx", fileName: "usd.ofx", content: base("<CURDEF>USD<BANKACCTFROM><ACCTID>1</BANKACCTFROM><BANKTRANLIST></BANKTRANLIST>") }),
    /reais \(BRL\)/i,
  );
  await assert.rejects(
    parser.parse({ format: "ofx", fileName: "account.ofx", content: base("<CURDEF>BRL<BANKTRANLIST></BANKTRANLIST>") }),
    /conta de origem/i,
  );
  await assert.rejects(
    parser.parse({ format: "ofx", fileName: "card.ofx", content: base("<CURDEF>BRL<CCSTMTTRNRS><CCACCTFROM><ACCTID>1</CCACCTFROM><BANKTRANLIST></BANKTRANLIST></CCSTMTTRNRS>") }),
    /faturas de cartão/i,
  );
  await assert.rejects(
    parser.parse({ format: "ofx", fileName: "encoding.ofx", content: base("", "ENCODING:EBCDIC\n") }),
    /codificação/i,
  );
  await assert.rejects(
    parser.parse({
      format: "ofx",
      fileName: "charset.ofx",
      content: base("", "ENCODING:USASCII\nCHARSET:KOI8-R\n"),
    }),
    /codificação/i,
  );
  await assert.rejects(
    parser.parse({
      format: "ofx",
      fileName: "unclosed-cdata.ofx",
      content: base("<CURDEF>BRL<BANKACCTFROM><ACCTID>1</BANKACCTFROM><BANKTRANLIST><![CDATA[sem fim"),
    }),
    /conteúdo XML.*inválido/i,
  );
  await assert.rejects(
    parser.parse({
      format: "ofx",
      fileName: "unclosed-comment.ofx",
      content: base("<CURDEF>BRL<BANKACCTFROM><ACCTID>1</BANKACCTFROM><BANKTRANLIST><!-- sem fim"),
    }),
    /conteúdo XML.*inválido/i,
  );
  await assert.rejects(
    new DefaultFinancialImportParser().parse({ format: "csv", fileName: "statement.csv", content: Buffer.from("date,amount") }),
    /mapeamento/i,
  );
});

test("inspects CSV and suggests common columns", () => {
  const result = inspectCsv(Buffer.from("Data;Descrição;Valor;ID\n31/10/2026;Mercado;-1.234,56;abc\n", "utf8"));
  assert.deepEqual(result.detectedConfiguration, {
    delimiter: ";", encoding: "utf-8", hasHeader: true, dateFormat: "dd/MM/yyyy", numberFormat: "pt-BR",
  });
  assert.deepEqual(result.suggestedMapping, { date: 0, description: 1, amount: 2, credit: null, debit: null, externalId: 3 });
  assert.equal(result.sample[0]?.lineNumber, 2);
});

test("detects legacy Western CSV and accepts explicit ISO-8859-1 decoding", async () => {
  const content = Buffer.from("Data;Descrição;Valor\n31/10/2026;Refeição;-10,20\n", "latin1");
  assert.equal(inspectCsv(content).detectedConfiguration.encoding, "windows-1252");
  const result = await new DefaultFinancialImportParser().parse({
    format: "csv", fileName: "legacy.csv", content,
    csvConfiguration: { delimiter: ";", encoding: "iso-8859-1", hasHeader: true, dateFormat: "dd/MM/yyyy", numberFormat: "pt-BR", columns: { date: 0, description: 1, amount: 2, credit: null, debit: null, externalId: null } },
  });
  assert.equal(result.items[0]?.description, "Refeição");
});

test("parses CSV money without floating point and reports every invalid line", async () => {
  const result = await new DefaultFinancialImportParser().parse({
    format: "csv",
    fileName: "statement.csv",
    content: Buffer.from("date,description,amount\n10/31/2026,Salary,1000.10\n10/32/2026,Bad date,-2.25\n", "utf8"),
    csvConfiguration: {
      delimiter: ",", encoding: "utf-8", hasHeader: true, dateFormat: "MM/dd/yyyy", numberFormat: "en-US",
      columns: { date: 0, description: 1, amount: 2, credit: null, debit: null, externalId: null },
    },
  });
  assert.deepEqual(result.items.map((item) => ({ date: item.date, amount: item.signedAmount, type: item.type, status: item.validationStatus })), [
    { date: "2026-10-31", amount: "1000.10", type: "income", status: undefined },
    { date: null, amount: "-2.25", type: "expense", status: "invalid" },
  ]);
  assert.match(result.items[1]?.errorMessage ?? "", /Linha 3: data inválida/);
});

test("parses separate credit/debit columns and quoted delimiters", async () => {
  const result = await new DefaultFinancialImportParser().parse({
    format: "csv", fileName: "statement.csv",
    content: Buffer.from('date;description;credit;debit\n2026-10-01;"Refund; card";10,50;\n2026-10-02;Purchase;;2,05\n'),
    csvConfiguration: { delimiter: ";", encoding: "utf-8", hasHeader: true, dateFormat: "yyyy-MM-dd", numberFormat: "pt-BR", columns: { date: 0, description: 1, amount: null, credit: 2, debit: 3, externalId: null } },
  });
  assert.deepEqual(result.items.map((item) => [item.description, item.signedAmount, item.type]), [
    ["Refund; card", "10.50", "income"], ["Purchase", "-2.05", "expense"],
  ]);
});

test("separate credit/debit columns distinguish empty, zero, invalid, and out-of-range values", async () => {
  const result = await new DefaultFinancialImportParser().parse({
    format: "csv", fileName: "statement.csv",
    content: Buffer.from([
      "date;credit;debit",
      "2026-10-01;invalid;1,00",
      "2026-10-02;1,00;invalid",
      "2026-10-03;1000000000000,00;",
      "2026-10-04;;1000000000000,00",
      "2026-10-05;0,00;2,00",
      "2026-10-06;3,00;0,00",
      "2026-10-07;999999999999,99;",
      "2026-10-08;;999999999999,99",
      "2026-10-09;;",
    ].join("\n")),
    csvConfiguration: { delimiter: ";", encoding: "utf-8", hasHeader: true, dateFormat: "yyyy-MM-dd", numberFormat: "pt-BR", columns: { date: 0, description: null, amount: null, credit: 1, debit: 2, externalId: null } },
  });
  assert.equal(result.items[0]?.signedAmount, null);
  assert.match(result.items[0]?.errorMessage ?? "", /crédito inválido/i);
  assert.equal(result.items[1]?.signedAmount, null);
  assert.match(result.items[1]?.errorMessage ?? "", /débito inválido/i);
  assert.match(result.items[2]?.errorMessage ?? "", /crédito inválido/i);
  assert.match(result.items[3]?.errorMessage ?? "", /débito inválido/i);
  assert.deepEqual(result.items.slice(4, 8).map((item) => [item.signedAmount, item.type, item.validationStatus]), [
    ["-2.00", "expense", undefined],
    ["3.00", "income", undefined],
    ["999999999999.99", "income", undefined],
    ["-999999999999.99", "expense", undefined],
  ]);
  assert.match(result.items[8]?.errorMessage ?? "", /apenas crédito ou débito/i);
});

test("rejects NUL instead of silently altering CSV date, description, or external id", async () => {
  const parser = new DefaultFinancialImportParser();
  const configuration = { delimiter: ";" as const, encoding: "utf-8" as const, hasHeader: true, dateFormat: "yyyy-MM-dd" as const, numberFormat: "pt-BR" as const, columns: { date: 0, description: 1, amount: 2, credit: null, debit: null, externalId: 3 } };
  for (const row of [
    "2026-10-\u000001;Description;1,00;id",
    "2026-10-01;Descri\u0000ption;1,00;id",
    "2026-10-01;Description;1,00;external\u0000id",
  ]) {
    await assert.rejects(
      parser.parse({ format: "csv", fileName: "nul.csv", content: Buffer.from(`date;description;amount;id\n${row}\n`), csvConfiguration: configuration }),
      /caractere nulo/i,
    );
  }
});

test("uses ordinal sequences while preserving physical lines across headers, blanks, and multiline cells", async () => {
  const parser = new DefaultFinancialImportParser();
  const configuration = { delimiter: ";" as const, encoding: "utf-8" as const, hasHeader: true, dateFormat: "yyyy-MM-dd" as const, numberFormat: "pt-BR" as const, columns: { date: 0, description: 1, amount: 2, credit: null, debit: null, externalId: null } };
  const result = await parser.parse({
    format: "csv", fileName: "lines.csv",
    content: Buffer.from('date;description;amount\n\n2026-10-01;"first\nsecond";1,00\n\nbad;invalid;2,00\n'),
    csvConfiguration: configuration,
  });
  assert.deepEqual(result.items.map((item) => item.sequence), [1, 2]);
  assert.equal(result.items[0]?.description, "first second");
  assert.match(result.items[1]?.errorMessage ?? "", /Linha 6: data inválida/);

  const highPhysicalLine = await parser.parse({
    format: "csv", fileName: "blank-lines.csv",
    content: Buffer.from(`date;description;amount\n${"\n".repeat(10_001)}2026-10-01;valid;1,00\n`),
    csvConfiguration: configuration,
  });
  assert.equal(highPhysicalLine.items[0]?.sequence, 1);
});

test("strictly rejects ambiguous mappings and unexpected properties", () => {
  assert.throws(() => parseCsvConfiguration({ delimiter: ",", encoding: "utf-8", hasHeader: true, dateFormat: "yyyy-MM-dd", numberFormat: "en-US", columns: { date: 0, amount: 1, credit: 2, debit: 3 } }), /coluna de valor/i);
  assert.throws(() => parseCsvConfiguration(JSON.parse('{"delimiter":",","encoding":"utf-8","hasHeader":true,"dateFormat":"yyyy-MM-dd","numberFormat":"en-US","columns":{"date":0,"amount":1,"__proto__":2}}')), /inválida/i);
  assert.deepEqual(parseCsvInspectionOverrides({
    delimiter: ";", encoding: "utf-8", hasHeader: false, dateFormat: "dd/MM/yyyy", numberFormat: "pt-BR",
    columns: { date: 0, amount: null, credit: null, debit: null },
  }), { delimiter: ";", encoding: "utf-8", hasHeader: false, dateFormat: "dd/MM/yyyy", numberFormat: "pt-BR" });
  assert.throws(() => parseCsvInspectionOverrides({
    delimiter: "|", encoding: "utf-8", hasHeader: false, dateFormat: "dd/MM/yyyy", numberFormat: "pt-BR",
  }), /inspeção.+inválida/i);
});
