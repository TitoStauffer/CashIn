import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { FinancialImportError } from "./financial-imports.errors.js";
import {
  CSV_DATE_FORMATS,
  CSV_ENCODINGS,
  CSV_NUMBER_FORMATS,
  type CsvColumnMapping,
  type CsvDateFormat,
  type CsvDelimiter,
  type CsvEncoding,
  type CsvImportConfiguration,
  type CsvInspectionResult,
  type CsvNumberFormat,
  type FinancialImportParserInput,
  type ParsedFinancialImport,
  type ParsedFinancialImportItem,
} from "./financial-imports.types.js";

const MAX_COLUMNS = 100;
const MAX_CELL_BYTES = 4_000;
const MAX_HEADER_BYTES = 32_000;
const ALLOWED_CONFIGURATION_KEYS = new Set(["delimiter", "encoding", "hasHeader", "dateFormat", "numberFormat", "columns"]);
const ALLOWED_COLUMN_KEYS = new Set(["date", "description", "amount", "credit", "debit", "externalId"]);

interface CsvRow { lineNumber: number; values: string[] }
type OptionalMoney =
  | { kind: "empty" | "zero" | "invalid" }
  | { kind: "value"; value: string };

export function parseCsvConfiguration(value: unknown): CsvImportConfiguration {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => !ALLOWED_CONFIGURATION_KEYS.has(key))) {
    throw new FinancialImportError("A configuração do arquivo CSV é inválida.", 400);
  }
  const { delimiter, encoding, hasHeader, dateFormat, numberFormat, columns } = value;
  if ((delimiter !== "," && delimiter !== ";")
    || typeof encoding !== "string" || !CSV_ENCODINGS.includes(encoding as CsvEncoding)
    || typeof hasHeader !== "boolean"
    || typeof dateFormat !== "string" || !CSV_DATE_FORMATS.includes(dateFormat as CsvDateFormat)
    || typeof numberFormat !== "string" || !CSV_NUMBER_FORMATS.includes(numberFormat as CsvNumberFormat)
    || !isPlainRecord(columns) || Object.keys(columns).some((key) => !ALLOWED_COLUMN_KEYS.has(key))) {
    throw new FinancialImportError("A configuração do arquivo CSV é inválida.", 400);
  }
  const normalizedColumns: CsvColumnMapping = {
    date: validateColumnIndex(columns.date, "data"),
    description: null,
    amount: null,
    credit: null,
    debit: null,
    externalId: null,
  };
  for (const key of ["description", "amount", "credit", "debit", "externalId"] as const) {
    if (columns[key] !== undefined && columns[key] !== null) normalizedColumns[key] = validateColumnIndex(columns[key], key);
  }
  const usesAmount = normalizedColumns.amount !== null;
  const usesCreditAndDebit = normalizedColumns.credit !== null && normalizedColumns.debit !== null;
  if (usesAmount === usesCreditAndDebit) {
    throw new FinancialImportError("Mapeie uma coluna de valor ou as colunas separadas de crédito e débito.", 400);
  }
  const indexes = Object.values(normalizedColumns).filter((item): item is number => typeof item === "number");
  if (new Set(indexes).size !== indexes.length) {
    throw new FinancialImportError("Cada campo deve usar uma coluna CSV diferente.", 400);
  }
  return { delimiter, encoding: encoding as CsvEncoding, hasHeader, dateFormat: dateFormat as CsvDateFormat, numberFormat: numberFormat as CsvNumberFormat, columns: normalizedColumns };
}

export function parseCsvInspectionOverrides(value: unknown): Omit<CsvImportConfiguration, "columns"> {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => !ALLOWED_CONFIGURATION_KEYS.has(key))) {
    throw new FinancialImportError("A configuração de inspeção do arquivo CSV é inválida.", 400);
  }
  const { delimiter, encoding, hasHeader, dateFormat, numberFormat, columns } = value;
  const hasValidIgnoredColumns = columns === undefined || (
    isPlainRecord(columns)
    && Object.keys(columns).every((key) => ALLOWED_COLUMN_KEYS.has(key))
    && Object.values(columns).every((index) => index === null || (
      Number.isSafeInteger(index) && (index as number) >= 0 && (index as number) < MAX_COLUMNS
    ))
  );
  if ((delimiter !== "," && delimiter !== ";")
    || typeof encoding !== "string" || !CSV_ENCODINGS.includes(encoding as CsvEncoding)
    || typeof hasHeader !== "boolean"
    || typeof dateFormat !== "string" || !CSV_DATE_FORMATS.includes(dateFormat as CsvDateFormat)
    || typeof numberFormat !== "string" || !CSV_NUMBER_FORMATS.includes(numberFormat as CsvNumberFormat)
    || !hasValidIgnoredColumns) {
    throw new FinancialImportError("A configuração de inspeção do arquivo CSV é inválida.", 400);
  }
  return {
    delimiter,
    encoding: encoding as CsvEncoding,
    hasHeader,
    dateFormat: dateFormat as CsvDateFormat,
    numberFormat: numberFormat as CsvNumberFormat,
  };
}

