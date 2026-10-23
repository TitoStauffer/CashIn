import { FinancialImportError } from "./financial-imports.errors.js";
import type { FinancialImportParser, FinancialImportParserInput, ParsedFinancialImportItem } from "./financial-imports.types.js";

export class UnsupportedFinancialImportParser implements FinancialImportParser {
  async parse(_input: FinancialImportParserInput): Promise<ParsedFinancialImportItem[]> {
    throw new FinancialImportError("O formato selecionado ainda não está disponível para importação.", 422);
  }
}
