import type { Database } from "../database.js";
import type {
  Category,
  CategoryNature,
  CategoryRepository,
  CategorySubcategory,
} from "./categories.types.js";

interface CategoryRow {
  id: string;
  name: string;
  nature: CategoryNature;
  subcategory_id: string | null;
  subcategory_name: string | null;
  subcategory_category_id: string | null;
}

interface CategoryResultRow {
  id: string;
  name: string;
  nature: CategoryNature;
}

interface SubcategoryResultRow {
  id: string;
  name: string;
  category_id: string;
}

export class PostgresCategoriesRepository implements CategoryRepository {
  constructor(private readonly database: Database) {}

  async listCategories(userId: string, nature?: CategoryNature): Promise<Category[]> {
    const result = await this.database.query<CategoryRow>(
      `SELECT
         category.id,
         category.name,
         category.nature,
         subcategory.id AS subcategory_id,
         subcategory.name AS subcategory_name,
         subcategory.category_id AS subcategory_category_id
       FROM categories AS category
       LEFT JOIN subcategories AS subcategory
         ON subcategory.category_id = category.id
        AND subcategory.user_id = category.user_id
       WHERE category.user_id = $1
         AND ($2::text IS NULL OR category.nature = $2)
       ORDER BY lower(category.name), category.id, lower(subcategory.name), subcategory.id`,
      [userId, nature ?? null],
    );

    const categories = new Map<string, Category>();
    for (const row of result.rows) {
      let category = categories.get(row.id);
      if (!category) {
        category = { id: row.id, name: row.name, nature: row.nature, subcategories: [] };
        categories.set(row.id, category);
      }
      if (row.subcategory_id && row.subcategory_name && row.subcategory_category_id) {
        category.subcategories.push({
          id: row.subcategory_id,
          name: row.subcategory_name,
          categoryId: row.subcategory_category_id,
        });
      }
    }
    return [...categories.values()];
  }

  async createCategory(userId: string, name: string, nature: CategoryNature): Promise<Category> {
    const result = await this.database.query<CategoryResultRow>(
      `INSERT INTO categories (user_id, name, nature)
       VALUES ($1, $2, $3)
       RETURNING id, name, nature`,
      [userId, name, nature],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Category insert returned no row");
    return { ...row, subcategories: [] };
  }

  async updateCategoryName(userId: string, categoryId: string, name: string): Promise<Category | null> {
    const result = await this.database.query<CategoryResultRow>(
      `UPDATE categories
       SET name = $3, updated_at = now()
       WHERE id = $1 AND user_id = $2
       RETURNING id, name, nature`,
      [categoryId, userId, name],
    );
    const row = result.rows[0];
    return row ? { ...row, subcategories: [] } : null;
  }

  async deleteCategory(userId: string, categoryId: string): Promise<boolean> {
    const result = await this.database.query(
      "DELETE FROM categories WHERE id = $1 AND user_id = $2",
      [categoryId, userId],
    );
    return result.rowCount === 1;
  }

  async createSubcategory(
    userId: string,
    categoryId: string,
    name: string,
  ): Promise<CategorySubcategory | null> {
    const result = await this.database.query<SubcategoryResultRow>(
      `INSERT INTO subcategories (user_id, category_id, name)
       SELECT category.user_id, category.id, $3
       FROM categories AS category
       WHERE category.id = $1 AND category.user_id = $2
       RETURNING id, name, category_id`,
      [categoryId, userId, name],
    );
    const row = result.rows[0];
    return row ? { id: row.id, name: row.name, categoryId: row.category_id } : null;
  }

  async updateSubcategoryName(
    userId: string,
    categoryId: string,
    subcategoryId: string,
    name: string,
  ): Promise<CategorySubcategory | null> {
    const result = await this.database.query<SubcategoryResultRow>(
      `UPDATE subcategories AS subcategory
       SET name = $4, updated_at = now()
       FROM categories AS category
       WHERE subcategory.id = $1
         AND subcategory.category_id = $2
         AND subcategory.user_id = $3
         AND category.id = subcategory.category_id
         AND category.user_id = subcategory.user_id
       RETURNING subcategory.id, subcategory.name, subcategory.category_id`,
      [subcategoryId, categoryId, userId, name],
    );
    const row = result.rows[0];
    return row ? { id: row.id, name: row.name, categoryId: row.category_id } : null;
  }

  async deleteSubcategory(userId: string, categoryId: string, subcategoryId: string): Promise<boolean> {
    const result = await this.database.query(
      `DELETE FROM subcategories AS subcategory
       USING categories AS category
       WHERE subcategory.id = $1
         AND subcategory.category_id = $2
         AND subcategory.user_id = $3
         AND category.id = subcategory.category_id
         AND category.user_id = subcategory.user_id`,
      [subcategoryId, categoryId, userId],
    );
    return result.rowCount === 1;
  }
}