export function inspectCsv(
  content: Buffer,
  overrides?: Omit<CsvImportConfiguration, "columns">,
): CsvInspectionResult {
  if (content.length === 0) throw new FinancialImportError("O arquivo está vazio.", 400);
  const encoding = overrides?.encoding ?? detectEncoding(content);
  const text = decodeCsv(content, encoding);
  const delimiter = overrides?.delimiter ?? detectDelimiter(text);
  const rows = parseRows(text, delimiter);
  if (rows.length === 0) throw new FinancialImportError("Nenhuma linha foi encontrada no arquivo CSV.", 422);
  const hasHeader = overrides?.hasHeader ?? detectHeader(rows);
  const header = hasHeader ? rows[0]!.values : rows[0]!.values.map((_value, index) => `Coluna ${index + 1}`);
  const dataRows = rows.slice(hasHeader ? 1 : 0);
  const dateFormat = overrides?.dateFormat ?? detectDateFormat(dataRows);
  const numberFormat = overrides?.numberFormat ?? detectNumberFormat(dataRows);
  return {
    detectedConfiguration: { delimiter, encoding, hasHeader, dateFormat, numberFormat },
    suggestedMapping: suggestMapping(header),
    columns: header.map((label, index) => ({ index, label: label || `Coluna ${index + 1}` })),
    sample: dataRows.slice(0, 10).map((row) => ({ lineNumber: row.lineNumber, values: row.values })),
  };
}

export function parseCsv(input: FinancialImportParserInput): ParsedFinancialImport {
  if (input.format !== "csv" || !input.csvConfiguration) {
    throw new FinancialImportError("Informe o mapeamento das colunas do arquivo CSV.", 400);
  }
  const configuration = parseCsvConfiguration(input.csvConfiguration);
  const rows = parseRows(decodeCsv(input.content, configuration.encoding), configuration.delimiter);
  const dataRows = rows.slice(configuration.hasHeader ? 1 : 0);
  if (dataRows.length === 0) throw new FinancialImportError("Nenhuma movimentação foi encontrada no arquivo CSV.", 422);
  const items = dataRows.map((row, index) => parseItem(row, configuration, index + 1));
  return { items, sourceMetadata: { csvDelimiter: configuration.delimiter === ";" ? "semicolon" : "comma", csvEncoding: configuration.encoding } };
}

function parseItem(row: CsvRow, configuration: CsvImportConfiguration, sequence: number): ParsedFinancialImportItem {
  const errors: string[] = [];
  const date = parseDate(readColumn(row, configuration.columns.date), configuration.dateFormat);
  if (!date) errors.push("data inválida");
  let amountIsRepairable = true;
  let signedAmount: string | null;
  if (configuration.columns.amount !== null) {
    signedAmount = parseMoney(readColumn(row, configuration.columns.amount), configuration.numberFormat);
    if (!signedAmount || signedAmount === "0.00") { errors.push("valor inválido ou igual a zero"); amountIsRepairable = false; }
  } else {
    const credit = parseOptionalMoney(readColumn(row, configuration.columns.credit!), configuration.numberFormat);
    const debit = parseOptionalMoney(readColumn(row, configuration.columns.debit!), configuration.numberFormat);
    if (credit.kind === "invalid") errors.push("valor de crédito inválido");
    if (debit.kind === "invalid") errors.push("valor de débito inválido");
    const creditValue = credit.kind === "value" ? credit.value : null;
    const debitValue = debit.kind === "value" ? debit.value : null;
    if (credit.kind === "invalid" || debit.kind === "invalid") {
      signedAmount = null;
      amountIsRepairable = false;
    } else if ((creditValue === null) === (debitValue === null)) {
      signedAmount = null;
      errors.push("preencha apenas crédito ou débito com valor diferente de zero");
      amountIsRepairable = false;
    } else {
      signedAmount = creditValue ?? `-${debitValue}`;
    }
  }
  const description = optionalColumn(row, configuration.columns.description)?.replaceAll(/\s+/g, " ").trim() || null;
  const externalId = optionalColumn(row, configuration.columns.externalId)?.trim() || null;
  const type = signedAmount?.startsWith("-") ? "expense" : "income";
  const normalizedAmount = signedAmount?.replace(/^-/, "") ?? null;
  const recordHash = date && signedAmount
    ? createHash("sha256").update([date, signedAmount, description?.normalize("NFKC").toLocaleLowerCase("pt-BR") ?? ""].join("|"), "utf8").digest("hex")
    : null;
  return {
    sequence,
    date,
    description,
    signedAmount: normalizedAmount ? (type === "expense" ? `-${normalizedAmount}` : normalizedAmount) : null,
    type,
    ...(errors.length > 0 ? { validationStatus: "invalid" as const, errorMessage: `Linha ${row.lineNumber}: ${errors.join("; ")}.`, isRepairable: amountIsRepairable } : {}),
    externalId,
    recordHash,
  };
}

