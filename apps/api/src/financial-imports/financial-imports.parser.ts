import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { FinancialImportError } from "./financial-imports.errors.js";
import type {
  FinancialImportParser,
  FinancialImportParserInput,
  ParsedFinancialImport,
  ParsedFinancialImportItem,
} from "./financial-imports.types.js";

const MAX_EXTERNAL_ID_BYTES = 512;
const OFX_DATE_PATTERN = /^(\d{4})(\d{2})(\d{2})/;
const OFX_AMOUNT_PATTERN = /^([+-]?)(\d+)(?:\.(\d+))?$/;
const TRANSFER_TYPES = new Set(["XFER", "TRANSFER"]);

export class UnsupportedFinancialImportParser implements FinancialImportParser {
  async parse(_input: FinancialImportParserInput): Promise<ParsedFinancialImport> {
    throw new FinancialImportError("O formato selecionado ainda não está disponível para importação.", 422);
  }
}

export class DefaultFinancialImportParser implements FinancialImportParser {
  private readonly ofxParser = new OfxFinancialImportParser();
  private readonly unsupportedParser = new UnsupportedFinancialImportParser();

  parse(input: FinancialImportParserInput): Promise<ParsedFinancialImport> {
    return input.format === "ofx" ? this.ofxParser.parse(input) : this.unsupportedParser.parse(input);
  }
}

export class OfxFinancialImportParser implements FinancialImportParser {
  async parse(input: FinancialImportParserInput): Promise<ParsedFinancialImport> {
    if (input.format !== "ofx") {
      throw new FinancialImportError("O arquivo informado não está no formato OFX.", 422);
    }

    const document = decodeOfx(input.content);
    validateDocumentShape(document);
    const statement = extractSingleBankStatement(document);
    const currency = requiredTag(statement, "CURDEF", "O arquivo OFX não informa a moeda da conta.").toUpperCase();
    if (currency !== "BRL") {
      throw new FinancialImportError("Somente extratos OFX em reais (BRL) podem ser importados.", 422);
    }
    const accountId = requiredTag(statement, "ACCTID", "O arquivo OFX não informa a conta de origem.");
    const bankId = optionalTag(statement, "BANKID");
    const accountType = optionalTag(statement, "ACCTTYPE")?.toUpperCase();
    const accountReferenceHash = sha256([bankId ?? "", accountId].join("|"));
    const transactionBlocks = extractTransactionBlocks(statement);
    if (transactionBlocks.length === 0) {
      throw new FinancialImportError("Nenhuma movimentação foi encontrada no arquivo OFX.", 422);
    }

    const seenExternalIds = new Set<string>();
    const items = transactionBlocks.map((block, index) => parseTransaction(
      block,
      index + 1,
      accountReferenceHash,
      seenExternalIds,
    ));

    return {
      items,
      sourceMetadata: compactMetadata({
        currency,
        bankId,
        accountType,
        accountReferenceHash,
        ofxVersion: readHeader(document, "VERSION"),
      }),
    };
  }
}

function decodeOfx(content: Buffer): string {
  const headerSample = content.subarray(0, Math.min(content.length, 8_192)).toString("latin1");
  const encoding = readHeader(headerSample, "ENCODING")?.toUpperCase().replaceAll(/[-_]/g, "");
  const charset = readHeader(headerSample, "CHARSET")?.toUpperCase().replaceAll(/[-_]/g, "");
  const xmlEncoding = /<\?xml\b[^>]*\bencoding\s*=\s*["']([^"']+)["']/i
    .exec(headerSample)?.[1]?.toUpperCase().replaceAll(/[-_]/g, "");
  const declaredEncoding = encoding ?? xmlEncoding;
  const decoderEncoding = resolveOfxDecoderEncoding(content, declaredEncoding, charset);
  if (!decoderEncoding) {
    throw new FinancialImportError(
      `A codificação ${declaredEncoding ?? charset ?? "informada"} do arquivo OFX não é compatível.`,
      422,
    );
  }
  let document: string;
  try {
    document = new TextDecoder(decoderEncoding, { fatal: decoderEncoding !== "windows-1252" })
      .decode(content)
      .replace(/^\uFEFF/, "");
  } catch {
    throw new FinancialImportError("Não foi possível interpretar a codificação do arquivo OFX.", 422);
  }
  if (!/<OFX\b/i.test(document)) {
    throw new FinancialImportError("O conteúdo do arquivo OFX é inválido.", 422);
  }
  return document;
}

