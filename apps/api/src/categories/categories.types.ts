export const CATEGORY_NATURES = ["income", "expense", "investment_goal"] as const;

export type CategoryNature = (typeof CATEGORY_NATURES)[number];

export interface CategorySubcategory {
  id: string;
  name: string;
  categoryId: string;
}

export interface Category {
  id: string;
  name: string;
  nature: CategoryNature;
  subcategories: CategorySubcategory[];
}

export interface CategoryRepository {
  listCategories(userId: string, nature?: CategoryNature): Promise<Category[]>;
  createCategory(userId: string, name: string, nature: CategoryNature): Promise<Category>;
  updateCategoryName(userId: string, categoryId: string, name: string): Promise<Category | null>;
  deleteCategory(userId: string, categoryId: string): Promise<boolean>;
  createSubcategory(userId: string, categoryId: string, name: string): Promise<CategorySubcategory | null>;
  updateSubcategoryName(
    userId: string,
    categoryId: string,
    subcategoryId: string,
    name: string,
  ): Promise<CategorySubcategory | null>;
  deleteSubcategory(userId: string, categoryId: string, subcategoryId: string): Promise<boolean>;
}
