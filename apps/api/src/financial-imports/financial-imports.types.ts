export const FINANCIAL_IMPORT_FORMATS = ["ofx", "csv"] as const;
export const FINANCIAL_IMPORT_STATUSES = ["processing", "preview", "confirming", "completed", "failed", "undone"] as const;
export const FINANCIAL_IMPORT_ITEM_TYPES = ["income", "expense", "transfer"] as const;
export const FINANCIAL_IMPORT_ITEM_STATUSES = ["valid", "duplicate", "invalid", "uncategorized", "imported"] as const;

export type FinancialImportFormat = (typeof FINANCIAL_IMPORT_FORMATS)[number];
export type FinancialImportStatus = (typeof FINANCIAL_IMPORT_STATUSES)[number];
export type FinancialImportItemType = (typeof FINANCIAL_IMPORT_ITEM_TYPES)[number];
export type FinancialImportItemStatus = (typeof FINANCIAL_IMPORT_ITEM_STATUSES)[number];

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
  createdAt: string;
  updatedAt: string;
}

export interface FinancialImportSession {
  id: string;
  format: FinancialImportFormat;
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
  date: string | null;
  description?: string | null;
  signedAmount: string | null;
  type: FinancialImportItemType;
  categoryId?: string | null;
  subcategoryId?: string | null;
  validationStatus?: Exclude<FinancialImportItemStatus, "imported">;
  errorMessage?: string | null;
  isRepairable?: boolean;
}

export interface FinancialImportParserInput {
  format: FinancialImportFormat;
  fileName: string;
  content: Buffer;
}

export interface FinancialImportParser {
  parse(input: FinancialImportParserInput): Promise<ParsedFinancialImportItem[]>;
}

export interface CreateFinancialImportInput {
  format: FinancialImportFormat;
  fileName: string;
  fileSize: number;
  fileHash: string;
}

export interface UpdateFinancialImportItemInput {
  date: string;
  description?: string | null;
  type: FinancialImportItemType;
  categoryId?: string | null;
  subcategoryId?: string | null;
}

export interface FinancialImportRepository {
  createImport(userId: string, walletId: string, input: CreateFinancialImportInput): Promise<FinancialImportSession>;
  savePreview(
    userId: string,
    walletId: string,
    importId: string,
    items: ParsedFinancialImportItem[],
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
}
