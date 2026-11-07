export const FINANCIAL_IMPORT_FORMATS = ["ofx", "csv"] as const;
export const FINANCIAL_IMPORT_STATUSES = ["processing", "preview", "confirming", "completed", "failed", "undone"] as const;
export const FINANCIAL_IMPORT_ITEM_TYPES = ["income", "expense", "transfer", "card_credit"] as const;
export const FINANCIAL_IMPORT_KINDS = ["bank_statement", "credit_card_statement"] as const;
// How a card statement CSV signs purchases; OFX always uses negative purchases.
export const CARD_AMOUNT_SIGNS = ["purchases_negative", "purchases_positive"] as const;
export const FINANCIAL_IMPORT_ITEM_STATUSES = ["valid", "duplicate", "invalid", "uncategorized", "imported"] as const;

export type FinancialImportFormat = (typeof FINANCIAL_IMPORT_FORMATS)[number];
export type FinancialImportStatus = (typeof FINANCIAL_IMPORT_STATUSES)[number];
export type FinancialImportItemType = (typeof FINANCIAL_IMPORT_ITEM_TYPES)[number];
export type FinancialImportItemStatus = (typeof FINANCIAL_IMPORT_ITEM_STATUSES)[number];
export type FinancialImportKind = (typeof FINANCIAL_IMPORT_KINDS)[number];
export type CardAmountSign = (typeof CARD_AMOUNT_SIGNS)[number];

export interface FinancialImportSummary {
  total: number;
  valid: number;
  duplicate: number;
  invalid: number;
  uncategorized: number;
  imported: number;
}
export interface FinancialImportItem {
  id: string;
  sequence: number;
  date: string;
  description: string | null;
  amount: string;
  type: FinancialImportItemType;
  categoryId: string | null;
  subcategoryId: string | null;
  validationStatus: FinancialImportItemStatus;
  errorMessage: string | null;
  canEdit: boolean;
  canIncludeDuplicate?: boolean;
  categorizationSource?: "rule" | "manual" | null;
  // Credit card statement imports only: the statement the item will be posted to.
  statementClosingDate?: string | null;
  statementDueDate?: string | null;
  // Bank statement imports only: the statement this payment was reconciled with, plus the open
  // statements it could pay. An ambiguous match is never reconciled automatically.
  creditCardStatementId?: string | null;
  statementCandidates?: BankPaymentCandidate[];
  createdAt: string;
  updatedAt: string;
}

// An open statement a bank payment may be reconciled with.
export interface BankPaymentCandidate {
  statementId: string;
  creditCardId: string;
  creditCardName: string;
  closingDate: string;
  dueDate: string;
  outstandingAmount: string;
}

// Preview of a credit card statement computed from the items that will be imported.
export interface FinancialImportStatementPreview {
  closingDate: string;
  dueDate: string;
  purchasesAmount: string;
  creditsAmount: string;
  totalAmount: string;
  isPaid: boolean;
}

export interface FinancialImportSession {
  id: string;
  format: FinancialImportFormat;
  kind: FinancialImportKind;
  creditCardId: string | null;
  creditCardName: string | null;
  // Lets clients offer the same statement choices the API accepts (previous, calculated, next).
  creditCardClosingDay: number | null;
  creditCardDueDay: number | null;
  statements?: FinancialImportStatementPreview[];
  fileName: string;
  fileSize: number;
  fileHash: string;
  status: FinancialImportStatus;
  summary: FinancialImportSummary;
  canUndo: boolean;
  undoBlockedReason: string | null;
  failureMessage: string | null;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  undoneAt: string | null;
  items?: FinancialImportItem[];
}

export interface ParsedFinancialImportItem {
  sequence: number;
  sourceLine?: number;
  date: string | null;
  description?: string | null;
  signedAmount: string | null;
  type: FinancialImportItemType;
  categoryId?: string | null;
  subcategoryId?: string | null;
  validationStatus?: Exclude<FinancialImportItemStatus, "imported">;
  errorMessage?: string | null;
  isRepairable?: boolean;
  externalId?: string | null;
  recordHash?: string | null;
  duplicateOverrideAllowed?: boolean;
  acceptedDuplicateFingerprint?: string | null;
  categorizationSource?: "rule" | "manual" | null;
  // Parser hint only (OFX TRNTYPE); never persisted.
  sourceTransactionType?: string;
  statementClosingDate?: string | null;
  creditCardStatementId?: string | null;
}

export interface ParsedFinancialImport {
  items: ParsedFinancialImportItem[];
  sourceMetadata?: Record<string, string>;
}

export interface FinancialImportParserInput {
  format: FinancialImportFormat;
  fileName: string;
  content: Buffer;
  csvConfiguration?: CsvImportConfiguration;
  statementKind?: FinancialImportKind;
  cardAmountSign?: CardAmountSign;
}