function parseRows(text: string, delimiter: CsvDelimiter): CsvRow[] {
  const rows: CsvRow[] = [];
  let values: string[] = [];
  let value = "";
  let quoted = false;
  let lineNumber = 1;
  let rowStart = 1;
  for (let index = 0; index <= text.length; index += 1) {
    const character = index === text.length ? "\n" : text[index]!;
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { value += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else { value += character; if (character === "\n") lineNumber += 1; }
      continue;
    }
    if (character === '"' && value.length === 0) { quoted = true; continue; }
    if (character === delimiter) { values.push(validateCell(value)); value = ""; continue; }
    if (character === "\r" && text[index + 1] === "\n") continue;
    if (character === "\n") {
      values.push(validateCell(value));
      if (values.length > MAX_COLUMNS) throw new FinancialImportError("O arquivo CSV deve ter no máximo 100 colunas.", 422);
      if (values.some((item) => item.trim() !== "")) rows.push({ lineNumber: rowStart, values });
      values = []; value = ""; lineNumber += 1; rowStart = lineNumber; continue;
    }
    value += character;
  }
  if (quoted) throw new FinancialImportError("O arquivo CSV possui aspas não finalizadas.", 422);
  return rows;
}

function validateCell(value: string): string {
  if (value.includes("\u0000")) {
    throw new FinancialImportError("O arquivo CSV contém caractere nulo e não pode ser processado com segurança.", 422);
  }
  const normalized = value.trim();
  if (Buffer.byteLength(normalized, "utf8") > MAX_CELL_BYTES) throw new FinancialImportError("Uma célula do arquivo CSV excede o limite permitido.", 422);
  return normalized;
}

function decodeCsv(content: Buffer, encoding: CsvEncoding): string {
  try { return new TextDecoder(encoding, { fatal: encoding === "utf-8" }).decode(content).replace(/^\uFEFF/, ""); }
  catch { throw new FinancialImportError("Não foi possível interpretar a codificação do arquivo CSV.", 422); }
}

function detectEncoding(content: Buffer): CsvEncoding {
  try { new TextDecoder("utf-8", { fatal: true }).decode(content); return "utf-8"; }
  catch { return "windows-1252"; }
}

function detectDelimiter(text: string): CsvDelimiter {
  const sample = text.slice(0, MAX_HEADER_BYTES);
  const comma = countOutsideQuotes(sample.split(/\r?\n/, 1)[0] ?? "", ",");
  const semicolon = countOutsideQuotes(sample.split(/\r?\n/, 1)[0] ?? "", ";");
  if (comma === 0 && semicolon === 0) throw new FinancialImportError("Não foi possível detectar as colunas do arquivo CSV.", 422);
  return semicolon > comma ? ";" : ",";
}

function countOutsideQuotes(value: string, target: CsvDelimiter): number {
  let count = 0; let quoted = false;
  for (const character of value) { if (character === '"') quoted = !quoted; else if (!quoted && character === target) count += 1; }
  return count;
}

function detectHeader(rows: CsvRow[]): boolean {
  const first = rows[0]?.values ?? [];
  const normalized = first.map(normalizeLabel);
  if (normalized.some((label) => /^(data|date|descricao|description|historico|valor|amount|credito|credit|debito|debit)$/.test(label))) return true;
  return first.some((value) => !parseDate(value, "dd/MM/yyyy") && !parseDate(value, "MM/dd/yyyy") && !parseDate(value, "yyyy-MM-dd") && parseMoney(value, "pt-BR") === null && parseMoney(value, "en-US") === null);
}

