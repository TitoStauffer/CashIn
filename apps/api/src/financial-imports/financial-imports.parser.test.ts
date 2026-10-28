import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DefaultFinancialImportParser, OfxFinancialImportParser } from "./financial-imports.parser.js";

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
    /ainda não está disponível/i,
  );
});