export const CSV_ENCODINGS = ["utf-8", "windows-1252", "iso-8859-1"] as const;
export const CSV_DATE_FORMATS = ["dd/MM/yyyy", "MM/dd/yyyy", "yyyy-MM-dd"] as const;
export const CSV_NUMBER_FORMATS = ["pt-BR", "en-US"] as const;
export type CsvEncoding = (typeof CSV_ENCODINGS)[number];
export type CsvDateFormat = (typeof CSV_DATE_FORMATS)[number];
export type CsvNumberFormat = (typeof CSV_NUMBER_FORMATS)[number];
export type CsvDelimiter = "," | ";";

export interface CsvColumnMapping {
  date: number;
  description: number | null;
  amount: number | null;
  credit: number | null;
  debit: number | null;
  externalId: number | null;
}

export interface CsvImportConfiguration {
  delimiter: CsvDelimiter;
  encoding: CsvEncoding;
  hasHeader: boolean;
  dateFormat: CsvDateFormat;
  numberFormat: CsvNumberFormat;
  columns: CsvColumnMapping;
}

export interface CsvInspectionResult {
  detectedConfiguration: Omit<CsvImportConfiguration, "columns">;
  suggestedMapping: CsvColumnMapping;
  columns: Array<{ index: number; label: string }>;
  sample: Array<{ lineNumber: number; values: string[] }>;
}

export interface CsvMapping {
  id: string;
  name: string;
  configuration: CsvImportConfiguration;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCsvMappingInput {
  name: string;
  configuration: CsvImportConfiguration;
}

export interface FinancialImportParser {
  parse(input: FinancialImportParserInput): Promise<ParsedFinancialImport | ParsedFinancialImportItem[]>;
}

export interface CreateFinancialImportInput {
  format: FinancialImportFormat;
  fileName: string;
  fileSize: number;
  fileHash: string;
  creditCardId?: string | null;
}

export interface ImportCreditCard {
  id: string;
  closingDay: number;
  dueDay: number;
}

export interface UpdateFinancialImportItemInput {
  date: string;
  description?: string | null;
  type: FinancialImportItemType;
  categoryId?: string | null;
  subcategoryId?: string | null;
  includeDuplicate?: boolean;
  statementClosingDate?: string | null;
  // Bank statement imports: the statement this payment settles, or null to leave it unreconciled.
  creditCardStatementId?: string | null;
}

export type FinancialCategorizationRuleType = Extract<FinancialImportItemType, "income" | "expense">;

export interface FinancialCategorizationRule {
  id: string;
  type: FinancialCategorizationRuleType;
  description: string;
  categoryId: string;
  categoryName: string | null;
  subcategoryId: string | null;
  subcategoryName: string | null;
  isActive: boolean;
  isStale: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FinancialCategorizationRuleInput {
  type: FinancialCategorizationRuleType;
  description: string;
  categoryId: string;
  subcategoryId?: string | null;
  isActive?: boolean;
}

export interface FinancialCategorizationRulesRepository {
  listRules(walletId: string): Promise<FinancialCategorizationRule[]>;
  createRule(userId: string, walletId: string, input: FinancialCategorizationRuleInput & { normalizedDescription: string }): Promise<FinancialCategorizationRule | null>;
  updateRule(walletId: string, ruleId: string, input: FinancialCategorizationRuleInput & { normalizedDescription: string }): Promise<FinancialCategorizationRule | null>;
  deleteRule(walletId: string, ruleId: string): Promise<boolean>;
}

export interface FinancialImportRepository {
  // Active card of the wallet, or null when it does not exist, is inactive or belongs to another wallet.
  findImportCreditCard(walletId: string, creditCardId: string): Promise<ImportCreditCard | null>;
  createImport(userId: string, walletId: string, input: CreateFinancialImportInput): Promise<FinancialImportSession>;
  savePreview(
    userId: string,
    walletId: string,
    importId: string,
    items: ParsedFinancialImportItem[],
    sourceMetadata?: Record<string, string>,
  ): Promise<FinancialImportSession | null>;
  listImports(userId: string, walletId: string): Promise<FinancialImportSession[]>;
  getImport(userId: string, walletId: string, importId: string): Promise<FinancialImportSession | null>;
  markFailed(userId: string, walletId: string, importId: string, failureMessage: string): Promise<void>;
  updateItem(
    userId: string,
    walletId: string,
    importId: string,
    itemId: string,
    input: Required<UpdateFinancialImportItemInput>,
  ): Promise<FinancialImportItem | null>;
  confirmImport(userId: string, walletId: string, importId: string): Promise<FinancialImportSession | null>;
  undoImport(userId: string, walletId: string, importId: string): Promise<FinancialImportSession | null>;
  discardImport(userId: string, walletId: string, importId: string): Promise<FinancialImportSession | null>;
  listCsvMappings(userId: string, walletId: string): Promise<CsvMapping[]>;
  getCsvMapping(userId: string, walletId: string, mappingId: string): Promise<CsvMapping | null>;
  createCsvMapping(userId: string, walletId: string, input: CreateCsvMappingInput): Promise<CsvMapping>;
  updateCsvMapping(userId: string, walletId: string, mappingId: string, input: CreateCsvMappingInput): Promise<CsvMapping | null>;
}
