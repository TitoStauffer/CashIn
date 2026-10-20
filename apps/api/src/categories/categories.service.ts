import { CategoryConflictError, CategoryError } from "./categories.errors.js";
import type {
  Category,
  CategoryNature,
  CategoryRepository,
  CategorySubcategory,
} from "./categories.types.js";

const MAX_NAME_LENGTH = 100;

function normalizeName(name: string): string {
  const normalizedName = name.trim();
  if (normalizedName.length === 0) {
    throw new CategoryError("O nome é obrigatório.", 400);
  }
  if (normalizedName.length > MAX_NAME_LENGTH) {
    throw new CategoryError(`O nome deve ter no máximo ${MAX_NAME_LENGTH} caracteres.`, 400);
  }
  return normalizedName;
}

function mapConflict(error: unknown): never {
  if (error instanceof CategoryError) throw error;
  if (typeof error === "object" && error !== null && "code" in error) {
    if (error.code === "23505") {
      throw new CategoryConflictError("Já existe um item com esse nome neste contexto.");
    }
    if (error.code === "23503") {
      throw new CategoryConflictError("O item possui registros vinculados e não pode ser excluído.");
    }
  }
  throw error;
}

export class CategoriesService {
  constructor(private readonly repository: CategoryRepository) {}

  listCategories(userId: string, nature?: CategoryNature): Promise<Category[]> {
    return this.repository.listCategories(userId, nature);
  }

  async createCategory(userId: string, name: string, nature: CategoryNature): Promise<Category> {
    try {
      return await this.repository.createCategory(userId, normalizeName(name), nature);
    } catch (error) {
      return mapConflict(error);
    }
  }

  async updateCategoryName(
    userId: string,
    categoryId: string,
    name: string,
  ): Promise<Category> {
    try {
      const category = await this.repository.updateCategoryName(userId, categoryId, normalizeName(name));
      if (!category) throw new CategoryError("Categoria não encontrada.", 404);
      return category;
    } catch (error) {
      return mapConflict(error);
    }
  }

  async deleteCategory(userId: string, categoryId: string): Promise<void> {
    try {
      const deleted = await this.repository.deleteCategory(userId, categoryId);
      if (!deleted) throw new CategoryError("Categoria não encontrada.", 404);
    } catch (error) {
      return mapConflict(error);
    }
  }

  async createSubcategory(
    userId: string,
    categoryId: string,
    name: string,
  ): Promise<CategorySubcategory> {
    try {
      const subcategory = await this.repository.createSubcategory(userId, categoryId, normalizeName(name));
      if (!subcategory) throw new CategoryError("Categoria não encontrada.", 404);
      return subcategory;
    } catch (error) {
      return mapConflict(error);
    }
  }

  async updateSubcategoryName(
    userId: string,
    categoryId: string,
    subcategoryId: string,
    name: string,
  ): Promise<CategorySubcategory> {
    try {
      const subcategory = await this.repository.updateSubcategoryName(
        userId,
        categoryId,
        subcategoryId,
        normalizeName(name),
      );
      if (!subcategory) throw new CategoryError("Subcategoria não encontrada.", 404);
      return subcategory;
    } catch (error) {
      return mapConflict(error);
    }
  }

  async deleteSubcategory(
    userId: string,
    categoryId: string,
    subcategoryId: string,
  ): Promise<void> {
    try {
      const deleted = await this.repository.deleteSubcategory(userId, categoryId, subcategoryId);
      if (!deleted) throw new CategoryError("Subcategoria não encontrada.", 404);
    } catch (error) {
      return mapConflict(error);
    }
  }
}