function resolveOfxDecoderEncoding(
  content: Buffer,
  declaredEncoding?: string,
  charset?: string,
): string | null {
  if (content.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) return "utf-16le";
  if (content.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) return "utf-16be";
  if (content.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) return "utf-8";
  if (declaredEncoding === "UTF8" || declaredEncoding === "UNICODE") return "utf-8";

  const legacyWesternEncodings = new Set(["1252", "WINDOWS1252", "ISO88591", "88591"]);
  if (legacyWesternEncodings.has(declaredEncoding ?? "") || legacyWesternEncodings.has(charset ?? "")) {
    return "windows-1252";
  }

  const asciiEncodings = new Set(["USASCII", "ASCII"]);
  const compatibleCharsets = new Set(["NONE", "UTF8", "USASCII", "ASCII"]);
  if (
    (declaredEncoding === undefined || asciiEncodings.has(declaredEncoding))
    && (charset === undefined || compatibleCharsets.has(charset))
  ) {
    return "utf-8";
  }
  return null;
}

function validateDocumentShape(document: string): void {
  if (/<CCSTMTTRNRS\b/i.test(document) || /<CCACCTFROM\b/i.test(document)) {
    throw new FinancialImportError("Faturas de cartão em OFX ainda não são suportadas nesta importação.", 422);
  }
}

function extractSingleBankStatement(document: string): string {
  const statements = [...document.matchAll(/<STMTRS\b[^>]*>/gi)];
  if (statements.length === 0) {
    throw new FinancialImportError("O arquivo não contém um extrato bancário OFX válido.", 422);
  }
  if (statements.length > 1) {
    throw new FinancialImportError("Importe apenas um extrato bancário por arquivo OFX.", 422);
  }

  const opening = statements[0]!;
  const start = (opening.index ?? 0) + opening[0].length;
  const tail = document.slice(start);
  const closing = tail.search(/<\/STMTRS\s*>/i);
  const statement = closing >= 0 ? tail.slice(0, closing) : tail;
  if (!/<BANKTRANLIST\b/i.test(statement)) {
    throw new FinancialImportError("O arquivo não contém um extrato bancário OFX válido.", 422);
  }
  return statement;
}

function extractTransactionBlocks(document: string): string[] {
  const starts = [...document.matchAll(/<STMTTRN\b[^>]*>/gi)];
  return starts.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const nextStart = starts[index + 1]?.index ?? document.length;
    const closing = document.slice(start, nextStart).search(/<\/STMTTRN\s*>/i);
    const end = closing >= 0 ? start + closing : nextStart;
    return document.slice(start, end);
  });
}

function parseTransaction(
  block: string,
  sequence: number,
  accountReferenceHash: string,
  seenExternalIds: Set<string>,
): ParsedFinancialImportItem {
  const rawDate = optionalTag(block, "DTPOSTED");
  const rawAmount = optionalTag(block, "TRNAMT");
  const rawExternalId = optionalTag(block, "FITID");
  const transactionType = optionalTag(block, "TRNTYPE")?.toUpperCase();
  const date = rawDate ? normalizeOfxDate(rawDate) : null;
  const signedAmount = rawAmount ? normalizeOfxAmount(rawAmount) : null;
  const description = buildDescription(optionalTag(block, "NAME"), optionalTag(block, "MEMO"));
  const type = transactionType && TRANSFER_TYPES.has(transactionType)
    ? "transfer"
    : signedAmount?.startsWith("-") ? "expense" : "income";
  const externalId = rawExternalId && Buffer.byteLength(rawExternalId, "utf8") <= MAX_EXTERNAL_ID_BYTES
    ? rawExternalId
    : null;
  const invalidReasons: string[] = [];
  const nonRepairableReasons: string[] = [];
  if (!date) invalidReasons.push("A data da movimentação OFX é inválida.");
  if (!signedAmount) nonRepairableReasons.push("O valor da movimentação OFX é inválido.");
  if (!rawExternalId) nonRepairableReasons.push("A movimentação OFX não possui FITID.");
  else if (!externalId) nonRepairableReasons.push("O FITID da movimentação OFX excede o tamanho permitido.");

  const repeatedExternalId = externalId !== null && seenExternalIds.has(externalId);
  if (externalId) seenExternalIds.add(externalId);
  const recordHash = date && signedAmount
    ? sha256([accountReferenceHash, date, signedAmount, normalizeDescriptionForHash(description)].join("|"))
    : null;

  if (repeatedExternalId) {
    return {
      sequence,
      date,
      description,
      signedAmount,
      type,
      validationStatus: "duplicate",
      errorMessage: "O FITID está repetido no arquivo OFX.",
      isRepairable: false,
      externalId,
      recordHash,
    };
  }
  const reasons = [...nonRepairableReasons, ...invalidReasons];
  return {
    sequence,
    date,
    description,
    signedAmount,
    type,
    ...(reasons.length === 0 ? {} : {
      validationStatus: "invalid" as const,
      errorMessage: reasons.join(" "),
      isRepairable: nonRepairableReasons.length === 0,
    }),
    externalId,
    recordHash,
  };
}