function detectDateFormat(rows: CsvRow[]): CsvDateFormat {
  for (const format of CSV_DATE_FORMATS) if (rows.some((row) => row.values.some((value) => parseDate(value, format)))) return format;
  return "dd/MM/yyyy";
}

function detectNumberFormat(rows: CsvRow[]): CsvNumberFormat {
  const values = rows.flatMap((row) => row.values);
  if (values.some((value) => /^[-+]?\d{1,3}(?:\.\d{3})*,\d{1,2}$/.test(value.trim()))) return "pt-BR";
  return "en-US";
}

function suggestMapping(header: string[]): CsvColumnMapping {
  const labels = header.map(normalizeLabel);
  const find = (...names: string[]) => { const index = labels.findIndex((label) => names.includes(label)); return index < 0 ? undefined : index; };
  const date = find("data", "date", "datatransacao", "transactiondate") ?? 0;
  const description = find("descricao", "description", "historico", "memo");
  const amount = find("valor", "amount", "value");
  const credit = find("credito", "credit", "entrada", "income");
  const debit = find("debito", "debit", "saida", "expense");
  const externalId = find("id", "externalid", "identificador", "documento");
  return {
    date,
    description: description ?? null,
    amount: amount ?? null,
    credit: amount !== undefined ? null : credit ?? null,
    debit: amount !== undefined ? null : debit ?? null,
    externalId: externalId ?? null,
  };
}

function parseDate(value: string, format: CsvDateFormat): string | null {
  const pattern = format === "yyyy-MM-dd" ? /^(\d{4})-(\d{2})-(\d{2})$/ : /^(\d{2})\/(\d{2})\/(\d{4})$/;
  const match = pattern.exec(value.trim()); if (!match) return null;
  const [year, month, day] = format === "yyyy-MM-dd" ? [match[1], match[2], match[3]] : format === "dd/MM/yyyy" ? [match[3], match[2], match[1]] : [match[3], match[1], match[2]];
  const result = `${year}-${month}-${day}`; const date = new Date(`${result}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === result ? result : null;
}

function parseMoney(value: string, format: CsvNumberFormat): string | null {
  let normalized = value.trim().replaceAll(/\s/g, "");
  if (!normalized) return null;
  let negative = false;
  if (normalized.startsWith("(") && normalized.endsWith(")")) { negative = true; normalized = normalized.slice(1, -1); }
  if (normalized.startsWith("-") || normalized.startsWith("+")) { negative = normalized[0] === "-"; normalized = normalized.slice(1); }
  const thousand = format === "pt-BR" ? "." : ","; const decimal = format === "pt-BR" ? "," : ".";
  const escapedThousand = thousand === "." ? "\\." : thousand; const escapedDecimal = decimal === "." ? "\\." : decimal;
  if (!new RegExp(`^(?:\\d{1,3}(?:${escapedThousand}\\d{3})+|\\d+)(?:${escapedDecimal}\\d{1,2})?$`).test(normalized)) return null;
  const [integerPart, fractionPart = ""] = normalized.replaceAll(thousand, "").split(decimal);
  const integer = (integerPart ?? "").replace(/^0+(?=\d)/, ""); if (!integer || integer.length > 12) return null;
  const result = `${integer}.${fractionPart.padEnd(2, "0")}`; return negative && result !== "0.00" ? `-${result}` : result;
}

function parseOptionalMoney(value: string, format: CsvNumberFormat): OptionalMoney {
  if (!value.trim()) return { kind: "empty" };
  const result = parseMoney(value, format);
  if (result === null) return { kind: "invalid" };
  if (result === "0.00") return { kind: "zero" };
  return { kind: "value", value: result.replace(/^-/, "") };
}
function readColumn(row: CsvRow, index: number): string { return row.values[index] ?? ""; }
function optionalColumn(row: CsvRow, index?: number | null): string | undefined { return index === undefined || index === null ? undefined : readColumn(row, index); }
function validateColumnIndex(value: unknown, _name: string): number { if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= MAX_COLUMNS) throw new FinancialImportError("O índice de uma coluna CSV é inválido.", 400); return value as number; }
function normalizeLabel(value: string): string { return value.normalize("NFD").replaceAll(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR").replaceAll(/[^a-z0-9]/g, ""); }
function isPlainRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