function normalizeOfxDate(value: string): string | null {
  const match = OFX_DATE_PATTERN.exec(value.trim());
  if (!match) return null;
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : null;
}

function normalizeOfxAmount(value: string): string | null {
  const match = OFX_AMOUNT_PATTERN.exec(value.trim());
  if (!match || (match[3]?.length ?? 0) > 2) return null;
  const integer = match[2]!.replace(/^0+(?=\d)/, "");
  if (integer.length > 12) return null;
  const fraction = (match[3] ?? "").padEnd(2, "0");
  const normalized = `${integer}.${fraction}`;
  if (/^0\.00$/.test(normalized)) return "0.00";
  return match[1] === "-" ? `-${normalized}` : normalized;
}

function buildDescription(name?: string, memo?: string): string | null {
  const values = [name, memo]
    .map((value) => value?.replaceAll(/\s+/g, " ").trim())
    .filter((value): value is string => Boolean(value));
  if (values.length === 2 && values[0]!.toLocaleLowerCase("pt-BR") === values[1]!.toLocaleLowerCase("pt-BR")) {
    values.pop();
  }
  return values.length > 0 ? values.join(" — ") : null;
}

function normalizeDescriptionForHash(value: string | null): string {
  return value?.normalize("NFKC").toLocaleLowerCase("pt-BR").replaceAll(/\s+/g, " ").trim() ?? "";
}

function requiredTag(document: string, tag: string, message: string): string {
  const value = optionalTag(document, tag);
  if (!value) throw new FinancialImportError(message, 422);
  return value;
}

function optionalTag(document: string, tag: string): string | undefined {
  const opening = new RegExp(`<${tag}\\b[^>]*>`, "i").exec(document);
  if (!opening) return undefined;

  const tail = document.slice((opening.index ?? 0) + opening[0].length);
  const closing = findXmlClosingTag(tail, tag);
  if (closing >= 0) {
    const xmlValue = parseXmlScalarContent(tail.slice(0, closing));
    if (xmlValue === null) return undefined;
    const value = xmlValue.trim();
    return value || undefined;
  }
  if (/^\s*<!\[CDATA\[/i.test(tail)) return undefined;

  const nextTag = tail.search(/<[!?/]?[a-z][^>]*>/i);
  const value = tail.slice(0, nextTag < 0 ? tail.length : nextTag).trim();
  return value ? decodeEntities(value) : undefined;
}

function findXmlClosingTag(content: string, tag: string): number {
  const closingPattern = new RegExp(`<\\/${tag}\\s*>`, "iy");
  let cursor = 0;
  while (cursor < content.length) {
    const markup = content.indexOf("<", cursor);
    if (markup < 0) return -1;
    if (content.startsWith("<![CDATA[", markup)) {
      const cdataEnd = content.indexOf("]]>", markup + 9);
      if (cdataEnd < 0) return -1;
      cursor = cdataEnd + 3;
      continue;
    }
    closingPattern.lastIndex = markup;
    if (closingPattern.test(content)) return markup;
    cursor = markup + 1;
  }
  return -1;
}

function parseXmlScalarContent(content: string): string | null {
  let cursor = 0;
  const chunks: string[] = [];
  while (cursor < content.length) {
    const markup = content.indexOf("<", cursor);
    if (markup < 0) {
      chunks.push(decodeEntities(content.slice(cursor)));
      return chunks.join("");
    }
    chunks.push(decodeEntities(content.slice(cursor, markup)));
    if (!content.startsWith("<![CDATA[", markup)) return null;
    const cdataEnd = content.indexOf("]]>", markup + 9);
    if (cdataEnd < 0) return null;
    chunks.push(content.slice(markup + 9, cdataEnd));
    cursor = cdataEnd + 3;
  }
  return chunks.join("");
}

function readHeader(document: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\r?\\n)\\s*${name}\\s*:\\s*([^\\r\\n]+)`, "i").exec(document);
  return match?.[1]?.trim();
}

function decodeEntities(value: string): string {
  return value.replaceAll(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, code: string) => {
    const normalized = code.toLowerCase();
    if (normalized === "amp") return "&";
    if (normalized === "lt") return "<";
    if (normalized === "gt") return ">";
    if (normalized === "quot") return "\"";
    if (normalized === "apos") return "'";
    const numeric = normalized.startsWith("#x")
      ? Number.parseInt(normalized.slice(2), 16)
      : Number.parseInt(normalized.slice(1), 10);
    return Number.isSafeInteger(numeric) && numeric >= 0 && numeric <= 0x10ffff
      ? String.fromCodePoint(numeric)
      : entity;
  });
}

function compactMetadata(values: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1])));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
